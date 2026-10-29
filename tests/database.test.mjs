import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { API_IDENTITY_HEADER, startApiServer } from "../dist-electron/api.js";
import {
  AppDatabase,
  AppError,
  MAX_BULK_PEOPLE_PER_REQUEST,
  MAX_CAPTURE_FEEDS_PER_REQUEST,
  MAX_CAPTURE_ITEMS_PER_REQUEST,
  MAX_COUNTER_VALUE,
  MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX,
  MAX_PEOPLE_PER_FEED,
  MAX_PROFILE_STATUS_BATCH_SIZE,
} from "../dist-electron/database.js";
import { RefreshSessionManager } from "../dist-electron/refreshSessions.js";

async function createTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lef-db-"));
  const dbPath = path.join(dir, "engagement.sqlite");
  const db = new AppDatabase(dbPath);
  await db.open();
  return { db, dir, dbPath };
}

async function reopenTestDb(dbPath) {
  const db = new AppDatabase(dbPath);
  await db.open();
  return db;
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function listenOnLoopback(port = 0) {
  const server = http.createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "occupied" }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function allDbRows(db, sql, params = []) {
  const statement = db.db.prepare(sql);
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
    return rows;
  } finally {
    statement.free();
  }
}

function insertRawQueueItem(db, { id, personId, feedIds, activityAt = "2026-01-01T00:00:00.000Z" }) {
  const at = activityAt;
  db.db.run(
    `
    INSERT INTO items (
      id, person_id, type, source_url, external_id, text,
      activity_at, discovered_at, status, comment_count_applied, created_at, updated_at
    )
    VALUES (?, ?, 'post', ?, ?, 'Raw queue fixture', ?, ?, 'new', 0, ?, ?)
    `,
    [
      id,
      personId,
      `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
      `post:https://www.linkedin.com/feed/update/urn:li:activity:${id}/`,
      at,
      at,
      at,
      at,
    ],
  );
  for (const feedId of feedIds) {
    db.db.run("INSERT INTO item_feeds (item_id, feed_id, created_at) VALUES (?, ?, ?)", [id, feedId, at]);
  }
}

function postRawJson(url, { body = "{}", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: text ? JSON.parse(text) : {},
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

function postPartialJsonAndReadRawResponse(port, path, { body, contentLength }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let raw = "";
    let settled = false;
    const settle = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      handler(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(2000, () => {
      settle(reject, new Error("Timed out waiting for raw API response."));
    });
    socket.on("connect", () => {
      socket.write(
        [
          `POST ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Content-Type: application/json",
          `Content-Length: ${contentLength}`,
          "Connection: close",
          "",
          body,
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      raw += chunk;
    });
    socket.on("end", () => settle(resolve, raw));
    socket.on("close", () => {
      if (raw) {
        settle(resolve, raw);
      }
    });
    socket.on("error", (error) => settle(reject, error));
  });
}

function parseRawHttpJsonResponse(raw) {
  const [head, body = ""] = String(raw).split("\r\n\r\n");
  const status = Number(head.match(/^HTTP\/1\.1\s+(\d+)/)?.[1]);
  const headers = Object.fromEntries(
    head
      .split("\r\n")
      .slice(1)
      .map((line) => {
        const separator = line.indexOf(":");
        return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
      }),
  );
  const responseBody = /chunked/i.test(headers["transfer-encoding"] || "") ? decodeChunkedBody(body) : body;
  return {
    status,
    headers,
    body: responseBody ? JSON.parse(responseBody) : {},
  };
}

function decodeChunkedBody(body) {
  let offset = 0;
  let decoded = "";
  while (offset < body.length) {
    const nextLine = body.indexOf("\r\n", offset);
    if (nextLine === -1) {
      break;
    }
    const chunkSize = Number.parseInt(body.slice(offset, nextLine), 16);
    if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
      break;
    }
    const chunkStart = nextLine + 2;
    decoded += body.slice(chunkStart, chunkStart + chunkSize);
    offset = chunkStart + chunkSize + 2;
  }
  return decoded;
}

async function feedNamesFromDatabaseFile(filePath) {
  const copyPath = path.join(path.dirname(filePath), `inspect-${path.basename(filePath)}-${Date.now()}`);
  fs.copyFileSync(filePath, copyPath);
  const db = new AppDatabase(copyPath);
  await db.open();
  return db.listFeeds().map((feed) => feed.name);
}

test("api server falls back when the preferred port is occupied", async () => {
  const blocker = await listenOnLoopback();
  const fallbackProbe = await listenOnLoopback();
  const blockedPort = blocker.address().port;
  const fallbackPort = fallbackProbe.address().port;
  await closeServer(fallbackProbe);

  const { db } = await createTestDb();
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [blockedPort, fallbackPort]);
  try {
    assert.equal(server.port, fallbackPort);
    assert.equal(server.baseUrl, `http://127.0.0.1:${fallbackPort}`);
    const health = await fetch(`${server.baseUrl}/health`).then((response) => response.json());
    assert.deepEqual(health, { ok: true });
  } finally {
    await closeServer(server);
    await closeServer(blocker);
  }
});

test("api responses expose the app identity header for extension port discovery", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/health`, {
      headers: { Origin: "https://www.linkedin.com" },
    });

    assert.equal(response.headers.get(API_IDENTITY_HEADER), "1");
    assert.equal(response.headers.get("access-control-expose-headers"), API_IDENTITY_HEADER);
    assert.equal(response.headers.get("access-control-allow-private-network"), "true");
    assert.match(response.headers.get("access-control-allow-headers") || "", /Content-Type/);
    assert.match(response.headers.get("access-control-allow-headers") || "", new RegExp(API_IDENTITY_HEADER));
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await closeServer(server);
  }
});

test("api server limits linkedin page origins to health discovery", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const feedCountBeforeBlockedWrite = db.listFeeds().length;
    const health = await fetch(`${server.baseUrl}/health`, {
      headers: { Origin: "https://www.linkedin.com" },
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get(API_IDENTITY_HEADER), "1");

    const blockedWrite = await fetch(`${server.baseUrl}/api/feeds`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://www.linkedin.com",
      },
      body: JSON.stringify({ name: "Blocked LinkedIn Origin" }),
    });
    const blockedBody = await blockedWrite.json();
    assert.equal(blockedWrite.status, 403);
    assert.match(blockedBody.error, /Origin is not allowed/);
    assert.equal(db.listFeeds().length, feedCountBeforeBlockedWrite);

    const allowedPreflight = await fetch(`${server.baseUrl}/api/feeds`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://www.linkedin.com",
        "Access-Control-Request-Headers": `Content-Type, ${API_IDENTITY_HEADER}`,
      },
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(allowedPreflight.headers.get("access-control-allow-origin"), "https://www.linkedin.com");

    const helperWrite = await fetch(`${server.baseUrl}/api/feeds`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [API_IDENTITY_HEADER]: "1",
        Origin: "https://www.linkedin.com",
      },
      body: JSON.stringify({ name: "LinkedIn Helper Origin Feed" }),
    });
    const helperBody = await helperWrite.json();
    assert.equal(helperWrite.status, 200);
    assert.equal(helperBody.name, "LinkedIn Helper Origin Feed");
    assert.equal(db.listFeeds().length, feedCountBeforeBlockedWrite + 1);

    const extensionWrite = await fetch(`${server.baseUrl}/api/feeds`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      },
      body: JSON.stringify({ name: "Extension Origin Feed" }),
    });
    const extensionBody = await extensionWrite.json();
    assert.equal(extensionWrite.status, 200);
    assert.equal(extensionBody.name, "Extension Origin Feed");
    assert.equal(db.listFeeds().length, feedCountBeforeBlockedWrite + 2);
  } finally {
    await closeServer(server);
  }
});

test("api server returns json for oversized request bodies", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/feeds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Oversized", padding: "x".repeat(1024 * 1024) }),
    });
    const body = await response.json();

    assert.equal(response.status, 413);
    assert.match(body.error, /too large/);
  } finally {
    await closeServer(server);
  }
});

test("api server rejects oversized declared request bodies before parsing", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const oversizedBody = "x".repeat(1024 * 1024 + 1);
    const response = await postRawJson(`${server.baseUrl}/api/feeds`, {
      body: oversizedBody,
      headers: { "Content-Length": String(Buffer.byteLength(oversizedBody)) },
    });

    assert.equal(response.status, 413);
    assert.equal(response.headers[API_IDENTITY_HEADER.toLowerCase()], "1");
    assert.match(response.body.error, /too large/);
  } finally {
    await closeServer(server);
  }
});

test("api server times out stalled json request bodies", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port], { requestBodyTimeoutMs: 40 });

  try {
    const rawResponse = await postPartialJsonAndReadRawResponse(port, "/api/feeds", {
      body: '{"name":"Stalled Body"',
      contentLength: 1024,
    });
    const response = parseRawHttpJsonResponse(rawResponse);

    assert.equal(response.status, 408);
    assert.equal(response.headers[API_IDENTITY_HEADER.toLowerCase()], "1");
    assert.equal(response.headers["retry-after"], "1");
    assert.match(response.body.error, /timed out/);
    assert.equal(db.listFeeds().some((feed) => feed.name === "Stalled Body"), false);
  } finally {
    await closeServer(server);
  }
});

test("api request body parser removes listeners after settling", () => {
  const source = fs.readFileSync(path.resolve("electron", "api.ts"), "utf8");
  const readJson = source.slice(source.indexOf("function readJson"), source.indexOf("function trimTrailingSlash"));

  assert.match(readJson, /const cleanup = \(\) => \{/);
  assert.match(readJson, /clearReadTimeout\(\);/);
  assert.match(readJson, /req\.off\("data", handleData\);/);
  assert.match(readJson, /req\.off\("end", handleEnd\);/);
  assert.match(readJson, /req\.off\("aborted", handleAborted\);/);
  assert.match(readJson, /req\.off\("error", rejectOnce\);/);
  assert.match(readJson, /const handleData = \(chunk: Buffer\) => \{/);
  assert.match(readJson, /const handleEnd = \(\) => \{/);
  assert.match(readJson, /const handleAborted = \(\) => \{/);
  assert.match(readJson, /req\.on\("data", handleData\);/);
  assert.match(readJson, /req\.on\("end", handleEnd\);/);
  assert.match(readJson, /req\.on\("aborted", handleAborted\);/);
  assert.match(readJson, /req\.on\("error", rejectOnce\);/);
  assert.doesNotMatch(readJson, /req\.on\("data", \(chunk: Buffer\) => \{/);
  assert.doesNotMatch(readJson, /req\.on\("end", \(\) => \{/);
  assert.doesNotMatch(readJson, /req\.on\("aborted", \(\) => \{/);
});

test("api server sends retry hints only for retryable errors", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const server = await startApiServer(
    {
      listFeeds() {
        throw new Error("Simulated transient list failure.");
      },
    },
    {},
    [port],
  );

  try {
    const retryableResponse = await fetch(`${server.baseUrl}/api/feeds`);
    const retryableBody = await retryableResponse.json();
    const nonRetryableResponse = await fetch(`${server.baseUrl}/api/queue?limit=not-a-number`);
    const nonRetryableBody = await nonRetryableResponse.json();

    assert.equal(retryableResponse.status, 500);
    assert.equal(retryableResponse.headers.get(API_IDENTITY_HEADER), "1");
    assert.equal(retryableResponse.headers.get("retry-after"), "1");
    assert.match(retryableBody.error, /Simulated transient list failure/);
    assert.equal(nonRetryableResponse.status, 400);
    assert.equal(nonRetryableResponse.headers.get("retry-after"), null);
    assert.match(nonRetryableBody.error, /Queue limit must be a number/);
  } finally {
    await closeServer(server);
  }
});

test("api server rejects non-object json request bodies", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    for (const body of ["null", "[]"]) {
      const response = await fetch(`${server.baseUrl}/api/people`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const payload = await response.json();

      assert.equal(response.status, 400);
      assert.match(payload.error, /JSON object/);
    }
  } finally {
    await closeServer(server);
  }
});

test("api server rejects malformed array request fields before mutating data", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Malformed Array API", 15);
  const knownFeed = db.createFeed("Malformed Known Feed", 15);
  const person = db.upsertPerson({
    name: "Malformed Array Person",
    profileUrl: "https://www.linkedin.com/in/malformed-array-person/",
  });
  db.setPersonFeedMembership(person.id, [knownFeed.id]);
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  async function postJson(pathname, body) {
    const response = await fetch(`${server.baseUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  try {
    const requests = [
      postJson("/api/people", {
        name: "Malformed Profile Memberships",
        profileUrl: "https://www.linkedin.com/in/malformed-profile-memberships/",
        feedIds: "not an array",
      }),
      postJson(`/api/people/${encodeURIComponent(person.id)}/memberships`, {
        feedIds: [],
        knownFeedIds: "not an array",
      }),
      postJson("/api/profile-memberships", {
        name: "Malformed Overlay Memberships",
        profileUrl: "https://www.linkedin.com/in/malformed-overlay-memberships/",
        feedIds: [feed.id],
        knownFeedIds: "not an array",
      }),
      postJson(`/api/people/${encodeURIComponent(person.id)}/memberships`, {
        feedIds: ["   "],
      }),
      postJson("/api/profile-memberships", {
        name: "Padded Overlay Memberships",
        profileUrl: "https://www.linkedin.com/in/padded-overlay-memberships/",
        feedIds: [` ${feed.id}`],
      }),
      postJson("/api/capture-items/multi", {
        feedIds: [feed.id, `${feed.id} `],
        items: [],
      }),
      postJson(`/api/feeds/${encodeURIComponent(feed.id)}/people/bulk`, { people: { profileUrl: person.profileUrl } }),
      postJson("/api/capture-items", { feedId: feed.id, items: { sourceUrl: "https://www.linkedin.com/feed/" } }),
      postJson("/api/capture-items/multi", { feedIds: feed.id, items: [] }),
      postJson("/api/capture-items/multi", { feedIds: [feed.id], items: { sourceUrl: "https://www.linkedin.com/feed/" } }),
    ];

    const results = await Promise.all(requests);

    assert.deepEqual(
      results.map((result) => result.status),
      [400, 400, 400, 400, 400, 400, 400, 400, 400, 400],
    );
    assert.match(results[0].body.error, /Feed memberships must be an array/);
    assert.match(results[1].body.error, /Known feed memberships must be an array/);
    assert.match(results[2].body.error, /Known feed memberships must be an array/);
    assert.match(results[3].body.error, /Feed memberships must not contain blank strings/);
    assert.match(results[4].body.error, /Feed memberships entries must not have surrounding whitespace/);
    assert.match(results[5].body.error, /Capture feed ids entries must not have surrounding whitespace/);
    assert.match(results[6].body.error, /People must be an array/);
    assert.match(results[7].body.error, /Captured items must be an array/);
    assert.match(results[8].body.error, /Capture feed ids must be an array/);
    assert.match(results[9].body.error, /Captured items must be an array/);
    assert.equal(db.getProfileStatus("https://www.linkedin.com/in/malformed-profile-memberships/").person, undefined);
    assert.equal(db.getProfileStatus("https://www.linkedin.com/in/padded-overlay-memberships/").person, undefined);
    assert.deepEqual(db.getPerson(person.id).feedIds, [knownFeed.id]);
    assert.equal(db.listQueue(feed.id).length, 0);
  } finally {
    await closeServer(server);
  }
});

test("api server rejects blank scalar feed ids before mutating data", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Blank Scalar Feed", 15);
  const person = db.upsertPerson({
    name: "Blank Scalar Person",
    profileUrl: "https://www.linkedin.com/in/blank-scalar-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:blank-scalar/",
      text: "Blank scalar feed id item",
      activityAt: new Date().toISOString(),
    },
  ]);
  const queuedItem = db.listQueue(feed.id)[0];
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  async function postJson(pathname, body) {
    const response = await fetch(`${server.baseUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  try {
    const queueBlank = await postJson(`/api/items/${encodeURIComponent(queuedItem.id)}/status`, {
      status: "done",
      feedId: "   ",
    });
    const queuePadded = await postJson(`/api/items/${encodeURIComponent(queuedItem.id)}/status`, {
      status: "done",
      feedId: `${feed.id} `,
    });
    const captureBlank = await postJson("/api/capture-items", { feedId: "   ", items: [] });
    const refreshPadded = await postJson("/api/refresh-sessions", { feedId: ` ${feed.id}` });

    assert.equal(queueBlank.status, 400);
    assert.match(queueBlank.body.error, /Queue feed id must not be blank/);
    assert.equal(queuePadded.status, 400);
    assert.match(queuePadded.body.error, /Queue feed id must not have surrounding whitespace/);
    assert.equal(captureBlank.status, 400);
    assert.match(captureBlank.body.error, /Capture feed id must not be blank/);
    assert.equal(refreshPadded.status, 400);
    assert.match(refreshPadded.body.error, /Refresh feed id must not have surrounding whitespace/);
    assert.equal(db.listQueue(feed.id, "new").some((item) => item.id === queuedItem.id), true);
    assert.equal(db.listQueue(feed.id, "done").some((item) => item.id === queuedItem.id), false);
    assert.deepEqual(manager.list(), []);
  } finally {
    await closeServer(server);
  }
});

test("api server rejects malformed encoded route parameters without a 500", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const requests = [
      fetch(`${server.baseUrl}/api/feeds/%E0%A4%A`, { method: "DELETE" }),
      fetch(`${server.baseUrl}/api/people/%E0%A4%A/memberships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedIds: [] }),
      }),
      fetch(`${server.baseUrl}/api/items/%E0%A4%A/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      }),
      fetch(`${server.baseUrl}/api/refresh-sessions/%E0%A4%A`),
    ];

    for (const response of await Promise.all(requests)) {
      const payload = await response.json();

      assert.equal(response.status, 400);
      assert.match(payload.error, /Malformed/);
    }
  } finally {
    await closeServer(server);
  }
});

test("api server rejects blank encoded route parameters before side effects", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Blank Route Feed", 15);
  const person = db.upsertPerson({
    name: "Blank Route Person",
    profileUrl: "https://www.linkedin.com/in/blank-route-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:blank-route/",
      text: "Blank route parameter should not mutate this item.",
      activityAt: new Date().toISOString(),
    },
  ]);
  const queuedItem = db.listQueue(feed.id)[0];
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const server = await startApiServer(db, manager, [port]);

  async function requestJson(method, pathname, body) {
    const response = await fetch(`${server.baseUrl}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  try {
    const results = await Promise.all([
      requestJson("PATCH", "/api/feeds/%20", { name: "Should Not Rename" }),
      requestJson("DELETE", "/api/feeds/%20"),
      requestJson("DELETE", "/api/people/%20"),
      requestJson("POST", "/api/people/%20/memberships", { feedIds: [] }),
      requestJson("POST", "/api/items/%20/status", { status: "done" }),
      requestJson("GET", "/api/refresh-sessions/%20"),
      requestJson("DELETE", "/api/refresh-sessions/%20"),
      requestJson("POST", "/api/refresh-sessions/%20/heartbeat", {}),
      requestJson("POST", "/api/refresh-sessions/%20/complete-target", {
        targetIndex: 0,
        requestId: "blank-route-refresh-report",
      }),
    ]);

    assert.deepEqual(results.map((result) => result.status), [400, 400, 400, 400, 400, 400, 400, 400, 400]);
    for (const result of results) {
      assert.match(result.body.error, /must not be blank/);
    }
    assert.equal(db.getFeed(feed.id).name, "Blank Route Feed");
    assert.deepEqual(db.getPerson(person.id).feedIds, [feed.id]);
    assert.equal(db.listQueue(feed.id, "new").some((item) => item.id === queuedItem.id), true);
    assert.equal(db.listQueue(feed.id, "done").some((item) => item.id === queuedItem.id), false);
    assert.equal(manager.get(session.id).status, "running");
  } finally {
    await closeServer(server);
  }
});

test("api server rejects separator encoded route parameters before side effects", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Separator Route Feed", 15);
  const person = db.upsertPerson({
    name: "Separator Route Person",
    profileUrl: "https://www.linkedin.com/in/separator-route-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:separator-route/",
      text: "Separator route parameter should not mutate this item.",
      activityAt: new Date().toISOString(),
    },
  ]);
  const queuedItem = db.listQueue(feed.id)[0];
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const server = await startApiServer(db, manager, [port]);

  async function requestJson(method, pathname, body) {
    const response = await fetch(`${server.baseUrl}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  try {
    const results = await Promise.all([
      requestJson("PATCH", "/api/feeds/%2F", { name: "Should Not Rename" }),
      requestJson("DELETE", "/api/feeds/%5C"),
      requestJson("DELETE", "/api/people/%3F"),
      requestJson("POST", "/api/people/%23/memberships", { feedIds: [] }),
      requestJson("POST", "/api/items/%00/status", { status: "done" }),
      requestJson("GET", "/api/refresh-sessions/%1F"),
      requestJson("DELETE", "/api/refresh-sessions/%2F"),
      requestJson("POST", "/api/refresh-sessions/%5C/heartbeat", {}),
      requestJson("POST", "/api/refresh-sessions/%23/complete-target", {
        targetIndex: 0,
        requestId: "separator-route-refresh-report",
      }),
    ]);

    assert.deepEqual(results.map((result) => result.status), [400, 400, 400, 400, 400, 400, 400, 400, 400]);
    for (const result of results) {
      assert.match(result.body.error, /contains unsupported characters/);
    }
    assert.equal(db.getFeed(feed.id).name, "Separator Route Feed");
    assert.deepEqual(db.getPerson(person.id).feedIds, [feed.id]);
    assert.equal(db.listQueue(feed.id, "new").some((item) => item.id === queuedItem.id), true);
    assert.equal(db.listQueue(feed.id, "done").some((item) => item.id === queuedItem.id), false);
    assert.equal(manager.get(session.id).status, "running");
  } finally {
    await closeServer(server);
  }
});

test("queue api rejects malformed pagination parameters with json 400s", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const requests = [
      { url: `${server.baseUrl}/api/queue?limit=abc`, message: /Queue limit must be a number/ },
      { url: `${server.baseUrl}/api/queue?limit=0`, message: /Queue limit must be at least 1/ },
      { url: `${server.baseUrl}/api/queue?limit=1.5`, message: /Queue limit must be a safe whole number/ },
      {
        url: `${server.baseUrl}/api/queue?limit=${Number.MAX_SAFE_INTEGER + 1}`,
        message: /Queue limit must be a safe whole number/,
      },
      { url: `${server.baseUrl}/api/queue?offset=abc`, message: /Queue offset must be a number/ },
      { url: `${server.baseUrl}/api/queue?offset=-1`, message: /Queue offset must be at least 0/ },
      { url: `${server.baseUrl}/api/queue?offset=1.5`, message: /Queue offset must be a safe whole number/ },
      {
        url: `${server.baseUrl}/api/queue?offset=${Number.MAX_SAFE_INTEGER + 1}`,
        message: /Queue offset must be a safe whole number/,
      },
      { url: `${server.baseUrl}/api/queue-view?limit=abc`, message: /Queue limit must be a number/ },
      { url: `${server.baseUrl}/api/queue-view?limit=0`, message: /Queue limit must be at least 1/ },
      { url: `${server.baseUrl}/api/queue-view?limit=1.5`, message: /Queue limit must be a safe whole number/ },
      {
        url: `${server.baseUrl}/api/queue-view?limit=${Number.MAX_SAFE_INTEGER + 1}`,
        message: /Queue limit must be a safe whole number/,
      },
      { url: `${server.baseUrl}/api/queue-view?offset=abc`, message: /Queue offset must be a number/ },
      { url: `${server.baseUrl}/api/queue-view?offset=-1`, message: /Queue offset must be at least 0/ },
      { url: `${server.baseUrl}/api/queue-view?offset=1.5`, message: /Queue offset must be a safe whole number/ },
      {
        url: `${server.baseUrl}/api/queue-view?offset=${Number.MAX_SAFE_INTEGER + 1}`,
        message: /Queue offset must be a safe whole number/,
      },
      {
        url: `${server.baseUrl}/api/queue?afterActivityAt=2026-01-01T00%3A00%3A00.000Z&afterId=item_1`,
        message: /Queue cursor must include activityAt, discoveredAt, and id/,
      },
      {
        url: `${server.baseUrl}/api/queue-view?afterActivityAt=2026-01-01T00%3A00%3A00.000Z&afterId=item_1`,
        message: /Queue cursor must include activityAt, discoveredAt, and id/,
      },
      {
        url: `${server.baseUrl}/api/queue?afterActivityAt=2026-01-01T00%3A00%3A00.000Z&afterDiscoveredAt=2026-01-01T00%3A00%3A00.000Z&afterId=%20%20%20`,
        message: /Queue cursor must include activityAt, discoveredAt, and id/,
      },
      {
        url: `${server.baseUrl}/api/queue-view?afterActivityAt=2026-01-01T00%3A00%3A00.000Z&afterDiscoveredAt=2026-01-01T00%3A00%3A00.000Z&afterId=%20%20%20`,
        message: /Queue cursor must include activityAt, discoveredAt, and id/,
      },
      {
        url: `${server.baseUrl}/api/queue?afterActivityAt=2026-01-01T00%3A00%3A00.000Z&afterDiscoveredAt=2026-01-01T00%3A00%3A00.000Z&afterId=item%2F1`,
        message: /Queue cursor id contains unsupported characters/,
      },
      {
        url: `${server.baseUrl}/api/queue-view?afterActivityAt=2026-01-01T00%3A00%3A00.000Z&afterDiscoveredAt=2026-01-01T00%3A00%3A00.000Z&afterId=${"x".repeat(81)}`,
        message: /Queue cursor id must be 80 characters or fewer/,
      },
      {
        url: `${server.baseUrl}/api/queue?afterActivityAt=not-a-date&afterDiscoveredAt=2026-01-01T00%3A00%3A00.000Z&afterId=item_1`,
        message: /Queue cursor dates are invalid/,
      },
      {
        url: `${server.baseUrl}/api/queue-view?afterActivityAt=not-a-date&afterDiscoveredAt=2026-01-01T00%3A00%3A00.000Z&afterId=item_1`,
        message: /Queue cursor dates are invalid/,
      },
    ];

    for (const request of requests) {
      const response = await fetch(request.url);
      const payload = await response.json();

      assert.equal(response.status, 400);
      assert.match(payload.error, request.message);
    }
  } finally {
    await closeServer(server);
  }
});

test("read api validates filters and normalizes blank optional query ids", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Read Query Validation Feed", 365);
  const person = db.upsertPerson({
    name: "Read Query Validation Person",
    profileUrl: "https://www.linkedin.com/in/read-query-validation-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:read-query-validation/",
      text: "Read query validation item",
      activityAt: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString(),
    },
  ]);
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const server = await startApiServer(db, manager, [port]);

  try {
    const badQueue = await fetch(`${server.baseUrl}/api/queue?status=archived`);
    const badQueueView = await fetch(`${server.baseUrl}/api/queue-view?status=%20done%20later`);
    const blankActive = await fetch(`${server.baseUrl}/api/refresh-sessions/active?id=%20%20%20`);
    const people = await fetch(`${server.baseUrl}/api/people?feedId=%20%20%20`);
    const counts = await fetch(`${server.baseUrl}/api/queue-counts?feedId=%20%20%20`);
    const sessions = await fetch(`${server.baseUrl}/api/refresh-sessions?feedId=%20%20%20`);
    const active = await fetch(`${server.baseUrl}/api/refresh-sessions/active`);

    const badQueueBody = await badQueue.json();
    const badQueueViewBody = await badQueueView.json();
    const blankActiveBody = await blankActive.json();
    const peopleBody = await people.json();
    const countsBody = await counts.json();
    const sessionsBody = await sessions.json();
    const activeBody = await active.json();

    assert.equal(badQueue.status, 400);
    assert.match(badQueueBody.error, /Queue status filter must be new, done, skipped, or all/);
    assert.equal(badQueueView.status, 400);
    assert.match(badQueueViewBody.error, /Queue status filter must be new, done, skipped, or all/);
    assert.equal(blankActive.status, 400);
    assert.match(blankActiveBody.error, /Refresh session id must not be blank/);
    assert.equal(people.status, 200);
    assert.deepEqual(
      peopleBody.map((entry) => entry.id),
      [person.id],
    );
    assert.equal(counts.status, 200);
    assert.equal(countsBody.all, 1);
    assert.equal(sessions.status, 200);
    assert.deepEqual(
      sessionsBody.map((entry) => entry.id),
      [session.id],
    );
    assert.equal(active.status, 200);
    assert.equal(activeBody.id, session.id);
    assert.equal(activeBody.status, "running");
  } finally {
    await closeServer(server);
  }
});

test("queue api normalizes parseable cursor dates before paging", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("API Cursor Date Normalize", 365);
  const person = db.upsertPerson({ name: "API Cursor Person", profileUrl: "https://www.linkedin.com/in/api-cursor-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);
  for (let index = 0; index < 5; index += 1) {
    db.captureItems(feed.id, [
      {
        personName: person.name,
        profileUrl: person.profileUrl,
        type: "post",
        sourceUrl: `https://www.linkedin.com/feed/update/urn:li:activity:api-cursor-${index}/`,
        text: `API cursor item ${index}`,
        activityAt: new Date(Date.UTC(2026, 0, 1, 12, 0 - index, 0)).toISOString(),
      },
    ]);
  }
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const firstResponse = await fetch(`${server.baseUrl}/api/queue?feedId=${encodeURIComponent(feed.id)}&limit=2`);
    const firstPage = await firstResponse.json();
    const cursor = firstPage[firstPage.length - 1];
    const params = new URLSearchParams({
      feedId: feed.id,
      limit: "2",
      afterActivityAt: new Date(cursor.activityAt).toUTCString(),
      afterDiscoveredAt: new Date(cursor.discoveredAt).toUTCString(),
      afterId: cursor.id,
    });
    const nextResponse = await fetch(`${server.baseUrl}/api/queue-view?${params.toString()}`);
    const nextPage = await nextResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(nextResponse.status, 200);
    assert.deepEqual(
      nextPage.items.map((item) => item.text),
      ["API cursor item 2", "API cursor item 3"],
    );
  } finally {
    await closeServer(server);
  }
});

test("profile status batch api returns canonical status map", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("API Batch Status", 15);
  const person = db.upsertPerson({
    name: "API Batch Person",
    profileUrl: "https://www.linkedin.com/in/API-Batch-Person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/profile-statuses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileUrls: [
          "https://www.linkedin.com/in/api-batch-person/?trackingId=ignored",
          "https://example.com/in/not-linkedin/",
        ],
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body), ["https://www.linkedin.com/in/api-batch-person/"]);
    assert.equal(body["https://www.linkedin.com/in/api-batch-person/"].person.id, person.id);
    assert.deepEqual(body["https://www.linkedin.com/in/api-batch-person/"].feedIds, [feed.id]);
  } finally {
    await closeServer(server);
  }
});

test("get-or-create feed api is idempotent for repeated quick-create requests", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const first = await fetch(`${server.baseUrl}/api/feeds/get-or-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Retry Safe Feed", lookbackDays: 30, requestId: "api-feed-create-replay-1" }),
    }).then((response) => response.json());
    const second = await fetch(`${server.baseUrl}/api/feeds/get-or-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "retry safe feed changed", lookbackDays: 7, requestId: "api-feed-create-replay-1" }),
    }).then((response) => response.json());

    assert.equal(second.id, first.id);
    assert.equal(second.name, "Retry Safe Feed");
    assert.equal(second.lookbackDays, 30);
    assert.equal(db.listFeeds().filter((feed) => feed.name.toLowerCase() === "retry safe feed").length, 1);
    assert.equal(db.listFeeds().filter((feed) => feed.name.toLowerCase() === "retry safe feed changed").length, 0);
  } finally {
    await closeServer(server);
  }
});

test("feed creation retries replay the original result", async () => {
  const { db, dbPath } = await createTestDb();
  const requestId = "feed-create-lost-response-1";
  const first = db.createFeed("Feed Create Replay", 21, { requestId });
  const duplicate = db.createFeed("Feed Create Replay Changed", 7, { requestId });
  const sameNameRetry = db.getOrCreateFeed(" feed   create   replay ", 7);

  assert.deepEqual(duplicate, first);
  assert.equal(sameNameRetry.id, first.id);
  assert.equal(sameNameRetry.lookbackDays, 21);
  assert.equal(db.listFeeds().filter((feed) => feed.name === "Feed Create Replay").length, 1);
  assert.equal(db.listFeeds().filter((feed) => feed.name === "Feed Create Replay Changed").length, 0);

  const reopened = await reopenTestDb(dbPath);
  const afterRestartDuplicate = reopened.createFeed("Feed Create Replay After Restart", 30, { requestId });
  assert.deepEqual(afterRestartDuplicate, first);
  assert.equal(reopened.listFeeds().filter((feed) => feed.name === "Feed Create Replay After Restart").length, 0);
});

test("feed creation retries replay even after the feed is deleted", async () => {
  const { db } = await createTestDb();
  const requestId = "feed-create-deleted-replay-1";
  const first = db.createFeed("Deleted Feed Create Replay", 15, { requestId });
  db.deleteFeed(first.id);
  const duplicate = db.createFeed("Deleted Feed Create Replay Retry", 30, { requestId });

  assert.deepEqual(duplicate, first);
  assert.equal(db.listFeeds().some((feed) => feed.name === "Deleted Feed Create Replay Retry"), false);
});

test("feed lookback validation rejects coercive non-numeric values", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Lookback Validation", 15);

  assert.throws(() => db.createFeed("Blank Lookback", ""), /Lookback days must be a number/);
  assert.throws(() => db.updateFeed(feed.id, { lookbackDays: null }), /Lookback days must be a number/);
  assert.throws(() => db.updateFeed(feed.id, { lookbackDays: true }), /Lookback days must be a number/);
  assert.equal(db.getFeed(feed.id).lookbackDays, 15);
});

test("feed and counter api reject malformed scalar payloads before mutating data", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("API Scalar Guard", 15);
  const person = db.upsertPerson({
    name: "API Scalar Guard Person",
    profileUrl: "https://www.linkedin.com/in/api-scalar-guard-person/",
  });
  const initialFeedCount = db.listFeeds().length;
  const server = await startApiServer(db, new RefreshSessionManager(db), [port]);

  try {
    const badCreateFeed = await fetch(`${server.baseUrl}/api/feeds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: 123, lookbackDays: 15 }),
    });
    const badPatchFeed = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feed.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Mutated Feed", lookbackDays: "30" }),
    });
    const badCounterSave = await fetch(`${server.baseUrl}/api/people/${encodeURIComponent(person.id)}/counters`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commentCount: "5" }),
    });
    const unsafeCounterSave = await fetch(`${server.baseUrl}/api/people/${encodeURIComponent(person.id)}/counters`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commentCount: Number.MAX_SAFE_INTEGER + 1 }),
    });
    const badCounterAdjustment = await fetch(
      `${server.baseUrl}/api/people/${encodeURIComponent(person.id)}/counters/adjust`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ likeCount: 1.5 }),
      },
    );
    const unsafeCounterAdjustment = await fetch(
      `${server.baseUrl}/api/people/${encodeURIComponent(person.id)}/counters/adjust`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backCommentCount: -(Number.MAX_SAFE_INTEGER + 1) }),
      },
    );

    assert.equal(badCreateFeed.status, 400);
    assert.match((await badCreateFeed.json()).error, /Feed name/);
    assert.equal(badPatchFeed.status, 400);
    assert.match((await badPatchFeed.json()).error, /Feed lookback days/);
    assert.equal(badCounterSave.status, 400);
    assert.match((await badCounterSave.json()).error, /Comment counter/);
    assert.equal(unsafeCounterSave.status, 400);
    assert.match((await unsafeCounterSave.json()).error, /Comment counter/);
    assert.equal(badCounterAdjustment.status, 400);
    assert.match((await badCounterAdjustment.json()).error, /Like counter adjustment/);
    assert.equal(unsafeCounterAdjustment.status, 400);
    assert.match((await unsafeCounterAdjustment.json()).error, /Back-comment counter adjustment/);

    assert.equal(db.listFeeds().length, initialFeedCount);
    assert.equal(db.getFeed(feed.id).name, "API Scalar Guard");
    assert.equal(db.getFeed(feed.id).lookbackDays, 15);
    assert.equal(db.getPerson(person.id).commentCount, 0);
    assert.equal(db.getPerson(person.id).likeCount, 0);
    assert.equal(db.getPerson(person.id).backCommentCount, 0);
  } finally {
    await closeServer(server);
  }
});

test("unchanged feed settings do not rewrite the feed row", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Noop Feed Settings", 15);

  const unchanged = db.updateFeed(feed.id, { name: "Noop Feed Settings", lookbackDays: 15 });

  assert.equal(unchanged.updatedAt, feed.updatedAt);
  assert.deepEqual(unchanged, feed);
});

test("feed setting retries replay the original result", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Feed Settings Replay", 15);

  const first = db.updateFeed(feed.id, { name: "Feed Settings Replayed", lookbackDays: 21 }, { requestId: "feed-settings-replay-1" });
  const duplicate = db.updateFeed(feed.id, { name: "Unexpected Retry Name", lookbackDays: 7 }, { requestId: "feed-settings-replay-1" });

  assert.deepEqual(duplicate, first);
  assert.equal(db.getFeed(feed.id).name, "Feed Settings Replayed");
  assert.equal(db.getFeed(feed.id).lookbackDays, 21);

  const reopened = await reopenTestDb(dbPath);
  const afterRestartDuplicate = reopened.updateFeed(
    feed.id,
    { name: "Unexpected Restart Retry Name", lookbackDays: 3 },
    { requestId: "feed-settings-replay-1" },
  );

  assert.deepEqual(afterRestartDuplicate, first);
});

test("feed setting retries replay even after the feed is deleted", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Deleted Feed Settings Replay", 15);

  const first = db.updateFeed(feed.id, { name: "Deleted Settings Saved", lookbackDays: 30 }, { requestId: "feed-settings-deleted-1" });
  db.deleteFeed(feed.id);
  const duplicate = db.updateFeed(feed.id, { name: "Deleted Settings Retry", lookbackDays: 5 }, { requestId: "feed-settings-deleted-1" });

  assert.deepEqual(duplicate, first);
});

test("feed-scoped add person api preserves existing memberships", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feedA = db.createFeed("API Atomic Add A", 15);
  const feedB = db.createFeed("API Atomic Add B", 15);
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const first = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feedA.id)}/people`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "API Atomic Person",
        profileUrl: "https://www.linkedin.com/in/api-atomic-person/",
      }),
    }).then((response) => response.json());
    const second = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feedB.id)}/people`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "API Atomic Person",
        profileUrl: "https://www.linkedin.com/in/api-atomic-person/",
      }),
    }).then((response) => response.json());

    assert.equal(first.id, second.id);
    assert.deepEqual(new Set(second.feedIds), new Set([feedA.id, feedB.id]));
  } finally {
    await closeServer(server);
  }
});

test("feed-scoped add person api extends a running refresh", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("API Running Refresh Add", 15);
  const alpha = db.addPersonToFeed(feed.id, {
    name: "Refresh Existing Add",
    profileUrl: "https://www.linkedin.com/in/api-refresh-existing-add/",
  });
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feed.id)}/people`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Refresh New Add",
        profileUrl: "https://www.linkedin.com/in/api-refresh-new-add/",
      }),
    });
    const body = await response.json();
    const synced = manager.get(session.id);

    assert.equal(response.ok, true);
    assert.equal(body.feedIds.includes(feed.id), true);
    assert.equal(synced.status, "running");
    assert.equal(synced.totalTargets, 4);
    assert.equal(synced.currentTarget.personId, alpha.id);
    assert.match(synced.lastError, /added 2 pending pages/);
  } finally {
    await closeServer(server);
  }
});

test("bulk add person api extends a running refresh", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("API Running Refresh Bulk", 15);
  db.addPersonToFeed(feed.id, {
    name: "Refresh Existing Bulk",
    profileUrl: "https://www.linkedin.com/in/api-refresh-existing-bulk/",
  });
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feed.id)}/people/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        people: [
          { name: "Bulk Refresh A", profileUrl: "https://www.linkedin.com/in/api-refresh-bulk-a/" },
          { name: "Bulk Refresh B", profileUrl: "https://www.linkedin.com/in/api-refresh-bulk-b/" },
        ],
      }),
    });
    const body = await response.json();
    const synced = manager.get(session.id);

    assert.equal(response.ok, true);
    assert.equal(body.added, 2);
    assert.equal(synced.status, "running");
    assert.equal(synced.totalTargets, 6);
    assert.match(synced.lastError, /added 4 pending pages/);
  } finally {
    await closeServer(server);
  }
});

test("bulk add person api replays retry results with the same request id", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("API Bulk Idempotent", 15);
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);
  const payload = {
    requestId: "api-bulk-lost-response-1",
    people: [{ name: "API Bulk Replay", profileUrl: "https://www.linkedin.com/in/api-bulk-replay/" }],
  };

  try {
    const first = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feed.id)}/people/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const duplicate = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feed.id)}/people/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const firstBody = await first.json();
    const duplicateBody = await duplicate.json();

    assert.equal(first.ok, true);
    assert.equal(duplicate.ok, true);
    assert.equal(firstBody.added, 1);
    assert.equal(firstBody.alreadyInFeed, 0);
    assert.deepEqual(duplicateBody, firstBody);
    assert.equal(db.listPeople("", feed.id).length, 1);
  } finally {
    await closeServer(server);
  }
});

test("api refresh session sync ignores deleted feed races", () => {
  const source = fs.readFileSync(path.resolve("electron", "api.ts"), "utf8");
  const peopleRoute = source.slice(source.indexOf('if (method === "POST" && path === "/api/people")'), source.indexOf("const personMatch = path.match"));
  const syncHelper = source.slice(source.indexOf("function syncRefreshSessionsForFeeds"), source.indexOf("function isNotFoundError"));

  assert.match(peopleRoute, /const before = db\.getProfileStatus\(input\.profileUrl\);/);
  assert.match(peopleRoute, /const person = db\.upsertPerson\(input, \{ requestId: input\.requestId \}\);/);
  assert.match(peopleRoute, /const status = db\.getProfileStatus\(person\.profileUrl\);/);
  assert.match(peopleRoute, /syncRefreshSessionsForFeeds\(refreshSessions, \[\.\.\.before\.feedIds, \.\.\.status\.feedIds\]\);/);
  assert.match(syncHelper, /try \{\s+refreshSessions\.syncFeedMemberships\(feedIds\);/);
  assert.match(syncHelper, /if \(!isNotFoundError\(error\)\) \{\s+throw error;\s+\}/);
  assert.match(syncHelper, /refreshSessions\.reconcileRunningSessions\(\);/);
});

test("generic person save api refreshes pending targets for tracked members", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("API Running Refresh Generic Person Save", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Generic Save Before",
    profileUrl: "https://www.linkedin.com/in/api-generic-save-before/",
  });
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/people`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Generic Save After",
        profileUrl: person.profileUrl,
        requestId: "api-generic-person-save-sync-1",
      }),
    });
    const body = await response.json();
    const synced = manager.get(session.id);

    assert.equal(response.ok, true);
    assert.deepEqual(body.feedIds, [feed.id]);
    assert.equal(synced.status, "running");
    assert.equal(synced.totalTargets, 2);
    assert.equal(synced.currentTarget.personName, "Generic Save After");
    assert.match(synced.lastError, /updated 2 pending pages/);
  } finally {
    await closeServer(server);
  }
});

test("refresh session batch membership sync skips blank and duplicate feed ids", () => {
  const source = fs.readFileSync(path.resolve("electron", "refreshSessions.ts"), "utf8");
  const sync = source.slice(source.indexOf("syncFeedMembership(feedId: string)"), source.indexOf("syncFeedSettings(feedId: string)"));
  const uniqueHelper = source.slice(source.indexOf("function uniqueRefreshFeedIds"), source.indexOf("function refreshSessionStatusOrder"));

  assert.match(sync, /return this\.syncFeedMemberships\(\[feedId\]\);/);
  assert.match(sync, /const requestedFeedIds = uniqueRefreshFeedIds\(feedIds\);/);
  assert.match(uniqueHelper, /const uniqueIds: string\[\] = \[\];/);
  assert.match(uniqueHelper, /const seen = new Set<string>\(\);/);
  assert.match(uniqueHelper, /const cleanFeedId = String\(feedId \|\| ""\)\.trim\(\);/);
  assert.match(uniqueHelper, /if \(cleanFeedId && !seen\.has\(cleanFeedId\)\) \{/);
  assert.match(uniqueHelper, /return uniqueIds;/);
});

test("api feed setting sync ignores deleted feed races", () => {
  const source = fs.readFileSync(path.resolve("electron", "api.ts"), "utf8");
  const updateRoute = source.slice(source.indexOf('if (feedMatch && method === "PATCH")'), source.indexOf('if (feedMatch && method === "DELETE")'));
  const syncHelper = source.slice(source.indexOf("function syncRefreshSessionSettingsForFeed"), source.indexOf("function isNotFoundError"));

  assert.match(updateRoute, /const input = feedUpdateInput\(body\);/);
  assert.match(updateRoute, /db\.updateFeed\(feedId, input, \{ requestId: input\.requestId \}\)/);
  assert.match(updateRoute, /syncRefreshSessionSettingsForFeed\(refreshSessions, feedId\);/);
  assert.match(syncHelper, /try \{\s+refreshSessions\.syncFeedSettings\(feedId\);/);
  assert.match(syncHelper, /if \(!isNotFoundError\(error\)\) \{\s+throw error;\s+\}/);
  assert.match(syncHelper, /refreshSessions\.reconcileRunningSessions\(\);/);
});

test("bulk add person api refreshes pending targets for existing feed members", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("API Running Refresh Existing Bulk", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Refresh Existing Before",
    profileUrl: "https://www.linkedin.com/in/api-refresh-existing-before/",
  });
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feed.id)}/people/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        people: [{ name: "Refresh Existing After", profileUrl: person.profileUrl }],
      }),
    });
    const body = await response.json();
    const synced = manager.get(session.id);

    assert.equal(response.ok, true);
    assert.equal(body.added, 0);
    assert.equal(body.updated, 1);
    assert.equal(synced.status, "running");
    assert.equal(synced.totalTargets, 2);
    assert.equal(synced.currentTarget.personName, "Refresh Existing After");
    assert.match(synced.lastError, /updated 2 pending pages/);
  } finally {
    await closeServer(server);
  }
});

test("bulk add person api skips refresh sync when existing memberships are unchanged", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("API Running Refresh Existing Noop Bulk", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Refresh Noop Before",
    profileUrl: "https://www.linkedin.com/in/api-refresh-existing-noop/",
  });
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  db.db.run("UPDATE people SET name = ?, updated_at = ? WHERE id = ?", [
    "Refresh Noop After",
    new Date().toISOString(),
    person.id,
  ]);
  assert.equal(manager.get(session.id).currentTarget.personName, "Refresh Noop Before");
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feed.id)}/people/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        people: [{ profileUrl: person.profileUrl }],
      }),
    });
    const body = await response.json();
    const unchanged = manager.get(session.id);

    assert.equal(response.ok, true);
    assert.equal(body.added, 0);
    assert.equal(body.updated, 0);
    assert.equal(body.alreadyInFeed, 1);
    assert.equal(unchanged.status, "running");
    assert.equal(unchanged.totalTargets, 2);
    assert.equal(unchanged.currentTarget.personName, "Refresh Noop Before");
    assert.equal(unchanged.lastError, "");
  } finally {
    await closeServer(server);
  }
});

test("profile membership api ignores stale feed ids from the LinkedIn overlay", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const staleFeed = db.createFeed("Deleted Overlay Feed", 15);
  const activeFeed = db.createFeed("Active Overlay Feed", 15);
  db.deleteFeed(staleFeed.id);

  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/profile-memberships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Stale Overlay Person",
        profileUrl: "https://www.linkedin.com/in/stale-overlay-person/",
        feedIds: [staleFeed.id, activeFeed.id],
      }),
    });
    const body = await response.json();

    assert.equal(response.ok, true);
    assert.deepEqual(body.feedIds, [activeFeed.id]);
    assert.ok(body.person);
    assert.deepEqual(db.getPerson(body.person.id).feedIds, [activeFeed.id]);
  } finally {
    await closeServer(server);
  }
});

test("profile membership api skips new people when all overlay feed ids are stale", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const staleFeed = db.createFeed("Only Deleted Overlay Feed", 15);
  db.deleteFeed(staleFeed.id);

  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);
  const profileUrl = "https://www.linkedin.com/in/all-stale-overlay-person/";

  try {
    const response = await fetch(`${server.baseUrl}/api/profile-memberships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "All Stale Overlay Person",
        profileUrl,
        feedIds: [staleFeed.id],
      }),
    });
    const body = await response.json();

    assert.equal(response.ok, true);
    assert.deepEqual(body.feedIds, []);
    assert.equal(body.person, undefined);
    assert.equal(db.getProfileStatus(profileUrl).person, undefined);
    assert.equal(db.listPeople().some((person) => person.profileUrl === profileUrl), false);
  } finally {
    await closeServer(server);
  }
});

test("profile membership api keeps existing memberships when all overlay feed ids are stale", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const staleFeed = db.createFeed("Deleted Existing Overlay Feed", 15);
  const activeFeed = db.createFeed("Existing Active Overlay Feed", 15);
  const person = db.addPersonToFeed(activeFeed.id, {
    name: "Existing Stale Overlay Person",
    profileUrl: "https://www.linkedin.com/in/existing-stale-overlay-person/",
  });
  db.deleteFeed(staleFeed.id);

  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/profile-memberships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: person.name,
        profileUrl: person.profileUrl,
        feedIds: [staleFeed.id],
      }),
    });
    const body = await response.json();

    assert.equal(response.ok, true);
    assert.deepEqual(body.feedIds, [activeFeed.id]);
    assert.deepEqual(db.getPerson(person.id).feedIds, [activeFeed.id]);
  } finally {
    await closeServer(server);
  }
});

test("profile membership api preserves memberships unknown to a stale overlay popover", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const knownFeed = db.createFeed("Known Overlay Feed", 15);
  const concurrentFeed = db.createFeed("Concurrent Desktop Feed", 15);
  const addedFeed = db.createFeed("Added From Overlay Feed", 15);
  const person = db.addPersonToFeed(knownFeed.id, {
    name: "Concurrent Membership Person",
    profileUrl: "https://www.linkedin.com/in/concurrent-membership-person/",
  });
  db.setPersonFeedMembership(person.id, [knownFeed.id, concurrentFeed.id]);

  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/profile-memberships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: person.name,
        profileUrl: person.profileUrl,
        knownFeedIds: [knownFeed.id],
        feedIds: [knownFeed.id, addedFeed.id],
      }),
    });
    const body = await response.json();

    assert.equal(response.ok, true);
    assert.deepEqual(new Set(body.feedIds), new Set([knownFeed.id, concurrentFeed.id, addedFeed.id]));
    assert.deepEqual(new Set(db.getPerson(person.id).feedIds), new Set([knownFeed.id, concurrentFeed.id, addedFeed.id]));
  } finally {
    await closeServer(server);
  }
});

test("desktop person membership api preserves memberships unknown to a stale row", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const knownFeed = db.createFeed("Known Desktop Feed", 15);
  const concurrentFeed = db.createFeed("Concurrent Overlay Feed", 15);
  const person = db.addPersonToFeed(knownFeed.id, {
    name: "Stale Desktop Membership Person",
    profileUrl: "https://www.linkedin.com/in/stale-desktop-membership-person/",
  });
  db.setPersonFeedMembership(person.id, [knownFeed.id, concurrentFeed.id]);

  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/people/${encodeURIComponent(person.id)}/memberships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        knownFeedIds: [knownFeed.id],
        feedIds: [],
      }),
    });
    const body = await response.json();

    assert.equal(response.ok, true);
    assert.deepEqual(body.feedIds, [concurrentFeed.id]);
    assert.deepEqual(db.getPerson(person.id).feedIds, [concurrentFeed.id]);
  } finally {
    await closeServer(server);
  }
});

test("desktop membership retry syncs refresh sessions for known removed feeds", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Known Removed Desktop Refresh", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Known Removed Desktop Person",
    profileUrl: "https://www.linkedin.com/in/known-removed-desktop-person/",
  });
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const requestId = "api-desktop-removal-sync-replay-1";
  db.setPersonFeedMembership(person.id, [], { knownFeedIds: [feed.id], requestId });
  assert.equal(manager.get(session.id).status, "running");

  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/people/${encodeURIComponent(person.id)}/memberships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        knownFeedIds: [feed.id],
        feedIds: [],
        requestId,
      }),
    });
    const body = await response.json();
    const synced = manager.get(session.id);

    assert.equal(response.ok, true);
    assert.deepEqual(body.feedIds, []);
    assert.equal(synced.status, "done");
    assert.equal(synced.totalTargets, 0);
    assert.match(synced.lastError, /removing 2 pending pages/);
  } finally {
    await closeServer(server);
  }
});

test("overlay membership retry syncs refresh sessions for known removed feeds", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Known Removed Overlay Refresh", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Known Removed Overlay Person",
    profileUrl: "https://www.linkedin.com/in/known-removed-overlay-person/",
  });
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const requestId = "api-overlay-removal-sync-replay-1";
  db.upsertPersonWithMembership(
    { name: person.name, profileUrl: person.profileUrl, feedIds: [] },
    { knownFeedIds: [feed.id], requestId },
  );
  assert.equal(manager.get(session.id).status, "running");

  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/profile-memberships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: person.name,
        profileUrl: person.profileUrl,
        knownFeedIds: [feed.id],
        feedIds: [],
        requestId,
      }),
    });
    const body = await response.json();
    const synced = manager.get(session.id);

    assert.equal(response.ok, true);
    assert.deepEqual(body.feedIds, []);
    assert.equal(synced.status, "done");
    assert.equal(synced.totalTargets, 0);
    assert.match(synced.lastError, /removing 2 pending pages/);
  } finally {
    await closeServer(server);
  }
});

test("people and membership api reject malformed scalar payloads before mutating data", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("People Scalar Guard", 15);
  const existing = db.addPersonToFeed(feed.id, {
    name: "People Scalar Existing",
    profileUrl: "https://www.linkedin.com/in/people-scalar-existing/",
  });
  const initialPeopleCount = db.listPeople().length;
  const server = await startApiServer(db, new RefreshSessionManager(db), [port]);

  try {
    const badPerson = await fetch(`${server.baseUrl}/api/people`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: 123, profileUrl: "https://www.linkedin.com/in/bad-person-scalar/" }),
    });
    const badPersonMembership = await fetch(`${server.baseUrl}/api/people`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Membership Person",
        profileUrl: "https://www.linkedin.com/in/bad-membership-person/",
        feedIds: [feed.id, 123],
      }),
    });
    const badExactMembership = await fetch(`${server.baseUrl}/api/people/${encodeURIComponent(existing.id)}/memberships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedIds: [], knownFeedIds: [feed.id, { stale: true }] }),
    });
    const badOverlayMembership = await fetch(`${server.baseUrl}/api/profile-memberships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Overlay Person",
        profileUrl: { href: "https://www.linkedin.com/in/bad-overlay-person/" },
        feedIds: [feed.id],
      }),
    });
    const badFeedScopedAdd = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feed.id)}/people`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Feed Scoped Person",
        profileUrl: "https://www.linkedin.com/in/bad-feed-scoped-person/",
        requestId: { value: "not-a-string" },
      }),
    });

    assert.equal(badPerson.status, 400);
    assert.match((await badPerson.json()).error, /Person name/);
    assert.equal(badPersonMembership.status, 400);
    assert.match((await badPersonMembership.json()).error, /Feed memberships/);
    assert.equal(badExactMembership.status, 400);
    assert.match((await badExactMembership.json()).error, /Known feed memberships/);
    assert.equal(badOverlayMembership.status, 400);
    assert.match((await badOverlayMembership.json()).error, /Person profile URL/);
    assert.equal(badFeedScopedAdd.status, 400);
    assert.match((await badFeedScopedAdd.json()).error, /Person request id/);

    assert.equal(db.listPeople().length, initialPeopleCount);
    assert.deepEqual(db.getPerson(existing.id).feedIds, [feed.id]);
    assert.equal(db.listFeeds().find((currentFeed) => currentFeed.id === feed.id).peopleCount, 1);
  } finally {
    await closeServer(server);
  }
});

test("desktop person membership api replays retries even after the person is deleted", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Deleted Retry Membership Feed", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Deleted Retry Membership Person",
    profileUrl: "https://www.linkedin.com/in/deleted-retry-membership-person/",
  });

  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const firstResponse = await fetch(`${server.baseUrl}/api/people/${encodeURIComponent(person.id)}/memberships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feedIds: [feed.id],
        requestId: "api-membership-deleted-retry-1",
      }),
    });
    const first = await firstResponse.json();
    db.deletePerson(person.id);

    const duplicateResponse = await fetch(`${server.baseUrl}/api/people/${encodeURIComponent(person.id)}/memberships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feedIds: [],
        requestId: "api-membership-deleted-retry-1",
      }),
    });
    const duplicate = await duplicateResponse.json();

    assert.equal(firstResponse.ok, true);
    assert.equal(duplicateResponse.ok, true);
    assert.deepEqual(duplicate, first);
  } finally {
    await closeServer(server);
  }
});

test("deleting a feed through the api cancels its running refresh", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Delete Active Refresh", 15);
  const person = db.upsertPerson({
    name: "Delete Refresh Person",
    profileUrl: "https://www.linkedin.com/in/delete-refresh-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feed.id)}`, { method: "DELETE" });
    const body = await response.json();

    assert.equal(response.ok, true);
    assert.deepEqual(body, { ok: true, canceledRefreshSessions: 1 });
    assert.equal(manager.get(session.id).status, "canceled");
    assert.match(manager.get(session.id).lastError, /feed was deleted/);
    assert.equal(manager.getActive(), undefined);
    assert.equal(db.listFeeds().some((currentFeed) => currentFeed.id === feed.id), false);
  } finally {
    await closeServer(server);
  }
});

test("feed delete api is idempotent after a lost response retry", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Retry Delete Feed", 15);
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const first = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feed.id)}`, { method: "DELETE" });
    const second = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feed.id)}`, { method: "DELETE" });

    assert.equal(first.ok, true);
    assert.deepEqual(await first.json(), { ok: true, canceledRefreshSessions: 0 });
    assert.equal(second.ok, true);
    assert.deepEqual(await second.json(), { ok: true, canceledRefreshSessions: 0, alreadyDeleted: true });
    assert.equal(db.listFeeds().some((currentFeed) => currentFeed.id === feed.id), false);
  } finally {
    await closeServer(server);
  }
});

test("feed delete retry cancels orphaned running refresh after the feed is already gone", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Retry Deleted Running Feed", 15);
  const person = db.upsertPerson({
    name: "Retry Deleted Running Person",
    profileUrl: "https://www.linkedin.com/in/retry-deleted-running-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  db.deleteFeed(feed.id);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feed.id)}`, { method: "DELETE" });
    const body = await response.json();

    assert.equal(response.ok, true);
    assert.deepEqual(body, { ok: true, canceledRefreshSessions: 1, alreadyDeleted: true });
    assert.equal(manager.get(session.id).status, "canceled");
    assert.match(manager.get(session.id).lastError, /feed was deleted/);
    assert.equal(manager.getActive(), undefined);
  } finally {
    await closeServer(server);
  }
});

test("refresh session delete api is idempotent after the session is already gone", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/refresh-sessions/${encodeURIComponent("refresh_already_gone")}`, {
      method: "DELETE",
    });
    const body = await response.json();

    assert.equal(response.ok, true);
    assert.deepEqual(body, { ok: true, id: "refresh_already_gone", alreadyCanceled: true });
  } finally {
    await closeServer(server);
  }
});

test("refresh session delete removes finished sessions from remembered history", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Delete Finished Refresh", 15);
  const person = db.upsertPerson({
    name: "Finished Refresh Person",
    profileUrl: "https://www.linkedin.com/in/delete-finished-refresh-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const firstTarget = session.currentTarget;
  assert.ok(firstTarget);
  manager.recordTargetComplete(session.id, {
    targetIndex: firstTarget.index,
    url: firstTarget.url,
    captureResult: {
      received: 0,
      inserted: 0,
      updated: 0,
      skippedOlder: 0,
      skippedUntracked: 0,
      skippedInvalid: 0,
    },
  });
  const secondTarget = manager.get(session.id).currentTarget;
  assert.ok(secondTarget);
  const finished = manager.recordTargetComplete(session.id, {
    targetIndex: secondTarget.index,
    url: secondTarget.url,
    captureResult: {
      received: 0,
      inserted: 0,
      updated: 0,
      skippedOlder: 0,
      skippedUntracked: 0,
      skippedInvalid: 0,
    },
  });
  assert.equal(finished.status, "done");
  const server = await startApiServer(db, manager, [port]);

  try {
    const first = await fetch(`${server.baseUrl}/api/refresh-sessions/${encodeURIComponent(session.id)}`, {
      method: "DELETE",
    });
    const firstBody = await first.json();

    assert.equal(first.ok, true);
    assert.equal(firstBody.id, session.id);
    assert.equal(firstBody.status, "done");
    assert.equal(manager.list().some((currentSession) => currentSession.id === session.id), false);
    assert.throws(() => manager.get(session.id), /Refresh session not found/);

    const second = await fetch(`${server.baseUrl}/api/refresh-sessions/${encodeURIComponent(session.id)}`, {
      method: "DELETE",
    });
    assert.equal(second.ok, true);
    assert.deepEqual(await second.json(), { ok: true, id: session.id, alreadyCanceled: true });
  } finally {
    await closeServer(server);
  }
});

test("deleting a feed cleans only affected orphan queue items without materializing item ids", async () => {
  const { db } = await createTestDb();
  const deleteFeed = db.createFeed("Chunk Delete Feed", 15);
  const sharedFeed = db.createFeed("Chunk Shared Feed", 15);
  const untouchedFeed = db.createFeed("Chunk Untouched Feed", 15);
  const deletedFeedPerson = db.upsertPerson({
    name: "Chunk Deleted Feed Person",
    profileUrl: "https://www.linkedin.com/in/chunk-deleted-feed-person/",
  });
  const untouchedPerson = db.upsertPerson({
    name: "Chunk Untouched Person",
    profileUrl: "https://www.linkedin.com/in/chunk-untouched-person/",
  });

  for (let index = 0; index < 425; index += 1) {
    insertRawQueueItem(db, {
      id: `item_delete_feed_${String(index).padStart(4, "0")}`,
      personId: deletedFeedPerson.id,
      feedIds: [deleteFeed.id],
    });
  }
  insertRawQueueItem(db, {
    id: "item_delete_feed_shared",
    personId: deletedFeedPerson.id,
    feedIds: [deleteFeed.id, sharedFeed.id],
  });
  insertRawQueueItem(db, {
    id: "item_delete_feed_untouched",
    personId: untouchedPerson.id,
    feedIds: [untouchedFeed.id],
  });
  insertRawQueueItem(db, {
    id: "item_delete_feed_unrelated_orphan",
    personId: untouchedPerson.id,
    feedIds: [],
  });

  db.deleteFeed(deleteFeed.id);

  assert.equal(db.listFeeds().some((feed) => feed.id === deleteFeed.id), false);
  assert.equal(db.getQueueCounts().all, 3);
  assert.equal(db.getQueueCounts(sharedFeed.id).all, 1);
  assert.equal(db.getQueueCounts(untouchedFeed.id).all, 1);
  assert.equal(allDbRows(db, "SELECT COUNT(*) AS count FROM item_feeds WHERE feed_id = ?", [deleteFeed.id])[0].count, 0);
  assert.equal(allDbRows(db, "SELECT COUNT(*) AS count FROM items WHERE id LIKE 'item_delete_feed_0%'")[0].count, 0);
  assert.equal(allDbRows(db, "SELECT COUNT(*) AS count FROM items WHERE id = ?", ["item_delete_feed_shared"])[0].count, 1);
  assert.equal(allDbRows(db, "SELECT COUNT(*) AS count FROM items WHERE id = ?", ["item_delete_feed_unrelated_orphan"])[0].count, 1);
});

test("feed deletion uses set-based orphan cleanup", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const deleteFeed = source.slice(source.indexOf("deleteFeed(id: string)"), source.indexOf("listPeople(query"));

  assert.match(deleteFeed, /DELETE FROM items\s+WHERE EXISTS \(/);
  assert.match(deleteFeed, /deleted_scope\.item_id = items\.id AND deleted_scope\.feed_id = \?/);
  assert.match(deleteFeed, /other_scope\.item_id = items\.id AND other_scope\.feed_id != \?/);
  assert.ok(deleteFeed.indexOf("DELETE FROM items") < deleteFeed.indexOf("DELETE FROM item_feeds WHERE feed_id = ?"));
  assert.doesNotMatch(deleteFeed, /itemIdsForFeed/);
  assert.doesNotMatch(source, /private itemIdsForFeed/);
  assert.doesNotMatch(source, /private deleteOrphanItemsByIds/);
});

test("person delete api is idempotent after a lost response retry", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Retry Delete Person", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Retry Deleted Person",
    profileUrl: "https://www.linkedin.com/in/retry-deleted-person/",
  });
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const first = await fetch(`${server.baseUrl}/api/people/${encodeURIComponent(person.id)}`, { method: "DELETE" });
    const second = await fetch(`${server.baseUrl}/api/people/${encodeURIComponent(person.id)}`, { method: "DELETE" });

    assert.equal(first.ok, true);
    assert.deepEqual(await first.json(), { ok: true });
    assert.equal(second.ok, true);
    assert.deepEqual(await second.json(), { ok: true, alreadyDeleted: true });
    assert.equal(db.listPeople("", feed.id).some((currentPerson) => currentPerson.id === person.id), false);
  } finally {
    await closeServer(server);
  }
});

test("deleting a person cleans all queue data without materializing item ids", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Delete Person Set Feed A", 15);
  const feedB = db.createFeed("Delete Person Set Feed B", 15);
  const survivorFeed = db.createFeed("Delete Person Set Survivor", 15);
  const deletedPerson = db.upsertPerson({
    name: "Set Deleted Person",
    profileUrl: "https://www.linkedin.com/in/set-deleted-person/",
  });
  const survivor = db.upsertPerson({
    name: "Set Survivor Person",
    profileUrl: "https://www.linkedin.com/in/set-survivor-person/",
  });

  for (let index = 0; index < 425; index += 1) {
    insertRawQueueItem(db, {
      id: `item_delete_person_set_${String(index).padStart(4, "0")}`,
      personId: deletedPerson.id,
      feedIds: index % 2 === 0 ? [feedA.id, feedB.id] : [feedA.id],
    });
  }
  insertRawQueueItem(db, {
    id: "item_survives_person_set_delete",
    personId: survivor.id,
    feedIds: [survivorFeed.id],
  });

  db.deletePerson(deletedPerson.id);

  assert.throws(() => db.getPerson(deletedPerson.id), /Person not found/);
  assert.equal(db.getQueueCounts().all, 1);
  assert.equal(db.getQueueCounts(feedA.id).all, 0);
  assert.equal(db.getQueueCounts(feedB.id).all, 0);
  assert.equal(db.getQueueCounts(survivorFeed.id).all, 1);
  assert.equal(allDbRows(db, "SELECT COUNT(*) AS count FROM item_feeds WHERE item_id LIKE 'item_delete_person_set_%'")[0].count, 0);
  assert.equal(allDbRows(db, "SELECT COUNT(*) AS count FROM items WHERE person_id = ?", [deletedPerson.id])[0].count, 0);
});

test("person deletion uses set-based item cleanup", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const deletePerson = source.slice(source.indexOf("deletePerson(id: string)"), source.indexOf("setPersonFeedMembership("));

  assert.match(deletePerson, /DELETE FROM item_feeds WHERE item_id IN \(SELECT id FROM items WHERE person_id = \?\)/);
  assert.match(deletePerson, /DELETE FROM items WHERE person_id = \?/);
  assert.doesNotMatch(deletePerson, /itemIdsForPerson/);
  assert.doesNotMatch(source, /private itemIdsForPerson/);
});

test("person delete retry reconciles orphaned running refresh targets after the person is already gone", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Retry Deleted Person Running Feed", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Retry Deleted Running Target",
    profileUrl: "https://www.linkedin.com/in/retry-deleted-running-target/",
  });
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  db.deletePerson(person.id);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/people/${encodeURIComponent(person.id)}`, { method: "DELETE" });
    const body = await response.json();

    assert.equal(response.ok, true);
    assert.deepEqual(body, { ok: true, alreadyDeleted: true });
    const reconciled = manager.get(session.id);
    assert.equal(reconciled.status, "done");
    assert.equal(reconciled.totalTargets, 0);
    assert.equal(reconciled.currentTarget, undefined);
    assert.match(reconciled.lastError, /removing 2 pending pages/);
    assert.equal(manager.getActive(), undefined);
  } finally {
    await closeServer(server);
  }
});

test("deleting a person cleans their queue items in chunks without touching other people", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Chunk Delete Person Feed", 15);
  const otherFeed = db.createFeed("Chunk Delete Person Other Feed", 15);
  const deletedPerson = db.upsertPerson({
    name: "Chunk Deleted Person",
    profileUrl: "https://www.linkedin.com/in/chunk-deleted-person/",
  });
  const survivor = db.upsertPerson({
    name: "Chunk Survivor Person",
    profileUrl: "https://www.linkedin.com/in/chunk-survivor-person/",
  });

  for (let index = 0; index < 425; index += 1) {
    insertRawQueueItem(db, {
      id: `item_delete_person_${String(index).padStart(4, "0")}`,
      personId: deletedPerson.id,
      feedIds: [feed.id, otherFeed.id],
    });
  }
  insertRawQueueItem(db, {
    id: "item_delete_person_survivor",
    personId: survivor.id,
    feedIds: [feed.id],
  });

  db.deletePerson(deletedPerson.id);

  assert.equal(db.listPeople().some((person) => person.id === deletedPerson.id), false);
  assert.equal(db.getQueueCounts().all, 1);
  assert.equal(db.getQueueCounts(feed.id).all, 1);
  assert.equal(db.getQueueCounts(otherFeed.id).all, 0);
  assert.equal(allDbRows(db, "SELECT COUNT(*) AS count FROM item_feeds WHERE item_id LIKE 'item_delete_person_%'")[0].count, 1);
});

test("item status api rejects stale feed-scoped queue rows", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feedA = db.createFeed("Stale Status A", 15);
  const feedB = db.createFeed("Stale Status B", 15);
  const person = db.upsertPerson({
    name: "Stale Status Person",
    profileUrl: "https://www.linkedin.com/in/stale-status-person/",
  });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id]);
  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:stale-status-api/",
    text: "Shared item should stay new when a stale feed row is clicked.",
    activityAt: new Date().toISOString(),
  };
  db.captureItems(feedA.id, [item]);
  db.captureItems(feedB.id, [item]);
  const queued = db.listQueue(feedA.id)[0];
  db.setPersonFeedMembership(person.id, [feedB.id]);

  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/items/${encodeURIComponent(queued.id)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done", feedId: feedA.id }),
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.match(body.error, /no longer in this feed/);
    assert.equal(db.listQueue(feedB.id).length, 1);
    assert.equal(db.listQueue(feedB.id)[0].status, "new");
  } finally {
    await closeServer(server);
  }
});

test("item status api rejects malformed scalar payloads before mutating data", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Status Scalar Guard", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Status Scalar Guard Person",
    profileUrl: "https://www.linkedin.com/in/status-scalar-guard-person/",
  });
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:status-scalar-guard/",
      text: "This item should stay new when malformed status writes arrive.",
      activityAt: new Date().toISOString(),
    },
  ]);
  const item = db.listQueue(feed.id)[0];
  const server = await startApiServer(db, new RefreshSessionManager(db), [port]);

  try {
    const badStatus = await fetch(`${server.baseUrl}/api/items/${encodeURIComponent(item.id)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "complete", feedId: feed.id }),
    });
    const badFeedId = await fetch(`${server.baseUrl}/api/items/${encodeURIComponent(item.id)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done", feedId: 123 }),
    });
    const badRequestId = await fetch(`${server.baseUrl}/api/items/${encodeURIComponent(item.id)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done", feedId: feed.id, requestId: { value: "not-a-string" } }),
    });

    assert.equal(badStatus.status, 400);
    assert.match((await badStatus.json()).error, /Queue item status/);
    assert.equal(badFeedId.status, 400);
    assert.match((await badFeedId.json()).error, /Queue feed id/);
    assert.equal(badRequestId.status, 400);
    assert.match((await badRequestId.json()).error, /Queue status request id/);

    assert.equal(db.getPerson(person.id).commentCount, 0);
    assert.equal(db.listQueue(feed.id)[0].status, "new");
    assert.equal(db.getQueueCounts(feed.id).new, 1);
    assert.equal(db.getQueueCounts(feed.id).done, 0);
  } finally {
    await closeServer(server);
  }
});

test("membership api prunes removed people from running refresh sessions", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("API Refresh Prune", 15);
  const alpha = db.upsertPerson({
    name: "API Removed Target",
    profileUrl: "https://www.linkedin.com/in/api-prune-alpha/",
  });
  const beta = db.upsertPerson({
    name: "API Remaining Target",
    profileUrl: "https://www.linkedin.com/in/api-prune-beta/",
  });
  db.setPersonFeedMembership(alpha.id, [feed.id]);
  db.setPersonFeedMembership(beta.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/people/${encodeURIComponent(alpha.id)}/memberships`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedIds: [] }),
    });
    const body = await response.json();
    const active = manager.get(session.id);

    assert.equal(response.ok, true);
    assert.deepEqual(body.feedIds, []);
    assert.equal(active.status, "running");
    assert.equal(active.totalTargets, 2);
    assert.equal(active.completedTargets, 0);
    assert.equal(active.currentTarget.personId, beta.id);
    assert.equal(active.currentTarget.index, 0);
    assert.match(active.lastError, /Removed 2 pending pages/);
  } finally {
    await closeServer(server);
  }
});

test("refresh heartbeat api keeps waiting sessions active without advancing targets", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("API Refresh Heartbeat", 15);
  db.addPersonToFeed(feed.id, {
    name: "API Heartbeat Person",
    profileUrl: "https://www.linkedin.com/in/api-heartbeat-person/",
  });
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/refresh-sessions/${encodeURIComponent(session.id)}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetIndex: 0, message: "Sign in to LinkedIn, then this refresh will continue." }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, "running");
    assert.equal(body.completedTargets, 0);
    assert.equal(body.currentTarget.index, 0);
    assert.match(body.lastError, /Sign in to LinkedIn/);
  } finally {
    await closeServer(server);
  }
});

test("refresh control api rejects malformed progress bodies before mutating sessions", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("API Refresh Body Guard", 15);
  db.addPersonToFeed(feed.id, {
    name: "API Body Guard Person",
    profileUrl: "https://www.linkedin.com/in/api-body-guard-person/",
  });
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const server = await startApiServer(db, manager, [port]);

  try {
    const badHeartbeat = await fetch(`${server.baseUrl}/api/refresh-sessions/${encodeURIComponent(session.id)}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetIndex: "0", message: "Still waiting." }),
    });
    const badCaptureResult = await fetch(
      `${server.baseUrl}/api/refresh-sessions/${encodeURIComponent(session.id)}/complete-target`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetIndex: 0, captureResult: "not a capture result" }),
      },
    );
    const missingCaptureCounts = await fetch(
      `${server.baseUrl}/api/refresh-sessions/${encodeURIComponent(session.id)}/complete-target`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetIndex: 0, captureResult: {} }),
      },
    );
    const fractionalCaptureCounts = await fetch(
      `${server.baseUrl}/api/refresh-sessions/${encodeURIComponent(session.id)}/complete-target`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetIndex: 0,
          captureResult: {
            received: 1,
            inserted: 0.5,
            updated: 0,
            skippedOlder: 0,
            skippedUntracked: 0,
            skippedInvalid: 0,
          },
        }),
      },
    );
    const impossibleCaptureCounts = await fetch(
      `${server.baseUrl}/api/refresh-sessions/${encodeURIComponent(session.id)}/complete-target`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetIndex: 0,
          captureResult: {
            received: 1,
            inserted: 2,
            updated: 0,
            skippedOlder: 0,
            skippedUntracked: 0,
            skippedInvalid: 0,
          },
        }),
      },
    );
    const impossibleAggregateCaptureCounts = await fetch(
      `${server.baseUrl}/api/refresh-sessions/${encodeURIComponent(session.id)}/complete-target`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetIndex: 0,
          captureResult: {
            received: 2,
            inserted: 1,
            updated: 1,
            skippedOlder: 1,
            skippedUntracked: 0,
            skippedInvalid: 0,
          },
        }),
      },
    );
    const unsafeCaptureCounts = await fetch(
      `${server.baseUrl}/api/refresh-sessions/${encodeURIComponent(session.id)}/complete-target`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetIndex: 0,
          captureResult: {
            received: Number.MAX_SAFE_INTEGER + 1,
            inserted: 0,
            updated: 0,
            skippedOlder: 0,
            skippedUntracked: 0,
            skippedInvalid: 0,
          },
        }),
      },
    );
    const badTargetIndex = await fetch(
      `${server.baseUrl}/api/refresh-sessions/${encodeURIComponent(session.id)}/complete-target`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetIndex: 0.5, error: "Temporary LinkedIn page issue." }),
      },
    );
    const unsafeTargetIndex = await fetch(
      `${server.baseUrl}/api/refresh-sessions/${encodeURIComponent(session.id)}/complete-target`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetIndex: Number.MAX_SAFE_INTEGER + 1, error: "Temporary LinkedIn page issue." }),
      },
    );

    assert.equal(badHeartbeat.status, 400);
    assert.match((await badHeartbeat.json()).error, /Refresh target index/);
    assert.equal(badCaptureResult.status, 400);
    assert.match((await badCaptureResult.json()).error, /Refresh capture result/);
    assert.equal(missingCaptureCounts.status, 400);
    assert.match((await missingCaptureCounts.json()).error, /Refresh capture result received/);
    assert.equal(fractionalCaptureCounts.status, 400);
    assert.match((await fractionalCaptureCounts.json()).error, /Refresh capture result inserted/);
    assert.equal(impossibleCaptureCounts.status, 400);
    assert.match((await impossibleCaptureCounts.json()).error, /Refresh capture result inserted cannot exceed received/);
    assert.equal(impossibleAggregateCaptureCounts.status, 400);
    assert.match((await impossibleAggregateCaptureCounts.json()).error, /Refresh capture result counts cannot exceed received/);
    assert.equal(unsafeCaptureCounts.status, 400);
    assert.match((await unsafeCaptureCounts.json()).error, /Refresh capture result received/);
    assert.equal(badTargetIndex.status, 400);
    assert.match((await badTargetIndex.json()).error, /Refresh target index/);
    assert.equal(unsafeTargetIndex.status, 400);
    assert.match((await unsafeTargetIndex.json()).error, /Refresh target index/);

    const active = manager.get(session.id);
    assert.equal(active.status, "running");
    assert.equal(active.completedTargets, 0);
    assert.equal(active.failedTargets, 0);
    assert.equal(active.updatedAt, session.updatedAt);
    assert.equal(active.lastError, "");
    assert.equal(active.currentTarget.index, 0);
  } finally {
    await closeServer(server);
  }
});

test("capture and refresh creation api reject malformed scalar payloads before mutating data", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Capture Scalar Guard", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Capture Scalar Guard Person",
    profileUrl: "https://www.linkedin.com/in/capture-scalar-guard-person/",
  });
  const capturedItem = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:capture-scalar-guard/",
    text: "Malformed capture writes should not create queue items.",
    activityAt: new Date().toISOString(),
  };
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const badCaptureFeed = await fetch(`${server.baseUrl}/api/capture-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedId: 123, items: [capturedItem] }),
    });
    const badCaptureRequestId = await fetch(`${server.baseUrl}/api/capture-items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedId: feed.id, items: [capturedItem], requestId: ["not-a-string"] }),
    });
    const badMultiFeedIds = await fetch(`${server.baseUrl}/api/capture-items/multi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedIds: [feed.id, 123], items: [capturedItem] }),
    });
    const badMultiRequestId = await fetch(`${server.baseUrl}/api/capture-items/multi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedIds: [feed.id], items: [capturedItem], requestId: { id: "not-a-string" } }),
    });
    const badRefreshFeed = await fetch(`${server.baseUrl}/api/refresh-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedId: 123 }),
    });
    const badRefreshRequestId = await fetch(`${server.baseUrl}/api/refresh-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedId: feed.id, requestId: { id: "not-a-string" } }),
    });

    assert.equal(badCaptureFeed.status, 400);
    assert.match((await badCaptureFeed.json()).error, /Capture feed id/);
    assert.equal(badCaptureRequestId.status, 400);
    assert.match((await badCaptureRequestId.json()).error, /Capture request id/);
    assert.equal(badMultiFeedIds.status, 400);
    assert.match((await badMultiFeedIds.json()).error, /Capture feed ids/);
    assert.equal(badMultiRequestId.status, 400);
    assert.match((await badMultiRequestId.json()).error, /Multi-feed capture request id/);
    assert.equal(badRefreshFeed.status, 400);
    assert.match((await badRefreshFeed.json()).error, /Refresh feed id/);
    assert.equal(badRefreshRequestId.status, 400);
    assert.match((await badRefreshRequestId.json()).error, /Refresh request id/);

    assert.equal(db.getQueueCounts(feed.id).all, 0);
    assert.equal(manager.list().length, 0);
  } finally {
    await closeServer(server);
  }
});

test("counter adjustment api applies deltas to the current stored value", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feed = db.createFeed("Counter Adjustment API", 15);
  const person = db.upsertPerson({
    name: "Counter API Person",
    profileUrl: "https://www.linkedin.com/in/counter-api-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:counter-adjust-api/",
      text: "Counter API item",
      activityAt: new Date().toISOString(),
    },
  ]);

  const stalePersonSnapshot = db.getPerson(person.id);
  db.setItemStatus(db.listQueue(feed.id)[0].id, "done");

  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/people/${encodeURIComponent(person.id)}/counters/adjust`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commentCount: 1 }),
    });
    const body = await response.json();

    assert.equal(response.ok, true);
    assert.equal(stalePersonSnapshot.commentCount, 0);
    assert.equal(body.commentCount, 2);
    assert.equal(db.getPerson(person.id).commentCount, 2);
  } finally {
    await closeServer(server);
  }
});

test("multi-feed capture api writes valid feeds with one request", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db } = await createTestDb();
  const feedA = db.createFeed("API Multi Capture A", 15);
  const feedB = db.createFeed("API Multi Capture B", 15);
  const staleFeed = db.createFeed("API Multi Capture Deleted", 15);
  const person = db.upsertPerson({
    name: "API Multi Capture Person",
    profileUrl: "https://www.linkedin.com/in/api-multi-capture-person/",
  });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id]);
  db.deleteFeed(staleFeed.id);
  const manager = new RefreshSessionManager(db);
  const server = await startApiServer(db, manager, [port]);

  try {
    const response = await fetch(`${server.baseUrl}/api/capture-items/multi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        feedIds: [feedA.id, staleFeed.id, feedB.id],
        requestId: "api-multi-capture-request-1",
        items: [
          {
            personName: person.name,
            profileUrl: person.profileUrl,
            type: "post",
            sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:api-multi-capture/",
            text: "API multi-feed capture writes valid feed memberships.",
            activityAt: new Date().toISOString(),
          },
        ],
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { received: 2, inserted: 1, updated: 1, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 });
    assert.equal(db.listQueue(feedA.id).length, 1);
    assert.equal(db.listQueue(feedB.id).length, 1);
  } finally {
    await closeServer(server);
  }
});

test("feed membership is capped at 200 people", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Capacity Test", 15);

  for (let index = 0; index < MAX_PEOPLE_PER_FEED; index += 1) {
    const person = db.upsertPerson({
      name: `Person ${index}`,
      profileUrl: `https://www.linkedin.com/in/capacity-${index}/`,
    });
    db.setPersonFeedMembership(person.id, [feed.id]);
  }

  const overflow = db.upsertPerson({
    name: "Overflow",
    profileUrl: "https://www.linkedin.com/in/capacity-overflow/",
  });

  assert.throws(() => db.setPersonFeedMembership(overflow.id, [feed.id]), /already has 200 people/);
});

test("feed-scoped add preserves existing memberships", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Atomic Add A", 15);
  const feedB = db.createFeed("Atomic Add B", 15);

  const first = db.addPersonToFeed(feedA.id, {
    name: "Atomic Add Person",
    profileUrl: "https://www.linkedin.com/in/atomic-add-person/",
  });
  const second = db.addPersonToFeed(feedB.id, {
    name: "Atomic Add Person Updated",
    profileUrl: "https://www.linkedin.com/in/atomic-add-person/",
  });

  assert.equal(first.id, second.id);
  assert.deepEqual(new Set(second.feedIds), new Set([feedA.id, feedB.id]));
  assert.deepEqual(
    db.listFeeds()
      .filter((feed) => feed.id === feedA.id || feed.id === feedB.id)
      .map((feed) => feed.peopleCount),
    [1, 1],
  );
});

test("sparse existing-person adds preserve useful display names", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Name Preserve A", 15);
  const feedB = db.createFeed("Name Preserve B", 15);
  const feedC = db.createFeed("Name Preserve C", 15);

  const first = db.addPersonToFeed(feedA.id, {
    name: "Useful Person Name",
    profileUrl: "https://www.linkedin.com/in/name-preserve-person/",
  });
  const sparse = db.addPersonToFeed(feedB.id, {
    name: "LinkedIn member",
    profileUrl: "https://www.linkedin.com/in/name-preserve-person/",
  });

  assert.equal(sparse.id, first.id);
  assert.equal(sparse.name, "Useful Person Name");

  const renamed = db.addPersonToFeed(feedC.id, {
    name: "Better Person Name",
    profileUrl: "https://www.linkedin.com/in/name-preserve-person/",
  });

  assert.equal(renamed.name, "Better Person Name");
  assert.deepEqual(new Set(renamed.feedIds), new Set([feedA.id, feedB.id, feedC.id]));
});

test("unchanged person upserts do not rewrite person rows", async () => {
  const { db } = await createTestDb();
  const person = db.upsertPerson({
    name: "Stable Person",
    profileUrl: "https://www.linkedin.com/in/stable-person/",
    headline: "SEO Lead",
  });
  const sentinelUpdatedAt = "2024-01-02T03:04:05.000Z";
  db.db.run("UPDATE people SET updated_at = ? WHERE id = ?", [sentinelUpdatedAt, person.id]);

  const unchanged = db.upsertPerson({
    name: "Stable Person",
    profileUrl: "https://www.linkedin.com/in/stable-person/",
    headline: "SEO Lead",
  });
  const changed = db.upsertPerson({
    name: "Stable Person",
    profileUrl: "https://www.linkedin.com/in/stable-person/",
    headline: "SEO Director",
  });

  assert.equal(unchanged.updatedAt, sentinelUpdatedAt);
  assert.notEqual(changed.updatedAt, sentinelUpdatedAt);
  assert.equal(changed.headline, "SEO Director");
});

test("person upserts with the same request id replay the original result", async () => {
  const { db, dbPath } = await createTestDb();
  const input = {
    name: "Person Upsert Replay",
    profileUrl: "https://www.linkedin.com/in/person-upsert-replay/",
    headline: "Technical SEO",
  };

  const first = db.upsertPerson(input, { requestId: "person-upsert-replay-1" });
  const duplicate = db.upsertPerson(
    {
      ...input,
      name: "Unexpected Retry Name",
      headline: "Unexpected Retry Headline",
    },
    { requestId: "person-upsert-replay-1" },
  );

  assert.deepEqual(duplicate, first);
  assert.equal(db.getPerson(first.id).name, "Person Upsert Replay");
  assert.equal(db.getPerson(first.id).headline, "Technical SEO");

  const reopened = await reopenTestDb(dbPath);
  const afterRestartDuplicate = reopened.upsertPerson(
    {
      ...input,
      name: "Unexpected Restart Retry Name",
    },
    { requestId: "person-upsert-replay-1" },
  );

  assert.deepEqual(afterRestartDuplicate, first);
});

test("person upsert retries replay even after the person is deleted", async () => {
  const { db } = await createTestDb();
  const input = {
    name: "Deleted Person Upsert Replay",
    profileUrl: "https://www.linkedin.com/in/deleted-person-upsert-replay/",
  };

  const first = db.upsertPerson(input, { requestId: "deleted-person-upsert-replay-1" });
  db.deletePerson(first.id);
  const duplicate = db.upsertPerson(input, { requestId: "deleted-person-upsert-replay-1" });

  assert.deepEqual(duplicate, first);
  assert.throws(() => db.getPerson(first.id), /Person not found/);
});

test("retrying an unchanged feed-scoped add preserves existing person rows", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Retry Add Noop", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Retry Add Person",
    profileUrl: "https://www.linkedin.com/in/retry-add-person/",
  });
  const sentinelUpdatedAt = "2024-02-03T04:05:06.000Z";
  db.db.run("UPDATE people SET updated_at = ? WHERE id = ?", [sentinelUpdatedAt, person.id]);

  const retry = db.addPersonToFeed(feed.id, {
    name: "Retry Add Person",
    profileUrl: "https://www.linkedin.com/in/retry-add-person/",
  });

  assert.equal(retry.id, person.id);
  assert.equal(retry.updatedAt, sentinelUpdatedAt);
  assert.deepEqual(retry.feedIds, [feed.id]);
});

test("feed-scoped add retries replay even after the feed is deleted", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Retry Deleted Add", 15);
  const input = {
    name: "Retry Deleted Add Person",
    profileUrl: "https://www.linkedin.com/in/retry-deleted-add-person/",
  };

  const first = db.addPersonToFeed(feed.id, input, { requestId: "lost-add-response-1" });
  db.deleteFeed(feed.id);
  const duplicate = db.addPersonToFeed(feed.id, input, { requestId: "lost-add-response-1" });

  assert.deepEqual(duplicate, first);
});

test("unchanged exact membership saves preserve feed membership rows", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Membership Noop A", 15);
  const feedB = db.createFeed("Membership Noop B", 15);
  const person = db.upsertPerson({
    name: "Membership Noop Person",
    profileUrl: "https://www.linkedin.com/in/membership-noop-person/",
  });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id]);
  const sentinelCreatedAt = "2024-03-04T05:06:07.000Z";
  db.db.run("UPDATE feed_people SET created_at = ? WHERE person_id = ?", [sentinelCreatedAt, person.id]);

  db.setPersonFeedMembership(person.id, [feedB.id, feedA.id]);

  assert.deepEqual(
    allDbRows(db, "SELECT created_at AS createdAt FROM feed_people WHERE person_id = ? ORDER BY feed_id", [
      person.id,
    ]).map((row) => row.createdAt),
    [sentinelCreatedAt, sentinelCreatedAt],
  );
});

test("exact membership retries replay the original result", async () => {
  const { db, dbPath } = await createTestDb();
  const feedA = db.createFeed("Membership Replay A", 15);
  const feedB = db.createFeed("Membership Replay B", 15);
  const person = db.upsertPerson({
    name: "Membership Replay Person",
    profileUrl: "https://www.linkedin.com/in/membership-replay-person/",
  });

  const first = db.setPersonFeedMembership(person.id, [feedA.id], { requestId: "membership-replay-1" });
  const duplicate = db.setPersonFeedMembership(person.id, [feedB.id], { requestId: "membership-replay-1" });

  assert.deepEqual(duplicate, first);
  assert.deepEqual(db.getPerson(person.id).feedIds, [feedA.id]);

  const reopened = await reopenTestDb(dbPath);
  const afterRestartDuplicate = reopened.setPersonFeedMembership(
    person.id,
    [feedB.id],
    { requestId: "membership-replay-1" },
  );

  assert.deepEqual(afterRestartDuplicate, first);
});

test("exact membership retries replay last-feed removals", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Membership Removal Replay", 15);
  const person = db.upsertPerson({
    name: "Membership Removal Replay Person",
    profileUrl: "https://www.linkedin.com/in/membership-removal-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const first = db.setPersonFeedMembership(person.id, [], { requestId: "membership-removal-replay-1" });
  const duplicate = db.setPersonFeedMembership(person.id, [feed.id], { requestId: "membership-removal-replay-1" });

  assert.deepEqual(first.feedIds, []);
  assert.deepEqual(duplicate, first);
  assert.deepEqual(db.getPerson(person.id).feedIds, []);

  const reopened = await reopenTestDb(dbPath);
  const afterRestartDuplicate = reopened.setPersonFeedMembership(
    person.id,
    [feed.id],
    { requestId: "membership-removal-replay-1" },
  );

  assert.deepEqual(afterRestartDuplicate, first);
  assert.deepEqual(reopened.getPerson(person.id).feedIds, []);
});

test("exact membership retries replay even after the person is deleted", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Deleted Membership Replay", 15);
  const person = db.upsertPerson({
    name: "Deleted Membership Replay Person",
    profileUrl: "https://www.linkedin.com/in/deleted-membership-replay-person/",
  });

  const first = db.setPersonFeedMembership(person.id, [feed.id], { requestId: "membership-deleted-replay-1" });
  db.deletePerson(person.id);
  const duplicate = db.setPersonFeedMembership(person.id, [], { requestId: "membership-deleted-replay-1" });

  assert.deepEqual(duplicate, first);
});

test("profile membership retries replay the original result", async () => {
  const { db, dbPath } = await createTestDb();
  const feedA = db.createFeed("Profile Membership Replay A", 15);
  const feedB = db.createFeed("Profile Membership Replay B", 15);
  const input = {
    name: "Profile Membership Replay Person",
    profileUrl: "https://www.linkedin.com/in/profile-membership-replay-person/",
    feedIds: [feedA.id],
  };

  const first = db.upsertPersonWithMembership(input, { requestId: "profile-membership-replay-1" });
  const duplicate = db.upsertPersonWithMembership(
    { ...input, name: "Unexpected Profile Membership Retry", feedIds: [feedB.id] },
    { requestId: "profile-membership-replay-1" },
  );

  assert.deepEqual(duplicate, first);
  assert.deepEqual(db.getPerson(first.person.id).feedIds, [feedA.id]);

  const reopened = await reopenTestDb(dbPath);
  const afterRestartDuplicate = reopened.upsertPersonWithMembership(
    { ...input, name: "Unexpected Restart Profile Membership Retry", feedIds: [feedB.id] },
    { requestId: "profile-membership-replay-1" },
  );

  assert.deepEqual(afterRestartDuplicate, first);
});

test("profile membership retries replay even after the person is deleted", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Deleted Profile Membership Replay", 15);
  const input = {
    name: "Deleted Profile Membership Replay Person",
    profileUrl: "https://www.linkedin.com/in/deleted-profile-membership-replay-person/",
    feedIds: [feed.id],
  };

  const first = db.upsertPersonWithMembership(input, { requestId: "profile-membership-deleted-replay-1" });
  db.deletePerson(first.person.id);
  const duplicate = db.upsertPersonWithMembership(
    { ...input, feedIds: [] },
    { requestId: "profile-membership-deleted-replay-1" },
  );

  assert.deepEqual(duplicate, first);
});

test("feed-scoped add does not create orphan people when feed is full", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Atomic Full Feed", 15);

  for (let index = 0; index < MAX_PEOPLE_PER_FEED; index += 1) {
    db.addPersonToFeed(feed.id, {
      name: `Atomic Full ${index}`,
      profileUrl: `https://www.linkedin.com/in/atomic-full-${index}/`,
    });
  }

  const profileUrl = "https://www.linkedin.com/in/atomic-full-overflow/";
  assert.throws(
    () =>
      db.addPersonToFeed(feed.id, {
        name: "Atomic Full Overflow",
        profileUrl,
      }),
    /already has 200 people/,
  );
  assert.equal(db.getProfileStatus(profileUrl).person, undefined);
});

test("person profile urls must resolve to real LinkedIn hosts", async () => {
  const { db } = await createTestDb();

  assert.throws(
    () =>
      db.upsertPerson({
        name: "Deceptive Host",
        profileUrl: "https://notlinkedin.com/in/deceptive-host/",
      }),
    /valid LinkedIn profile URL/,
  );
  assert.throws(
    () =>
      db.upsertPerson({
        name: "Embedded LinkedIn Path",
        profileUrl: "https://example.com/linkedin.com/in/embedded-path/",
      }),
    /valid LinkedIn profile URL/,
  );
  assert.throws(
    () =>
      db.upsertPerson({
        name: "Encoded Separator",
        profileUrl: "https://www.linkedin.com/in/encoded%2Fseparator/",
      }),
    /valid LinkedIn profile URL/,
  );
  assert.throws(
    () =>
      db.upsertPerson({
        name: "Whitespace Public Id",
        profileUrl: "https://www.linkedin.com/in/white%20space/",
      }),
    /valid LinkedIn profile URL/,
  );

  const person = db.upsertPerson({
    name: "Canonical Person",
    profileUrl: "/in/canonical-person/?trk=profile-badge",
  });

  assert.equal(person.profileUrl, "https://www.linkedin.com/in/canonical-person/");

  const wrapped = db.upsertPerson({
    name: "Wrapped Paste Person",
    profileUrl: "(https://www.linkedin.com/in/wrapped-paste-person/).",
  });
  const trailingDot = db.upsertPerson({
    name: "Trailing Dot Person",
    profileUrl: "https://www.linkedin.com/in/trailing-dot-person.",
  });

  assert.equal(wrapped.profileUrl, "https://www.linkedin.com/in/wrapped-paste-person/");
  assert.equal(trailingDot.profileUrl, "https://www.linkedin.com/in/trailing-dot-person/");
});

test("profile status matches public ids case-insensitively", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Profile Status Case", 15);
  const person = db.upsertPerson({
    name: "Case Sensitive Person",
    profileUrl: "https://www.linkedin.com/in/MixedCase-SEO/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const status = db.getProfileStatus("https://www.linkedin.com/in/mixedcase-seo/?miniProfileUrn=ignored");

  assert.equal(status.person.id, person.id);
  assert.deepEqual(status.feedIds, [feed.id]);
});

test("single profile status reuses fetched membership metadata", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Profile Status Reuse", 15);
  const person = db.upsertPerson({
    name: "Profile Status Reuse Person",
    profileUrl: "https://www.linkedin.com/in/profile-status-reuse-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  db.feedIdsForPerson = () => {
    throw new Error("getProfileStatus should not re-query feed memberships.");
  };

  const status = db.getProfileStatus("https://www.linkedin.com/in/profile-status-reuse-person/");

  assert.equal(status.person.id, person.id);
  assert.deepEqual(status.feedIds, [feed.id]);
});

test("batched profile statuses normalize urls and match public ids case-insensitively", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Batch Status A", 15);
  const feedB = db.createFeed("Batch Status B", 15);
  const alpha = db.upsertPerson({
    name: "Batch Alpha",
    profileUrl: "https://www.linkedin.com/in/Batch-Alpha/",
  });
  const beta = db.upsertPerson({
    name: "Batch Beta",
    profileUrl: "https://www.linkedin.com/in/batch-beta/",
  });
  db.setPersonFeedMembership(alpha.id, [feedA.id]);
  db.setPersonFeedMembership(beta.id, [feedA.id, feedB.id]);

  const statuses = db.getProfileStatuses([
    "https://www.linkedin.com/in/batch-alpha/?miniProfileUrn=ignored",
    "https://www.linkedin.com/in/batch-beta/",
    "https://example.com/in/not-linkedin/",
    "not a url",
    "https://www.linkedin.com/in/batch-beta/",
  ]);

  assert.deepEqual(Object.keys(statuses).sort(), [
    "https://www.linkedin.com/in/batch-alpha/",
    "https://www.linkedin.com/in/batch-beta/",
  ]);
  assert.equal(statuses["https://www.linkedin.com/in/batch-alpha/"].person.id, alpha.id);
  assert.deepEqual(statuses["https://www.linkedin.com/in/batch-alpha/"].feedIds, [feedA.id]);
  assert.equal(statuses["https://www.linkedin.com/in/batch-beta/"].person.id, beta.id);
  assert.deepEqual(new Set(statuses["https://www.linkedin.com/in/batch-beta/"].feedIds), new Set([feedA.id, feedB.id]));
});

test("batched profile statuses only use public-id fallback for profile-url misses", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Batch Status Fallback", 15);
  const exact = db.upsertPerson({
    name: "Exact Batch Status",
    profileUrl: "https://www.linkedin.com/in/exact-batch-status/",
  });
  const mixedCase = db.upsertPerson({
    name: "Mixed Batch Status",
    profileUrl: "https://www.linkedin.com/in/Mixed-Batch-Status/",
  });
  db.setPersonFeedMembership(exact.id, [feed.id]);
  db.setPersonFeedMembership(mixedCase.id, [feed.id]);

  const originalPublicIdLookup = db.peopleByPublicIds.bind(db);
  const fallbackRequests = [];
  db.peopleByPublicIds = (publicIds) => {
    fallbackRequests.push([...publicIds]);
    return originalPublicIdLookup(publicIds);
  };

  const exactStatuses = db.getProfileStatuses(["https://www.linkedin.com/in/exact-batch-status/"]);
  const fallbackStatuses = db.getProfileStatuses(["https://www.linkedin.com/in/mixed-batch-status/"]);

  assert.equal(exactStatuses["https://www.linkedin.com/in/exact-batch-status/"].person.id, exact.id);
  assert.equal(fallbackStatuses["https://www.linkedin.com/in/mixed-batch-status/"].person.id, mixedCase.id);
  assert.deepEqual(fallbackRequests, [["mixed-batch-status"]]);
});

test("person membership feed ids are returned in stable feed-name order", async () => {
  const { db } = await createTestDb();
  const zuluFeed = db.createFeed("Zulu Membership", 15);
  const alphaFeed = db.createFeed("Alpha Membership", 15);
  const person = db.upsertPerson({
    name: "Stable Membership Person",
    profileUrl: "https://www.linkedin.com/in/stable-membership-person/",
  });
  db.setPersonFeedMembership(person.id, [zuluFeed.id, alphaFeed.id]);

  const expectedFeedIds = [alphaFeed.id, zuluFeed.id];
  const profileUrl = "https://www.linkedin.com/in/stable-membership-person/";

  assert.deepEqual(db.getPerson(person.id).feedIds, expectedFeedIds);
  assert.deepEqual(db.listPeople().find((entry) => entry.id === person.id)?.feedIds, expectedFeedIds);
  assert.deepEqual(db.listPeople("", zuluFeed.id).find((entry) => entry.id === person.id)?.feedIds, expectedFeedIds);
  assert.deepEqual(db.getProfileStatus(profileUrl).feedIds, expectedFeedIds);
  assert.deepEqual(db.getProfileStatuses([profileUrl])[profileUrl].feedIds, expectedFeedIds);
});

test("batched profile statuses reject oversized request lists", async () => {
  const { db } = await createTestDb();
  const profileUrls = Array.from(
    { length: MAX_PROFILE_STATUS_BATCH_SIZE + 1 },
    (_unused, index) => `https://www.linkedin.com/in/oversized-status-${index}/`,
  );

  assert.throws(
    () => db.getProfileStatuses(profileUrls),
    new RegExp(`limited to ${MAX_PROFILE_STATUS_BATCH_SIZE} urls`),
  );
});

test("batched profile statuses cap canonical unique profile urls", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Duplicate Batch Status", 15);
  const person = db.upsertPerson({
    name: "Duplicate Batch Person",
    profileUrl: "https://www.linkedin.com/in/duplicate-batch-status/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  const profileUrls = Array.from(
    { length: MAX_PROFILE_STATUS_BATCH_SIZE + 1 },
    (_unused, index) =>
      `https://www.linkedin.com/in/duplicate-batch-status/?trackingId=ignored-${index}&miniProfileUrn=also-ignored`,
  );

  const statuses = db.getProfileStatuses(profileUrls);

  assert.deepEqual(Object.keys(statuses), ["https://www.linkedin.com/in/duplicate-batch-status/"]);
  assert.equal(statuses["https://www.linkedin.com/in/duplicate-batch-status/"].person.id, person.id);
  assert.deepEqual(statuses["https://www.linkedin.com/in/duplicate-batch-status/"].feedIds, [feed.id]);
});

test("bulk import rejects deceptive non-linkedin profile hosts", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Bulk Host Guard", 15);

  const result = db.bulkAddPeopleToFeed(feed.id, [
    { name: "Bad Host", profileUrl: "https://notlinkedin.com/in/bad-host/" },
    { name: "Encoded Separator", profileUrl: "https://www.linkedin.com/in/bulk%2Fbad/" },
    { name: "Good Host", profileUrl: "linkedin.com/in/good-host/" },
  ]);

  assert.equal(result.added, 1);
  assert.equal(result.skippedInvalid, 2);
  assert.match(result.errors[0].error, /Valid LinkedIn profile URL/);
  assert.match(result.errors[1].error, /Valid LinkedIn profile URL/);
  assert.deepEqual(
    db.listPeople("", feed.id).map((person) => person.profileUrl),
    ["https://www.linkedin.com/in/good-host/"],
  );
});

test("bulk import rejects malformed people payloads before feed lookup", async () => {
  const { db } = await createTestDb();

  assert.throws(
    () => db.bulkAddPeopleToFeed("feed_missing", { profileUrl: "https://www.linkedin.com/in/not-an-array/" }),
    /People must be an array/,
  );
});

test("bulk import rejects oversized direct requests before mutating data", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Oversized Direct Bulk", 15);
  const people = Array.from({ length: MAX_BULK_PEOPLE_PER_REQUEST + 1 }, (_, index) => ({
    name: `Oversized Direct ${index}`,
    profileUrl: `https://www.linkedin.com/in/oversized-direct-${index}/`,
  }));

  assert.throws(
    () => db.bulkAddPeopleToFeed(feed.id, people),
    (error) => {
      assert.equal(error instanceof AppError, true);
      assert.match(error.message, new RegExp(`limited to ${MAX_BULK_PEOPLE_PER_REQUEST} profiles`));
      return true;
    },
  );
  assert.equal(db.listPeople("", feed.id).length, 0);
});

test("bulk import accepts pasted profile urls with wrapping punctuation", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Bulk Pasted URLs", 15);

  const result = db.bulkAddPeopleToFeed(feed.id, [
    { name: "Wrapped URL", profileUrl: "<linkedin.com/in/wrapped-bulk-person/>" },
    { name: "Sentence URL", profileUrl: "https://www.linkedin.com/in/sentence-bulk-person)." },
  ]);

  assert.equal(result.added, 2);
  assert.equal(result.skippedInvalid, 0);
  assert.deepEqual(
    db.listPeople("", feed.id).map((person) => person.profileUrl),
    [
      "https://www.linkedin.com/in/sentence-bulk-person/",
      "https://www.linkedin.com/in/wrapped-bulk-person/",
    ],
  );
});

test("capture accepts only tracked feed members", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Tracked Only", 15);
  const tracked = db.upsertPerson({ name: "Tracked Person", profileUrl: "https://www.linkedin.com/in/tracked-person/" });
  db.setPersonFeedMembership(tracked.id, [feed.id]);

  const result = db.captureItems(feed.id, [
    {
      personName: "Tracked Person",
      profileUrl: tracked.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
      text: "Tracked item",
      activityAt: new Date().toISOString(),
    },
    {
      personName: "Random Commenter",
      profileUrl: "https://www.linkedin.com/in/random-commenter/",
      type: "comment",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:2/",
      text: "Untracked item",
      activityAt: new Date().toISOString(),
    },
  ]);

  assert.equal(result.inserted, 1);
  assert.equal(result.skippedUntracked, 1);
  assert.equal(db.listQueue(feed.id).length, 1);
});

test("capture malformed item payloads fail before feed access", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Malformed Capture Payload Feed", 15);

  assert.throws(() => db.captureItems(feed.id, undefined), /Captured items must be an array/);
  assert.throws(() => db.captureItems("missing-feed", undefined), /Captured items must be an array/);
  assert.throws(() => db.captureItemsForFeeds([feed.id], undefined), /Captured items must be an array/);
  assert.throws(() => db.captureItemsForFeeds(["missing-feed"], undefined), /Captured items must be an array/);
});

test("capture matches tracked feed members by public id when profile URL casing changes", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Case Insensitive Capture", 15);
  const tracked = db.upsertPerson({
    name: "Case Capture Person",
    profileUrl: "https://www.linkedin.com/in/case-capture-person/",
  });
  db.setPersonFeedMembership(tracked.id, [feed.id]);

  const result = db.captureItems(feed.id, [
    {
      personName: "Case Capture Person",
      profileUrl: "https://www.linkedin.com/in/Case-Capture-Person/?miniProfileUrn=ignored",
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:case-capture-person/",
      text: "Captured item should still match the tracked member when LinkedIn changes profile slug casing.",
      activityAt: new Date().toISOString(),
    },
  ]);

  const queued = db.listQueue(feed.id);

  assert.equal(result.inserted, 1);
  assert.equal(result.skippedUntracked, 0);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].personId, tracked.id);
});

test("capture without a usable display name preserves the existing person name", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Capture Name Guard", 15);
  const person = db.upsertPerson({
    name: "Curated Person Name",
    profileUrl: "https://www.linkedin.com/in/capture-name-guard/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const result = db.captureItems(feed.id, [
    {
      personName: "   ",
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:capture-name-guard/",
      text: "A valid captured item with no useful display name should not downgrade the person.",
      activityAt: new Date().toISOString(),
    },
  ]);

  assert.equal(result.inserted, 1);
  assert.equal(db.getPerson(person.id).name, "Curated Person Name");
});

test("capture preserves useful names while allowing generic names to improve", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Capture Snapshot Name Quality", 15);
  const curated = db.upsertPerson({
    name: "Curated Strategist",
    profileUrl: "https://www.linkedin.com/in/curated-strategist/",
  });
  const generic = db.upsertPerson({
    name: "LinkedIn member",
    profileUrl: "https://www.linkedin.com/in/generic-snapshot-person/",
  });
  db.setPersonFeedMembership(curated.id, [feed.id]);
  db.setPersonFeedMembership(generic.id, [feed.id]);

  const result = db.captureItems(feed.id, [
    {
      personName: "LinkedIn member",
      profileUrl: curated.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:curated-name-downgrade/",
      text: "A generic captured display name should not replace a curated saved name.",
      activityAt: new Date().toISOString(),
    },
    {
      personName: "Actual Snapshot Person",
      profileUrl: generic.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:generic-name-upgrade/",
      text: "A useful captured display name should improve a generic saved name.",
      activityAt: new Date().toISOString(),
    },
  ]);

  assert.equal(result.inserted, 2);
  assert.equal(db.getPerson(curated.id).name, "Curated Strategist");
  assert.equal(db.getPerson(generic.id).name, "Actual Snapshot Person");
});

test("capture skips malformed entries without aborting valid items", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Malformed Capture Entries", 15);
  const person = db.upsertPerson({ name: "Malformed Person", profileUrl: "https://www.linkedin.com/in/malformed-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const result = db.captureItems(feed.id, [
    null,
    [],
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:malformed-batch-valid/",
      text: "Valid item should survive malformed neighbors.",
      activityAt: new Date().toISOString(),
    },
  ]);

  assert.equal(result.received, 3);
  assert.equal(result.inserted, 1);
  assert.equal(result.skippedInvalid, 2);
  assert.equal(db.listQueue(feed.id).length, 1);
  assert.equal(db.listQueue(feed.id)[0].text, "Valid item should survive malformed neighbors.");
});

test("capture rejects non-linkedin source urls", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Source URL Guard", 15);
  const person = db.upsertPerson({ name: "Source Person", profileUrl: "https://www.linkedin.com/in/source-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const result = db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://example.com/not-the-linkedin-conversation",
      text: "External source should not become an engagement queue link.",
      activityAt: new Date().toISOString(),
    },
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "/feed/update/urn:li:activity:relative-source/",
      text: "Relative LinkedIn source is still valid.",
      activityAt: new Date().toISOString(),
    },
  ]);

  const queued = db.listQueue(feed.id);

  assert.equal(result.inserted, 1);
  assert.equal(result.skippedInvalid, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].sourceUrl, "https://www.linkedin.com/feed/update/urn:li:activity:relative-source/");
});

test("capture rejects malformed source urls", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Malformed Source URL Guard", 15);
  const person = db.upsertPerson({ name: "Malformed Source Person", profileUrl: "https://www.linkedin.com/in/malformed-source-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const result = db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "http://[bad-url",
      text: "Malformed source should not become an engagement queue link.",
      activityAt: new Date().toISOString(),
    },
  ]);

  assert.equal(result.inserted, 0);
  assert.equal(result.skippedInvalid, 1);
  assert.equal(db.listQueue(feed.id).length, 0);
});

test("capture rejects generic linkedin pages as engagement sources", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Generic LinkedIn Source Guard", 15);
  const person = db.upsertPerson({ name: "Generic Source Person", profileUrl: "https://www.linkedin.com/in/generic-source-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const activityAt = new Date().toISOString();
  const result = db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/",
      text: "The feed homepage should not become a queue item source.",
      activityAt,
    },
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/in/generic-source-person/",
      text: "A plain profile page should not become a queue item source.",
      activityAt,
    },
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/company/example/",
      text: "A company page should not become a queue item source.",
      activityAt,
    },
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/in/generic-source-person/recent-activity/all/",
      text: "The profile activity page remains a valid refresh fallback source.",
      activityAt,
    },
  ]);

  const queued = db.listQueue(feed.id);

  assert.equal(result.inserted, 1);
  assert.equal(result.skippedInvalid, 3);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].sourceUrl, "https://www.linkedin.com/in/generic-source-person/recent-activity/all/");
});

test("lookback filters older captured items", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Lookback", 3);
  const person = db.upsertPerson({ name: "Recent Person", profileUrl: "https://www.linkedin.com/in/recent-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const result = db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:3/",
      text: "Recent item",
      activityAt: recentDate,
    },
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:4/",
      text: "Old item",
      activityAt: oldDate,
    },
  ]);

  assert.equal(result.inserted, 1);
  assert.equal(result.skippedOlder, 1);
  assert.equal(db.listQueue(feed.id)[0].text, "Recent item");
});

test("capture clamps future activity dates to the discovery time", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Future Date Guard", 15);
  const person = db.upsertPerson({ name: "Future Person", profileUrl: "https://www.linkedin.com/in/future-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const futureDate = new Date(Date.now() + 120 * 24 * 60 * 60 * 1000).toISOString();
  const result = db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:future-date/",
      text: "Future-dated item",
      activityAt: futureDate,
    },
  ]);

  const item = db.listQueue(feed.id)[0];
  assert.equal(result.inserted, 1);
  assert.equal(item.activityAt, item.discoveredAt);
  assert.ok(new Date(item.activityAt).getTime() < new Date(futureDate).getTime());
});

test("capture bounds oversized batches before writing queue items", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Capture Batch Limit", 15);
  const person = db.upsertPerson({ name: "Batch Person", profileUrl: "https://www.linkedin.com/in/batch-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const items = Array.from({ length: MAX_CAPTURE_ITEMS_PER_REQUEST + 7 }, (_unused, index) => ({
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: `https://www.linkedin.com/feed/update/urn:li:activity:batch-${index}/`,
    text: `Batch item ${index}`,
    activityAt: new Date().toISOString(),
  }));

  const result = db.captureItems(feed.id, items);

  assert.equal(result.received, MAX_CAPTURE_ITEMS_PER_REQUEST + 7);
  assert.equal(result.inserted, MAX_CAPTURE_ITEMS_PER_REQUEST);
  assert.equal(result.skippedInvalid, 7);
  assert.equal(db.listQueue(feed.id, "new", { limit: MAX_CAPTURE_ITEMS_PER_REQUEST + 20 }).length, MAX_CAPTURE_ITEMS_PER_REQUEST);
});

test("dedupe connects the same item to multiple feeds and global done hides it everywhere", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Feed A", 15);
  const feedB = db.createFeed("Feed B", 15);
  const person = db.upsertPerson({ name: "Shared Person", profileUrl: "https://www.linkedin.com/in/shared-person/" });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id]);

  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:5/",
    text: "Shared item",
    activityAt: new Date().toISOString(),
  };

  assert.equal(db.captureItems(feedA.id, [item]).inserted, 1);
  assert.equal(db.captureItems(feedB.id, [item]).updated, 1);
  assert.equal(db.listQueue(feedA.id).length, 1);
  assert.equal(db.listQueue(feedB.id).length, 1);

  const queued = db.listQueue(feedA.id)[0];
  db.setItemStatus(queued.id, "done");

  assert.equal(db.listQueue(feedA.id).length, 0);
  assert.equal(db.listQueue(feedB.id).length, 0);
  assert.equal(db.getPerson(person.id).commentCount, 1);
});

test("unchanged duplicate captures do not count as updates", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("No-op Duplicate", 15);
  const person = db.upsertPerson({ name: "No-op Person", profileUrl: "https://www.linkedin.com/in/no-op-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:no-op-duplicate/",
    text: "No-op duplicate capture text.",
    activityAt: new Date().toISOString(),
  };

  assert.equal(db.captureItems(feed.id, [item]).inserted, 1);
  const duplicate = db.captureItems(feed.id, [item]);

  assert.equal(duplicate.inserted, 0);
  assert.equal(duplicate.updated, 0);
  assert.equal(db.listQueue(feed.id).length, 1);
});

test("capture item retries with the same request id replay the original result", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Capture Retry Result", 15);
  const person = db.upsertPerson({
    name: "Capture Retry Person",
    profileUrl: "https://www.linkedin.com/in/capture-retry-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:capture-retry-result/",
    text: "Capture retry should return the original inserted count after a lost response.",
    activityAt: new Date().toISOString(),
  };

  const first = db.captureItems(feed.id, [item], { requestId: "lost-capture-response-1" });
  const duplicate = db.captureItems(feed.id, [item], { requestId: "lost-capture-response-1" });
  const normalDuplicate = db.captureItems(feed.id, [item]);

  assert.deepEqual(first, { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 });
  assert.deepEqual(duplicate, first);
  assert.equal(normalDuplicate.inserted, 0);
  assert.equal(normalDuplicate.updated, 0);
  assert.equal(db.listQueue(feed.id).length, 1);

  const reopened = await reopenTestDb(dbPath);
  const afterRestartDuplicate = reopened.captureItems(feed.id, [item], { requestId: "lost-capture-response-1" });

  assert.deepEqual(afterRestartDuplicate, first);
  assert.equal(reopened.listQueue(feed.id).length, 1);
});

test("multi-feed capture aggregates valid feeds with one retry-safe request", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Multi Capture A", 15);
  const feedB = db.createFeed("Multi Capture B", 15);
  const staleFeed = db.createFeed("Multi Capture Deleted", 15);
  const person = db.upsertPerson({
    name: "Multi Capture Person",
    profileUrl: "https://www.linkedin.com/in/multi-capture-person/",
  });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id]);
  db.deleteFeed(staleFeed.id);
  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:multi-capture-result/",
    text: "Multi-feed capture should write each valid feed with one request.",
    activityAt: new Date().toISOString(),
  };

  const first = db.captureItemsForFeeds([feedA.id, staleFeed.id, feedB.id, feedA.id], [item], {
    requestId: "lost-multi-capture-response-1",
  });
  const duplicate = db.captureItemsForFeeds([feedA.id, staleFeed.id, feedB.id, feedA.id], [item], {
    requestId: "lost-multi-capture-response-1",
  });

  assert.deepEqual(first, { received: 2, inserted: 1, updated: 1, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 });
  assert.deepEqual(duplicate, first);
  assert.equal(db.listQueue(feedA.id).length, 1);
  assert.equal(db.listQueue(feedB.id).length, 1);
});

test("multi-feed capture filters stale feed ids before per-feed writes", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Filtered Multi Capture A", 15);
  const feedB = db.createFeed("Filtered Multi Capture B", 15);
  const staleFeed = db.createFeed("Filtered Multi Capture Deleted", 15);
  const person = db.upsertPerson({
    name: "Filtered Multi Capture Person",
    profileUrl: "https://www.linkedin.com/in/filtered-multi-capture-person/",
  });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id]);
  db.deleteFeed(staleFeed.id);
  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:filtered-multi-capture/",
    text: "Deleted feed ids should be filtered before the capture loop.",
    activityAt: new Date().toISOString(),
  };
  const originalCaptureItems = db.captureItems.bind(db);
  const capturedFeedIds = [];
  db.captureItems = (feedId, items, options) => {
    capturedFeedIds.push(feedId);
    return originalCaptureItems(feedId, items, options);
  };

  const result = db.captureItemsForFeeds([feedA.id, staleFeed.id, feedB.id, feedA.id], [item], {
    requestId: "filtered-multi-capture-1",
  });

  assert.deepEqual(capturedFeedIds, [feedA.id, feedB.id]);
  assert.deepEqual(result, { received: 2, inserted: 1, updated: 1, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 });
  assert.equal(db.listQueue(feedA.id).length, 1);
  assert.equal(db.listQueue(feedB.id).length, 1);
});

test("multi-feed capture rejects oversized unique feed batches before mutating data", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Oversized Multi Capture Guard", 15);
  const person = db.upsertPerson({
    name: "Oversized Multi Capture Person",
    profileUrl: "https://www.linkedin.com/in/oversized-multi-capture-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  const feedIds = [
    feed.id,
    ...Array.from({ length: MAX_CAPTURE_FEEDS_PER_REQUEST }, (_unused, index) => `stale-feed-${index}`),
  ];

  assert.throws(
    () =>
      db.captureItemsForFeeds(
        feedIds,
        [
          {
            personName: person.name,
            profileUrl: person.profileUrl,
            type: "post",
            sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:oversized-multi-capture-guard/",
            text: "Oversized multi-feed capture fan-out should be rejected before writes.",
            activityAt: new Date().toISOString(),
          },
        ],
        { requestId: "oversized-multi-capture-guard-1" },
      ),
    new RegExp(`limited to ${MAX_CAPTURE_FEEDS_PER_REQUEST} feeds`),
  );
  assert.equal(db.listQueue(feed.id).length, 0);
});

test("multi-feed capture dedupes repeated feed ids before applying the fan-out cap", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Duplicate Multi Capture Feed", 15);
  const person = db.upsertPerson({
    name: "Duplicate Multi Capture Person",
    profileUrl: "https://www.linkedin.com/in/duplicate-multi-capture-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:duplicate-multi-capture/",
    text: "Duplicate feed ids should not trip the multi-feed fan-out guard.",
    activityAt: new Date().toISOString(),
  };

  const result = db.captureItemsForFeeds(Array.from({ length: MAX_CAPTURE_FEEDS_PER_REQUEST + 20 }, () => feed.id), [item], {
    requestId: "duplicate-multi-capture-1",
  });

  assert.deepEqual(result, { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 });
  assert.equal(db.listQueue(feed.id).length, 1);
});

test("multi-feed capture retries replay the original aggregate for changed feed lists", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Stable Multi Capture A", 15);
  const feedB = db.createFeed("Stable Multi Capture B", 15);
  const feedC = db.createFeed("Stable Multi Capture C", 15);
  const person = db.upsertPerson({
    name: "Stable Multi Capture Person",
    profileUrl: "https://www.linkedin.com/in/stable-multi-capture-person/",
  });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id, feedC.id]);
  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:stable-multi-capture-result/",
    text: "Multi-feed capture retry should not expand to feeds added after the original bundled write.",
    activityAt: new Date().toISOString(),
  };

  const first = db.captureItemsForFeeds([feedA.id, feedB.id], [item], {
    requestId: "stable-multi-capture-response-1",
  });
  const changedRetry = db.captureItemsForFeeds([feedA.id, feedB.id, feedC.id], [item], {
    requestId: "stable-multi-capture-response-1",
  });

  assert.deepEqual(first, { received: 2, inserted: 1, updated: 1, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 });
  assert.deepEqual(changedRetry, first);
  assert.equal(db.listQueue(feedA.id).length, 1);
  assert.equal(db.listQueue(feedB.id).length, 1);
  assert.equal(db.listQueue(feedC.id).length, 0);
});

test("multi-feed capture stores one bundled replay state instead of per-feed replay rows", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Lean Multi Capture A", 15);
  const feedB = db.createFeed("Lean Multi Capture B", 15);
  const person = db.upsertPerson({
    name: "Lean Multi Capture Person",
    profileUrl: "https://www.linkedin.com/in/lean-multi-capture-person/",
  });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id]);
  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:lean-multi-capture/",
    text: "Bundled multi-feed capture should not leave redundant per-feed replay state.",
    activityAt: new Date().toISOString(),
  };

  const result = db.captureItemsForFeeds([feedA.id, feedB.id], [item], {
    requestId: "lean-multi-capture-response-1",
  });
  const rows =
    db.db.exec(`
      SELECT
        SUM(CASE WHEN key LIKE 'captureItemsMulti.%' THEN 1 ELSE 0 END) AS multiCount,
        SUM(CASE WHEN key LIKE 'captureItems.%' THEN 1 ELSE 0 END) AS singleCount
      FROM app_state
    `)[0]?.values?.[0] ?? [];

  assert.deepEqual(result, { received: 2, inserted: 1, updated: 1, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 });
  assert.deepEqual(rows, [1, 0]);
});

test("multi-feed capture rolls back successful feeds on unexpected failures", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Rollback Multi Capture A", 15);
  const feedB = db.createFeed("Rollback Multi Capture B", 15);
  const person = db.upsertPerson({
    name: "Rollback Multi Capture Person",
    profileUrl: "https://www.linkedin.com/in/rollback-multi-capture-person/",
  });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id]);
  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:rollback-multi-capture/",
    text: "Unexpected bundled capture failures should not leave partial writes behind.",
    activityAt: new Date().toISOString(),
  };
  const originalCaptureItems = db.captureItems.bind(db);
  let calls = 0;
  db.captureItems = (feedId, items, options) => {
    calls += 1;
    if (calls === 2) {
      throw new AppError("Simulated capture failure.", 500);
    }
    return originalCaptureItems(feedId, items, options);
  };

  assert.throws(
    () => db.captureItemsForFeeds([feedA.id, feedB.id], [item], { requestId: "rollback-multi-capture-1" }),
    /Simulated capture failure/,
  );
  assert.equal(db.listQueue(feedA.id).length, 0);
  assert.equal(db.listQueue(feedB.id).length, 0);
});

test("same-batch duplicate captures write the best item once", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Same Batch Duplicate", 15);
  const person = db.upsertPerson({ name: "LinkedIn member", profileUrl: "https://www.linkedin.com/in/same-batch-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const correctedActivityAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const sourceUrl = "https://www.linkedin.com/feed/update/urn:li:activity:same-batch-duplicate/";
  const result = db.captureItems(feed.id, [
    {
      personName: " ",
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl,
      text: "Short batch text.",
    },
    {
      personName: "Same Batch Person",
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl,
      text: "Short batch text with the expanded body captured from a second matching DOM region.",
      activityAt: correctedActivityAt,
    },
  ]);

  const queued = db.listQueue(feed.id);
  assert.equal(result.received, 2);
  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 0);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].text, "Short batch text with the expanded body captured from a second matching DOM region.");
  assert.equal(queued[0].activityAt, correctedActivityAt);
  assert.equal(db.getPerson(person.id).name, "Same Batch Person");
});

test("capture strips refresh parameters before deduping source urls", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Param Dedupe", 15);
  const person = db.upsertPerson({ name: "Refresh Param Person", profileUrl: "https://www.linkedin.com/in/refresh-param-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const base = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    text: "Refresh parameter source URL should dedupe cleanly.",
    activityAt: new Date().toISOString(),
  };

  assert.equal(
    db.captureItems(feed.id, [
      {
        ...base,
        sourceUrl:
          "https://www.linkedin.com/feed/update/urn:li:activity:refresh-param/?lefSession=old&lefTarget=7&trk=public_profile",
      },
    ]).inserted,
    1,
  );
  const duplicate = db.captureItems(feed.id, [
    {
      ...base,
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:refresh-param/?lefSession=new&lefTarget=11",
    },
  ]);

  const queued = db.listQueue(feed.id);
  assert.equal(duplicate.inserted, 0);
  assert.equal(duplicate.updated, 0);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].sourceUrl, "https://www.linkedin.com/feed/update/urn:li:activity:refresh-param/");
});

test("capture accepts pasted source urls with wrapping punctuation", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Wrapped Source URL", 15);
  const person = db.upsertPerson({ name: "Wrapped Source Person", profileUrl: "https://www.linkedin.com/in/wrapped-source-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const base = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    text: "Wrapped source URL should normalize before validation and dedupe.",
    activityAt: new Date().toISOString(),
  };

  assert.equal(
    db.captureItems(feed.id, [
      {
        ...base,
        sourceUrl: "<https://www.linkedin.com/feed/update/urn:li:activity:wrapped-source/>",
      },
    ]).inserted,
    1,
  );
  const duplicate = db.captureItems(feed.id, [
    {
      ...base,
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:wrapped-source/).",
    },
  ]);

  const queued = db.listQueue(feed.id);
  assert.equal(duplicate.inserted, 0);
  assert.equal(duplicate.updated, 0);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].sourceUrl, "https://www.linkedin.com/feed/update/urn:li:activity:wrapped-source/");
});

test("profile activity page fallback keeps distinct posts separate", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Activity Fallback", 15);
  const person = db.upsertPerson({ name: "Fallback Person", profileUrl: "https://www.linkedin.com/in/fallback-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const sourceUrl = "https://www.linkedin.com/in/fallback-person/recent-activity/all/";
  const result = db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl,
      text: "First fallback post from the profile activity page.",
      activityAt: new Date(Date.now() - 60 * 1000).toISOString(),
    },
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl,
      text: "Second fallback post from the same profile activity page.",
      activityAt: new Date().toISOString(),
    },
  ]);

  assert.equal(result.inserted, 2);
  assert.equal(result.updated, 0);
  assert.deepEqual(
    db.listQueue(feed.id)
      .map((item) => item.text)
      .sort(),
    [
      "First fallback post from the profile activity page.",
      "Second fallback post from the same profile activity page.",
    ],
  );
});

test("direct post captures upgrade profile activity fallback queue links", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Fallback Source Upgrade", 15);
  const person = db.upsertPerson({
    name: "Source Upgrade Person",
    profileUrl: "https://www.linkedin.com/in/source-upgrade-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const text = "Profile activity fallback should be replaced once LinkedIn exposes the direct post source.";
  const activityAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  assert.equal(
    db.captureItems(feed.id, [
      {
        personName: person.name,
        profileUrl: person.profileUrl,
        type: "post",
        sourceUrl: "https://www.linkedin.com/in/source-upgrade-person/recent-activity/all/",
        text,
        activityAt,
      },
    ]).inserted,
    1,
  );

  const upgraded = db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:source-upgrade/",
      text,
      activityAt,
    },
  ]);
  const queued = db.listQueue(feed.id);

  assert.equal(upgraded.inserted, 0);
  assert.equal(upgraded.updated, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].sourceUrl, "https://www.linkedin.com/feed/update/urn:li:activity:source-upgrade/");
  assert.equal(queued[0].externalId, "post:https://www.linkedin.com/feed/update/urn:li:activity:source-upgrade/");
});

test("direct post captures upgrade deceptive legacy source links", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Deceptive Legacy Source Upgrade", 15);
  const person = db.upsertPerson({
    name: "Legacy Source Person",
    profileUrl: "https://www.linkedin.com/in/legacy-source-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const activityAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const discoveredAt = new Date().toISOString();
  const stableSourceUrl = "https://www.linkedin.com/feed/update/urn:li:activity:legacy-source-upgrade/";
  const text = "A deceptive legacy stored source should not block the direct LinkedIn source upgrade.";
  db.db.run(
    `
    INSERT INTO items (
      id, person_id, type, source_url, external_id, text,
      activity_at, discovered_at, status, comment_count_applied, created_at, updated_at
    )
    VALUES (?, ?, 'post', ?, ?, ?, ?, ?, 'new', 0, ?, ?)
    `,
    [
      "item_deceptive_legacy_source",
      person.id,
      `https://example.com/redirect?next=${encodeURIComponent(stableSourceUrl)}`,
      "post:legacy-deceptive-source",
      text,
      activityAt,
      discoveredAt,
      discoveredAt,
      discoveredAt,
    ],
  );
  db.db.run("INSERT INTO item_feeds (item_id, feed_id, created_at) VALUES (?, ?, ?)", [
    "item_deceptive_legacy_source",
    feed.id,
    discoveredAt,
  ]);

  const upgraded = db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: stableSourceUrl,
      text,
      activityAt,
    },
  ]);
  const queued = db.listQueue(feed.id);

  assert.equal(upgraded.inserted, 0);
  assert.equal(upgraded.updated, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, "item_deceptive_legacy_source");
  assert.equal(queued[0].sourceUrl, stableSourceUrl);
  assert.equal(queued[0].externalId, `post:${stableSourceUrl}`);
});

test("duplicate captures update existing items only when the stored item improves", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Improved Duplicate", 15);
  const person = db.upsertPerson({ name: "Improved Person", profileUrl: "https://www.linkedin.com/in/improved-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const base = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:improved-duplicate/",
    activityAt: new Date().toISOString(),
  };

  db.captureItems(feed.id, [{ ...base, text: "Short text." }]);
  const improved = db.captureItems(feed.id, [
    {
      ...base,
      text: "Short text with a longer expanded body captured after LinkedIn loaded more content.",
    },
  ]);

  assert.equal(improved.inserted, 0);
  assert.equal(improved.updated, 1);
  assert.equal(db.listQueue(feed.id)[0].text, "Short text with a longer expanded body captured after LinkedIn loaded more content.");
});

test("duplicate captures correct discovery-time fallback activity dates", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Corrected Activity Time", 15);
  const person = db.upsertPerson({
    name: "Corrected Time Person",
    profileUrl: "https://www.linkedin.com/in/corrected-time-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const correctedSourceUrl = "https://www.linkedin.com/feed/update/urn:li:activity:corrected-time/";
  const newerSourceUrl = "https://www.linkedin.com/feed/update/urn:li:activity:corrected-time-newer/";
  const correctedActivityAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const newerActivityAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: correctedSourceUrl,
      text: "This item initially only had a discovery-time fallback.",
    },
  ]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: newerSourceUrl,
      text: "Newer item should remain above the corrected older item.",
      activityAt: newerActivityAt,
    },
  ]);

  const corrected = db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: correctedSourceUrl,
      text: "This item initially only had a discovery-time fallback.",
      activityAt: correctedActivityAt,
    },
  ]);

  const queued = db.listQueue(feed.id);
  const correctedItem = queued.find((item) => item.sourceUrl === correctedSourceUrl);

  assert.equal(corrected.inserted, 0);
  assert.equal(corrected.updated, 1);
  assert.equal(correctedItem.activityAt, correctedActivityAt);
  assert.notEqual(correctedItem.activityAt, correctedItem.discoveredAt);
  assert.deepEqual(
    queued.map((item) => item.sourceUrl),
    [newerSourceUrl, correctedSourceUrl],
  );
});

test("corrected older duplicate captures are unlinked from feeds outside lookback", async () => {
  const { db } = await createTestDb();
  const shortFeed = db.createFeed("Short Lookback Correction", 1);
  const longFeed = db.createFeed("Long Lookback Correction", 15);
  const person = db.upsertPerson({
    name: "Lookback Correction Person",
    profileUrl: "https://www.linkedin.com/in/lookback-correction-person/",
  });
  db.setPersonFeedMembership(person.id, [shortFeed.id, longFeed.id]);

  const sourceUrl = "https://www.linkedin.com/feed/update/urn:li:activity:lookback-correction/";
  const correctedActivityAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl,
    text: "LinkedIn initially hid this older item's timestamp.",
  };

  assert.equal(db.captureItems(shortFeed.id, [item]).inserted, 1);
  assert.equal(db.captureItems(longFeed.id, [{ ...item, activityAt: correctedActivityAt }]).updated, 1);
  assert.equal(db.listQueue(shortFeed.id).length, 1);
  assert.equal(db.listQueue(longFeed.id).length, 1);

  const corrected = db.captureItems(shortFeed.id, [{ ...item, activityAt: correctedActivityAt }]);

  assert.equal(corrected.inserted, 0);
  assert.equal(corrected.updated, 1);
  assert.equal(corrected.skippedOlder, 1);
  assert.equal(db.listQueue(shortFeed.id).length, 0);
  assert.equal(db.listQueue(longFeed.id).length, 1);
  assert.equal(db.listQueue(longFeed.id)[0].activityAt, correctedActivityAt);
  assert.deepEqual(db.getQueueCounts(shortFeed.id), {
    new: 0,
    done: 0,
    skipped: 0,
    all: 0,
  });
  assert.deepEqual(db.getQueueCounts(longFeed.id), {
    new: 1,
    done: 0,
    skipped: 0,
    all: 1,
  });
});

test("duplicate item improvements do not reorder newer queue activity", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Chronological Duplicate", 15);
  const person = db.upsertPerson({
    name: "Chronological Person",
    profileUrl: "https://www.linkedin.com/in/chronological-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const olderDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const newerDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:older-chronological/",
      text: "Older short text.",
      activityAt: olderDate,
    },
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:newer-chronological/",
      text: "Newer activity text.",
      activityAt: newerDate,
    },
  ]);

  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:older-chronological/",
      text: "Older short text with later expanded context from LinkedIn.",
      activityAt: olderDate,
    },
  ]);

  assert.deepEqual(
    db.listQueue(feed.id).map((item) => item.sourceUrl),
    [
      "https://www.linkedin.com/feed/update/urn:li:activity:newer-chronological/",
      "https://www.linkedin.com/feed/update/urn:li:activity:older-chronological/",
    ],
  );
});

test("same-text comments on the same post stay separate per tracked person", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Comment Collision", 15);
  const alpha = db.upsertPerson({ name: "Alpha Commenter", profileUrl: "https://www.linkedin.com/in/alpha-commenter/" });
  const beta = db.upsertPerson({ name: "Beta Commenter", profileUrl: "https://www.linkedin.com/in/beta-commenter/" });
  db.setPersonFeedMembership(alpha.id, [feed.id]);
  db.setPersonFeedMembership(beta.id, [feed.id]);

  const sourceUrl = "https://www.linkedin.com/feed/update/urn:li:activity:same-post/";
  const activityAt = new Date().toISOString();
  const result = db.captureItems(feed.id, [
    {
      personName: alpha.name,
      profileUrl: alpha.profileUrl,
      type: "comment",
      sourceUrl,
      text: "Great perspective.",
      activityAt,
    },
    {
      personName: beta.name,
      profileUrl: beta.profileUrl,
      type: "comment",
      sourceUrl,
      text: "Great perspective.",
      activityAt,
    },
  ]);

  const queued = db.listQueue(feed.id);
  assert.equal(result.inserted, 2);
  assert.equal(result.updated, 0);
  assert.equal(queued.length, 2);
  assert.deepEqual(
    queued.map((item) => item.personName).sort(),
    ["Alpha Commenter", "Beta Commenter"],
  );
});

test("expanded comment captures update the same queue item", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Expanded Comment", 15);
  const person = db.upsertPerson({ name: "Expanded Commenter", profileUrl: "https://www.linkedin.com/in/expanded-commenter/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const base = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "comment",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:expanded-comment/",
    activityAt: new Date().toISOString(),
  };

  assert.equal(
    db.captureItems(feed.id, [
      {
        ...base,
        text: "This is a thoughtful point",
      },
    ]).inserted,
    1,
  );
  const expanded = db.captureItems(feed.id, [
    {
      ...base,
      text: "This is a thoughtful point about technical SEO prioritization and stakeholder alignment.",
    },
  ]);

  const queued = db.listQueue(feed.id);
  assert.equal(expanded.inserted, 0);
  assert.equal(expanded.updated, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].text, "This is a thoughtful point about technical SEO prioritization and stakeholder alignment.");
});

test("expanded comment dedupe uses normalized activity day ranges", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Expanded Comment Day Range", 15);
  const person = db.upsertPerson({
    name: "Offset Commenter",
    profileUrl: "https://www.linkedin.com/in/offset-commenter/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  const recentActivityTime = new Date(Date.now() - 60 * 60 * 1000);
  const offsetWallClockTime = new Date(recentActivityTime.getTime() - 5 * 60 * 60 * 1000);
  const activityAt = offsetWallClockTime.toISOString().replace("Z", "-05:00");
  const normalizedActivityAt = new Date(activityAt).toISOString();

  const base = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "comment",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:offset-comment/",
    activityAt,
  };

  assert.equal(
    db.captureItems(feed.id, [
      {
        ...base,
        text: "Timezone normalized comment",
      },
    ]).inserted,
    1,
  );
  const expanded = db.captureItems(feed.id, [
    {
      ...base,
      text: "Timezone normalized comment with the rest of the expanded text.",
    },
  ]);
  const queued = db.listQueue(feed.id);

  assert.equal(expanded.inserted, 0);
  assert.equal(expanded.updated, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].activityAt, normalizedActivityAt);
});

test("different comments by the same person on the same post stay separate", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Distinct Same Person Comments", 15);
  const person = db.upsertPerson({ name: "Repeat Commenter", profileUrl: "https://www.linkedin.com/in/repeat-commenter/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const sourceUrl = "https://www.linkedin.com/feed/update/urn:li:activity:repeat-commenter/";
  const activityAt = new Date().toISOString();
  const result = db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "comment",
      sourceUrl,
      text: "Strong point about internal linking strategy.",
      activityAt,
    },
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "comment",
      sourceUrl,
      text: "I also liked the crawl budget framing here.",
      activityAt,
    },
  ]);

  const queued = db.listQueue(feed.id);
  assert.equal(result.inserted, 2);
  assert.equal(result.updated, 0);
  assert.equal(queued.length, 2);
  assert.deepEqual(
    queued.map((item) => item.text).sort(),
    ["I also liked the crawl budget framing here.", "Strong point about internal linking strategy."],
  );
});

test("the same person's comment still dedupes across feeds", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Comment Dedupe A", 15);
  const feedB = db.createFeed("Comment Dedupe B", 15);
  const person = db.upsertPerson({ name: "Cross Feed Commenter", profileUrl: "https://www.linkedin.com/in/cross-feed-commenter/" });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id]);

  const comment = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "comment",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:cross-feed-comment/",
    text: "Useful discussion.",
    activityAt: new Date().toISOString(),
  };

  assert.equal(db.captureItems(feedA.id, [comment]).inserted, 1);
  assert.equal(db.captureItems(feedB.id, [comment]).updated, 1);
  assert.equal(db.listQueue(feedA.id).length, 1);
  assert.equal(db.listQueue(feedB.id).length, 1);
  assert.equal(db.getQueueCounts().all, 1);
});

test("old extension comment ids are still scoped per tracked person by the backend", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Legacy Comment Id", 15);
  const alpha = db.upsertPerson({ name: "Legacy Alpha", profileUrl: "https://www.linkedin.com/in/legacy-alpha/" });
  const beta = db.upsertPerson({ name: "Legacy Beta", profileUrl: "https://www.linkedin.com/in/legacy-beta/" });
  db.setPersonFeedMembership(alpha.id, [feed.id]);
  db.setPersonFeedMembership(beta.id, [feed.id]);

  const sourceUrl = "https://www.linkedin.com/feed/update/urn:li:activity:legacy-same-post/";
  const legacyExternalId = "comment:https://www.linkedin.com/feed/update/urn:li:activity:legacy-same-post/:12345";
  const activityAt = new Date().toISOString();
  const result = db.captureItems(feed.id, [
    {
      personName: alpha.name,
      profileUrl: alpha.profileUrl,
      type: "comment",
      sourceUrl,
      externalId: legacyExternalId,
      text: "Following this.",
      activityAt,
    },
    {
      personName: beta.name,
      profileUrl: beta.profileUrl,
      type: "comment",
      sourceUrl,
      externalId: legacyExternalId,
      text: "Following this.",
      activityAt,
    },
  ]);

  assert.equal(result.inserted, 2);
  assert.equal(db.listQueue(feed.id).length, 2);
});

test("removing a person from a feed unlinks their queued items from that feed only", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Membership Queue A", 15);
  const feedB = db.createFeed("Membership Queue B", 15);
  const person = db.upsertPerson({ name: "Movable Person", profileUrl: "https://www.linkedin.com/in/movable-person/" });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id]);

  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:membership-shared/",
    text: "Shared membership item",
    activityAt: new Date().toISOString(),
  };

  db.captureItems(feedA.id, [item]);
  db.captureItems(feedB.id, [item]);
  assert.equal(db.listQueue(feedA.id).length, 1);
  assert.equal(db.listQueue(feedB.id).length, 1);

  db.setPersonFeedMembership(person.id, [feedB.id]);

  assert.equal(db.listPeople("", feedA.id).length, 0);
  assert.equal(db.listPeople("", feedB.id).length, 1);
  assert.equal(db.listQueue(feedA.id).length, 0);
  assert.equal(db.listQueue(feedB.id).length, 1);
});

test("overlay membership updates remove orphan queued items for unchecked feeds", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Overlay Removal", 15);
  const status = db.upsertPersonWithMembership({
    name: "Overlay Person",
    profileUrl: "https://www.linkedin.com/in/overlay-person/",
    feedIds: [feed.id],
  });

  assert.ok(status.person);
  db.captureItems(feed.id, [
    {
      personName: "Overlay Person",
      profileUrl: "https://www.linkedin.com/in/overlay-person/",
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:overlay-removal/",
      text: "Overlay captured item",
      activityAt: new Date().toISOString(),
    },
  ]);
  assert.equal(db.listQueue(feed.id).length, 1);

  db.upsertPersonWithMembership({
    name: "Overlay Person",
    profileUrl: "https://www.linkedin.com/in/overlay-person/",
    feedIds: [],
  });

  assert.equal(db.listPeople("", feed.id).length, 0);
  assert.equal(db.listQueue(feed.id).length, 0);
  assert.equal(db.getQueueCounts(feed.id).all, 0);
});

test("desktop membership updates still reject missing feed ids", async () => {
  const { db } = await createTestDb();
  const person = db.upsertPerson({
    name: "Strict Membership Person",
    profileUrl: "https://www.linkedin.com/in/strict-membership-person/",
  });

  assert.throws(() => db.setPersonFeedMembership(person.id, ["feed_missing"]), /selected feeds no longer exist/);
  assert.throws(
    () =>
      db.upsertPersonWithMembership({
        name: "Strict Membership Person",
        profileUrl: person.profileUrl,
        feedIds: ["feed_missing"],
      }),
    /selected feeds no longer exist/,
  );
});

test("membership updates validate and unlink large feed lists in chunks", async () => {
  const { db } = await createTestDb();
  const person = db.upsertPerson({
    name: "Chunk Membership Person",
    profileUrl: "https://www.linkedin.com/in/chunk-membership-person/",
  });
  const at = new Date().toISOString();
  const feedIds = Array.from({ length: 425 }, (_value, index) => `feed_chunk_membership_${String(index).padStart(4, "0")}`);
  for (const [index, feedId] of feedIds.entries()) {
    db.db.run("INSERT INTO feeds (id, name, lookback_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
      feedId,
      `Chunk Membership ${index}`,
      15,
      at,
      at,
    ]);
  }

  const updated = db.setPersonFeedMembership(person.id, feedIds);
  insertRawQueueItem(db, {
    id: "item_chunk_membership_unlink",
    personId: person.id,
    feedIds,
  });

  assert.equal(updated.feedIds.length, feedIds.length);
  assert.deepEqual(new Set(updated.feedIds), new Set(feedIds));

  const removed = db.setPersonFeedMembership(person.id, []);

  assert.deepEqual(removed.feedIds, []);
  assert.equal(allDbRows(db, "SELECT COUNT(*) AS count FROM item_feeds WHERE item_id = ?", ["item_chunk_membership_unlink"])[0].count, 0);
  assert.equal(allDbRows(db, "SELECT COUNT(*) AS count FROM items WHERE id = ?", ["item_chunk_membership_unlink"])[0].count, 0);
});

test("membership capacity checks find full feeds across chunked feed lists", async () => {
  const { db } = await createTestDb();
  const person = db.upsertPerson({
    name: "Chunk Capacity Person",
    profileUrl: "https://www.linkedin.com/in/chunk-capacity-person/",
  });
  const at = new Date().toISOString();
  const feedIds = Array.from({ length: 425 }, (_value, index) => `feed_chunk_capacity_${String(index).padStart(4, "0")}`);
  for (const [index, feedId] of feedIds.entries()) {
    db.db.run("INSERT INTO feeds (id, name, lookback_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
      feedId,
      `Chunk Capacity ${String(index).padStart(4, "0")}`,
      15,
      at,
      at,
    ]);
  }
  const fullFeedId = feedIds[410];
  for (let index = 0; index < MAX_PEOPLE_PER_FEED; index += 1) {
    const existing = db.upsertPerson({
      name: `Chunk Capacity Existing ${index}`,
      profileUrl: `https://www.linkedin.com/in/chunk-capacity-existing-${index}/`,
    });
    db.setPersonFeedMembership(existing.id, [fullFeedId]);
  }

  assert.throws(() => db.setPersonFeedMembership(person.id, feedIds), /"Chunk Capacity 0410" already has 200 people/);
  assert.deepEqual(db.getPerson(person.id).feedIds, []);
});

test("queue history can reopen done and skipped items", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Reopen Queue", 15);
  const person = db.upsertPerson({ name: "Recover Person", profileUrl: "https://www.linkedin.com/in/recover-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:reopen/",
      text: "Recoverable item",
      activityAt: new Date().toISOString(),
    },
  ]);

  const item = db.listQueue(feed.id)[0];
  db.setItemStatus(item.id, "done");
  assert.equal(db.listQueue(feed.id).length, 0);
  assert.equal(db.listQueue(feed.id, "done").length, 1);
  assert.equal(db.getPerson(person.id).commentCount, 1);

  db.setItemStatus(item.id, "new");
  assert.equal(db.listQueue(feed.id).length, 1);
  assert.equal(db.listQueue(feed.id, "done").length, 0);
  assert.equal(db.getPerson(person.id).commentCount, 0);

  db.setItemStatus(item.id, "skipped");
  assert.equal(db.listQueue(feed.id).length, 0);
  assert.equal(db.listQueue(feed.id, "skipped").length, 1);
});

test("queue status changes return summaries and only move counters when status changes", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Status Summary", 15);
  const person = db.upsertPerson({ name: "Summary Person", profileUrl: "https://www.linkedin.com/in/summary-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:status-summary/",
      text: "Summary item",
      activityAt: new Date().toISOString(),
    },
  ]);

  const item = db.listQueue(feed.id)[0];
  const done = db.setItemStatus(item.id, "done");
  assert.deepEqual(done, {
    itemId: item.id,
    personId: person.id,
    previousStatus: "new",
    status: "done",
    changed: true,
    commentCountDelta: 1,
  });
  assert.equal(db.getPerson(person.id).commentCount, 1);

  const doneAgain = db.setItemStatus(item.id, "done");
  assert.deepEqual(doneAgain, {
    itemId: item.id,
    personId: person.id,
    previousStatus: "done",
    status: "done",
    changed: false,
    commentCountDelta: 0,
  });
  assert.equal(db.getPerson(person.id).commentCount, 1);

  const skipped = db.setItemStatus(item.id, "skipped");
  assert.deepEqual(skipped, {
    itemId: item.id,
    personId: person.id,
    previousStatus: "done",
    status: "skipped",
    changed: true,
    commentCountDelta: -1,
  });
  assert.equal(db.getPerson(person.id).commentCount, 0);
});

test("queue status counter updates share the item status timestamp", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Status Timestamp", 15);
  const person = db.upsertPerson({
    name: "Timestamp Person",
    profileUrl: "https://www.linkedin.com/in/status-timestamp-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:status-timestamp/",
      text: "Status timestamp item",
      activityAt: new Date().toISOString(),
    },
  ]);

  const item = db.listQueue(feed.id)[0];
  db.setItemStatus(item.id, "done");
  const [row] = allDbRows(
    db,
    `
    SELECT i.updated_at AS itemUpdatedAt, p.updated_at AS personUpdatedAt
    FROM items i
    JOIN people p ON p.id = i.person_id
    WHERE i.id = ?
    `,
    [item.id],
  );

  assert.equal(row.itemUpdatedAt, row.personUpdatedAt);
});

test("queue status changes with the same request id are idempotent", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Status Retry Idempotency", 15);
  const person = db.upsertPerson({
    name: "Status Retry Person",
    profileUrl: "https://www.linkedin.com/in/status-retry-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:status-retry/",
      text: "Status retry item",
      activityAt: new Date().toISOString(),
    },
  ]);

  const item = db.listQueue(feed.id)[0];
  const first = db.setItemStatus(item.id, "done", { requestId: "lost-status-response-1" });
  const duplicate = db.setItemStatus(item.id, "done", { requestId: "lost-status-response-1" });

  assert.deepEqual(first, {
    itemId: item.id,
    personId: person.id,
    previousStatus: "new",
    status: "done",
    changed: true,
    commentCountDelta: 1,
  });
  assert.deepEqual(duplicate, first);
  assert.equal(db.getPerson(person.id).commentCount, 1);

  const reopened = await reopenTestDb(dbPath);
  const afterRestartDuplicate = reopened.setItemStatus(item.id, "done", { requestId: "lost-status-response-1" });
  assert.deepEqual(afterRestartDuplicate, first);
  assert.equal(reopened.getPerson(person.id).commentCount, 1);
});

test("long queue status request ids remain distinct after bounding", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Long Status Request Ids", 15);
  const person = db.upsertPerson({
    name: "Long Status Request Person",
    profileUrl: "https://www.linkedin.com/in/long-status-request-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:long-status-request/",
      text: "Long request ids should not collide after their shared prefix.",
      activityAt: new Date().toISOString(),
    },
  ]);

  const item = db.listQueue(feed.id)[0];
  const sharedPrefix = "x".repeat(120);
  const first = db.setItemStatus(item.id, "done", { requestId: `${sharedPrefix}-done` });
  const second = db.setItemStatus(item.id, "skipped", { requestId: `${sharedPrefix}-skipped` });

  assert.equal(first.status, "done");
  assert.equal(first.changed, true);
  assert.equal(second.previousStatus, "done");
  assert.equal(second.status, "skipped");
  assert.equal(second.changed, true);
  assert.equal(db.listQueue(feed.id, "skipped")[0].id, item.id);
});

test("feed-scoped status changes cannot mutate stale queue rows from other feeds", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Scoped Status A", 15);
  const feedB = db.createFeed("Scoped Status B", 15);
  const person = db.upsertPerson({ name: "Scoped Status Person", profileUrl: "https://www.linkedin.com/in/scoped-status-person/" });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id]);
  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:scoped-status/",
    text: "This item remains available in one feed after removal from another.",
    activityAt: new Date().toISOString(),
  };
  db.captureItems(feedA.id, [item]);
  db.captureItems(feedB.id, [item]);
  const queued = db.listQueue(feedA.id)[0];

  db.setPersonFeedMembership(person.id, [feedB.id]);

  assert.throws(() => db.setItemStatus(queued.id, "done", { feedId: feedA.id }), /no longer in this feed/);
  assert.equal(db.listQueue(feedB.id).length, 1);
  assert.equal(db.getPerson(person.id).commentCount, 0);

  const done = db.setItemStatus(queued.id, "done", { feedId: feedB.id });

  assert.equal(done.changed, true);
  assert.equal(db.listQueue(feedB.id).length, 0);
  assert.equal(db.getPerson(person.id).commentCount, 1);
});

test("feed-scoped queue status checks use item-feed primary key without counting", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const statusWrite = source.slice(source.indexOf("setItemStatus("), source.indexOf("captureItems(feedId"));

  assert.match(statusWrite, /this\.assertFeedExists\(options\.feedId\);/);
  assert.match(
    statusWrite,
    /SELECT 1 AS found FROM item_feeds WHERE item_id = \? AND feed_id = \? LIMIT 1/,
  );
  assert.match(statusWrite, /\[itemId, options\.feedId\]/);
  assert.doesNotMatch(statusWrite, /SELECT COUNT\(\*\) AS count FROM item_feeds WHERE item_id = \? AND feed_id = \?/);
  assert.doesNotMatch(statusWrite, /this\.getFeed\(options\.feedId\)/);
});

test("queue status counter deltas reflect clamp boundaries", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Status Clamp", 15);
  const person = db.upsertPerson({ name: "Clamp Person", profileUrl: "https://www.linkedin.com/in/clamp-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.updateCounters(person.id, { commentCount: MAX_COUNTER_VALUE });
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:status-clamp/",
      text: "Clamp item",
      activityAt: new Date().toISOString(),
    },
  ]);

  const item = db.listQueue(feed.id)[0];
  const cappedDone = db.setItemStatus(item.id, "done");
  assert.equal(cappedDone.commentCountDelta, 0);
  assert.equal(db.getPerson(person.id).commentCount, MAX_COUNTER_VALUE);

  const cappedReopen = db.setItemStatus(item.id, "new");
  assert.equal(cappedReopen.commentCountDelta, 0);
  assert.equal(db.getPerson(person.id).commentCount, MAX_COUNTER_VALUE);

  db.updateCounters(person.id, { commentCount: MAX_COUNTER_VALUE - 1 });
  const trackedDone = db.setItemStatus(item.id, "done");
  assert.equal(trackedDone.commentCountDelta, 1);
  assert.equal(db.getPerson(person.id).commentCount, MAX_COUNTER_VALUE);

  const trackedReopen = db.setItemStatus(item.id, "new");
  assert.equal(trackedReopen.commentCountDelta, -1);
  assert.equal(db.getPerson(person.id).commentCount, MAX_COUNTER_VALUE - 1);

  db.updateCounters(person.id, { commentCount: 0 });
  const zeroReopen = db.setItemStatus(item.id, "new");
  assert.equal(zeroReopen.commentCountDelta, 0);
  assert.equal(db.getPerson(person.id).commentCount, 0);
});

test("counter adjustments apply deltas to stored counters and clamp results", async () => {
  const { db } = await createTestDb();
  const person = db.upsertPerson({ name: "Delta Person", profileUrl: "https://www.linkedin.com/in/delta-person/" });

  db.updateCounters(person.id, { commentCount: 1, likeCount: MAX_COUNTER_VALUE - 1, backCommentCount: 2 });
  const increased = db.adjustCounters(person.id, { commentCount: 1, likeCount: 10, backCommentCount: -5 });
  assert.equal(increased.commentCount, 2);
  assert.equal(increased.likeCount, MAX_COUNTER_VALUE);
  assert.equal(increased.backCommentCount, 0);

  const lowered = db.adjustCounters(person.id, { commentCount: -200 });
  assert.equal(lowered.commentCount, 0);
  assert.throws(() => db.adjustCounters(person.id, { likeCount: Number.NaN }), /adjustments must be numbers/);
});

test("unchanged absolute counter saves do not rewrite the person row", async () => {
  const { db } = await createTestDb();
  const person = db.upsertPerson({ name: "Noop Counter Person", profileUrl: "https://www.linkedin.com/in/noop-counter-person/" });
  const updated = db.updateCounters(person.id, { commentCount: 2, likeCount: 1, backCommentCount: 3 });

  const unchanged = db.updateCounters(person.id, { commentCount: 2, likeCount: 1, backCommentCount: 3 });

  assert.equal(unchanged.updatedAt, updated.updatedAt);
  assert.deepEqual(unchanged, updated);
});

test("no-op counter adjustments do not rewrite the person row", async () => {
  const { db } = await createTestDb();
  const person = db.upsertPerson({ name: "Noop Delta Person", profileUrl: "https://www.linkedin.com/in/noop-delta-person/" });
  const updated = db.updateCounters(person.id, { commentCount: 2, likeCount: 1, backCommentCount: 0 });

  const unchanged = db.adjustCounters(person.id, { commentCount: 0, likeCount: 0, backCommentCount: -1 });
  const replayed = db.adjustCounters(person.id, { commentCount: 0 }, { requestId: "noop-delta-replay-1" });
  const duplicate = db.adjustCounters(person.id, { commentCount: 4 }, { requestId: "noop-delta-replay-1" });

  assert.equal(unchanged.updatedAt, updated.updatedAt);
  assert.deepEqual(unchanged, updated);
  assert.deepEqual(replayed, updated);
  assert.deepEqual(duplicate, updated);
  assert.deepEqual(db.getPerson(person.id), updated);
});

test("absolute counter saves with the same request id are idempotent", async () => {
  const { db, dbPath } = await createTestDb();
  const person = db.upsertPerson({
    name: "Retry Absolute Counter Person",
    profileUrl: "https://www.linkedin.com/in/retry-absolute-counter-person/",
  });

  const first = db.updateCounters(
    person.id,
    { commentCount: 4, likeCount: 2, backCommentCount: 1 },
    { requestId: "lost-absolute-counter-response-1" },
  );
  const laterAdjustment = db.adjustCounters(person.id, { commentCount: 1 }, { requestId: "later-counter-click-1" });
  const duplicate = db.updateCounters(
    person.id,
    { commentCount: 0, likeCount: 0, backCommentCount: 0 },
    { requestId: "lost-absolute-counter-response-1" },
  );

  assert.deepEqual(duplicate, first);
  assert.equal(laterAdjustment.commentCount, 5);
  assert.equal(db.getPerson(person.id).commentCount, 5);
  assert.equal(db.getPerson(person.id).likeCount, 2);
  assert.equal(db.getPerson(person.id).backCommentCount, 1);

  const reopened = await reopenTestDb(dbPath);
  const afterRestartDuplicate = reopened.updateCounters(
    person.id,
    { commentCount: 9, likeCount: 9, backCommentCount: 9 },
    { requestId: "lost-absolute-counter-response-1" },
  );

  assert.deepEqual(afterRestartDuplicate, first);
  assert.equal(reopened.getPerson(person.id).commentCount, 5);
});

test("absolute counter saves replay even after the person is deleted", async () => {
  const { db } = await createTestDb();
  const person = db.upsertPerson({
    name: "Deleted Absolute Counter Person",
    profileUrl: "https://www.linkedin.com/in/deleted-absolute-counter-person/",
  });

  const first = db.updateCounters(
    person.id,
    { commentCount: 3, likeCount: 2, backCommentCount: 1 },
    { requestId: "deleted-absolute-counter-response-1" },
  );
  db.deletePerson(person.id);
  const duplicate = db.updateCounters(
    person.id,
    { commentCount: 0, likeCount: 0, backCommentCount: 0 },
    { requestId: "deleted-absolute-counter-response-1" },
  );

  assert.deepEqual(duplicate, first);
});

test("counter adjustments with the same request id are idempotent", async () => {
  const { db, dbPath } = await createTestDb();
  const person = db.upsertPerson({ name: "Retry Delta Person", profileUrl: "https://www.linkedin.com/in/retry-delta-person/" });

  const first = db.adjustCounters(person.id, { commentCount: 1, likeCount: 2 }, { requestId: "lost-response-1" });
  const duplicate = db.adjustCounters(person.id, { commentCount: 1, likeCount: 2 }, { requestId: "lost-response-1" });
  const next = db.adjustCounters(person.id, { commentCount: 1 }, { requestId: "next-click-1" });

  assert.equal(first.commentCount, 1);
  assert.equal(first.likeCount, 2);
  assert.deepEqual(duplicate, first);
  assert.equal(next.commentCount, 2);
  assert.equal(next.likeCount, 2);

  const reopened = await reopenTestDb(dbPath);
  const afterRestartDuplicate = reopened.adjustCounters(person.id, { commentCount: 1, likeCount: 2 }, { requestId: "lost-response-1" });
  assert.deepEqual(afterRestartDuplicate, first);
  assert.equal(reopened.getPerson(person.id).commentCount, 2);
  assert.equal(reopened.getPerson(person.id).likeCount, 2);
});

test("queue counts summarize statuses for a feed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Queue Counts", 15);
  const person = db.upsertPerson({ name: "Counts Person", profileUrl: "https://www.linkedin.com/in/counts-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  for (let index = 0; index < 3; index += 1) {
    db.captureItems(feed.id, [
      {
        personName: person.name,
        profileUrl: person.profileUrl,
        type: "post",
        sourceUrl: `https://www.linkedin.com/feed/update/urn:li:activity:counts-${index}/`,
        text: `Counts item ${index}`,
        activityAt: new Date().toISOString(),
      },
    ]);
  }

  const [first, second] = db.listQueue(feed.id);
  db.setItemStatus(first.id, "done");
  db.setItemStatus(second.id, "skipped");

  assert.deepEqual(db.getQueueCounts(feed.id), {
    new: 1,
    done: 1,
    skipped: 1,
    all: 3,
  });
});

test("queue listing is bounded while counts remain complete", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Queue Limit", 15);
  const person = db.upsertPerson({ name: "Limit Person", profileUrl: "https://www.linkedin.com/in/limit-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  for (let index = 0; index < 5; index += 1) {
    db.captureItems(feed.id, [
      {
        personName: person.name,
        profileUrl: person.profileUrl,
        type: "post",
        sourceUrl: `https://www.linkedin.com/feed/update/urn:li:activity:limit-${index}/`,
        text: `Limit item ${index}`,
        activityAt: new Date(Date.now() - index * 60 * 1000).toISOString(),
      },
    ]);
  }

  const limited = db.listQueue(feed.id, "new", { limit: 2 });
  const nextPage = db.listQueue(feed.id, "new", { limit: 2, offset: 2 });

  assert.equal(limited.length, 2);
  assert.equal(nextPage.length, 2);
  assert.deepEqual(
    limited.map((item) => item.text),
    ["Limit item 0", "Limit item 1"],
  );
  assert.deepEqual(db.getQueueCounts(feed.id), {
    new: 5,
    done: 0,
    skipped: 0,
    all: 5,
  });
});

test("queue view returns a bounded page with complete counts", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Queue View", 15);
  const person = db.upsertPerson({ name: "View Person", profileUrl: "https://www.linkedin.com/in/view-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  for (let index = 0; index < 4; index += 1) {
    db.captureItems(feed.id, [
      {
        personName: person.name,
        profileUrl: person.profileUrl,
        type: "post",
        sourceUrl: `https://www.linkedin.com/feed/update/urn:li:activity:view-${index}/`,
        text: `View item ${index}`,
        activityAt: new Date(Date.now() - index * 60 * 1000).toISOString(),
      },
    ]);
  }

  const [first] = db.listQueue(feed.id);
  db.setItemStatus(first.id, "done");
  const view = db.getQueueView(feed.id, "new", { limit: 2 });

  assert.deepEqual(
    view.items.map((item) => item.text),
    ["View item 1", "View item 2"],
  );
  assert.deepEqual(view.counts, {
    new: 3,
    done: 1,
    skipped: 0,
    all: 4,
  });
});

test("queue items preserve feed names that contain commas", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("SEO, SaaS Leaders", 15);
  const feedB = db.createFeed("Agency Directors", 15);
  const person = db.upsertPerson({
    name: "Comma Feed Person",
    profileUrl: "https://www.linkedin.com/in/comma-feed-person/",
  });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id]);
  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:comma-feed-name/",
    text: "Queue item feed names should preserve punctuation from custom feed names.",
    activityAt: new Date().toISOString(),
  };

  db.captureItems(feedA.id, [item]);
  db.captureItems(feedB.id, [item]);
  const [queued] = db.listQueue(feedA.id);

  assert.deepEqual(new Set(queued.feedNames), new Set(["SEO, SaaS Leaders", "Agency Directors"]));
  assert.equal(queued.feedNames.includes("SEO"), false);
  assert.equal(queued.feedNames.includes("SaaS Leaders"), false);
});

test("queue items return feed metadata in stable name order", async () => {
  const { db } = await createTestDb();
  const at = new Date().toISOString();
  db.db.run("INSERT INTO feeds (id, name, lookback_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
    "feed_a_zulu",
    "Zulu Feed",
    15,
    at,
    at,
  ]);
  db.db.run("INSERT INTO feeds (id, name, lookback_days, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
    "feed_z_alpha",
    "Alpha Feed",
    15,
    at,
    at,
  ]);
  const person = db.upsertPerson({
    name: "Stable Feed Metadata Person",
    profileUrl: "https://www.linkedin.com/in/stable-feed-metadata-person/",
  });
  db.setPersonFeedMembership(person.id, ["feed_a_zulu", "feed_z_alpha"]);
  const item = {
    personName: person.name,
    profileUrl: person.profileUrl,
    type: "post",
    sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:stable-feed-metadata/",
    text: "Queue feed metadata order should stay stable across reads.",
    activityAt: new Date().toISOString(),
  };

  db.captureItems("feed_a_zulu", [item]);
  db.captureItems("feed_z_alpha", [item]);
  const [queued] = db.listQueue("feed_a_zulu");

  assert.deepEqual(queued.feedNames, ["Alpha Feed", "Zulu Feed"]);
  assert.deepEqual(queued.feedIds, ["feed_z_alpha", "feed_a_zulu"]);
});

test("queue cursor pagination stays stable when newer items arrive", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Queue Cursor Stable", 365);
  const person = db.upsertPerson({ name: "Cursor Person", profileUrl: "https://www.linkedin.com/in/cursor-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  for (let index = 0; index < 5; index += 1) {
    db.captureItems(feed.id, [
      {
        personName: person.name,
        profileUrl: person.profileUrl,
        type: "post",
        sourceUrl: `https://www.linkedin.com/feed/update/urn:li:activity:cursor-${index}/`,
        text: `Cursor item ${index}`,
        activityAt: new Date(Date.UTC(2026, 0, 1, 12, 0 - index, 0)).toISOString(),
      },
    ]);
  }

  const firstPage = db.listQueue(feed.id, "new", { limit: 2 });
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:cursor-newer/",
      text: "Cursor newer item",
      activityAt: new Date(Date.UTC(2026, 0, 1, 12, 5, 0)).toISOString(),
    },
  ]);
  const nextPage = db.listQueue(feed.id, "new", { limit: 2, after: firstPage[firstPage.length - 1] });

  assert.deepEqual(
    firstPage.map((item) => item.text),
    ["Cursor item 0", "Cursor item 1"],
  );
  assert.deepEqual(
    nextPage.map((item) => item.text),
    ["Cursor item 2", "Cursor item 3"],
  );
});

test("queue cursor pagination normalizes parseable non-iso cursor dates", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Queue Cursor Date Normalize", 365);
  const person = db.upsertPerson({ name: "Cursor Date Person", profileUrl: "https://www.linkedin.com/in/cursor-date-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  for (let index = 0; index < 5; index += 1) {
    db.captureItems(feed.id, [
      {
        personName: person.name,
        profileUrl: person.profileUrl,
        type: "post",
        sourceUrl: `https://www.linkedin.com/feed/update/urn:li:activity:cursor-date-${index}/`,
        text: `Cursor date item ${index}`,
        activityAt: new Date(Date.UTC(2026, 0, 1, 12, 0 - index, 0)).toISOString(),
      },
    ]);
  }

  const firstPage = db.listQueue(feed.id, "new", { limit: 2 });
  const cursor = firstPage[firstPage.length - 1];
  const nextPage = db.listQueue(feed.id, "new", {
    limit: 2,
    after: {
      ...cursor,
      activityAt: new Date(cursor.activityAt).toUTCString(),
      discoveredAt: new Date(cursor.discoveredAt).toUTCString(),
    },
  });

  assert.deepEqual(
    nextPage.map((item) => item.text),
    ["Cursor date item 2", "Cursor date item 3"],
  );
});

test("queue cursor pagination ignores offset once a cursor is provided", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Queue Cursor Offset Dominates", 365);
  const person = db.upsertPerson({ name: "Cursor Offset Person", profileUrl: "https://www.linkedin.com/in/cursor-offset-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  for (let index = 0; index < 6; index += 1) {
    db.captureItems(feed.id, [
      {
        personName: person.name,
        profileUrl: person.profileUrl,
        type: "post",
        sourceUrl: `https://www.linkedin.com/feed/update/urn:li:activity:cursor-offset-${index}/`,
        text: `Cursor offset item ${index}`,
        activityAt: new Date(Date.UTC(2026, 0, 1, 12, 0 - index, 0)).toISOString(),
      },
    ]);
  }

  const firstPage = db.listQueue(feed.id, "new", { limit: 2 });
  const cursorOnlyPage = db.listQueue(feed.id, "new", { limit: 2, after: firstPage[firstPage.length - 1] });
  const mixedPage = db.listQueue(feed.id, "new", {
    limit: 2,
    offset: 2,
    after: firstPage[firstPage.length - 1],
  });

  assert.deepEqual(
    cursorOnlyPage.map((item) => item.text),
    ["Cursor offset item 2", "Cursor offset item 3"],
  );
  assert.deepEqual(
    mixedPage.map((item) => item.text),
    cursorOnlyPage.map((item) => item.text),
  );
});

test("queue ordering stays chronological after timezone normalization", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Timezone Queue Ordering", 365);
  const person = db.upsertPerson({ name: "Timezone Person", profileUrl: "https://www.linkedin.com/in/timezone-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:timezone-middle/",
      text: "Middle UTC item",
      activityAt: "2026-01-01T16:30:00.000Z",
    },
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:timezone-newest/",
      text: "Newest offset item",
      activityAt: "2026-01-01T09:00:00-08:00",
    },
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:timezone-oldest/",
      text: "Oldest offset item",
      activityAt: "2026-01-01T17:15:00+01:00",
    },
  ]);

  assert.deepEqual(
    db.listQueue(feed.id).map((item) => item.text),
    ["Newest offset item", "Middle UTC item", "Oldest offset item"],
  );
});

test("queue offset pagination can move beyond the max single-page cap", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Queue Offset Beyond Cap", 15);
  const person = db.upsertPerson({ name: "Offset Person", profileUrl: "https://www.linkedin.com/in/offset-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);

  for (let index = 0; index < 505; index += 1) {
    db.captureItems(feed.id, [
      {
        personName: person.name,
        profileUrl: person.profileUrl,
        type: "post",
        sourceUrl: `https://www.linkedin.com/feed/update/urn:li:activity:offset-${index}/`,
        text: `Offset item ${index}`,
        activityAt: new Date(Date.now() - index * 60 * 1000).toISOString(),
      },
    ]);
  }

  assert.equal(db.listQueue(feed.id, "new", { limit: 999 }).length, 500);
  assert.deepEqual(
    db.listQueue(feed.id, "new", { limit: 150, offset: 500 }).map((item) => item.text),
    ["Offset item 500", "Offset item 501", "Offset item 502", "Offset item 503", "Offset item 504"],
  );
  assert.equal(db.getQueueCounts(feed.id).new, 505);
});

test("queue pagination rejects unsafe direct limits and offsets", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Queue Unsafe Pagination", 15);

  assert.throws(() => db.listQueue(feed.id, "new", { limit: 1.5 }), /Queue limit must be a safe whole number/);
  assert.throws(() => db.listQueue(feed.id, "new", { limit: Number.MAX_SAFE_INTEGER + 1 }), /Queue limit must be a safe whole number/);
  assert.throws(() => db.listQueue(feed.id, "new", { offset: 1.5 }), /Queue offset must be a safe whole number/);
  assert.throws(() => db.listQueue(feed.id, "new", { offset: Number.MAX_SAFE_INTEGER + 1 }), /Queue offset must be a safe whole number/);
  assert.throws(
    () =>
      db.listQueue(feed.id, "new", {
        after: {
          activityAt: "2026-01-01T00:00:00.000Z",
          discoveredAt: "2026-01-01T00:00:00.000Z",
          id: "item/1",
        },
      }),
    /Queue cursor id contains unsupported characters/,
  );
  assert.throws(
    () =>
      db.listQueue(feed.id, "new", {
        after: {
          activityAt: "2026-01-01T00:00:00.000Z",
          discoveredAt: "2026-01-01T00:00:00.000Z",
          id: "x".repeat(81),
        },
      }),
    /Queue cursor id must be 80 characters or fewer/,
  );
});

test("feed-scoped queue pages start from ordered item indexes", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const listQueue = source.slice(source.indexOf("listQueue(feedId?"), source.indexOf("getQueueView(feedId?"));
  const feedBranch = listQueue.slice(listQueue.indexOf("const pageSql = feedId"), listQueue.indexOf(": (() => {", listQueue.indexOf("const pageSql = feedId")));

  assert.match(feedBranch, /const itemIndex = statusSql \? "idx_items_status_activity_discovered" : "idx_items_activity_discovered";/);
  assert.match(feedBranch, /FROM items i INDEXED BY \$\{itemIndex\}/);
  assert.match(feedBranch, /JOIN item_feeds scope ON scope\.item_id = i\.id AND scope\.feed_id = \?/);
  assert.match(feedBranch, /ORDER BY i\.activity_at DESC, i\.discovered_at DESC, i\.id ASC/);
  assert.doesNotMatch(feedBranch, /FROM item_feeds scope INDEXED BY idx_item_feeds_feed_item\s+CROSS JOIN items i/);
});

test("global queue pages start from ordered item indexes", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const listQueue = source.slice(source.indexOf("listQueue(feedId?"), source.indexOf("getQueueView(feedId?"));
  const globalBranchStart = listQueue.indexOf(": (() => {", listQueue.indexOf("const pageSql = feedId"));
  const globalBranch = listQueue.slice(globalBranchStart, listQueue.indexOf("})();", globalBranchStart));

  assert.match(globalBranch, /const itemIndex = statusSql \? "idx_items_status_activity_discovered" : "idx_items_activity_discovered";/);
  assert.match(globalBranch, /FROM items i INDEXED BY \$\{itemIndex\}/);
  assert.match(globalBranch, /ORDER BY i\.activity_at DESC, i\.discovered_at DESC, i\.id ASC/);
  assert.doesNotMatch(globalBranch, /FROM items i\s+\$\{whereSql/);
});

test("queue listing aggregates feed tags once for the visible page", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const listQueue = source.slice(source.indexOf("listQueue(feedId?"), source.indexOf("getQueueView(feedId?"));

  assert.match(listQueue, /WITH page AS \(/);
  assert.match(listQueue, /feed_tags AS \(\s+SELECT item_id, GROUP_CONCAT\(feed_id\) AS feedIds, GROUP_CONCAT\(feed_name_hex\) AS feedNames/);
  assert.match(listQueue, /JOIN page ON page\.id = scoped_feed\.item_id/);
  assert.match(listQueue, /ORDER BY scoped_feed\.item_id ASC, scoped_name\.name COLLATE NOCASE ASC, scoped_feed\.feed_id ASC/);
  assert.match(listQueue, /LEFT JOIN feed_tags ON feed_tags\.item_id = i\.id/);
  assert.match(listQueue, /feed_tags\.feedIds, feed_tags\.feedNames/);
  assert.doesNotMatch(listQueue, /WHERE scoped_feed\.item_id = i\.id/);
});

test("queue view validates scoped feeds once before loading items and counts", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const listQueue = source.slice(source.indexOf("listQueue(feedId?"), source.indexOf("getQueueView(feedId?"));
  const getQueueView = source.slice(source.indexOf("getQueueView(feedId?"), source.indexOf("getQueueCounts(feedId?"));
  const getQueueCounts = source.slice(source.indexOf("getQueueCounts(feedId?"), source.indexOf("setItemStatus("));

  assert.match(source, /type QueueReadOptions = QueueListOptions & \{\s+skipFeedValidation\?: boolean;\s+\};/);
  assert.match(listQueue, /const after = normalizeQueueCursor\(options\.after\);\s+const offset = after \? 0 : normalizeQueueOffset\(options\.offset\);/);
  assert.match(listQueue, /if \(!options\.skipFeedValidation\) \{\s+this\.assertFeedExists\(feedId\);/);
  assert.match(getQueueView, /if \(feedId\) \{\s+this\.assertFeedExists\(feedId\);/);
  assert.match(getQueueView, /this\.listQueue\(feedId, status, \{ \.\.\.options, skipFeedValidation: Boolean\(feedId\) \}\)/);
  assert.match(getQueueView, /this\.getQueueCounts\(feedId, \{ skipFeedValidation: Boolean\(feedId\) \}\)/);
  assert.match(getQueueCounts, /if \(!options\.skipFeedValidation\) \{\s+this\.assertFeedExists\(feedId\);/);
  assert.doesNotMatch(listQueue, /this\.getFeed\(feedId\)/);
  assert.doesNotMatch(getQueueView, /this\.getFeed\(feedId\)/);
  assert.doesNotMatch(getQueueCounts, /this\.getFeed\(feedId\)/);
});

test("queue counts start from status and feed indexes", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const getQueueCounts = source.slice(source.indexOf("getQueueCounts(feedId?"), source.indexOf("setItemStatus("));

  assert.match(getQueueCounts, /FROM item_feeds scope INDEXED BY idx_item_feeds_feed_item/);
  assert.match(getQueueCounts, /WHERE scope\.feed_id = \? AND i\.id = scope\.item_id/);
  assert.match(getQueueCounts, /FROM items i INDEXED BY idx_items_status_activity/);
  assert.doesNotMatch(getQueueCounts, /FROM items i\s+GROUP BY i\.status/);
});

test("hot feed validations avoid membership counts when only existence is needed", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const helper = source.slice(source.indexOf("private assertFeedExists"), source.indexOf("createFeed(name"));
  const listPeople = source.slice(source.indexOf("listPeople("), source.indexOf("getPerson(id: string)"));
  const addPerson = source.slice(source.indexOf("addPersonToFeed("), source.indexOf("bulkAddPeopleToFeed("));
  const statusWrite = source.slice(source.indexOf("setItemStatus("), source.indexOf("captureItems(feedId"));

  assert.match(helper, /private assertFeedExists\(id: string\)/);
  assert.match(helper, /SELECT 1 AS found FROM feeds WHERE id = \? LIMIT 1/);
  assert.match(helper, /throw new AppError\("Feed not found\.", 404\);/);
  assert.doesNotMatch(helper, /COUNT\(fp\.person_id\)/);
  assert.match(listPeople, /this\.assertFeedExists\(feedId\);/);
  assert.match(addPerson, /this\.assertFeedExists\(feedId\);/);
  assert.match(statusWrite, /this\.assertFeedExists\(options\.feedId\);/);
  assert.doesNotMatch(listPeople, /this\.getFeed\(feedId\);/);
  assert.doesNotMatch(addPerson, /this\.getFeed\(feedId\);/);
  assert.doesNotMatch(statusWrite, /this\.getFeed\(options\.feedId\);/);
});

test("feed summaries count members through the feed membership index", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Indexed Feed Counts A", 15);
  const feedB = db.createFeed("Indexed Feed Counts B", 15);
  const personA = db.upsertPerson({ name: "Indexed Count A", profileUrl: "https://www.linkedin.com/in/indexed-count-a/" });
  const personB = db.upsertPerson({ name: "Indexed Count B", profileUrl: "https://www.linkedin.com/in/indexed-count-b/" });
  db.setPersonFeedMembership(personA.id, [feedA.id]);
  db.setPersonFeedMembership(personB.id, [feedA.id, feedB.id]);

  assert.equal(db.getFeed(feedA.id).peopleCount, 2);
  assert.equal(db.getFeed(feedB.id).peopleCount, 1);
  assert.deepEqual(
    db
      .listFeeds()
      .filter((feed) => feed.id === feedA.id || feed.id === feedB.id)
      .map((feed) => [feed.name, feed.peopleCount]),
    [
      ["Indexed Feed Counts A", 2],
      ["Indexed Feed Counts B", 1],
    ],
  );

  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const feedReaders = [
    source.slice(source.indexOf("listFeeds()"), source.indexOf("private assertFeedExists")),
    source.slice(source.indexOf("private feedByName"), source.indexOf("private ensureDefaultFeed")),
  ].join("\n");

  assert.match(feedReaders, /FROM feed_people INDEXED BY idx_feed_people_feed\s+WHERE feed_id = f\.id/);
  assert.doesNotMatch(feedReaders, /LEFT JOIN feed_people fp ON fp\.feed_id = f\.id/);
  assert.doesNotMatch(feedReaders, /GROUP BY f\.id/);
});

test("people search is scoped to the selected feed", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("People Search A", 15);
  const feedB = db.createFeed("People Search B", 15);
  const alpha = db.upsertPerson({ name: "Alpha Strategist", profileUrl: "https://www.linkedin.com/in/alpha-strategist/" });
  const beta = db.upsertPerson({ name: "Beta Strategist", profileUrl: "https://www.linkedin.com/in/beta-strategist/" });
  db.setPersonFeedMembership(alpha.id, [feedA.id]);
  db.setPersonFeedMembership(beta.id, [feedB.id]);

  assert.deepEqual(
    db.listPeople("strategist", feedA.id).map((person) => person.name),
    ["Alpha Strategist"],
  );
  assert.deepEqual(
    db.listPeople("beta", feedA.id).map((person) => person.name),
    [],
  );
});

test("people search treats SQL wildcard characters as literal text", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("People Wildcard Search", 15);
  const percent = db.upsertPerson({
    name: "Percent 100% Match",
    profileUrl: "https://www.linkedin.com/in/percent-match/",
  });
  const percentLookalike = db.upsertPerson({
    name: "Percent 100X Match",
    profileUrl: "https://www.linkedin.com/in/percent-lookalike/",
  });
  const underscore = db.upsertPerson({
    name: "Under A_B Match",
    profileUrl: "https://www.linkedin.com/in/under-a-b-match/",
  });
  const underscoreLookalike = db.upsertPerson({
    name: "Under ACB Match",
    profileUrl: "https://www.linkedin.com/in/under-acb-match/",
  });
  db.setPersonFeedMembership(percent.id, [feed.id]);
  db.setPersonFeedMembership(percentLookalike.id, [feed.id]);
  db.setPersonFeedMembership(underscore.id, [feed.id]);
  db.setPersonFeedMembership(underscoreLookalike.id, [feed.id]);

  assert.deepEqual(
    db.listPeople("100%", feed.id).map((person) => person.name),
    ["Percent 100% Match"],
  );
  assert.deepEqual(
    db.listPeople("a_b", feed.id).map((person) => person.name),
    ["Under A_B Match"],
  );
});

test("people search normalizes copied LinkedIn profile urls", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("People URL Search", 15);
  const person = db.upsertPerson({
    name: "Tracked Profile Search",
    profileUrl: "https://www.linkedin.com/in/tracked-profile-search/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  assert.deepEqual(
    db
      .listPeople(
        "<https://www.linkedin.com/in/tracked-profile-search/?miniProfileUrn=abc&utm_source=share>",
        feed.id,
      )
      .map((currentPerson) => currentPerson.name),
    ["Tracked Profile Search"],
  );
});

test("feed-scoped people listing keeps complete membership metadata", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("People Membership A", 15);
  const feedB = db.createFeed("People Membership B", 15);
  const feedC = db.createFeed("People Membership C", 15);
  const person = db.upsertPerson({
    name: "Multi Feed Member",
    profileUrl: "https://www.linkedin.com/in/multi-feed-member/",
  });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id, feedC.id]);

  const scoped = db.listPeople("multi", feedB.id);

  assert.equal(scoped.length, 1);
  assert.deepEqual(new Set(scoped[0].feedIds), new Set([feedA.id, feedB.id, feedC.id]));
});

test("feed member lookup returns compact ordered members for refresh work", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Compact Members A", 15);
  const feedB = db.createFeed("Compact Members B", 15);
  const alpha = db.upsertPerson({
    name: "Alpha Compact Member",
    profileUrl: "https://www.linkedin.com/in/alpha-compact-member/",
  });
  const beta = db.upsertPerson({
    name: "Beta Compact Member",
    profileUrl: "https://www.linkedin.com/in/beta-compact-member/",
  });
  const gamma = db.upsertPerson({
    name: "Gamma Other Member",
    profileUrl: "https://www.linkedin.com/in/gamma-other-member/",
  });
  db.setPersonFeedMembership(beta.id, [feedA.id]);
  db.setPersonFeedMembership(alpha.id, [feedA.id, feedB.id]);
  db.setPersonFeedMembership(gamma.id, [feedB.id]);

  const members = db.listFeedMembers(feedA.id);

  assert.deepEqual(
    members.map((member) => member.name),
    ["Alpha Compact Member", "Beta Compact Member"],
  );
  assert.deepEqual(Object.keys(members[0]).sort(), ["id", "name", "profileUrl"]);
});

test("feed-scoped people listing starts from indexed feed memberships", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const listPeople = source.slice(source.indexOf("listPeople("), source.indexOf("getPerson(id: string)"));
  const searchHelper = source.slice(source.indexOf("function normalizePeopleSearchQuery"), source.indexOf("function normalizeFeedName"));

  assert.match(source, /const MAX_PEOPLE_SEARCH_QUERY_LENGTH = 240;/);
  assert.match(listPeople, /const cleanQuery = normalizePeopleSearchQuery\(query\);/);
  assert.match(listPeople, /FROM feed_people scope INDEXED BY idx_feed_people_feed/);
  assert.match(listPeople, /JOIN people p ON p\.id = scope\.person_id/);
  assert.match(listPeople, /WHERE scope\.feed_id = \?/);
  assert.doesNotMatch(listPeople, /EXISTS \(SELECT 1 FROM feed_people fpf/);
  assert.match(searchHelper, /const normalizedProfileUrl = normalizeLinkedInProfileUrl\(cleanQuery\);/);
  assert.match(searchHelper, /cleanQuery\.slice\(0, MAX_PEOPLE_SEARCH_QUERY_LENGTH\)/);
});

test("feed member lookup starts from indexed feed memberships", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const listFeedMembers = source.slice(source.indexOf("listFeedMembers("), source.indexOf("getPerson(id: string)"));

  assert.match(listFeedMembers, /FROM feed_people scope INDEXED BY idx_feed_people_feed/);
  assert.match(listFeedMembers, /JOIN people p ON p\.id = scope\.person_id/);
  assert.match(listFeedMembers, /WHERE scope\.feed_id = \?/);
  assert.doesNotMatch(listFeedMembers, /GROUP_CONCAT/);
  assert.doesNotMatch(listFeedMembers, /comment_count AS commentCount/);
});

test("refresh sessions use compact feed member lookup for target work", () => {
  const source = fs.readFileSync(path.resolve("electron", "refreshSessions.ts"), "utf8");

  assert.match(source, /const people = this\.db\.listFeedMembers\(feedId\);/);
  assert.match(source, /activePeople = this\.db\.listFeedMembers\(feedId\);/);
  assert.match(source, /syncFeedMemberships\(feedIds: string\[\]\)/);
  assert.match(source, /this\.syncPendingTargets\(session, this\.db\.listFeedMembers\(feed\.id\)\)/);
  assert.doesNotMatch(source, /this\.db\.listPeople\("", feedId\)/);
  assert.doesNotMatch(source, /this\.db\.listPeople\("", feed\.id\)/);
});

test("refresh membership checks use the feed-person composite key without counting", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const membershipCheck = source.slice(source.indexOf("isPersonInFeed(personId"), source.indexOf("private remainingFeedCapacity"));

  assert.match(
    membershipCheck,
    /SELECT 1 AS found FROM feed_people WHERE feed_id = \? AND person_id = \? LIMIT 1/,
  );
  assert.match(membershipCheck, /\[feedId, personId\]/);
  assert.doesNotMatch(membershipCheck, /COUNT\(\*\)/);
  assert.doesNotMatch(membershipCheck, /WHERE person_id = \? AND feed_id = \?/);
});

test("feed membership helper counts and lookups use membership indexes", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const feedIdsForPerson = source.slice(source.indexOf("private feedIdsForPerson"), source.indexOf("private personIdsInFeed"));
  const personIdsInFeed = source.slice(source.indexOf("private personIdsInFeed"), source.indexOf("private unlinkPersonItemsFromFeeds"));
  const remainingCapacity = source.slice(source.indexOf("private remainingFeedCapacity"), source.indexOf("private validateFeedIds"));

  assert.match(feedIdsForPerson, /FROM feed_people fp INDEXED BY idx_feed_people_person/);
  assert.match(feedIdsForPerson, /WHERE fp\.person_id = \?/);
  assert.match(personIdsInFeed, /FROM feed_people INDEXED BY idx_feed_people_feed WHERE feed_id = \?/);
  assert.match(remainingCapacity, /SELECT COUNT\(\*\) AS count FROM feed_people INDEXED BY idx_feed_people_feed WHERE feed_id = \?/);
  assert.doesNotMatch(feedIdsForPerson, /FROM feed_people fp\s+JOIN feeds/);
  assert.doesNotMatch(personIdsInFeed, /SELECT person_id AS personId FROM feed_people WHERE feed_id = \?/);
  assert.doesNotMatch(remainingCapacity, /SELECT COUNT\(\*\) AS count FROM feed_people WHERE feed_id = \?/);
});

test("capture member lookup starts from indexed feed memberships and public ids", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const lookup = source.slice(source.indexOf("private feedMemberIndex"), source.indexOf("isPersonInFeed"));

  assert.match(lookup, /FROM feed_people scope INDEXED BY idx_feed_people_feed/);
  assert.match(lookup, /JOIN people p ON p\.id = scope\.person_id/);
  assert.match(lookup, /WHERE scope\.feed_id = \?/);
  assert.match(lookup, /const byProfileUrl = new Map<string, FeedMember>\(\);/);
  assert.match(lookup, /const byPublicId = new Map<string, FeedMember>\(\);/);
  assert.match(lookup, /publicIdFromProfileUrl\(profileUrl\)\.toLowerCase\(\)/);
  assert.match(lookup, /index\.byPublicId\.get\(profilePublicId\)/);
  assert.doesNotMatch(lookup, /FROM people p\s+JOIN feed_people fp ON fp\.person_id = p\.id/);
});

test("capture duplicate external id lookup is batched per request", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const capture = source.slice(source.indexOf("captureItems(feedId: string"), source.indexOf("captureItemsForFeeds("));
  const lookup = source.slice(source.indexOf("private existingCapturedItemsByExternalId"), source.indexOf("private unlinkItemFromFeed"));

  assert.match(capture, /const existingItemsByExternalId = this\.existingCapturedItemsByExternalId\(\s+normalizedItems\.map\(\(item\) => item\.externalId\),\s+\);/);
  assert.match(capture, /existingItemsByExternalId\.get\(externalId\) \|\|/);
  assert.doesNotMatch(capture, /FROM items WHERE external_id = \?/);
  assert.match(lookup, /const uniqueExternalIds = \[\.\.\.new Set\(externalIds\.filter\(Boolean\)\)\];/);
  assert.match(lookup, /for \(const externalIdsChunk of chunkStrings\(uniqueExternalIds\)\) \{/);
  assert.match(lookup, /WHERE external_id IN \(\$\{placeholdersFor\(externalIdsChunk\)\}\)/);
  assert.match(lookup, /items\.set\(row\.externalId, row\);/);
});

test("capture rejects malformed item payloads before feed lookups", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const capture = source.slice(source.indexOf("captureItems(feedId: string"), source.indexOf("captureItemsForFeeds("));
  const multiCapture = source.slice(source.indexOf("captureItemsForFeeds("), source.indexOf("private upsertPersonUnsafe"));

  assert.ok(capture.indexOf('throw new AppError("Captured items must be an array.", 400);') < capture.indexOf("const feed = this.getFeed(feedId);"));
  assert.ok(capture.indexOf("received: items.length,") > capture.indexOf('throw new AppError("Captured items must be an array.", 400);'));
  assert.ok(multiCapture.indexOf('throw new AppError("Captured items must be an array.", 400);') < multiCapture.indexOf("const existingFeedIds = this.existingCaptureFeedIds(cleanFeedIds);"));
});

test("api scalar feed id inputs use non-blank validation", () => {
  const source = fs.readFileSync(path.resolve("electron", "api.ts"), "utf8");
  const itemStatus = source.slice(source.indexOf("function itemStatusInput"), source.indexOf("function captureItemsInput"));
  const captureItems = source.slice(source.indexOf("function captureItemsInput"), source.indexOf("function captureItemsForFeedsInput"));
  const refreshCreate = source.slice(source.indexOf("function refreshCreateInput"), source.indexOf("function refreshHeartbeatInput"));

  assert.match(itemStatus, /feedId: optionalNonBlankStringField\(body, "feedId", "Queue feed id"\)/);
  assert.match(captureItems, /feedId: requiredNonBlankStringField\(body, "feedId", "Capture feed id"\)/);
  assert.match(refreshCreate, /feedId: requiredNonBlankStringField\(body, "feedId", "Refresh feed id"\)/);
  assert.match(source, /function validateNonBlankString\(value: string, label: string\)/);
  assert.match(source, /throw new AppError\(`\$\{label\} must not be blank\.`/);
  assert.match(source, /throw new AppError\(`\$\{label\} must not have surrounding whitespace\.`/);
});

test("feed id membership helpers chunk large SQL parameter lists", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const unlink = source.slice(source.indexOf("private unlinkPersonItemsFromFeeds"), source.indexOf("private feedMembersByProfileUrl"));
  const validate = source.slice(source.indexOf("private validateFeedIds"), source.indexOf("private assertFeedCapacity"));
  const existingSet = source.slice(source.indexOf("private existingFeedIdSet"), source.indexOf("private assertFeedCapacity"));
  const capacity = source.slice(source.indexOf("private assertFeedCapacity"), source.indexOf("private assertFeedNameAvailable"));

  assert.match(unlink, /for \(const feedIdsChunk of chunkStrings\(feedIds\)\) \{/);
  assert.match(unlink, /WHERE feed_id IN \(\$\{placeholdersFor\(feedIdsChunk\)\}\)/);
  assert.match(validate, /const existing = this\.existingFeedIdSet\(cleanFeedIds\);/);
  assert.match(existingSet, /for \(const feedIdsChunk of chunkStrings\(feedIds\)\) \{/);
  assert.match(existingSet, /SELECT id FROM feeds WHERE id IN \(\$\{placeholdersFor\(feedIdsChunk\)\}\)/);
  assert.match(capacity, /for \(const feedIdsChunk of chunkStrings\(feedIds\)\) \{/);
  assert.match(capacity, /LEFT JOIN feed_people fp ON fp\.feed_id = f\.id AND fp\.person_id != \?/);
  assert.match(capacity, /HAVING count >= \?/);
  assert.match(capacity, /\[personId, \.\.\.feedIdsChunk, MAX_PEOPLE_PER_FEED\]/);
  assert.doesNotMatch(capacity, /SELECT COUNT\(\*\) AS count FROM feed_people WHERE feed_id = \? AND person_id != \?/);
});

test("idempotency pruning skips expensive deletes until a prefix exceeds the cap", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const classFields = source.slice(source.indexOf("export class AppDatabase"), source.indexOf("constructor(private readonly dbPath"));
  const prune = source.slice(source.indexOf("private pruneIdempotencyState"), source.indexOf("private save()"));

  assert.match(classFields, /private idempotencyPrefixCounts = new Map<string, number>\(\);/);
  assert.match(prune, /const count = this\.idempotencyPrefixCount\(prefix\);/);
  assert.match(prune, /if \(count <= MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX\) \{\s+return;\s+\}/);
  assert.match(prune, /const prefixPattern = `\$\{escapeSqlLikePattern\(prefix\)\}%`;/);
  assert.match(prune, /DELETE FROM app_state/);
  assert.match(prune, /WHERE key LIKE \? ESCAPE '\^'/);
  assert.match(prune, /this\.idempotencyPrefixCounts\.set\(prefix, Math\.max\(0, count - deleted\)\);/);
  assert.match(prune, /private idempotencyPrefixCount\(prefix: string\)/);
  assert.match(prune, /const cached = this\.idempotencyPrefixCounts\.get\(prefix\);/);
  assert.match(prune, /SELECT COUNT\(\*\) AS count FROM app_state WHERE key LIKE \? ESCAPE '\^'/);
  assert.match(prune, /this\.idempotencyPrefixCounts\.set\(prefix, count\);/);
  assert.match(prune, /private incrementIdempotencyPrefixCount\(key: string\)/);
  assert.match(prune, /this\.idempotencyPrefixCount\(prefix\) \+ 1/);
  assert.match(prune, /private decrementIdempotencyPrefixCount\(prefix: string\)/);
  assert.doesNotMatch(prune, /\[`\$\{prefix\}%`/);
});

test("bulk import adds people in one transaction and reports duplicates", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Bulk Import", 15);

  const result = db.bulkAddPeopleToFeed(feed.id, [
    { name: "Alpha", profileUrl: "linkedin.com/in/bulk-alpha/" },
    { name: "Beta", profileUrl: "https://www.linkedin.com/in/bulk-beta/" },
    { name: "Alpha Duplicate", profileUrl: "https://www.linkedin.com/in/bulk-alpha/" },
    { name: "Invalid", profileUrl: "not a linkedin profile" },
  ]);

  assert.equal(result.added, 2);
  assert.equal(result.skippedInvalid, 2);
  assert.equal(result.remainingCapacity, MAX_PEOPLE_PER_FEED - 2);
  assert.equal(db.listPeople("", feed.id).length, 2);
});

test("bulk import detects duplicate public ids case-insensitively", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Bulk Public Id Duplicate", 15);

  const result = db.bulkAddPeopleToFeed(feed.id, [
    { name: "Case Original", profileUrl: "https://www.linkedin.com/in/MixedCase-Bulk/" },
    { name: "Case Duplicate", profileUrl: "https://www.linkedin.com/in/mixedcase-bulk/" },
  ]);

  assert.equal(result.added, 1);
  assert.equal(result.skippedInvalid, 1);
  assert.equal(result.errors[0].index, 1);
  assert.match(result.errors[0].error, /Duplicate profile/);
  assert.equal(result.remainingCapacity, MAX_PEOPLE_PER_FEED - 1);
  assert.equal(db.listPeople("", feed.id).length, 1);
});

test("bulk import keeps oversized pastes as partial results", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Bulk Oversized Paste", 15);
  const people = Array.from({ length: MAX_PEOPLE_PER_FEED + 2 }, (_value, index) => ({
    name: `Bulk Oversized ${index}`,
    profileUrl: `https://www.linkedin.com/in/bulk-oversized-${index}/`,
  }));

  const result = db.bulkAddPeopleToFeed(feed.id, people);

  assert.equal(result.received, MAX_PEOPLE_PER_FEED + 2);
  assert.equal(result.added, MAX_PEOPLE_PER_FEED);
  assert.equal(result.skippedInvalid, 0);
  assert.equal(result.skippedCapacity, 2);
  assert.equal(result.remainingCapacity, 0);
  assert.equal(result.errors[0].index, MAX_PEOPLE_PER_FEED);
  assert.match(result.errors[0].error, /is full/);
  assert.equal(db.listPeople("", feed.id).length, MAX_PEOPLE_PER_FEED);
  assert.equal(db.getProfileStatus("https://www.linkedin.com/in/bulk-oversized-200/").person, undefined);
});

test("bulk import does not let invalid pasted rows consume valid import slots", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Bulk Invalid Slot Recovery", 15);
  const people = [
    { name: "Invalid 1", profileUrl: "not linkedin" },
    { name: "Invalid 2", profileUrl: "https://example.com/in/nope/" },
    ...Array.from({ length: MAX_PEOPLE_PER_FEED }, (_value, index) => ({
      name: `Bulk Slot Recovery ${index}`,
      profileUrl: `https://www.linkedin.com/in/bulk-slot-recovery-${index}/`,
    })),
  ];

  const result = db.bulkAddPeopleToFeed(feed.id, people);

  assert.equal(result.received, MAX_PEOPLE_PER_FEED + 2);
  assert.equal(result.added, MAX_PEOPLE_PER_FEED);
  assert.equal(result.skippedInvalid, 2);
  assert.equal(result.skippedCapacity, 0);
  assert.equal(result.remainingCapacity, 0);
  assert.equal(db.listPeople("", feed.id).length, MAX_PEOPLE_PER_FEED);
  assert.ok(db.getProfileStatus("https://www.linkedin.com/in/bulk-slot-recovery-199/").person);
});

test("bulk import caps detailed errors while preserving skipped counts", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Bulk Error Detail Cap", 15);
  const people = Array.from({ length: 80 }, (_value, index) => ({
    name: `Invalid Bulk ${index}`,
    profileUrl: `https://example.com/in/not-linkedin-${index}/`,
  }));

  const result = db.bulkAddPeopleToFeed(feed.id, people);

  assert.equal(result.received, 80);
  assert.equal(result.added, 0);
  assert.equal(result.skippedInvalid, 80);
  assert.equal(result.skippedCapacity, 0);
  assert.equal(result.errors.length, 50);
  assert.equal(result.errors[0].index, 0);
  assert.equal(result.errors[49].index, 49);
  assert.equal(db.listPeople("", feed.id).length, 0);
});

test("bulk import reuses existing people without consuming capacity for existing members", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Bulk Existing Capacity", 15);
  const otherFeed = db.createFeed("Bulk Existing Other", 15);
  const inFeed = db.addPersonToFeed(feed.id, {
    name: "Existing Member",
    profileUrl: "https://www.linkedin.com/in/existing-member/",
  });
  const outsideFeed = db.addPersonToFeed(otherFeed.id, {
    name: "Outside Member",
    profileUrl: "https://www.linkedin.com/in/outside-member/",
  });

  const result = db.bulkAddPeopleToFeed(feed.id, [
    { name: "Existing Member Renamed", profileUrl: inFeed.profileUrl },
    { name: "Outside Member Added", profileUrl: outsideFeed.profileUrl },
  ]);

  assert.equal(result.alreadyInFeed, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.added, 1);
  assert.equal(result.remainingCapacity, MAX_PEOPLE_PER_FEED - 2);
  assert.deepEqual(new Set(db.getPerson(outsideFeed.id).feedIds), new Set([otherFeed.id, feed.id]));
  assert.equal(db.listPeople("", feed.id).length, 2);
});

test("bulk import profile-only existing people preserves useful display names", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Bulk Name Preserve Target", 15);
  const otherFeed = db.createFeed("Bulk Name Preserve Source", 15);
  const person = db.addPersonToFeed(otherFeed.id, {
    name: "Recognizable Existing Name",
    profileUrl: "https://www.linkedin.com/in/bulk-name-preserve/",
  });

  const result = db.bulkAddPeopleToFeed(feed.id, [
    {
      profileUrl: "https://www.linkedin.com/in/bulk-name-preserve/",
    },
  ]);

  assert.equal(result.added, 1);
  assert.equal(db.getPerson(person.id).name, "Recognizable Existing Name");
  assert.deepEqual(new Set(db.getPerson(person.id).feedIds), new Set([otherFeed.id, feed.id]));
});

test("bulk import prefers exact profile matches over stale public id matches", async () => {
  const { db } = await createTestDb();
  const targetFeed = db.createFeed("Bulk Exact Profile Target", 15);
  const sourceFeed = db.createFeed("Bulk Exact Profile Source", 15);
  const conflictFeed = db.createFeed("Bulk Stale Public Source", 15);
  const exactProfilePerson = db.addPersonToFeed(sourceFeed.id, {
    name: "Exact Profile Person",
    profileUrl: "https://www.linkedin.com/in/bulk-exact-profile/",
  });
  const conflictingPublicIdPerson = db.addPersonToFeed(conflictFeed.id, {
    name: "Conflicting Public Id Person",
    profileUrl: "https://www.linkedin.com/in/bulk-conflicting-public-id/",
  });
  db.db.run("UPDATE people SET public_id = ? WHERE id = ?", ["stale-exact-profile", exactProfilePerson.id]);
  db.db.run("UPDATE people SET public_id = ? WHERE id = ?", ["bulk-exact-profile", conflictingPublicIdPerson.id]);

  const result = db.bulkAddPeopleToFeed(targetFeed.id, [
    {
      name: "Exact Profile Person",
      profileUrl: "https://www.linkedin.com/in/bulk-exact-profile/",
    },
  ]);

  assert.equal(result.added, 1);
  assert.deepEqual(new Set(db.getPerson(exactProfilePerson.id).feedIds), new Set([sourceFeed.id, targetFeed.id]));
  assert.deepEqual(new Set(db.getPerson(conflictingPublicIdPerson.id).feedIds), new Set([conflictFeed.id]));
  assert.equal(db.getPerson(exactProfilePerson.id).publicId, "bulk-exact-profile");
});

test("bulk import only uses public-id fallback for profile-url misses", async () => {
  const { db } = await createTestDb();
  const targetFeed = db.createFeed("Bulk Fallback Target", 15);
  const sourceFeed = db.createFeed("Bulk Fallback Source", 15);
  const exact = db.addPersonToFeed(sourceFeed.id, {
    name: "Bulk Exact Fallback Person",
    profileUrl: "https://www.linkedin.com/in/bulk-exact-fallback/",
  });
  const mixedCase = db.addPersonToFeed(sourceFeed.id, {
    name: "Bulk Mixed Fallback Person",
    profileUrl: "https://www.linkedin.com/in/Bulk-Mixed-Fallback/",
  });

  const originalPublicIdLookup = db.peopleByPublicIds.bind(db);
  const fallbackRequests = [];
  db.peopleByPublicIds = (publicIds) => {
    fallbackRequests.push([...publicIds]);
    return originalPublicIdLookup(publicIds);
  };

  const result = db.bulkAddPeopleToFeed(targetFeed.id, [
    { name: "Bulk Exact Fallback Person", profileUrl: "https://www.linkedin.com/in/bulk-exact-fallback/" },
    { name: "Bulk Mixed Fallback Person", profileUrl: "https://www.linkedin.com/in/bulk-mixed-fallback/" },
  ]);

  assert.equal(result.added, 2);
  assert.deepEqual(fallbackRequests, [["bulk-mixed-fallback"]]);
  assert.deepEqual(new Set(db.getPerson(exact.id).feedIds), new Set([sourceFeed.id, targetFeed.id]));
  assert.deepEqual(new Set(db.getPerson(mixedCase.id).feedIds), new Set([sourceFeed.id, targetFeed.id]));
});

test("bulk import batches existing profile-url lookups", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const bulkImportStart = source.indexOf("bulkAddPeopleToFeed(feedId");
  const bulkImport = source.slice(bulkImportStart, source.indexOf("getProfileStatus(profileUrl", bulkImportStart));
  const peopleByProfileUrls = source.slice(source.indexOf("private peopleByProfileUrls"), source.indexOf("private feedIdsByPersonIds"));
  const peopleByPublicIds = source.slice(source.indexOf("private peopleByPublicIds"), source.indexOf("private peopleByProfileUrls"));
  const feedIdsByPersonIds = source.slice(source.indexOf("private feedIdsByPersonIds"), source.indexOf("private personByWhere"));

  assert.match(
    bulkImport,
    /const peopleNeedingPublicIdFallback = peopleToProcess\.filter\(\s+\(person\) => !existingPeopleByProfileUrl\.has\(person\.profileUrl\),\s+\);/,
  );
  assert.match(
    bulkImport,
    /peopleNeedingPublicIdFallback\.length > 0\s+\? this\.peopleByPublicIds\(peopleNeedingPublicIdFallback\.map\(\(person\) => person\.publicId\)\)\s+: new Map<string, Person>\(\);/,
  );
  assert.match(bulkImport, /const existingPeopleByProfileUrl = this\.peopleByProfileUrls\(peopleToProcess\.map\(\(person\) => person\.profileUrl\)\);/);
  assert.match(
    bulkImport,
    /const existing =\s+existingPeopleByProfileUrl\.get\(raw\.profileUrl\) \|\|\s+existingPeopleByPublicId\.get\(raw\.duplicateKey\)/,
  );
  assert.doesNotMatch(bulkImport, /this\.findPersonByProfileUrl\(raw\.profileUrl\)/);
  assert.doesNotMatch(bulkImport, /this\.findPersonByPublicId\(raw\.publicId\)/);
  assert.doesNotMatch(bulkImport, /this\.findPersonByPublicId\(raw\.duplicateKey\)/);
  assert.match(source, /private peopleByProfileUrls\(profileUrls: string\[\]\): Map<string, Person>/);
  assert.match(source, /private peopleByPublicIds\(publicIds: string\[\]\): Map<string, Person>/);
  assert.match(peopleByProfileUrls, /const feedIdsByPersonId = this\.feedIdsByPersonIds\(rows\.map\(\(row\) => row\.id\)\);/);
  assert.match(peopleByPublicIds, /const feedIdsByPersonId = this\.feedIdsByPersonIds\(rows\.map\(\(row\) => row\.id\)\);/);
  assert.doesNotMatch(peopleByProfileUrls, /orderedPersonFeedIdsSql/);
  assert.doesNotMatch(peopleByPublicIds, /orderedPersonFeedIdsSql/);
  assert.match(feedIdsByPersonIds, /FROM feed_people fp INDEXED BY idx_feed_people_person/);
  assert.match(feedIdsByPersonIds, /WHERE fp\.person_id IN \(\$\{placeholdersFor\(personIdsChunk\)\}\)/);
  assert.match(feedIdsByPersonIds, /ORDER BY f\.name COLLATE NOCASE ASC, fp\.feed_id ASC/);
});

test("bulk import retry does not report unchanged existing members as updates", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Bulk Retry Noop", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Bulk Retry Existing",
    profileUrl: "https://www.linkedin.com/in/bulk-retry-existing/",
  });

  const result = db.bulkAddPeopleToFeed(feed.id, [
    { name: person.name, profileUrl: person.profileUrl },
  ]);

  assert.equal(result.added, 0);
  assert.equal(result.alreadyInFeed, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.remainingCapacity, MAX_PEOPLE_PER_FEED - 1);
});

test("bulk import only reports added rows for inserted memberships", () => {
  const source = fs.readFileSync(path.resolve("electron", "database.ts"), "utf8");
  const bulkImportStart = source.indexOf("bulkAddPeopleToFeed(feedId");
  const bulkImport = source.slice(bulkImportStart, source.indexOf("getProfileStatus(profileUrl", bulkImportStart));

  assert.match(bulkImport, /const membershipInserted = this\.db\.getRowsModified\(\) > 0;/);
  assert.match(
    bulkImport,
    /if \(membershipInserted\) \{\s+feedMemberIds\.add\(person\.id\);\s+result\.added \+= 1;\s+result\.remainingCapacity -= 1;\s+\} else \{\s+result\.alreadyInFeed \+= 1;\s+\}/,
  );
  assert.doesNotMatch(bulkImport, /const membershipInserted = this\.db\.getRowsModified\(\) > 0;\s+feedMemberIds\.add\(person\.id\);\s+result\.added \+= 1;/);
});

test("bulk import retries replay the original result", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Bulk Idempotent Retry", 15);
  const people = [
    { name: "Bulk Retry Added", profileUrl: "https://www.linkedin.com/in/bulk-idempotent-retry/" },
  ];

  const first = db.bulkAddPeopleToFeed(feed.id, people, { requestId: "bulk-lost-response-1" });
  const duplicate = db.bulkAddPeopleToFeed(feed.id, people, { requestId: "bulk-lost-response-1" });
  const normalRetry = db.bulkAddPeopleToFeed(feed.id, people);

  assert.equal(first.added, 1);
  assert.equal(first.alreadyInFeed, 0);
  assert.deepEqual(duplicate, first);
  assert.equal(normalRetry.added, 0);
  assert.equal(normalRetry.alreadyInFeed, 1);

  const reopened = await reopenTestDb(dbPath);
  const afterRestartDuplicate = reopened.bulkAddPeopleToFeed(feed.id, people, { requestId: "bulk-lost-response-1" });
  assert.deepEqual(afterRestartDuplicate, first);
  assert.equal(reopened.listPeople("", feed.id).length, 1);
});

test("bulk import retries replay even after the feed is deleted", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Bulk Deleted Retry", 15);
  const people = [
    { name: "Bulk Deleted Replay", profileUrl: "https://www.linkedin.com/in/bulk-deleted-replay/" },
  ];

  const first = db.bulkAddPeopleToFeed(feed.id, people, { requestId: "bulk-deleted-retry-1" });
  db.deleteFeed(feed.id);
  const duplicate = db.bulkAddPeopleToFeed(feed.id, people, { requestId: "bulk-deleted-retry-1" });

  assert.equal(first.added, 1);
  assert.deepEqual(duplicate, first);
});

test("bulk import does not create orphan people when feed is full", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Full Feed", 15);

  for (let index = 0; index < MAX_PEOPLE_PER_FEED; index += 1) {
    const person = db.upsertPerson({
      name: `Full ${index}`,
      profileUrl: `https://www.linkedin.com/in/full-${index}/`,
    });
    db.setPersonFeedMembership(person.id, [feed.id]);
  }

  const result = db.bulkAddPeopleToFeed(feed.id, [
    { name: "Overflow Bulk", profileUrl: "https://www.linkedin.com/in/overflow-bulk/" },
  ]);

  assert.equal(result.added, 0);
  assert.equal(result.skippedCapacity, 1);
  assert.equal(db.getProfileStatus("https://www.linkedin.com/in/overflow-bulk/").person, undefined);
});

test("refresh sessions reuse an active run for the same feed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Reuse", 15);

  for (let index = 0; index < 40; index += 1) {
    const person = db.upsertPerson({
      name: `Refresh ${index}`,
      profileUrl: `https://www.linkedin.com/in/refresh-${index}/`,
    });
    db.setPersonFeedMembership(person.id, [feed.id]);
  }

  const manager = new RefreshSessionManager(db);
  const first = manager.create(feed.id, { requestId: "same-start-click" });
  const second = manager.create(feed.id, { requestId: "different-start-click" });
  const retried = manager.create(feed.id, { requestId: "same-start-click" });

  assert.equal(second.id, first.id);
  assert.equal(retried.id, first.id);
  assert.equal(first.createdByRequest, true);
  assert.equal(second.createdByRequest, false);
  assert.equal(retried.createdByRequest, true);
  assert.equal(first.totalTargets, 80);
  assert.equal(first.delayMs, 3200);
});

test("refresh session ids use cryptographic uuids with the stable app prefix", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Ids", 15);
  db.addPersonToFeed(feed.id, {
    name: "Refresh Id Person",
    profileUrl: "https://www.linkedin.com/in/refresh-id-person/",
  });

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);

  assert.match(
    session.id,
    /^refresh_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  const source = fs.readFileSync(path.resolve("electron/refreshSessions.ts"), "utf8");
  const createStart = source.indexOf("create(feedId: string");
  const createEnd = source.indexOf("  list(feedId?: string)");
  const createSource = source.slice(createStart, createEnd);

  assert.match(source, /import \{ createHash, randomUUID \} from "node:crypto";/);
  assert.match(source, /function createRefreshSessionId\(\) \{\s+return `refresh_\$\{randomUUID\(\)\}`;\s+\}/);
  assert.match(createSource, /const id = createRefreshSessionId\(\);/);
  assert.doesNotMatch(createSource, /Math\.random/);
  assert.doesNotMatch(createSource, /Date\.now\(\)\.toString\(36\)/);
});

test("refresh session creation retries replay remembered finished sessions", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Finished Start Replay", 15);
  db.addPersonToFeed(feed.id, {
    name: "Finished Start Replay Person",
    profileUrl: "https://www.linkedin.com/in/finished-start-replay-person/",
  });

  const manager = new RefreshSessionManager(db);
  const first = manager.create(feed.id, { requestId: "finished-start-replay-1" });
  const emptyCapture = { received: 0, inserted: 0, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 };
  manager.recordTargetComplete(first.id, { targetIndex: 0, captureResult: emptyCapture });
  const finished = manager.recordTargetComplete(first.id, { targetIndex: 1, captureResult: emptyCapture });
  const retried = manager.create(feed.id, { requestId: "finished-start-replay-1" });

  assert.equal(finished.status, "done");
  assert.equal(retried.id, first.id);
  assert.equal(retried.status, "done");
  assert.equal(retried.createdByRequest, true);
  assert.equal(manager.list().filter((session) => session.status === "running").length, 0);
  assert.equal(manager.list().length, 1);
});

test("refresh session creation retries replay remembered sessions after restart", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Refresh Start Replay After Restart", 15);
  db.addPersonToFeed(feed.id, {
    name: "Restart Start Replay Person",
    profileUrl: "https://www.linkedin.com/in/restart-start-replay-person/",
  });

  const manager = new RefreshSessionManager(db);
  const first = manager.create(feed.id, { requestId: "restart-start-replay-1" });
  const stopped = manager.cancel(first.id);

  assert.equal(stopped.status, "canceled");

  const reopened = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(reopened);
  const retried = restoredManager.create(feed.id, { requestId: "restart-start-replay-1" });

  assert.equal(retried.id, first.id);
  assert.equal(retried.status, "canceled");
  assert.equal(retried.createdByRequest, true);
  assert.equal(restoredManager.list().filter((session) => session.status === "running").length, 0);
});

test("refresh sessions reject concurrent runs across feeds", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Refresh One At A Time A", 15);
  const feedB = db.createFeed("Refresh One At A Time B", 15);
  db.addPersonToFeed(feedA.id, {
    name: "Single Runner Alpha",
    profileUrl: "https://www.linkedin.com/in/single-runner-alpha/",
  });
  db.addPersonToFeed(feedB.id, {
    name: "Single Runner Beta",
    profileUrl: "https://www.linkedin.com/in/single-runner-beta/",
  });

  const manager = new RefreshSessionManager(db);
  const first = manager.create(feedA.id);

  assert.throws(
    () => manager.create(feedB.id),
    (error) => {
      assert.equal(error instanceof AppError, true);
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /Refresh One At A Time A/);
      assert.match(error.message, /Refresh One At A Time B/);
      return true;
    },
  );
  assert.equal(manager.get(first.id).status, "running");
  assert.equal(manager.list().filter((session) => session.status === "running").length, 1);
});

test("restored refresh sessions keep only the newest running session", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Restored Running A", 15);
  const feedB = db.createFeed("Restored Running B", 15);
  const alpha = db.addPersonToFeed(feedA.id, {
    name: "Restored Running Alpha",
    profileUrl: "https://www.linkedin.com/in/restored-running-alpha/",
  });
  const beta = db.addPersonToFeed(feedB.id, {
    name: "Restored Running Beta",
    profileUrl: "https://www.linkedin.com/in/restored-running-beta/",
  });

  const manager = new RefreshSessionManager(db, { now: () => new Date("2026-05-01T12:00:00.000Z") });
  const older = manager.create(feedA.id);
  const persisted = db.getAppState("refreshSessions.v1").value;
  const olderPersisted = persisted.sessions.find((session) => session.id === older.id);
  const newerPersisted = {
    ...olderPersisted,
    id: "refresh_newer_restored_running",
    feedId: feedB.id,
    feedName: feedB.name,
    createdAt: "2026-05-01T12:05:00.000Z",
    updatedAt: "2026-05-01T12:05:00.000Z",
    targets: [
      {
        index: 0,
        personId: beta.id,
        personName: beta.name,
        profileUrl: beta.profileUrl,
        kind: "posts",
        url: "https://www.linkedin.com/in/restored-running-beta/recent-activity/all/",
      },
      {
        index: 1,
        personId: beta.id,
        personName: beta.name,
        profileUrl: beta.profileUrl,
        kind: "comments",
        url: "https://www.linkedin.com/in/restored-running-beta/recent-activity/comments/",
      },
    ],
  };
  db.setAppState("refreshSessions.v1", {
    ...persisted,
    sessions: [
      {
        ...olderPersisted,
        createdAt: "2026-05-01T12:00:00.000Z",
        updatedAt: "2026-05-01T12:00:00.000Z",
      },
      newerPersisted,
    ],
  });

  const restoredManager = new RefreshSessionManager(db, { now: () => new Date("2026-05-01T12:10:00.000Z") });
  const restoredOlder = restoredManager.get(older.id);
  const restoredNewer = restoredManager.get("refresh_newer_restored_running");
  const persistedAfterRestore = db.getAppState("refreshSessions.v1").value;
  const savedOlder = persistedAfterRestore.sessions.find((session) => session.id === older.id);

  assert.equal(restoredOlder.status, "failed");
  assert.match(restoredOlder.lastError, /Restored Running B/);
  assert.equal(restoredOlder.updatedAt, "2026-05-01T12:10:00.000Z");
  assert.equal(restoredNewer.status, "running");
  assert.equal(restoredNewer.currentTarget.personId, beta.id);
  assert.equal(restoredManager.list().filter((session) => session.status === "running").length, 1);
  assert.equal(savedOlder.status, "failed");
  assert.equal(db.isPersonInFeed(alpha.id, feedA.id), true);
});

test("restored refresh sessions break created-at ties by latest update", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Restored Tie A", 15);
  const feedB = db.createFeed("Restored Tie B", 15);
  const alpha = db.addPersonToFeed(feedA.id, {
    name: "Restored Tie Alpha",
    profileUrl: "https://www.linkedin.com/in/restored-tie-alpha/",
  });
  const beta = db.addPersonToFeed(feedB.id, {
    name: "Restored Tie Beta",
    profileUrl: "https://www.linkedin.com/in/restored-tie-beta/",
  });

  const manager = new RefreshSessionManager(db, { now: () => new Date("2026-05-01T12:00:00.000Z") });
  const first = manager.create(feedA.id);
  const persisted = db.getAppState("refreshSessions.v1").value;
  const firstPersisted = persisted.sessions.find((session) => session.id === first.id);
  const secondPersisted = {
    ...firstPersisted,
    id: "refresh_same_created_newer_update",
    feedId: feedB.id,
    feedName: feedB.name,
    createdAt: firstPersisted.createdAt,
    updatedAt: "2026-05-01T12:04:00.000Z",
    targets: [
      {
        index: 0,
        personId: beta.id,
        personName: beta.name,
        profileUrl: beta.profileUrl,
        kind: "posts",
        url: "https://www.linkedin.com/in/restored-tie-beta/recent-activity/all/",
      },
      {
        index: 1,
        personId: beta.id,
        personName: beta.name,
        profileUrl: beta.profileUrl,
        kind: "comments",
        url: "https://www.linkedin.com/in/restored-tie-beta/recent-activity/comments/",
      },
    ],
  };
  db.setAppState("refreshSessions.v1", {
    ...persisted,
    sessions: [
      {
        ...firstPersisted,
        updatedAt: "2026-05-01T12:01:00.000Z",
      },
      secondPersisted,
    ],
  });

  const restoredManager = new RefreshSessionManager(db, { now: () => new Date("2026-05-01T12:10:00.000Z") });
  const listedSessions = restoredManager.list();
  const restoredFirst = restoredManager.get(first.id);
  const restoredSecond = restoredManager.get(secondPersisted.id);
  const active = restoredManager.getActive();

  assert.equal(listedSessions[0].id, secondPersisted.id);
  assert.equal(active.id, secondPersisted.id);
  assert.equal(restoredFirst.status, "failed");
  assert.match(restoredFirst.lastError, /Restored Tie B/);
  assert.equal(restoredSecond.status, "running");
  assert.equal(restoredSecond.currentTarget.personId, beta.id);
  assert.equal(db.isPersonInFeed(alpha.id, feedA.id), true);
});

test("refresh sessions expose the feed lookback cutoff to the Chrome helper", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Lookback", 21);
  const person = db.upsertPerson({
    name: "Lookback Person",
    profileUrl: "https://www.linkedin.com/in/lookback-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const now = new Date("2026-04-30T12:00:00.000Z");
  const manager = new RefreshSessionManager(db, { now: () => now });
  const session = manager.create(feed.id);

  assert.equal(session.lookbackDays, 21);
  assert.equal(session.lookbackCutoffAt, "2026-04-09T12:00:00.000Z");
  assert.equal(manager.get(session.id).lookbackCutoffAt, session.lookbackCutoffAt);
});

test("feed update api syncs running refresh feed settings", async () => {
  const portProbe = await listenOnLoopback();
  const port = portProbe.address().port;
  await closeServer(portProbe);

  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Refresh Settings Old", 21);
  const person = db.upsertPerson({
    name: "Refresh Settings Person",
    profileUrl: "https://www.linkedin.com/in/refresh-settings-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  let now = new Date("2026-04-30T12:00:00.000Z");
  const manager = new RefreshSessionManager(db, { now: () => now });
  const session = manager.create(feed.id);
  const server = await startApiServer(db, manager, [port]);

  try {
    now = new Date("2026-04-30T12:15:00.000Z");
    const response = await fetch(`${server.baseUrl}/api/feeds/${encodeURIComponent(feed.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Refresh Settings New", lookbackDays: 7 }),
    });
    const body = await response.json();
    const active = manager.get(session.id);

    assert.equal(response.ok, true);
    assert.equal(body.name, "Refresh Settings New");
    assert.equal(body.lookbackDays, 7);
    assert.equal(active.feedName, "Refresh Settings New");
    assert.equal(active.lookbackDays, 7);
    assert.equal(active.lookbackCutoffAt, "2026-04-23T12:15:00.000Z");
    assert.equal(active.status, "running");
    assert.equal(active.currentTarget.personId, person.id);

    const restoredDb = await reopenTestDb(dbPath);
    const restoredManager = new RefreshSessionManager(restoredDb, { now: () => now });
    const restored = restoredManager.get(session.id);

    assert.equal(restored.feedName, "Refresh Settings New");
    assert.equal(restored.lookbackDays, 7);
    assert.equal(restored.lookbackCutoffAt, "2026-04-23T12:15:00.000Z");
  } finally {
    await closeServer(server);
  }
});

test("refresh sessions update pending target details for renamed feed members", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Rename Pending", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Pending Rename Before",
    profileUrl: "https://www.linkedin.com/in/pending-rename-before/",
  });
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);

  db.addPersonToFeed(feed.id, {
    name: "Pending Rename After",
    profileUrl: person.profileUrl,
  });
  const synced = manager.syncFeedMembership(feed.id)[0];

  assert.equal(synced.status, "running");
  assert.equal(synced.totalTargets, 2);
  assert.equal(synced.currentTarget.personName, "Pending Rename After");
  assert.equal(synced.currentTarget.profileUrl, person.profileUrl);
  assert.match(synced.lastError, /updated 2 pending pages/);
});

test("refresh sessions ignore progress reports from the wrong LinkedIn activity page", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh URL Guard", 15);
  const alpha = db.upsertPerson({
    name: "Guard Alpha",
    profileUrl: "https://www.linkedin.com/in/guard-alpha/",
  });
  const beta = db.upsertPerson({
    name: "Guard Beta",
    profileUrl: "https://www.linkedin.com/in/guard-beta/",
  });
  db.setPersonFeedMembership(alpha.id, [feed.id]);
  db.setPersonFeedMembership(beta.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);

  const wrongProfile = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    url: `https://www.linkedin.com/in/guard-beta/recent-activity/all/?lefSession=${session.id}&lefTarget=0`,
    captureResult: { received: 3, inserted: 3, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(wrongProfile.completedTargets, 0);
  assert.equal(wrongProfile.inserted, 0);
  assert.equal(wrongProfile.currentTarget.index, 0);
  assert.match(wrongProfile.lastError, /different LinkedIn activity page/);

  const wrongKind = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    url: `https://www.linkedin.com/in/guard-alpha/recent-activity/comments/?lefSession=${session.id}&lefTarget=0`,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(wrongKind.completedTargets, 0);
  assert.equal(wrongKind.inserted, 0);
  assert.equal(wrongKind.currentTarget.index, 0);

  const accepted = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    url: session.nextUrl,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(accepted.completedTargets, 1);
  assert.equal(accepted.inserted, 1);
  assert.equal(accepted.currentTarget.index, 1);
});

test("refresh sessions ignore progress reports with conflicting target markers", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Conflicting Target Guard", 15);
  const person = db.upsertPerson({
    name: "Conflicting Target Person",
    profileUrl: "https://www.linkedin.com/in/conflicting-target-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const conflictingUrl = new URL(session.nextUrl);
  conflictingUrl.searchParams.set("lefTarget", "1");

  const ignored = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    url: conflictingUrl.toString(),
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(ignored.completedTargets, 0);
  assert.equal(ignored.inserted, 0);
  assert.equal(ignored.currentTarget.index, 0);
  assert.match(ignored.lastError, /conflicting target identifiers/);

  const accepted = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    url: session.nextUrl,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(accepted.completedTargets, 1);
  assert.equal(accepted.inserted, 1);
  assert.equal(accepted.currentTarget.index, 1);
});

test("refresh sessions ignore duplicate reports for already completed targets", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Duplicate Refresh Report", 15);
  const person = db.upsertPerson({
    name: "Duplicate Report Person",
    profileUrl: "https://www.linkedin.com/in/duplicate-report-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  let now = new Date("2026-05-01T12:00:00.000Z");
  const manager = new RefreshSessionManager(db, { now: () => now });
  const session = manager.create(feed.id);

  now = new Date("2026-05-01T12:01:00.000Z");
  const accepted = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  now = new Date("2026-05-01T12:20:00.000Z");
  const duplicate = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 1, inserted: 99, updated: 99, skippedOlder: 99, skippedUntracked: 99, skippedInvalid: 99 },
  });

  assert.equal(duplicate.completedTargets, accepted.completedTargets);
  assert.equal(duplicate.inserted, accepted.inserted);
  assert.equal(duplicate.updated, accepted.updated);
  assert.equal(duplicate.skippedOlder, accepted.skippedOlder);
  assert.equal(duplicate.updatedAt, accepted.updatedAt);
  assert.equal(duplicate.currentTarget.index, 1);
});

test("late reports for already completed targets replay after the session is pruned", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Late Completed Target Replay", 15);
  const person = db.upsertPerson({
    name: "Late Completed Target Person",
    profileUrl: "https://www.linkedin.com/in/late-completed-target-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const accepted = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });
  const lateDuplicate = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "The old LinkedIn page retried after the refresh advanced.",
    requestId: "late-completed-target-retry-1",
  });

  for (let index = 0; index < 35; index += 1) {
    const nextSession = manager.create(feed.id);
    manager.cancel(nextSession.id);
  }

  assert.throws(() => manager.get(session.id), /Refresh session not found/);
  const prunedDuplicate = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "The old LinkedIn page retried after the session was pruned.",
    requestId: "late-completed-target-retry-1",
  });

  assert.equal(lateDuplicate.completedTargets, accepted.completedTargets);
  assert.equal(lateDuplicate.inserted, accepted.inserted);
  assert.equal(lateDuplicate.currentTarget.index, 1);
  assert.deepEqual(prunedDuplicate, lateDuplicate);
});

test("refresh target report retries replay the original result", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Report Replay", 15);
  const person = db.upsertPerson({
    name: "Refresh Report Replay Person",
    profileUrl: "https://www.linkedin.com/in/refresh-report-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const first = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "Too many requests.",
    requestId: "refresh-report-lost-response-1",
  });
  const duplicate = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "Too many requests.",
    requestId: "refresh-report-lost-response-1",
  });

  assert.equal(first.currentAttempt, 2);
  assert.equal(first.rateLimitStreak, 1);
  assert.deepEqual(duplicate, first);
});

test("long refresh target request ids remain distinct after bounding", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Long Refresh Request Ids", 15);
  const person = db.upsertPerson({
    name: "Long Refresh Request Person",
    profileUrl: "https://www.linkedin.com/in/long-refresh-request-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const sharedPrefix = "r".repeat(120);
  const first = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "LinkedIn returned a temporary error page.",
    requestId: `${sharedPrefix}-first`,
  });
  const second = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "LinkedIn returned a temporary error page.",
    requestId: `${sharedPrefix}-second`,
  });

  assert.equal(first.currentAttempt, 2);
  assert.equal(second.currentAttempt, 3);
  assert.equal(second.issueStreak, 2);
  assert.match(second.lastError, /Retrying attempt 3\/3/);
});

test("malformed refresh target replay state is pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Malformed Refresh Report Replay", 15);
  const person = db.upsertPerson({
    name: "Malformed Refresh Report Replay Person",
    profileUrl: "https://www.linkedin.com/in/malformed-refresh-report-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const requestId = "malformed-refresh-report-replay-1";
  const replayKey = `refreshTarget.${session.id}.${requestId}`;
  db.setAppState(replayKey, {
    ...session,
    inserted: "1",
    lookbackDays: 0,
  });

  const first = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
    requestId,
  });
  const duplicate = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "The original LinkedIn page retried after capture succeeded.",
    requestId,
  });

  assert.equal(first.id, session.id);
  assert.equal(first.completedTargets, 1);
  assert.equal(first.inserted, 1);
  assert.equal(first.currentTarget.index, 1);
  assert.deepEqual(duplicate, first);
  assert.equal(db.getAppState(replayKey)?.value.inserted, 1);

  const malformedTargetReplayRequestId = "malformed-refresh-target-replay-2";
  const malformedTargetReplayKey = `refreshTarget.${session.id}.${malformedTargetReplayRequestId}`;
  db.setAppState(malformedTargetReplayKey, {
    ...first,
    nextUrl: "https://example.com/not-linkedin/",
  });
  const second = manager.recordTargetComplete(session.id, {
    targetIndex: 1,
    captureResult: { received: 0, inserted: 0, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
    requestId: malformedTargetReplayRequestId,
  });

  assert.equal(second.status, "done");
  assert.equal(second.completedTargets, 2);
  assert.equal(db.getAppState(malformedTargetReplayKey)?.value.status, "done");
});

test("impossible finished refresh target replay state is pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Impossible Finished Refresh Replay", 15);
  const person = db.upsertPerson({
    name: "Impossible Finished Refresh Replay Person",
    profileUrl: "https://www.linkedin.com/in/impossible-finished-refresh-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const requestId = "impossible-finished-refresh-replay-1";
  const replayKey = `refreshTarget.${session.id}.${requestId}`;
  const replay = JSON.parse(JSON.stringify(session));
  replay.status = "done";
  replay.completedTargets = 1;
  replay.failedTargets = 0;
  delete replay.currentTarget;
  delete replay.nextUrl;
  db.setAppState(replayKey, replay);

  const first = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
    requestId,
  });
  const duplicate = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "The original LinkedIn page retried after capture succeeded.",
    requestId,
  });

  assert.equal(first.id, session.id);
  assert.equal(first.status, "running");
  assert.equal(first.completedTargets, 1);
  assert.equal(first.inserted, 1);
  assert.equal(first.currentTarget.index, 1);
  assert.deepEqual(duplicate, first);
  assert.equal(db.getAppState(replayKey)?.value.status, "running");
  assert.equal(db.getAppState(replayKey)?.value.currentTarget.index, 1);
});

test("refresh target retry replays return the recovered live session", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Report Replay Recovery", 15);
  const person = db.upsertPerson({
    name: "Refresh Report Replay Recovery Person",
    profileUrl: "https://www.linkedin.com/in/refresh-report-replay-recovery-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const retrying = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "LinkedIn returned a temporary error page.",
    requestId: "refresh-report-recovered-replay-1",
  });
  const recovered = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });
  const replay = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "LinkedIn returned a temporary error page.",
    requestId: "refresh-report-recovered-replay-1",
  });

  assert.equal(retrying.completedTargets, 0);
  assert.equal(retrying.currentAttempt, 2);
  assert.equal(recovered.completedTargets, 1);
  assert.equal(recovered.currentAttempt, 1);
  assert.equal(replay.completedTargets, 1);
  assert.equal(replay.currentTarget.index, 1);
  assert.equal(replay.inserted, 1);
  assert.equal(replay.lastError, "");
  assert.deepEqual(db.getAppState(`refreshTarget.${session.id}.refresh-report-recovered-replay-1`).value, replay);
});

test("refresh target report retries replay after the session is pruned", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Report Pruned Replay", 15);
  const person = db.upsertPerson({
    name: "Refresh Report Pruned Replay Person",
    profileUrl: "https://www.linkedin.com/in/refresh-report-pruned-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const emptyCapture = { received: 0, inserted: 0, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 };
  manager.recordTargetComplete(session.id, { targetIndex: 0, captureResult: emptyCapture });
  const completed = manager.recordTargetComplete(session.id, {
    targetIndex: 1,
    captureResult: emptyCapture,
    requestId: "refresh-report-pruned-replay-1",
  });

  for (let index = 0; index < 35; index += 1) {
    const nextSession = manager.create(feed.id);
    manager.cancel(nextSession.id);
  }

  assert.throws(() => manager.get(session.id), /Refresh session not found/);
  const duplicate = manager.recordTargetComplete(session.id, {
    targetIndex: 1,
    error: "The original LinkedIn tab retried after the app moved on.",
    requestId: "refresh-report-pruned-replay-1",
  });

  assert.equal(completed.status, "done");
  assert.deepEqual(duplicate, completed);
});

test("late reports for finished sessions replay after the session is pruned", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Finished Refresh Late Replay", 15);
  const person = db.upsertPerson({
    name: "Finished Refresh Late Replay Person",
    profileUrl: "https://www.linkedin.com/in/finished-refresh-late-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const emptyCapture = { received: 0, inserted: 0, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 };
  manager.recordTargetComplete(session.id, { targetIndex: 0, captureResult: emptyCapture });
  const completed = manager.recordTargetComplete(session.id, { targetIndex: 1, captureResult: emptyCapture });
  const lateReport = manager.recordTargetComplete(session.id, {
    targetIndex: 1,
    error: "The old LinkedIn page retried after the refresh finished.",
    requestId: "finished-refresh-late-replay-1",
  });

  for (let index = 0; index < 35; index += 1) {
    const nextSession = manager.create(feed.id);
    manager.cancel(nextSession.id);
  }

  assert.throws(() => manager.get(session.id), /Refresh session not found/);
  const prunedLateReport = manager.recordTargetComplete(session.id, {
    targetIndex: 1,
    error: "The old LinkedIn page retried after pruning.",
    requestId: "finished-refresh-late-replay-1",
  });

  assert.equal(completed.status, "done");
  assert.deepEqual(lateReport, JSON.parse(JSON.stringify(completed)));
  assert.deepEqual(prunedLateReport, lateReport);
});

test("refresh target report idempotency prevents success followed by fallback error", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Success Replay", 15);
  const person = db.upsertPerson({
    name: "Refresh Success Replay Person",
    profileUrl: "https://www.linkedin.com/in/refresh-success-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const accepted = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
    requestId: "refresh-report-success-then-error",
  });
  const fallbackError = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "The local Engagement Feed app did not respond.",
    requestId: "refresh-report-success-then-error",
  });

  assert.equal(accepted.completedTargets, 1);
  assert.equal(accepted.inserted, 1);
  assert.equal(accepted.failedTargets, 0);
  assert.deepEqual(fallbackError, accepted);
});

test("refresh session url target parsing does not treat missing params as target zero", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Missing Target Param Refresh", 15);
  const person = db.upsertPerson({
    name: "Missing Target Param Person",
    profileUrl: "https://www.linkedin.com/in/missing-target-param-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    url: session.nextUrl,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  const completed = manager.recordTargetComplete(session.id, {
    url: "https://www.linkedin.com/in/missing-target-param-person/recent-activity/comments/",
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(completed.completedTargets, 2);
  assert.equal(completed.status, "done");
  assert.equal(completed.inserted, 2);
});

test("refresh sessions ignore body-only reports without a target identifier", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Identifier Required Refresh", 15);
  const person = db.upsertPerson({
    name: "Identifier Required Person",
    profileUrl: "https://www.linkedin.com/in/identifier-required-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const ignored = manager.recordTargetComplete(session.id, {
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(ignored.completedTargets, 0);
  assert.equal(ignored.inserted, 0);
  assert.equal(ignored.currentTarget.index, 0);
  assert.match(ignored.lastError, /without a target identifier/);

  const accepted = manager.recordTargetComplete(session.id, {
    url: "https://www.linkedin.com/in/identifier-required-person/recent-activity/all/",
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(accepted.completedTargets, 1);
  assert.equal(accepted.inserted, 1);
  assert.equal(accepted.currentTarget.index, 1);
});

test("refresh sessions ignore unsafe target identifiers", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Unsafe Target Identifier Refresh", 15);
  const person = db.upsertPerson({
    name: "Unsafe Target Identifier Person",
    profileUrl: "https://www.linkedin.com/in/unsafe-target-identifier-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const unsafeBodyIndex = manager.recordTargetComplete(session.id, {
    targetIndex: Number.MAX_SAFE_INTEGER + 1,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(unsafeBodyIndex.completedTargets, 0);
  assert.equal(unsafeBodyIndex.inserted, 0);
  assert.equal(unsafeBodyIndex.currentTarget.index, 0);
  assert.match(unsafeBodyIndex.lastError, /without a target identifier/);

  const unsafeUrl = new URL(session.nextUrl);
  unsafeUrl.searchParams.set("lefTarget", String(Number.MAX_SAFE_INTEGER + 1));
  const unsafeUrlIndex = manager.recordTargetComplete(session.id, {
    url: unsafeUrl.toString(),
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(unsafeUrlIndex.completedTargets, 0);
  assert.equal(unsafeUrlIndex.inserted, 0);
  assert.equal(unsafeUrlIndex.currentTarget.index, 0);
  assert.match(unsafeUrlIndex.lastError, /target identifiers/);
});

test("refresh sessions ignore empty progress reports", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Empty Refresh Report", 15);
  const person = db.upsertPerson({
    name: "Empty Report Person",
    profileUrl: "https://www.linkedin.com/in/empty-report-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const ignored = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    url: session.nextUrl,
  });

  assert.equal(ignored.completedTargets, 0);
  assert.equal(ignored.currentTarget.index, 0);
  assert.equal(ignored.inserted, 0);
  assert.match(ignored.lastError, /empty progress report/);

  const accepted = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    url: session.nextUrl,
    captureResult: { received: 0, inserted: 0, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(accepted.completedTargets, 1);
  assert.equal(accepted.currentTarget.index, 1);
  assert.equal(accepted.lastError, "");
});

test("repeated ignored refresh progress reports do not rewrite persisted session state", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Repeated Ignored Refresh Report", 15);
  const person = db.upsertPerson({
    name: "Repeated Ignored Person",
    profileUrl: "https://www.linkedin.com/in/repeated-ignored-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  const originalSetAppState = db.setAppState.bind(db);
  let refreshSessionWrites = 0;
  db.setAppState = (key, value) => {
    if (key === "refreshSessions.v1") {
      refreshSessionWrites += 1;
    }
    return originalSetAppState(key, value);
  };

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const writesAfterCreate = refreshSessionWrites;
  const repeatedReport = {
    targetIndex: 0,
    url: "https://www.linkedin.com/in/someone-else/recent-activity/all/?lefTarget=0",
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  };

  const firstIgnored = manager.recordTargetComplete(session.id, repeatedReport);
  const writesAfterFirstIgnored = refreshSessionWrites;
  const secondIgnored = manager.recordTargetComplete(session.id, repeatedReport);

  assert.equal(writesAfterCreate, 1);
  assert.equal(writesAfterFirstIgnored, writesAfterCreate + 1);
  assert.equal(refreshSessionWrites, writesAfterFirstIgnored);
  assert.equal(secondIgnored.completedTargets, 0);
  assert.equal(secondIgnored.inserted, 0);
  assert.equal(secondIgnored.lastError, firstIgnored.lastError);
});

test("ignored refresh progress reports do not keep stale sessions alive", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Ignored Progress Expiry", 15);
  const person = db.upsertPerson({
    name: "Ignored Progress Person",
    profileUrl: "https://www.linkedin.com/in/ignored-progress-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  let now = new Date("2026-01-01T00:00:00.000Z");
  const manager = new RefreshSessionManager(db, {
    staleSessionMs: 1000,
    now: () => now,
  });
  const session = manager.create(feed.id);

  now = new Date("2026-01-01T00:00:00.800Z");
  const ignored = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    url: "https://www.linkedin.com/in/someone-else/recent-activity/all/?lefTarget=0",
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
    requestId: "ignored-progress-before-expiry-1",
  });

  assert.equal(ignored.status, "running");
  assert.equal(ignored.updatedAt, session.updatedAt);
  assert.equal(ignored.completedTargets, 0);
  assert.equal(ignored.inserted, 0);
  assert.match(ignored.lastError, /different LinkedIn activity page/);

  now = new Date("2026-01-01T00:00:01.200Z");
  const expired = manager.get(session.id);

  assert.equal(expired.status, "failed");
  assert.match(expired.lastError, /expired/);
  assert.equal(manager.getActive(), undefined);

  const retriedIgnoredReport = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    url: "https://www.linkedin.com/in/someone-else/recent-activity/all/?lefTarget=0",
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
    requestId: "ignored-progress-before-expiry-1",
  });

  assert.equal(retriedIgnoredReport.status, "failed");
  assert.match(retriedIgnoredReport.lastError, /expired/);
});

test("refresh sessions ignore reports for missing session targets", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Missing Session Target Refresh", 15);
  const person = db.upsertPerson({
    name: "Missing Session Target Person",
    profileUrl: "https://www.linkedin.com/in/missing-session-target-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const liveSession = manager.sessions.get(session.id);
  liveSession.targets = [];
  liveSession.totalTargets = 1;

  const ignored = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(ignored.status, "running");
  assert.equal(ignored.completedTargets, 0);
  assert.equal(ignored.inserted, 0);
  assert.equal(ignored.currentTarget, undefined);
  assert.match(ignored.lastError, /no longer in this session/);
});

test("refresh sessions normalize malformed capture counters", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Counter Guard", 15);
  const person = db.upsertPerson({
    name: "Counter Guard Person",
    profileUrl: "https://www.linkedin.com/in/counter-guard-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const guarded = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: {
      inserted: -12,
      updated: 2.6,
      skippedOlder: MAX_CAPTURE_ITEMS_PER_REQUEST + 999,
      skippedUntracked: "4",
      skippedInvalid: "not a number",
    },
  });

  assert.equal(guarded.completedTargets, 1);
  assert.equal(guarded.inserted, 0);
  assert.equal(guarded.updated, 3);
  assert.equal(guarded.skippedOlder, MAX_CAPTURE_ITEMS_PER_REQUEST);
  assert.equal(guarded.skippedUntracked, 4);
  assert.equal(guarded.skippedInvalid, 0);
});

test("refresh sessions preserve chunked aggregate capture counters", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Chunked Counter Guard", 15);
  const person = db.upsertPerson({
    name: "Chunked Counter Guard Person",
    profileUrl: "https://www.linkedin.com/in/chunked-counter-guard-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const received = MAX_CAPTURE_ITEMS_PER_REQUEST + 80;
  const inserted = MAX_CAPTURE_ITEMS_PER_REQUEST + 30;
  const updated = 50;
  const captured = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: {
      received,
      inserted,
      updated,
      skippedOlder: 0,
      skippedUntracked: 0,
      skippedInvalid: 0,
    },
  });

  assert.equal(captured.completedTargets, 1);
  assert.equal(captured.inserted, inserted);
  assert.equal(captured.updated, updated);
});

test("refresh sessions drop impossible aggregate capture counters", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Aggregate Counter Guard", 15);
  const person = db.upsertPerson({
    name: "Aggregate Counter Guard Person",
    profileUrl: "https://www.linkedin.com/in/aggregate-counter-guard-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const guarded = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: {
      received: 1,
      inserted: 1,
      updated: 1,
      skippedOlder: 0,
      skippedUntracked: 0,
      skippedInvalid: 0,
    },
  });

  assert.equal(guarded.completedTargets, 1);
  assert.equal(guarded.inserted, 0);
  assert.equal(guarded.updated, 0);
  assert.equal(guarded.skippedOlder, 0);
  assert.equal(guarded.skippedUntracked, 0);
  assert.equal(guarded.skippedInvalid, 0);
});

test("refresh sessions add pending targets for new feed members", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh New Target Sync", 15);
  const alpha = db.addPersonToFeed(feed.id, {
    name: "Refresh Existing Member",
    profileUrl: "https://www.linkedin.com/in/refresh-existing-member/",
  });
  const beta = db.addPersonToFeed(feed.id, {
    name: "Refresh New Member",
    profileUrl: "https://www.linkedin.com/in/refresh-new-member/",
  });
  db.setPersonFeedMembership(beta.id, []);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  db.setPersonFeedMembership(beta.id, [feed.id]);
  const [synced] = manager.syncFeedMembership(feed.id);

  assert.equal(synced.status, "running");
  assert.equal(synced.totalTargets, 4);
  assert.equal(synced.currentTarget.personId, alpha.id);
  assert.match(synced.lastError, /added 2 pending pages/);

  manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 0, inserted: 0, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });
  const afterExisting = manager.recordTargetComplete(session.id, {
    targetIndex: 1,
    captureResult: { received: 0, inserted: 0, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(afterExisting.completedTargets, 2);
  assert.equal(afterExisting.currentTarget.personId, beta.id);
  assert.equal(afterExisting.currentTarget.kind, "posts");
});

test("refresh membership sync preserves only pending target retry state", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Pending Retry Sync", 15);
  const alpha = db.addPersonToFeed(feed.id, {
    name: "Retry Sync Alpha",
    profileUrl: "https://www.linkedin.com/in/retry-sync-alpha/",
  });
  const beta = db.addPersonToFeed(feed.id, {
    name: "Retry Sync Beta",
    profileUrl: "https://www.linkedin.com/in/retry-sync-beta/",
  });

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const emptyCapture = { received: 0, inserted: 0, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 };
  manager.recordTargetComplete(session.id, { targetIndex: 0, captureResult: emptyCapture });
  manager.recordTargetComplete(session.id, { targetIndex: 1, captureResult: emptyCapture });
  const retrying = manager.recordTargetComplete(session.id, { targetIndex: 2, error: "Temporary network problem." });
  const storedSession = manager.sessions.get(session.id);
  storedSession.targetRetries[0] = 1;

  db.addPersonToFeed(feed.id, {
    name: "Retry Sync Gamma",
    profileUrl: "https://www.linkedin.com/in/retry-sync-gamma/",
  });
  const [synced] = manager.syncFeedMembership(feed.id);

  assert.equal(retrying.currentTarget.personId, beta.id);
  assert.equal(retrying.currentAttempt, 2);
  assert.equal(synced.status, "running");
  assert.equal(synced.totalTargets, 6);
  assert.equal(synced.completedTargets, 2);
  assert.equal(synced.currentTarget.personId, beta.id);
  assert.equal(synced.currentAttempt, 2);
  assert.deepEqual(manager.sessions.get(session.id).targetRetries, { 2: 1 });
  assert.equal(manager.sessions.get(session.id).targets[0].personId, alpha.id);
  assert.equal(manager.sessions.get(session.id).targets[4].personName, "Retry Sync Gamma");
});

test("refresh membership sync updates stored pacing after large feed growth", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Pacing Growth", 15);
  db.addPersonToFeed(feed.id, {
    name: "Refresh Pacing Seed",
    profileUrl: "https://www.linkedin.com/in/refresh-pacing-seed/",
  });

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  assert.equal(session.delayMs, 2800);
  assert.equal(manager.sessions.get(session.id).nextDelayMs, 2800);

  for (let index = 0; index < 39; index += 1) {
    db.addPersonToFeed(feed.id, {
      name: `Refresh Pacing Added ${String(index).padStart(2, "0")}`,
      profileUrl: `https://www.linkedin.com/in/refresh-pacing-added-${index}/`,
    });
  }

  const [synced] = manager.syncFeedMembership(feed.id);
  const storedSession = manager.sessions.get(session.id);

  assert.equal(synced.totalTargets, 80);
  assert.equal(synced.delayMs, 3200);
  assert.equal(synced.nextDelayMs, 3200);
  assert.equal(storedSession.delayMs, 3200);
  assert.equal(storedSession.nextDelayMs, 3200);
});

test("refresh membership sync preserves retry and adaptive pacing snapshots", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Retry Pacing Growth", 15);
  db.addPersonToFeed(feed.id, {
    name: "Refresh Retry Pacing Seed",
    profileUrl: "https://www.linkedin.com/in/refresh-retry-pacing-seed/",
  });

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const retrying = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "LinkedIn appears to be rate limiting this profile page.",
  });

  assert.equal(retrying.currentAttempt, 2);
  assert.equal(retrying.nextDelayMs, 45000);

  for (let index = 0; index < 39; index += 1) {
    db.addPersonToFeed(feed.id, {
      name: `Refresh Retry Pacing Added ${String(index).padStart(2, "0")}`,
      profileUrl: `https://www.linkedin.com/in/refresh-retry-pacing-added-${index}/`,
    });
  }

  const [synced] = manager.syncFeedMembership(feed.id);
  const storedSession = manager.sessions.get(session.id);
  const persistedSession = db.getAppState("refreshSessions.v1").value.sessions.find((entry) => entry.id === session.id);

  assert.equal(synced.totalTargets, 80);
  assert.equal(synced.delayMs, 3200);
  assert.equal(synced.currentAttempt, 2);
  assert.equal(synced.nextDelayMs, 45000);
  assert.match(synced.nextDelayReason, /Rate-limit cooldown/);
  assert.equal(storedSession.nextDelayMs, 45000);
  assert.match(storedSession.nextDelayReason, /Rate-limit cooldown/);
  assert.equal(persistedSession.nextDelayMs, 45000);
  assert.equal(persistedSession.currentAttempt, 2);
  assert.equal(persistedSession.currentTarget.index, 0);
  assert.match(persistedSession.nextUrl, /lefTarget=0/);
});

test("refresh session batch membership sync fails deleted feed sessions without throwing", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Deleted Batch Sync", 15);
  db.addPersonToFeed(feed.id, {
    name: "Refresh Deleted Batch Member",
    profileUrl: "https://www.linkedin.com/in/refresh-deleted-batch-member/",
  });

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  db.deleteFeed(feed.id);

  const synced = manager.syncFeedMemberships(["", feed.id, feed.id]);

  assert.equal(synced.length, 1);
  assert.equal(synced[0].id, session.id);
  assert.equal(synced[0].status, "failed");
  assert.match(synced[0].lastError, /feed no longer exists/);
  assert.equal(manager.getActive(), undefined);
});

test("refresh session membership sync returns sessions in canonical order", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Sync Order", 15);
  const alpha = db.addPersonToFeed(feed.id, {
    name: "Refresh Sync Order Alpha",
    profileUrl: "https://www.linkedin.com/in/refresh-sync-order-alpha/",
  });

  const manager = new RefreshSessionManager(db, { now: () => new Date("2026-05-01T12:00:00.000Z") });
  const first = manager.create(feed.id);
  const firstLiveSession = manager.sessions.get(first.id);
  manager.sessions.set("refresh_sync_order_newer", {
    ...firstLiveSession,
    id: "refresh_sync_order_newer",
    createdAt: firstLiveSession.createdAt,
    updatedAt: "2026-05-01T12:04:00.000Z",
  });

  const synced = manager.syncFeedMembership(feed.id);

  assert.equal(synced.length, 2);
  assert.equal(synced[0].id, "refresh_sync_order_newer");
  assert.equal(synced[1].id, first.id);
  assert.equal(synced[0].status, "running");
  assert.equal(synced[0].currentTarget.personId, alpha.id);
});

test("refresh sessions restore a missing activity page when a member is re-added", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Partial Target Restore", 15);
  const alpha = db.addPersonToFeed(feed.id, {
    name: "Alpha Partial Restore",
    profileUrl: "https://www.linkedin.com/in/partial-restore-alpha/",
  });
  const beta = db.addPersonToFeed(feed.id, {
    name: "Beta Partial Restore",
    profileUrl: "https://www.linkedin.com/in/partial-restore-beta/",
  });
  const gamma = db.addPersonToFeed(feed.id, {
    name: "Gamma Partial Restore",
    profileUrl: "https://www.linkedin.com/in/partial-restore-gamma/",
  });

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const emptyCapture = { received: 0, inserted: 0, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 };

  manager.recordTargetComplete(session.id, { targetIndex: 0, captureResult: emptyCapture });
  manager.recordTargetComplete(session.id, { targetIndex: 1, captureResult: emptyCapture });
  const afterBetaPosts = manager.recordTargetComplete(session.id, { targetIndex: 2, captureResult: emptyCapture });
  assert.equal(afterBetaPosts.currentTarget.personId, beta.id);
  assert.equal(afterBetaPosts.currentTarget.kind, "comments");

  db.setPersonFeedMembership(beta.id, []);
  const [pruned] = manager.syncFeedMembership(feed.id);
  assert.equal(pruned.status, "running");
  assert.equal(pruned.totalTargets, 5);
  assert.equal(pruned.currentTarget.personId, gamma.id);
  assert.match(pruned.lastError, /Removed 1 pending page/);

  db.setPersonFeedMembership(beta.id, [feed.id]);
  const [restored] = manager.syncFeedMembership(feed.id);
  assert.equal(restored.status, "running");
  assert.equal(restored.totalTargets, 6);
  assert.equal(restored.currentTarget.personId, gamma.id);
  assert.match(restored.lastError, /added 1 pending page for 1 new feed member/);

  manager.recordTargetComplete(session.id, { targetIndex: 3, captureResult: emptyCapture });
  const afterGamma = manager.recordTargetComplete(session.id, { targetIndex: 4, captureResult: emptyCapture });
  assert.equal(afterGamma.currentTarget.personId, beta.id);
  assert.equal(afterGamma.currentTarget.kind, "comments");
});

test("refresh sessions drop pending targets removed from the feed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Pending Target Prune", 15);
  const alpha = db.upsertPerson({
    name: "Alpha Removed Before Visit",
    profileUrl: "https://www.linkedin.com/in/prune-alpha/",
  });
  const beta = db.upsertPerson({
    name: "Beta Still In Refresh",
    profileUrl: "https://www.linkedin.com/in/prune-beta/",
  });
  db.setPersonFeedMembership(alpha.id, [feed.id]);
  db.setPersonFeedMembership(beta.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const retrying = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    url: session.nextUrl,
    error: "LinkedIn returned a temporary error page.",
  });

  assert.equal(retrying.currentTarget.personId, alpha.id);
  assert.equal(retrying.currentAttempt, 2);

  db.setPersonFeedMembership(alpha.id, []);
  const [synced] = manager.syncFeedMembership(feed.id);

  assert.equal(synced.status, "running");
  assert.equal(synced.totalTargets, 2);
  assert.equal(synced.completedTargets, 0);
  assert.equal(synced.currentTarget.personId, beta.id);
  assert.equal(synced.currentTarget.kind, "posts");
  assert.equal(synced.currentTarget.index, 0);
  assert.equal(synced.currentAttempt, 1);
  assert.match(synced.lastError, /Removed 2 pending pages/);

  const completed = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    url: synced.nextUrl,
    captureResult: { received: 0, inserted: 0, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(completed.completedTargets, 1);
  assert.equal(completed.currentTarget.personId, beta.id);
  assert.equal(completed.currentTarget.kind, "comments");
});

test("refresh sessions finish when all pending targets are removed from the feed", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Refresh Empty Target Prune", 15);
  const person = db.upsertPerson({
    name: "Only Removed Target",
    profileUrl: "https://www.linkedin.com/in/prune-only-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  db.setPersonFeedMembership(person.id, []);
  const [synced] = manager.syncFeedMembership(feed.id);

  assert.equal(synced.status, "done");
  assert.equal(synced.totalTargets, 0);
  assert.equal(synced.completedTargets, 0);
  assert.equal(synced.currentTarget, undefined);
  assert.equal(synced.nextUrl, undefined);
  assert.equal(manager.getActive(), undefined);
  assert.match(synced.lastError, /Refresh finished after removing 2 pending pages/);

  const restoredDb = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(restoredDb);
  const restored = restoredManager.get(session.id);

  assert.equal(restored.status, "done");
  assert.equal(restored.totalTargets, 0);
  assert.equal(restored.currentTarget, undefined);
  assert.equal(restoredManager.getActive(), undefined);
});

test("refresh sessions skip targets removed from the feed mid-run", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Membership Guard", 15);
  const alpha = db.upsertPerson({
    name: "Alpha Removed",
    profileUrl: "https://www.linkedin.com/in/removed-alpha/",
  });
  const beta = db.upsertPerson({
    name: "Beta Remaining",
    profileUrl: "https://www.linkedin.com/in/remaining-beta/",
  });
  db.setPersonFeedMembership(alpha.id, [feed.id]);
  db.setPersonFeedMembership(beta.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  db.setPersonFeedMembership(alpha.id, []);

  const skippedPosts = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    url: session.nextUrl,
    captureResult: { received: 3, inserted: 3, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(skippedPosts.completedTargets, 1);
  assert.equal(skippedPosts.inserted, 0);
  assert.equal(skippedPosts.failedTargets, 0);
  assert.equal(skippedPosts.currentTarget.personId, alpha.id);
  assert.equal(skippedPosts.currentTarget.kind, "comments");
  assert.match(skippedPosts.lastError, /no longer in this feed/);

  const skippedComments = manager.recordTargetComplete(session.id, {
    targetIndex: 1,
    url: skippedPosts.nextUrl,
    error: "LinkedIn returned a temporary error page.",
  });

  assert.equal(skippedComments.completedTargets, 2);
  assert.equal(skippedComments.failedTargets, 0);
  assert.equal(skippedComments.currentTarget.personId, beta.id);
  assert.equal(skippedComments.currentTarget.kind, "posts");
  assert.match(skippedComments.lastError, /no longer in this feed/);
});

test("refresh sessions persist progress and resume after database reopen", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Refresh Resume", 15);
  const person = db.upsertPerson({
    name: "Resume Person",
    profileUrl: "https://www.linkedin.com/in/resume-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const now = new Date("2026-05-01T12:00:00.000Z");
  const manager = new RefreshSessionManager(db, { now: () => now });
  const session = manager.create(feed.id);
  manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 3, inserted: 2, updated: 1, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  const restoredDb = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(restoredDb, { now: () => now });
  const active = restoredManager.getActive(session.id);

  assert.equal(active.status, "running");
  assert.equal(active.completedTargets, 1);
  assert.equal(active.inserted, 2);
  assert.equal(active.updated, 1);
  assert.equal(active.currentTarget.index, 1);
  assert.equal(active.currentTarget.kind, "comments");
  assert.match(active.nextUrl, new RegExp(`lefSession=${session.id}`));
  assert.match(active.nextUrl, /lefTarget=1/);

  const finished = restoredManager.recordTargetComplete(session.id, {
    targetIndex: 1,
    captureResult: { received: 0, inserted: 0, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });
  assert.equal(finished.status, "done");

  const finalDb = await reopenTestDb(dbPath);
  const persisted = finalDb.getAppState("refreshSessions.v1")?.value;
  const persistedSession = persisted.sessions.find((entry) => entry.id === session.id);
  assert.equal(persistedSession.status, "done");
  assert.equal(persistedSession.totalTargets, 2);
  assert.equal(persistedSession.completedTargets, 2);
  assert.deepEqual(persistedSession.targets, []);
  assert.deepEqual(persistedSession.targetRetries, {});

  const finalManager = new RefreshSessionManager(finalDb, { now: () => now });
  const finalSession = finalManager.get(session.id);
  assert.equal(finalSession.status, "done");
  assert.equal(finalSession.totalTargets, 2);
  assert.equal(finalSession.completedTargets, 2);
  assert.equal(finalSession.currentTarget, undefined);
  assert.equal(finalManager.getActive(), undefined);
});

test("persisted refresh sessions rebuild target urls on manager startup", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Refresh Target URL Restore", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Target Restore Person",
    profileUrl: "https://www.linkedin.com/in/target-restore-person/",
  });
  const now = "2026-05-01T12:00:00.000Z";
  db.setAppState("refreshSessions.v1", {
    schemaVersion: 1,
    savedAt: now,
    sessions: [
      {
        id: "refresh_saved_url_guard",
        feedId: feed.id,
        feedName: feed.name,
        lookbackDays: 15,
        lookbackCutoffAt: "2026-04-16T12:00:00.000Z",
        status: "running",
        totalTargets: 1,
        completedTargets: 0,
        failedTargets: 0,
        inserted: 0,
        updated: 0,
        skippedOlder: 0,
        skippedUntracked: 0,
        skippedInvalid: 0,
        lastError: "",
        delayMs: 2800,
        nextDelayMs: 2800,
        nextDelayReason: "Standard pacing",
        issueStreak: 0,
        rateLimitStreak: 0,
        currentAttempt: 1,
        maxAttempts: 3,
        createdAt: now,
        updatedAt: now,
        targetRetries: {},
        targets: [
          {
            index: 0,
            personId: person.id,
            personName: person.name,
            profileUrl: "https://www.linkedin.com/in/target-restore-person/?trk=stale",
            kind: "comments",
            url: "https://example.com/not-linkedin/",
          },
        ],
      },
    ],
  });

  const restoredDb = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(restoredDb, { now: () => new Date(now) });
  const restored = restoredManager.get("refresh_saved_url_guard");

  assert.equal(restored.status, "running");
  assert.equal(restored.currentTarget.profileUrl, person.profileUrl);
  assert.equal(restored.currentTarget.url, "https://www.linkedin.com/in/target-restore-person/recent-activity/comments/");
  assert.match(restored.nextUrl, /^https:\/\/www\.linkedin\.com\/in\/target-restore-person\/recent-activity\/comments\//);
  assert.match(restored.nextUrl, /lefSession=refresh_saved_url_guard/);
  assert.match(restored.nextUrl, /lefTarget=0/);
});

test("persisted refresh sessions dedupe targets without losing progress on startup", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Refresh Duplicate Target Restore", 15);
  const alpha = db.addPersonToFeed(feed.id, {
    name: "Alpha Duplicate Restore",
    profileUrl: "https://www.linkedin.com/in/duplicate-restore-alpha/",
  });
  const beta = db.addPersonToFeed(feed.id, {
    name: "Beta Duplicate Restore",
    profileUrl: "https://www.linkedin.com/in/duplicate-restore-beta/",
  });
  const now = "2026-05-01T12:00:00.000Z";
  db.setAppState("refreshSessions.v1", {
    schemaVersion: 1,
    savedAt: now,
    sessions: [
      {
        id: "refresh_duplicate_target_restore",
        feedId: feed.id,
        feedName: feed.name,
        lookbackDays: 15,
        lookbackCutoffAt: "2026-04-16T12:00:00.000Z",
        status: "running",
        totalTargets: 3,
        completedTargets: 2,
        failedTargets: 0,
        inserted: 1,
        updated: 0,
        skippedOlder: 0,
        skippedUntracked: 0,
        skippedInvalid: 0,
        lastError: "",
        delayMs: 2800,
        nextDelayMs: 2800,
        nextDelayReason: "Standard pacing",
        issueStreak: 0,
        rateLimitStreak: 0,
        currentAttempt: 1,
        maxAttempts: 3,
        createdAt: now,
        updatedAt: now,
        targetRetries: {},
        targets: [
          {
            index: 0,
            personId: alpha.id,
            personName: alpha.name,
            profileUrl: alpha.profileUrl,
            kind: "posts",
            url: "https://www.linkedin.com/in/duplicate-restore-alpha/recent-activity/all/",
          },
          {
            index: 1,
            personId: alpha.id,
            personName: `${alpha.name} Duplicate`,
            profileUrl: alpha.profileUrl,
            kind: "posts",
            url: "https://www.linkedin.com/in/duplicate-restore-alpha/recent-activity/all/",
          },
          {
            index: 2,
            personId: alpha.id,
            personName: alpha.name,
            profileUrl: alpha.profileUrl,
            kind: "comments",
            url: "https://www.linkedin.com/in/duplicate-restore-alpha/recent-activity/comments/",
          },
          {
            index: 3,
            personId: beta.id,
            personName: beta.name,
            profileUrl: beta.profileUrl,
            kind: "posts",
            url: "https://www.linkedin.com/in/duplicate-restore-beta/recent-activity/all/",
          },
        ],
      },
    ],
  });

  const restoredDb = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(restoredDb, { now: () => new Date(now) });
  const restored = restoredManager.get("refresh_duplicate_target_restore");

  assert.equal(restored.status, "running");
  assert.equal(restored.totalTargets, 4);
  assert.equal(restored.completedTargets, 1);
  assert.equal(restored.inserted, 1);
  assert.equal(restored.currentTarget.personId, alpha.id);
  assert.equal(restored.currentTarget.kind, "comments");
  assert.equal(restored.currentTarget.index, 1);
  assert.match(restored.nextUrl, /lefTarget=1/);
  assert.match(restored.lastError, /added 1 pending page for 1 new feed member/);

  const completedComments = restoredManager.recordTargetComplete(restored.id, {
    targetIndex: 1,
    url: restored.nextUrl,
    captureResult: { received: 0, inserted: 0, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(completedComments.completedTargets, 2);
  assert.equal(completedComments.currentTarget.personId, beta.id);
  assert.equal(completedComments.currentTarget.kind, "posts");
});

test("persisted refresh sessions save deduped targets on startup", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Refresh Persist Deduped Targets", 15);
  const alpha = db.addPersonToFeed(feed.id, {
    name: "Alpha Persist Deduped",
    profileUrl: "https://www.linkedin.com/in/persist-deduped-alpha/",
  });
  const beta = db.addPersonToFeed(feed.id, {
    name: "Beta Persist Deduped",
    profileUrl: "https://www.linkedin.com/in/persist-deduped-beta/",
  });
  const now = "2026-05-01T12:00:00.000Z";
  db.setAppState("refreshSessions.v1", {
    schemaVersion: 1,
    savedAt: now,
    sessions: [
      {
        id: "refresh_persist_deduped_targets",
        feedId: feed.id,
        feedName: feed.name,
        lookbackDays: 15,
        lookbackCutoffAt: "2026-04-16T12:00:00.000Z",
        status: "running",
        totalTargets: 5,
        completedTargets: 2,
        failedTargets: 0,
        inserted: 1,
        updated: 0,
        skippedOlder: 0,
        skippedUntracked: 0,
        skippedInvalid: 0,
        lastError: "",
        delayMs: 2800,
        nextDelayMs: 2800,
        nextDelayReason: "Standard pacing",
        issueStreak: 0,
        rateLimitStreak: 0,
        currentAttempt: 1,
        maxAttempts: 3,
        createdAt: now,
        updatedAt: now,
        targetRetries: {},
        targets: [
          {
            index: 0,
            personId: alpha.id,
            personName: alpha.name,
            profileUrl: alpha.profileUrl,
            kind: "posts",
            url: "https://www.linkedin.com/in/persist-deduped-alpha/recent-activity/all/",
          },
          {
            index: 1,
            personId: alpha.id,
            personName: alpha.name,
            profileUrl: alpha.profileUrl,
            kind: "posts",
            url: "https://www.linkedin.com/in/persist-deduped-alpha/recent-activity/all/",
          },
          {
            index: 2,
            personId: alpha.id,
            personName: alpha.name,
            profileUrl: alpha.profileUrl,
            kind: "comments",
            url: "https://www.linkedin.com/in/persist-deduped-alpha/recent-activity/comments/",
          },
          {
            index: 3,
            personId: beta.id,
            personName: beta.name,
            profileUrl: beta.profileUrl,
            kind: "posts",
            url: "https://www.linkedin.com/in/persist-deduped-beta/recent-activity/all/",
          },
          {
            index: 4,
            personId: beta.id,
            personName: beta.name,
            profileUrl: beta.profileUrl,
            kind: "comments",
            url: "https://www.linkedin.com/in/persist-deduped-beta/recent-activity/comments/",
          },
        ],
      },
    ],
  });

  const restoredDb = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(restoredDb, { now: () => new Date(now) });
  const restored = restoredManager.get("refresh_persist_deduped_targets");
  const persisted = restoredDb.getAppState("refreshSessions.v1").value;
  const persistedSession = persisted.sessions.find((entry) => entry.id === restored.id);

  assert.equal(restored.status, "running");
  assert.equal(restored.totalTargets, 4);
  assert.equal(restored.completedTargets, 1);
  assert.equal(restored.currentTarget.personId, alpha.id);
  assert.equal(restored.currentTarget.kind, "comments");
  assert.equal(persistedSession.totalTargets, 4);
  assert.equal(persistedSession.completedTargets, 1);
  assert.equal(persistedSession.targets.length, 4);
  assert.deepEqual(
    persistedSession.targets.map((target) => `${target.personId}:${target.kind}:${target.index}`),
    [`${alpha.id}:posts:0`, `${alpha.id}:comments:1`, `${beta.id}:posts:2`, `${beta.id}:comments:3`],
  );
});

test("persisted refresh sessions clamp failed targets to completed targets on startup", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Refresh Failed Count Restore", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Failed Count Restore Person",
    profileUrl: "https://www.linkedin.com/in/failed-count-restore-person/",
  });
  const now = "2026-05-01T12:00:00.000Z";
  db.setAppState("refreshSessions.v1", {
    schemaVersion: 1,
    savedAt: now,
    sessions: [
      {
        id: "refresh_failed_count_restore",
        feedId: feed.id,
        feedName: feed.name,
        lookbackDays: 15,
        lookbackCutoffAt: "2026-04-16T12:00:00.000Z",
        status: "running",
        totalTargets: 2,
        completedTargets: 0,
        failedTargets: 2,
        inserted: 0,
        updated: 0,
        skippedOlder: 0,
        skippedUntracked: 0,
        skippedInvalid: 0,
        lastError: "",
        delayMs: 2800,
        nextDelayMs: 2800,
        nextDelayReason: "Standard pacing",
        issueStreak: 0,
        rateLimitStreak: 0,
        currentAttempt: 1,
        maxAttempts: 3,
        createdAt: now,
        updatedAt: now,
        targetRetries: {},
        targets: [
          {
            index: 0,
            personId: person.id,
            personName: person.name,
            profileUrl: person.profileUrl,
            kind: "posts",
            url: "https://www.linkedin.com/in/failed-count-restore-person/recent-activity/all/",
          },
          {
            index: 1,
            personId: person.id,
            personName: person.name,
            profileUrl: person.profileUrl,
            kind: "comments",
            url: "https://www.linkedin.com/in/failed-count-restore-person/recent-activity/comments/",
          },
        ],
      },
    ],
  });

  const restoredDb = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(restoredDb, { now: () => new Date(now) });
  const restored = restoredManager.get("refresh_failed_count_restore");

  assert.equal(restored.status, "running");
  assert.equal(restored.totalTargets, 2);
  assert.equal(restored.completedTargets, 0);
  assert.equal(restored.failedTargets, 0);
  assert.equal(restored.currentTarget.index, 0);
});

test("persisted refresh sessions do not round fractional progress on startup", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Refresh Fractional Restore", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Fractional Restore Person",
    profileUrl: "https://www.linkedin.com/in/fractional-restore-person/",
  });
  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const persisted = db.getAppState("refreshSessions.v1").value;
  const savedSession = persisted.sessions.find((entry) => entry.id === session.id);

  db.setAppState("refreshSessions.v1", {
    ...persisted,
    sessions: [
      {
        ...savedSession,
        completedTargets: 0.6,
        failedTargets: 0.4,
        inserted: 1.4,
        delayMs: 3200.8,
        issueStreak: 1.2,
        rateLimitStreak: 0.7,
        targetRetries: { 0: 1.6 },
      },
    ],
  });

  const restoredDb = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(restoredDb);
  const restored = restoredManager.get(session.id);

  assert.equal(restored.status, "running");
  assert.equal(restored.totalTargets, 2);
  assert.equal(restored.completedTargets, 0);
  assert.equal(restored.failedTargets, 0);
  assert.equal(restored.inserted, 0);
  assert.equal(restored.currentTarget.index, 0);
  assert.equal(restored.currentTarget.personId, person.id);
  assert.equal(restored.currentAttempt, 1);

  const accepted = restoredManager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(accepted.completedTargets, 1);
  assert.equal(accepted.inserted, 1);
  assert.equal(accepted.currentTarget.index, 1);
});

test("persisted refresh sessions save normalized scalar fields on startup", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Refresh Scalar Restore", 15);
  db.addPersonToFeed(feed.id, {
    name: "Scalar Restore Person",
    profileUrl: "https://www.linkedin.com/in/scalar-restore-person/",
  });
  const manager = new RefreshSessionManager(db, { now: () => new Date("2026-05-01T12:00:00.000Z") });
  const session = manager.create(feed.id, { requestId: "restore-scalar-request" });
  const canceled = manager.cancel(session.id);
  const persisted = db.getAppState("refreshSessions.v1").value;
  const savedSession = persisted.sessions.find((entry) => entry.id === canceled.id);

  db.setAppState("refreshSessions.v1", {
    ...persisted,
    sessions: [
      {
        ...savedSession,
        feedName: " Refresh Scalar Restore ",
        lookbackDays: 999,
        lookbackCutoffAt: "not-a-date",
        inserted: 1.4,
        updated: -1,
        skippedOlder: "2",
        skippedUntracked: 3.3,
        skippedInvalid: undefined,
        lastError: "x".repeat(520),
        delayMs: 100,
        nextDelayMs: 90000,
        nextDelayReason: "Stale backoff",
        issueStreak: 99,
        rateLimitStreak: -1,
        currentAttempt: 3,
        maxAttempts: 99,
        targetRetries: { 0: 1, 99: 1 },
        createRequestId: " restore-scalar-request ",
        createdAt: "not-a-date",
        updatedAt: "also-not-a-date",
      },
    ],
  });

  const restoredDb = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(restoredDb, { now: () => new Date("2026-05-01T12:30:00.000Z") });
  const restored = restoredManager.get(canceled.id);
  const saved = restoredDb.getAppState("refreshSessions.v1").value.sessions.find((entry) => entry.id === canceled.id);

  assert.equal(restored.status, "canceled");
  assert.equal(restored.feedName, "Refresh Scalar Restore");
  assert.equal(restored.lookbackDays, 365);
  assert.equal(restored.lookbackCutoffAt, "1970-01-01T00:00:00.000Z");
  assert.equal(restored.inserted, 0);
  assert.equal(restored.updated, 0);
  assert.equal(restored.skippedOlder, 0);
  assert.equal(restored.skippedUntracked, 0);
  assert.equal(restored.skippedInvalid, 0);
  assert.equal(restored.lastError.length, 500);
  assert.equal(restored.delayMs, 500);
  assert.equal(restored.nextDelayMs, 24000);
  assert.equal(restored.nextDelayReason, "");
  assert.equal(restored.issueStreak, 4);
  assert.equal(restored.rateLimitStreak, 0);
  assert.equal(restored.currentAttempt, 1);
  assert.equal(restored.maxAttempts, 3);
  assert.deepEqual(saved.targetRetries, {});
  assert.equal(saved.feedName, restored.feedName);
  assert.equal(saved.lookbackDays, restored.lookbackDays);
  assert.equal(saved.lookbackCutoffAt, restored.lookbackCutoffAt);
  assert.equal(saved.lastError, restored.lastError);
  assert.equal(saved.delayMs, restored.delayMs);
  assert.equal(saved.nextDelayMs, 500);
  assert.equal(saved.nextDelayReason, "Standard pacing");
  assert.equal(saved.createdAt, "1970-01-01T00:00:00.000Z");
  assert.equal(saved.updatedAt, "1970-01-01T00:00:00.000Z");
  assert.equal(saved.createRequestId, "restore-scalar-request");
});

test("persisted refresh sessions fail deleted feeds on manager startup", async () => {
  const { db, dbPath } = await createTestDb();
  const deletedFeed = db.createFeed("Deleted Persisted Refresh", 15);
  const activeFeed = db.createFeed("Active Feed After Deleted Refresh", 15);
  db.addPersonToFeed(deletedFeed.id, {
    name: "Deleted Refresh Person",
    profileUrl: "https://www.linkedin.com/in/deleted-persisted-refresh-person/",
  });
  db.addPersonToFeed(activeFeed.id, {
    name: "Next Refresh Person",
    profileUrl: "https://www.linkedin.com/in/next-refresh-after-deleted-person/",
  });

  const manager = new RefreshSessionManager(db);
  const staleSession = manager.create(deletedFeed.id);
  db.deleteFeed(deletedFeed.id);

  const restoredDb = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(restoredDb);
  const restored = restoredManager.get(staleSession.id);

  assert.equal(restored.status, "failed");
  assert.match(restored.lastError, /feed no longer exists/);
  assert.equal(restoredManager.getActive(), undefined);

  const nextSession = restoredManager.create(activeFeed.id);
  assert.equal(nextSession.status, "running");
  assert.equal(nextSession.feedId, activeFeed.id);

  const finalDb = await reopenTestDb(dbPath);
  const finalManager = new RefreshSessionManager(finalDb);
  assert.equal(finalManager.get(staleSession.id).status, "failed");
});

test("persisted refresh sessions reconcile removed members on manager startup", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Startup Member Reconcile", 15);
  const person = db.addPersonToFeed(feed.id, {
    name: "Removed While Closed",
    profileUrl: "https://www.linkedin.com/in/removed-while-closed/",
  });

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  db.setPersonFeedMembership(person.id, []);

  const restoredDb = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(restoredDb);
  const restored = restoredManager.get(session.id);

  assert.equal(restored.status, "done");
  assert.equal(restored.totalTargets, 0);
  assert.equal(restored.completedTargets, 0);
  assert.equal(restored.currentTarget, undefined);
  assert.equal(restored.nextUrl, undefined);
  assert.equal(restoredManager.getActive(), undefined);
  assert.match(restored.lastError, /removing 2 pending pages/);
});

test("refresh retry state persists after database reopen", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Refresh Retry Persist", 15);
  const person = db.upsertPerson({
    name: "Retry Persist Person",
    profileUrl: "https://www.linkedin.com/in/retry-persist-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const retrying = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "LinkedIn appears to be rate limiting this profile page.",
  });
  assert.equal(retrying.currentAttempt, 2);

  const restoredDb = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(restoredDb);
  const active = restoredManager.getActive(session.id);

  assert.equal(active.currentTarget.index, 0);
  assert.equal(active.currentAttempt, 2);
  assert.ok(active.nextDelayMs > active.delayMs);
  assert.match(active.lastError, /Retrying attempt 2\/3/);

  const recovered = restoredManager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });
  assert.equal(recovered.completedTargets, 1);
  assert.equal(recovered.currentAttempt, 1);
});

test("rate-limit-like refresh failures create persisted adaptive cooldown", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Refresh Rate Cooldown", 15);
  const person = db.upsertPerson({
    name: "Rate Cooldown Person",
    profileUrl: "https://www.linkedin.com/in/rate-cooldown-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const first = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "LinkedIn appears to be rate limiting this profile page.",
  });
  assert.equal(first.rateLimitStreak, 1);
  assert.equal(first.issueStreak, 1);
  assert.equal(first.nextDelayMs, 45000);
  assert.match(first.nextDelayReason, /Rate-limit cooldown/);

  manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "LinkedIn appears to be rate limiting this profile page.",
  });
  const exhausted = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "LinkedIn appears to be rate limiting this profile page.",
  });

  assert.equal(exhausted.status, "running");
  assert.equal(exhausted.completedTargets, 1);
  assert.equal(exhausted.failedTargets, 1);
  assert.equal(exhausted.rateLimitStreak, 3);
  assert.equal(exhausted.issueStreak, 3);
  assert.equal(exhausted.nextDelayMs, 180000);
  assert.match(exhausted.nextDelayReason, /Rate-limit cooldown after 3 recent signals/);

  const restoredDb = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(restoredDb);
  const restored = restoredManager.get(session.id);
  assert.equal(restored.rateLimitStreak, 3);
  assert.equal(restored.issueStreak, 3);
  assert.equal(restored.nextDelayMs, 180000);
});

test("verbose refresh failures classify rate limits before display truncation", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Verbose Rate Cooldown", 15);
  const person = db.upsertPerson({
    name: "Verbose Rate Person",
    profileUrl: "https://www.linkedin.com/in/verbose-rate-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const verboseError = `${"LinkedIn diagnostics ".repeat(20)} Too many requests. Please slow down.`;
  const retrying = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: verboseError,
  });

  assert.equal(retrying.status, "running");
  assert.equal(retrying.completedTargets, 0);
  assert.equal(retrying.rateLimitStreak, 1);
  assert.equal(retrying.issueStreak, 1);
  assert.equal(retrying.nextDelayMs, 45000);
  assert.match(retrying.nextDelayReason, /Rate-limit cooldown/);
  assert.ok(retrying.lastError.length <= 500);
});

test("auth refresh errors keep the current target waiting without burning retries", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Refresh Auth Wait", 15);
  const person = db.upsertPerson({
    name: "Auth Wait Person",
    profileUrl: "https://www.linkedin.com/in/auth-wait-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const waiting = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "LinkedIn is asking you to sign in.",
  });

  assert.equal(waiting.status, "running");
  assert.equal(waiting.completedTargets, 0);
  assert.equal(waiting.failedTargets, 0);
  assert.equal(waiting.currentTarget.index, 0);
  assert.equal(waiting.currentAttempt, 1);
  assert.equal(waiting.issueStreak, 0);
  assert.equal(waiting.rateLimitStreak, 0);
  assert.equal(waiting.nextDelayMs, waiting.delayMs);
  assert.match(waiting.lastError, /asking you to sign in/);
  assert.match(waiting.lastError, /refresh will continue/);

  const stillWaiting = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "Checkpoint required. Please login.",
  });

  assert.equal(stillWaiting.status, "running");
  assert.equal(stillWaiting.completedTargets, 0);
  assert.equal(stillWaiting.failedTargets, 0);
  assert.equal(stillWaiting.currentAttempt, 1);

  const persisted = db.getAppState("refreshSessions.v1").value.sessions.find((entry) => entry.id === session.id);
  assert.deepEqual(persisted.targetRetries, {});

  const restoredDb = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(restoredDb);
  const restored = restoredManager.get(session.id);
  assert.equal(restored.status, "running");
  assert.equal(restored.completedTargets, 0);
  assert.equal(restored.currentAttempt, 1);
  assert.match(restored.lastError, /asking you to sign in/);

  const recovered = restoredManager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });
  assert.equal(recovered.completedTargets, 1);
  assert.equal(recovered.currentAttempt, 1);
  assert.equal(recovered.inserted, 1);
});

test("late auth refresh replays return live progress instead of stale waiting state", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Auth Late Replay", 15);
  const person = db.upsertPerson({
    name: "Auth Late Replay Person",
    profileUrl: "https://www.linkedin.com/in/auth-late-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const waiting = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "LinkedIn is asking you to sign in.",
    requestId: "auth-late-replay-1",
  });
  const advanced = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
    requestId: "auth-late-replay-success-1",
  });
  const lateReplay = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "LinkedIn is asking you to sign in.",
    requestId: "auth-late-replay-1",
  });

  assert.equal(waiting.completedTargets, 0);
  assert.equal(advanced.completedTargets, 1);
  assert.equal(lateReplay.completedTargets, 1);
  assert.equal(lateReplay.inserted, 1);
  assert.equal(lateReplay.currentTarget.index, 1);
  assert.deepEqual(lateReplay, advanced);
});

test("successful refresh targets recover adaptive pacing gradually", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Cooldown Recovery", 15);
  const alpha = db.upsertPerson({
    name: "Cooldown Alpha",
    profileUrl: "https://www.linkedin.com/in/cooldown-alpha/",
  });
  const beta = db.upsertPerson({
    name: "Cooldown Beta",
    profileUrl: "https://www.linkedin.com/in/cooldown-beta/",
  });
  db.setPersonFeedMembership(alpha.id, [feed.id]);
  db.setPersonFeedMembership(beta.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  manager.recordTargetComplete(session.id, { targetIndex: 0, error: "Too many requests." });
  manager.recordTargetComplete(session.id, { targetIndex: 0, error: "Too many requests." });
  const recovered = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(recovered.completedTargets, 1);
  assert.equal(recovered.rateLimitStreak, 1);
  assert.equal(recovered.issueStreak, 1);
  assert.equal(recovered.nextDelayMs, 45000);
});

test("permanent unavailable refresh pages skip without adaptive cooldown", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Permanent Skip", 15);
  const person = db.upsertPerson({
    name: "Unavailable Person",
    profileUrl: "https://www.linkedin.com/in/unavailable-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const skipped = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "This LinkedIn profile page is unavailable.",
  });

  assert.equal(skipped.status, "failed");
  assert.equal(skipped.completedTargets, 2);
  assert.equal(skipped.failedTargets, 2);
  assert.equal(skipped.currentTarget, undefined);
  assert.equal(skipped.currentAttempt, 1);
  assert.equal(skipped.issueStreak, 0);
  assert.equal(skipped.rateLimitStreak, 0);
  assert.equal(skipped.nextDelayMs, skipped.delayMs);
  assert.match(skipped.lastError, /profile page is unavailable/);
  assert.match(skipped.lastError, /Skipped 2 pending activity pages/);
});

test("unavailable refresh page variants skip the rest of that person", async () => {
  const variants = [
    "This page doesn't exist.",
    "This page doesn\u2019t exist.",
    "This profile isn't available.",
    "This profile isn\u2019t available.",
    "Member unavailable.",
  ];

  for (const [index, message] of variants.entries()) {
    const { db } = await createTestDb();
    const feed = db.createFeed(`Refresh Permanent Variant ${index}`, 15);
    const unavailable = db.upsertPerson({
      name: `A Unavailable Variant ${index}`,
      profileUrl: `https://www.linkedin.com/in/unavailable-variant-${index}/`,
    });
    const available = db.upsertPerson({
      name: `Z Available Variant ${index}`,
      profileUrl: `https://www.linkedin.com/in/available-variant-${index}/`,
    });
    db.setPersonFeedMembership(unavailable.id, [feed.id]);
    db.setPersonFeedMembership(available.id, [feed.id]);

    const manager = new RefreshSessionManager(db);
    const session = manager.create(feed.id);
    const skipped = manager.recordTargetComplete(session.id, {
      targetIndex: 0,
      error: message,
    });

    assert.equal(skipped.status, "running");
    assert.equal(skipped.completedTargets, 2);
    assert.equal(skipped.failedTargets, 2);
    assert.equal(skipped.currentTarget.personId, available.id);
    assert.equal(skipped.currentTarget.kind, "posts");
    assert.equal(skipped.issueStreak, 0);
    assert.equal(skipped.rateLimitStreak, 0);
    assert.match(skipped.lastError, /Skipped 2 pending activity pages/);
  }
});

test("permanent unavailable refresh pages skip the rest of that person and continue", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Permanent Skip Sibling", 15);
  const unavailable = db.upsertPerson({
    name: "A Unavailable Sibling Person",
    profileUrl: "https://www.linkedin.com/in/unavailable-sibling-person/",
  });
  const available = db.upsertPerson({
    name: "Z Available After Skip Person",
    profileUrl: "https://www.linkedin.com/in/available-after-skip-person/",
  });
  db.setPersonFeedMembership(unavailable.id, [feed.id]);
  db.setPersonFeedMembership(available.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  assert.equal(session.currentTarget.personId, unavailable.id);
  const skipped = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "This LinkedIn profile page is unavailable.",
  });

  assert.equal(skipped.status, "running");
  assert.equal(skipped.completedTargets, 2);
  assert.equal(skipped.failedTargets, 2);
  assert.equal(skipped.currentTarget.personId, available.id);
  assert.equal(skipped.currentTarget.kind, "posts");
  assert.equal(skipped.currentTarget.index, 2);
  assert.match(skipped.lastError, /Skipped 2 pending activity pages/);
});

test("refresh sessions retry a failed target before advancing", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Retry", 15);
  const person = db.upsertPerson({
    name: "Retry Person",
    profileUrl: "https://www.linkedin.com/in/retry-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const firstRetry = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "LinkedIn returned a temporary error page.",
  });

  assert.equal(firstRetry.status, "running");
  assert.equal(firstRetry.completedTargets, 0);
  assert.equal(firstRetry.currentTarget.index, 0);
  assert.equal(firstRetry.currentAttempt, 2);
  assert.equal(firstRetry.maxAttempts, 3);
  assert.ok(firstRetry.nextDelayMs > firstRetry.delayMs);
  assert.match(firstRetry.lastError, /Retrying attempt 2\/3/);

  const recovered = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 1, inserted: 1, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(recovered.status, "running");
  assert.equal(recovered.completedTargets, 1);
  assert.equal(recovered.currentTarget.index, 1);
  assert.equal(recovered.currentAttempt, 1);
  assert.equal(recovered.inserted, 1);
  assert.equal(recovered.failedTargets, 0);
});

test("refresh target url availability errors retry as temporary issues", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Target URL Missing Retry", 15);
  const person = db.upsertPerson({
    name: "Missing URL Retry Person",
    profileUrl: "https://www.linkedin.com/in/missing-url-retry-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  const retrying = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    error: "Refresh target URL is unavailable.",
  });

  assert.equal(retrying.status, "running");
  assert.equal(retrying.completedTargets, 0);
  assert.equal(retrying.failedTargets, 0);
  assert.equal(retrying.currentTarget.index, 0);
  assert.equal(retrying.currentAttempt, 2);
  assert.match(retrying.lastError, /temporary problem/);
  assert.match(retrying.lastError, /Retrying attempt 2\/3/);
});

test("refresh sessions continue after a target exhausts retries", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Exhaustion", 15);
  const person = db.upsertPerson({
    name: "Exhaustion Person",
    profileUrl: "https://www.linkedin.com/in/exhaustion-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  const manager = new RefreshSessionManager(db);
  const session = manager.create(feed.id);
  manager.recordTargetComplete(session.id, { targetIndex: 0, error: "Too many requests." });
  manager.recordTargetComplete(session.id, { targetIndex: 0, error: "Too many requests." });
  const exhausted = manager.recordTargetComplete(session.id, { targetIndex: 0, error: "Too many requests." });

  assert.equal(exhausted.status, "running");
  assert.equal(exhausted.completedTargets, 1);
  assert.equal(exhausted.currentTarget.index, 1);
  assert.equal(exhausted.failedTargets, 1);
  assert.match(exhausted.lastError, /skipped after 3 attempts/);

  const finished = manager.recordTargetComplete(session.id, {
    targetIndex: 1,
    captureResult: { received: 0, inserted: 0, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  assert.equal(finished.status, "failed");
  assert.equal(finished.completedTargets, 2);
  assert.equal(finished.failedTargets, 1);
  assert.match(finished.lastError, /skipped after 3 attempts/);
});

test("refresh sessions expire when no page reports progress", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Expiry", 15);
  const person = db.upsertPerson({
    name: "Expiry Person",
    profileUrl: "https://www.linkedin.com/in/expiry-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  let now = new Date("2026-01-01T00:00:00.000Z");
  const manager = new RefreshSessionManager(db, {
    staleSessionMs: 1000,
    now: () => now,
  });
  const session = manager.create(feed.id);

  now = new Date("2026-01-01T00:00:02.000Z");
  const expired = manager.get(session.id);

  assert.equal(expired.status, "failed");
  assert.match(expired.lastError, /expired/);
  assert.equal(manager.getActive(), undefined);
});

test("refresh heartbeats keep login waits from expiring", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Login Wait", 15);
  const person = db.upsertPerson({
    name: "Login Wait Person",
    profileUrl: "https://www.linkedin.com/in/login-wait-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  let now = new Date("2026-01-01T00:00:00.000Z");
  const manager = new RefreshSessionManager(db, {
    staleSessionMs: 1000,
    now: () => now,
  });
  const session = manager.create(feed.id);

  now = new Date("2026-01-01T00:00:00.800Z");
  const heartbeat = manager.recordHeartbeat(session.id, {
    targetIndex: 0,
    message: "Sign in to LinkedIn, then this refresh will continue.",
  });

  assert.equal(heartbeat.status, "running");
  assert.equal(heartbeat.completedTargets, 0);
  assert.match(heartbeat.lastError, /Sign in to LinkedIn/);

  now = new Date("2026-01-01T00:00:01.500Z");
  const stillRunning = manager.get(session.id);

  assert.equal(stillRunning.status, "running");
  assert.equal(stillRunning.currentTarget.index, 0);
  assert.match(stillRunning.lastError, /Sign in to LinkedIn/);

  now = new Date("2026-01-01T00:00:02.000Z");
  const expired = manager.get(session.id);

  assert.equal(expired.status, "failed");
  assert.match(expired.lastError, /expired/);
});

test("auth refresh heartbeats from LinkedIn login gates keep sessions alive", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Login Gate Heartbeat", 15);
  const person = db.upsertPerson({
    name: "Login Gate Heartbeat Person",
    profileUrl: "https://www.linkedin.com/in/login-gate-heartbeat-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  let now = new Date("2026-01-01T00:00:00.000Z");
  const manager = new RefreshSessionManager(db, {
    staleSessionMs: 1000,
    now: () => now,
  });
  const session = manager.create(feed.id);

  now = new Date("2026-01-01T00:00:00.800Z");
  const heartbeat = manager.recordHeartbeat(session.id, {
    targetIndex: 0,
    url: "https://www.linkedin.com/checkpoint/challenge/",
    message: "Sign in to LinkedIn, then this refresh will continue.",
  });

  assert.equal(heartbeat.status, "running");
  assert.equal(heartbeat.completedTargets, 0);
  assert.equal(heartbeat.updatedAt, "2026-01-01T00:00:00.800Z");
  assert.match(heartbeat.lastError, /Sign in to LinkedIn/);

  now = new Date("2026-01-01T00:00:01.500Z");
  const stillRunning = manager.get(session.id);

  assert.equal(stillRunning.status, "running");
  assert.equal(stillRunning.currentTarget.index, 0);

  now = new Date("2026-01-01T00:00:02.000Z");
  const expired = manager.get(session.id);

  assert.equal(expired.status, "failed");
  assert.match(expired.lastError, /expired/);
});

test("repeated refresh heartbeats are persisted only after a throttle interval", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Heartbeat Throttle", 15);
  const person = db.upsertPerson({
    name: "Heartbeat Throttle Person",
    profileUrl: "https://www.linkedin.com/in/heartbeat-throttle-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  let now = new Date("2026-01-01T00:00:00.000Z");
  const manager = new RefreshSessionManager(db, {
    heartbeatPersistIntervalMs: 1000,
    now: () => now,
  });
  const session = manager.create(feed.id);
  const originalSetAppState = db.setAppState.bind(db);
  let persistedWrites = 0;
  db.setAppState = (...args) => {
    persistedWrites += 1;
    return originalSetAppState(...args);
  };

  now = new Date("2026-01-01T00:00:00.100Z");
  const first = manager.recordHeartbeat(session.id, {
    targetIndex: 0,
    url: session.nextUrl,
    message: "Sign in to LinkedIn, then this refresh will continue.",
  });
  now = new Date("2026-01-01T00:00:00.500Z");
  const throttled = manager.recordHeartbeat(session.id, {
    targetIndex: 0,
    url: session.nextUrl,
    message: "Sign in to LinkedIn, then this refresh will continue.",
  });
  now = new Date("2026-01-01T00:00:01.200Z");
  const persisted = manager.recordHeartbeat(session.id, {
    targetIndex: 0,
    url: session.nextUrl,
    message: "Sign in to LinkedIn, then this refresh will continue.",
  });

  assert.equal(persistedWrites, 2);
  assert.equal(first.updatedAt, "2026-01-01T00:00:00.100Z");
  assert.equal(throttled.updatedAt, "2026-01-01T00:00:00.500Z");
  assert.equal(persisted.updatedAt, "2026-01-01T00:00:01.200Z");
  assert.equal(manager.get(session.id).status, "running");
});

test("refresh heartbeats without target identity do not keep sessions alive", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Untargeted Heartbeat", 15);
  const person = db.upsertPerson({
    name: "Untargeted Heartbeat Person",
    profileUrl: "https://www.linkedin.com/in/untargeted-heartbeat-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  let now = new Date("2026-01-01T00:00:00.000Z");
  const manager = new RefreshSessionManager(db, {
    staleSessionMs: 1000,
    now: () => now,
  });
  const session = manager.create(feed.id);

  now = new Date("2026-01-01T00:00:00.800Z");
  const ignored = manager.recordHeartbeat(session.id, { message: "Still here, but from an unknown page." });

  assert.equal(ignored.status, "running");
  assert.equal(ignored.updatedAt, session.updatedAt);
  assert.equal(ignored.lastError, "");

  now = new Date("2026-01-01T00:00:01.200Z");
  const expired = manager.get(session.id);

  assert.equal(expired.status, "failed");
  assert.match(expired.lastError, /expired/);
});

test("refresh heartbeats from mismatched target urls do not keep sessions alive", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Wrong Url Heartbeat", 15);
  const person = db.upsertPerson({
    name: "Wrong Url Heartbeat Person",
    profileUrl: "https://www.linkedin.com/in/wrong-url-heartbeat-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  let now = new Date("2026-01-01T00:00:00.000Z");
  const manager = new RefreshSessionManager(db, {
    staleSessionMs: 1000,
    now: () => now,
  });
  const session = manager.create(feed.id);

  now = new Date("2026-01-01T00:00:00.800Z");
  const wrongProfile = manager.recordHeartbeat(session.id, {
    targetIndex: 0,
    url: "https://www.linkedin.com/in/someone-else/recent-activity/all/?lefTarget=0",
    message: "Wrong profile heartbeat.",
  });
  const wrongProfileAuthText = manager.recordHeartbeat(session.id, {
    targetIndex: 0,
    url: "https://www.linkedin.com/in/someone-else/recent-activity/all/?lefTarget=0",
    message: "Sign in to LinkedIn, then this refresh will continue.",
  });
  const missingTargetMarker = manager.recordHeartbeat(session.id, {
    url: "https://www.linkedin.com/in/wrong-url-heartbeat-person/recent-activity/all/",
    message: "Missing target marker heartbeat.",
  });

  assert.equal(wrongProfile.updatedAt, session.updatedAt);
  assert.equal(wrongProfileAuthText.updatedAt, session.updatedAt);
  assert.equal(missingTargetMarker.updatedAt, session.updatedAt);

  now = new Date("2026-01-01T00:00:01.200Z");
  const expired = manager.get(session.id);

  assert.equal(expired.status, "failed");
  assert.match(expired.lastError, /expired/);
});

test("refresh heartbeats with conflicting target markers do not keep sessions alive", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Refresh Conflicting Heartbeat", 15);
  const person = db.upsertPerson({
    name: "Conflicting Heartbeat Person",
    profileUrl: "https://www.linkedin.com/in/conflicting-heartbeat-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  let now = new Date("2026-01-01T00:00:00.000Z");
  const manager = new RefreshSessionManager(db, {
    staleSessionMs: 1000,
    now: () => now,
  });
  const session = manager.create(feed.id);
  const conflictingUrl = new URL(session.nextUrl);
  conflictingUrl.searchParams.set("lefTarget", "1");

  now = new Date("2026-01-01T00:00:00.800Z");
  const ignored = manager.recordHeartbeat(session.id, {
    targetIndex: 0,
    url: conflictingUrl.toString(),
    message: "Conflicting marker heartbeat.",
  });

  assert.equal(ignored.status, "running");
  assert.equal(ignored.updatedAt, session.updatedAt);
  assert.equal(ignored.lastError, "");

  now = new Date("2026-01-01T00:00:01.200Z");
  const expired = manager.get(session.id);

  assert.equal(expired.status, "failed");
  assert.match(expired.lastError, /expired/);
});

test("refresh heartbeats from completed targets do not keep sessions alive", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Stale Heartbeat Refresh", 15);
  const person = db.upsertPerson({
    name: "Stale Heartbeat Person",
    profileUrl: "https://www.linkedin.com/in/stale-heartbeat-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  let now = new Date("2026-05-01T12:00:00.000Z");
  const manager = new RefreshSessionManager(db, {
    staleSessionMs: 1000,
    now: () => now,
  });
  const session = manager.create(feed.id);

  now = new Date("2026-05-01T12:00:00.500Z");
  const completedFirstTarget = manager.recordTargetComplete(session.id, {
    targetIndex: 0,
    captureResult: { received: 0, inserted: 0, updated: 0, skippedOlder: 0, skippedUntracked: 0, skippedInvalid: 0 },
  });

  now = new Date("2026-05-01T12:00:00.800Z");
  const staleHeartbeat = manager.recordHeartbeat(session.id, {
    targetIndex: 0,
    message: "Sign in to LinkedIn, then this refresh will continue.",
  });

  assert.equal(staleHeartbeat.completedTargets, 1);
  assert.equal(staleHeartbeat.currentTarget.index, 1);
  assert.equal(staleHeartbeat.updatedAt, completedFirstTarget.updatedAt);

  now = new Date("2026-05-01T12:00:02.000Z");
  const expired = manager.get(session.id);

  assert.equal(expired.status, "failed");
  assert.match(expired.lastError, /expired/);
});

test("persisted refresh sessions expire on manager startup", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Refresh Persisted Expiry", 15);
  const person = db.upsertPerson({
    name: "Persisted Expiry Person",
    profileUrl: "https://www.linkedin.com/in/persisted-expiry-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);

  let now = new Date("2026-01-01T00:00:00.000Z");
  const manager = new RefreshSessionManager(db, {
    staleSessionMs: 1000,
    now: () => now,
  });
  const session = manager.create(feed.id);

  now = new Date("2026-01-01T00:00:02.000Z");
  const restoredDb = await reopenTestDb(dbPath);
  const restoredManager = new RefreshSessionManager(restoredDb, {
    staleSessionMs: 1000,
    now: () => now,
  });
  const expired = restoredManager.get(session.id);

  assert.equal(expired.status, "failed");
  assert.match(expired.lastError, /expired/);
  assert.equal(restoredManager.getActive(), undefined);

  const finalDb = await reopenTestDb(dbPath);
  const finalManager = new RefreshSessionManager(finalDb, { now: () => now });
  assert.equal(finalManager.get(session.id).status, "failed");
  assert.equal(finalManager.getActive(), undefined);
});

test("storage info reports database, backup, and corrupt files", async () => {
  const { db, dbPath } = await createTestDb();
  db.createFeed("Storage Info", 15);
  const corruptPath = `${dbPath}.corrupt-test`;
  fs.writeFileSync(corruptPath, "corrupt");

  const info = db.getStorageInfo();

  assert.equal(info.databasePath, dbPath);
  assert.equal(info.backupPath, `${dbPath}.bak`);
  assert.equal(info.databaseExists, true);
  assert.equal(info.backupExists, true);
  assert.ok(info.databaseBytes > 0);
  assert.ok(info.backupBytes > 0);
  assert.ok(info.corruptBackups.some((entry) => entry.path === corruptPath));
});

test("idempotency app state stays bounded without pruning durable app state", async () => {
  const { db } = await createTestDb();
  db.setAppState("refreshSessions.v1", { durable: true });

  for (let index = 0; index < MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX + 25; index += 1) {
    db.setAppState(`queueStatus.test.${String(index).padStart(4, "0")}`, { index });
    db.setAppState(`counterAdjust.test.${String(index).padStart(4, "0")}`, { index });
    db.setAppState(`counterUpdate.test.${String(index).padStart(4, "0")}`, { index });
    db.setAppState(`captureItems.test.${String(index).padStart(4, "0")}`, { index });
    db.setAppState(`captureItemsMulti.test.${String(index).padStart(4, "0")}`, { index });
    db.setAppState(`feedCreate.test.${String(index).padStart(4, "0")}`, { index });
    db.setAppState(`feedUpdate.test.${String(index).padStart(4, "0")}`, { index });
    db.setAppState(`personMembership.test.${String(index).padStart(4, "0")}`, { index });
    db.setAppState(`personUpsert.test.${String(index).padStart(4, "0")}`, { index });
    db.setAppState(`profileMembership.test.${String(index).padStart(4, "0")}`, { index });
    db.setAppState(`feedPerson.test.${String(index).padStart(4, "0")}`, { index });
    db.setAppState(`refreshTarget.test.${String(index).padStart(4, "0")}`, { index });
    db.setAppState(`bulkPeople.test.${String(index).padStart(4, "0")}`, { index });
  }

  const rows =
    db.db.exec(`
      SELECT
        SUM(CASE WHEN key LIKE 'queueStatus.%' THEN 1 ELSE 0 END) AS queueStatusCount,
        SUM(CASE WHEN key LIKE 'counterAdjust.%' THEN 1 ELSE 0 END) AS counterAdjustCount,
        SUM(CASE WHEN key LIKE 'counterUpdate.%' THEN 1 ELSE 0 END) AS counterUpdateCount,
        SUM(CASE WHEN key LIKE 'captureItems.%' THEN 1 ELSE 0 END) AS captureItemsCount,
        SUM(CASE WHEN key LIKE 'captureItemsMulti.%' THEN 1 ELSE 0 END) AS captureItemsMultiCount,
        SUM(CASE WHEN key LIKE 'feedCreate.%' THEN 1 ELSE 0 END) AS feedCreateCount,
        SUM(CASE WHEN key LIKE 'feedUpdate.%' THEN 1 ELSE 0 END) AS feedUpdateCount,
        SUM(CASE WHEN key LIKE 'personMembership.%' THEN 1 ELSE 0 END) AS personMembershipCount,
        SUM(CASE WHEN key LIKE 'personUpsert.%' THEN 1 ELSE 0 END) AS personUpsertCount,
        SUM(CASE WHEN key LIKE 'profileMembership.%' THEN 1 ELSE 0 END) AS profileMembershipCount,
        SUM(CASE WHEN key LIKE 'feedPerson.%' THEN 1 ELSE 0 END) AS feedPersonCount,
        SUM(CASE WHEN key LIKE 'refreshTarget.%' THEN 1 ELSE 0 END) AS refreshTargetCount,
        SUM(CASE WHEN key LIKE 'bulkPeople.%' THEN 1 ELSE 0 END) AS bulkPeopleCount,
        SUM(CASE WHEN key = 'refreshSessions.v1' THEN 1 ELSE 0 END) AS durableCount
      FROM app_state
    `)[0]?.values?.[0] ?? [];

  assert.deepEqual(rows, [
    MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX,
    MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX,
    MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX,
    MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX,
    MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX,
    MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX,
    MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX,
    MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX,
    MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX,
    MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX,
    MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX,
    MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX,
    MAX_IDEMPOTENCY_STATE_ENTRIES_PER_PREFIX,
    1,
  ]);
  assert.equal(db.getAppState("queueStatus.test.0000"), undefined);
  assert.equal(db.getAppState("counterAdjust.test.0000"), undefined);
  assert.equal(db.getAppState("counterUpdate.test.0000"), undefined);
  assert.equal(db.getAppState("captureItems.test.0000"), undefined);
  assert.equal(db.getAppState("captureItemsMulti.test.0000"), undefined);
  assert.equal(db.getAppState("feedCreate.test.0000"), undefined);
  assert.equal(db.getAppState("feedUpdate.test.0000"), undefined);
  assert.equal(db.getAppState("personMembership.test.0000"), undefined);
  assert.equal(db.getAppState("personUpsert.test.0000"), undefined);
  assert.equal(db.getAppState("profileMembership.test.0000"), undefined);
  assert.equal(db.getAppState("feedPerson.test.0000"), undefined);
  assert.equal(db.getAppState("refreshTarget.test.0000"), undefined);
  assert.equal(db.getAppState("bulkPeople.test.0000"), undefined);
  assert.deepEqual(db.getAppState("refreshSessions.v1")?.value, { durable: true });
});

test("idempotency prefix counts are cached between writes", async () => {
  const { db } = await createTestDb();
  const originalOne = db.one.bind(db);
  let countQueries = 0;
  db.one = (sql, params) => {
    if (String(sql).includes("SELECT COUNT(*) AS count FROM app_state WHERE key LIKE ? ESCAPE '^'")) {
      countQueries += 1;
    }
    return originalOne(sql, params);
  };

  for (let index = 0; index < 25; index += 1) {
    db.setAppState(`queueStatus.cached.${String(index).padStart(4, "0")}`, { index });
  }

  assert.equal(countQueries, 1);
});

test("unchanged app state saves do not rewrite the database", async () => {
  const { db } = await createTestDb();
  const originalSave = db.save.bind(db);
  let saveCount = 0;
  db.save = () => {
    saveCount += 1;
    originalSave();
  };

  const first = db.setAppState("refreshSessions.v1", { durable: true });
  const duplicate = db.setAppState("refreshSessions.v1", { durable: true });
  const changed = db.setAppState("refreshSessions.v1", { durable: false });

  assert.equal(saveCount, 2);
  assert.equal(duplicate.updatedAt, first.updatedAt);
  assert.deepEqual(duplicate.value, first.value);
  assert.deepEqual(changed.value, { durable: false });
  assert.deepEqual(db.getAppState("refreshSessions.v1")?.value, { durable: false });
});

test("corrupt idempotency replay state is pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Corrupt Replay Feed", 15);
  const person = db.upsertPerson({
    name: "Corrupt Replay Person",
    profileUrl: "https://www.linkedin.com/in/corrupt-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:corrupt-replay/",
      text: "Corrupt replay state should not break a retried queue status write.",
      activityAt: new Date().toISOString(),
    },
  ]);
  const item = db.listQueue(feed.id)[0];
  const requestId = "corrupt-replay-status-1";
  const replayKey = `queueStatus.${shortHash(item.id)}.${requestId}`;
  db.db.run(
    "INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)",
    [replayKey, "{not valid json", new Date().toISOString()],
  );

  const first = db.setItemStatus(item.id, "done", { requestId });
  const duplicate = db.setItemStatus(item.id, "skipped", { requestId });

  assert.equal(first.status, "done");
  assert.equal(first.changed, true);
  assert.deepEqual(duplicate, first);
  assert.equal(db.getAppState(replayKey)?.value.status, "done");
  assert.equal(db.listQueue(feed.id, "done").length, 1);
});

test("malformed queue status replay state is pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Malformed Queue Replay Feed", 15);
  const person = db.upsertPerson({
    name: "Malformed Queue Replay Person",
    profileUrl: "https://www.linkedin.com/in/malformed-queue-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:malformed-queue-replay/",
      text: "Malformed but valid replay JSON should not poison queue status retries.",
      activityAt: new Date().toISOString(),
    },
  ]);
  const item = db.listQueue(feed.id)[0];
  const requestId = "malformed-queue-replay-status-1";
  const replayKey = `queueStatus.${shortHash(item.id)}.${requestId}`;
  db.setAppState(replayKey, {
    itemId: item.id,
    personId: person.id,
    previousStatus: "new",
    status: "done",
    changed: true,
    commentCountDelta: 2,
  });

  const first = db.setItemStatus(item.id, "done", { requestId });
  const duplicate = db.setItemStatus(item.id, "skipped", { requestId });

  assert.equal(first.itemId, item.id);
  assert.equal(first.status, "done");
  assert.equal(first.changed, true);
  assert.equal(first.commentCountDelta, 1);
  assert.deepEqual(duplicate, first);
  assert.equal(db.getAppState(replayKey)?.value.itemId, item.id);
  assert.equal(db.getAppState(replayKey)?.value.commentCountDelta, 1);
  assert.equal(db.listQueue(feed.id, "done").length, 1);
});

test("impossible queue status replay state is pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Impossible Queue Replay Feed", 15);
  const person = db.upsertPerson({
    name: "Impossible Queue Replay Person",
    profileUrl: "https://www.linkedin.com/in/impossible-queue-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:impossible-queue-replay/",
      text: "Impossible but type-valid replay state should not poison queue status retries.",
      activityAt: new Date().toISOString(),
    },
  ]);
  const item = db.listQueue(feed.id)[0];
  const requestId = "impossible-queue-replay-status-1";
  const replayKey = `queueStatus.${shortHash(item.id)}.${requestId}`;
  db.setAppState(replayKey, {
    itemId: item.id,
    personId: person.id,
    previousStatus: "new",
    status: "skipped",
    changed: false,
    commentCountDelta: 0,
  });

  const first = db.setItemStatus(item.id, "done", { requestId });
  const duplicate = db.setItemStatus(item.id, "skipped", { requestId });

  assert.equal(first.itemId, item.id);
  assert.equal(first.status, "done");
  assert.equal(first.changed, true);
  assert.equal(first.commentCountDelta, 1);
  assert.deepEqual(duplicate, first);
  assert.equal(db.getAppState(replayKey)?.value.status, "done");
  assert.equal(db.getAppState(replayKey)?.value.commentCountDelta, 1);
  assert.equal(db.listQueue(feed.id, "done").length, 1);
});

test("malformed capture replay state is pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Malformed Capture Replay Feed", 15);
  const person = db.upsertPerson({
    name: "Malformed Capture Replay Person",
    profileUrl: "https://www.linkedin.com/in/malformed-capture-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  const requestId = "malformed-capture-replay-1";
  const replayKey = `captureItems.${shortHash(feed.id)}.${requestId}`;
  db.setAppState(replayKey, {
    received: 1,
    inserted: 1.5,
    updated: 0,
    skippedOlder: 0,
    skippedUntracked: 0,
    skippedInvalid: 0,
  });

  const first = db.captureItems(
    feed.id,
    [
      {
        personName: person.name,
        profileUrl: person.profileUrl,
        type: "post",
        sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:malformed-capture-replay/",
        text: "Malformed capture replay state should not suppress a real capture.",
        activityAt: new Date().toISOString(),
      },
    ],
    { requestId },
  );
  const duplicate = db.captureItems(feed.id, [], { requestId });

  assert.deepEqual(first, {
    received: 1,
    inserted: 1,
    updated: 0,
    skippedOlder: 0,
    skippedUntracked: 0,
    skippedInvalid: 0,
  });
  assert.deepEqual(duplicate, first);
  assert.equal(db.getAppState(replayKey)?.value.inserted, 1);
  assert.equal(db.listQueue(feed.id, "new").length, 1);
});

test("impossible aggregate capture replay state is pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Impossible Aggregate Capture Replay Feed", 15);
  const person = db.upsertPerson({
    name: "Impossible Aggregate Capture Replay Person",
    profileUrl: "https://www.linkedin.com/in/impossible-aggregate-capture-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  const requestId = "impossible-aggregate-capture-replay-1";
  const replayKey = `captureItems.${shortHash(feed.id)}.${requestId}`;
  db.setAppState(replayKey, {
    received: 1,
    inserted: 1,
    updated: 1,
    skippedOlder: 0,
    skippedUntracked: 0,
    skippedInvalid: 0,
  });

  const first = db.captureItems(
    feed.id,
    [
      {
        personName: person.name,
        profileUrl: person.profileUrl,
        type: "post",
        sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:impossible-aggregate-capture-replay/",
        text: "Impossible aggregate capture replay state should not suppress real captures.",
        activityAt: new Date().toISOString(),
      },
    ],
    { requestId },
  );
  const duplicate = db.captureItems(feed.id, [], { requestId });

  assert.deepEqual(first, {
    received: 1,
    inserted: 1,
    updated: 0,
    skippedOlder: 0,
    skippedUntracked: 0,
    skippedInvalid: 0,
  });
  assert.deepEqual(duplicate, first);
  assert.equal(db.getAppState(replayKey)?.value.updated, 0);
  assert.equal(db.listQueue(feed.id, "new").length, 1);
});

test("oversized single-feed capture replay state is pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Oversized Capture Replay Feed", 15);
  const person = db.upsertPerson({
    name: "Oversized Capture Replay Person",
    profileUrl: "https://www.linkedin.com/in/oversized-capture-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feed.id]);
  const requestId = "oversized-capture-replay-1";
  const replayKey = `captureItems.${shortHash(feed.id)}.${requestId}`;
  db.setAppState(replayKey, {
    received: MAX_CAPTURE_ITEMS_PER_REQUEST + 50,
    inserted: MAX_CAPTURE_ITEMS_PER_REQUEST + 50,
    updated: 0,
    skippedOlder: 0,
    skippedUntracked: 0,
    skippedInvalid: 0,
  });

  const first = db.captureItems(
    feed.id,
    [
      {
        personName: person.name,
        profileUrl: person.profileUrl,
        type: "post",
        sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:oversized-capture-replay/",
        text: "Oversized capture replay state should not suppress a real capture.",
        activityAt: new Date().toISOString(),
      },
    ],
    { requestId },
  );
  const duplicate = db.captureItems(feed.id, [], { requestId });

  assert.deepEqual(first, {
    received: 1,
    inserted: 1,
    updated: 0,
    skippedOlder: 0,
    skippedUntracked: 0,
    skippedInvalid: 0,
  });
  assert.deepEqual(duplicate, first);
  assert.equal(db.getAppState(replayKey)?.value.received, 1);
  assert.equal(db.listQueue(feed.id, "new").length, 1);
});

test("oversized single-feed capture replay accepts counted overflow", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Counted Overflow Capture Replay Feed", 15);
  const requestId = "counted-overflow-capture-replay-1";
  const replayKey = `captureItems.${shortHash(feed.id)}.${requestId}`;
  db.setAppState(replayKey, {
    received: MAX_CAPTURE_ITEMS_PER_REQUEST + 10,
    inserted: MAX_CAPTURE_ITEMS_PER_REQUEST,
    updated: 0,
    skippedOlder: 0,
    skippedUntracked: 0,
    skippedInvalid: 10,
  });

  const replay = db.captureItems(feed.id, [], { requestId });

  assert.deepEqual(replay, {
    received: MAX_CAPTURE_ITEMS_PER_REQUEST + 10,
    inserted: MAX_CAPTURE_ITEMS_PER_REQUEST,
    updated: 0,
    skippedOlder: 0,
    skippedUntracked: 0,
    skippedInvalid: 10,
  });
  assert.equal(db.listQueue(feed.id, "new").length, 0);
});

test("malformed multi-feed capture replay state is pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Malformed Multi Capture Replay A", 15);
  const feedB = db.createFeed("Malformed Multi Capture Replay B", 15);
  const person = db.upsertPerson({
    name: "Malformed Multi Capture Replay Person",
    profileUrl: "https://www.linkedin.com/in/malformed-multi-capture-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feedA.id, feedB.id]);
  const requestId = "malformed-multi-capture-replay-1";
  const replayKey = `captureItemsMulti.${requestId}`;
  db.setAppState(replayKey, {
    received: Number.MAX_SAFE_INTEGER + 1,
    inserted: Number.MAX_SAFE_INTEGER + 1,
    updated: 0,
    skippedOlder: 0,
    skippedUntracked: 0,
    skippedInvalid: 0,
  });

  const first = db.captureItemsForFeeds(
    [feedA.id, feedB.id],
    [
      {
        personName: person.name,
        profileUrl: person.profileUrl,
        type: "post",
        sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:malformed-multi-capture-replay/",
        text: "Malformed multi-feed capture replay state should not suppress real captures.",
        activityAt: new Date().toISOString(),
      },
    ],
    { requestId },
  );
  const duplicate = db.captureItemsForFeeds([feedA.id], [], { requestId });

  assert.deepEqual(first, {
    received: 2,
    inserted: 1,
    updated: 1,
    skippedOlder: 0,
    skippedUntracked: 0,
    skippedInvalid: 0,
  });
  assert.deepEqual(duplicate, first);
  assert.equal(db.getAppState(replayKey)?.value.skippedOlder, 0);
  assert.equal(db.listQueue(feedA.id, "new").length, 1);
  assert.equal(db.listQueue(feedB.id, "new").length, 1);
});

test("malformed feed and counter replay states are pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Malformed Feed Replay Original", 15);
  const person = db.upsertPerson({
    name: "Malformed Counter Replay Person",
    profileUrl: "https://www.linkedin.com/in/malformed-counter-replay-person/",
  });
  const feedCreateRequestId = "malformed-feed-create-replay-1";
  const feedRequestId = "malformed-feed-replay-1";
  const counterUpdateRequestId = "malformed-counter-update-replay-1";
  const counterAdjustRequestId = "malformed-counter-adjust-replay-1";
  db.setAppState(`feedCreate.${feedCreateRequestId}`, {
    ...feed,
    id: "",
    lookbackDays: 0,
  });
  db.setAppState(`feedUpdate.${shortHash(feed.id)}.${feedRequestId}`, {
    ...feed,
    lookbackDays: 0,
    peopleCount: MAX_PEOPLE_PER_FEED + 1,
  });
  db.setAppState(`counterUpdate.${shortHash(person.id)}.${counterUpdateRequestId}`, {
    ...person,
    commentCount: Number.MAX_SAFE_INTEGER + 1,
  });
  db.setAppState(`counterAdjust.${shortHash(person.id)}.${counterAdjustRequestId}`, {
    ...person,
    id: "wrong-person",
  });

  const createdFeed = db.createFeed("Malformed Feed Create Replay Recovered", 45, { requestId: feedCreateRequestId });
  const updatedFeed = db.updateFeed(feed.id, { name: "Malformed Feed Replay Recovered", lookbackDays: 30 }, { requestId: feedRequestId });
  const counterUpdate = db.updateCounters(person.id, { commentCount: 5 }, { requestId: counterUpdateRequestId });
  const counterAdjust = db.adjustCounters(person.id, { likeCount: 2 }, { requestId: counterAdjustRequestId });

  assert.equal(createdFeed.name, "Malformed Feed Create Replay Recovered");
  assert.equal(createdFeed.lookbackDays, 45);
  assert.equal(updatedFeed.id, feed.id);
  assert.equal(updatedFeed.name, "Malformed Feed Replay Recovered");
  assert.equal(updatedFeed.lookbackDays, 30);
  assert.equal(db.getAppState(`feedCreate.${feedCreateRequestId}`)?.value.id, createdFeed.id);
  assert.equal(db.getAppState(`feedUpdate.${shortHash(feed.id)}.${feedRequestId}`)?.value.id, feed.id);
  assert.equal(counterUpdate.id, person.id);
  assert.equal(counterUpdate.commentCount, 5);
  assert.equal(counterAdjust.id, person.id);
  assert.equal(counterAdjust.likeCount, 2);
  assert.equal(db.getAppState(`counterUpdate.${shortHash(person.id)}.${counterUpdateRequestId}`)?.value.commentCount, 5);
  assert.equal(db.getAppState(`counterAdjust.${shortHash(person.id)}.${counterAdjustRequestId}`)?.value.likeCount, 2);
});

test("malformed person upsert replay states are pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const requestId = "malformed-person-upsert-replay-1";
  const profileUrl = "https://www.linkedin.com/in/malformed-person-upsert-replay/";
  db.setAppState(`personUpsert.${shortHash(profileUrl)}.${requestId}`, {
    id: "",
    name: "",
    profileUrl,
    publicId: "",
    headline: "",
    commentCount: -1,
    likeCount: 0,
    backCommentCount: 0,
    feedIds: [],
    createdAt: "",
    updatedAt: "",
  });

  const person = db.upsertPerson(
    {
      name: "Malformed Person Upsert Recovered",
      profileUrl,
    },
    { requestId },
  );
  const duplicate = db.upsertPerson(
    {
      name: "Malformed Person Upsert Duplicate",
      profileUrl,
    },
    { requestId },
  );

  assert.equal(person.name, "Malformed Person Upsert Recovered");
  assert.deepEqual(duplicate, person);
  assert.equal(db.getAppState(`personUpsert.${shortHash(profileUrl)}.${requestId}`)?.value.id, person.id);
});

test("malformed person membership replay states are pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Malformed Membership Replay A", 15);
  const feedB = db.createFeed("Malformed Membership Replay B", 15);
  const person = db.upsertPerson({
    name: "Malformed Membership Replay Person",
    profileUrl: "https://www.linkedin.com/in/malformed-membership-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feedA.id]);
  const personMembershipRequestId = "malformed-person-membership-replay-1";
  const profileMembershipRequestId = "malformed-profile-membership-replay-1";
  const feedPersonRequestId = "malformed-feed-person-replay-1";
  const profileUrl = "https://www.linkedin.com/in/malformed-profile-membership-replay-person/";
  const feedPersonProfileUrl = "https://www.linkedin.com/in/malformed-feed-person-replay-person/";
  db.setAppState(`personMembership.${shortHash(person.id)}.${personMembershipRequestId}`, {
    ...person,
    publicId: "wrong-public-id",
  });
  db.setAppState(`profileMembership.${shortHash(profileUrl)}.${profileMembershipRequestId}`, { feedIds: [] });
  db.setAppState(`feedPerson.${shortHash(feedB.id)}.${feedPersonRequestId}`, {
    ...person,
    feedIds: [feedA.id],
  });

  const membership = db.setPersonFeedMembership(person.id, [feedB.id], { requestId: personMembershipRequestId });
  const profileStatus = db.upsertPersonWithMembership(
    {
      name: "Malformed Profile Membership Replay Person",
      profileUrl,
      feedIds: [feedA.id],
    },
    { requestId: profileMembershipRequestId },
  );
  const feedPerson = db.addPersonToFeed(
    feedB.id,
    {
      name: "Malformed Feed Person Replay Person",
      profileUrl: feedPersonProfileUrl,
    },
    { requestId: feedPersonRequestId },
  );

  assert.equal(membership.id, person.id);
  assert.deepEqual(membership.feedIds, [feedB.id]);
  assert.equal(profileStatus.person?.profileUrl, profileUrl);
  assert.deepEqual(profileStatus.feedIds, [feedA.id]);
  assert.equal(feedPerson.profileUrl, feedPersonProfileUrl);
  assert.ok(feedPerson.feedIds.includes(feedB.id));
  assert.equal(db.getAppState(`personMembership.${shortHash(person.id)}.${personMembershipRequestId}`)?.value.feedIds[0], feedB.id);
  assert.equal(db.getAppState(`profileMembership.${shortHash(profileUrl)}.${profileMembershipRequestId}`)?.value.person.profileUrl, profileUrl);
  assert.ok(db.getAppState(`feedPerson.${shortHash(feedB.id)}.${feedPersonRequestId}`)?.value.feedIds.includes(feedB.id));
});

test("duplicate membership replay feed ids are pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feedA = db.createFeed("Duplicate Membership Replay A", 15);
  const feedB = db.createFeed("Duplicate Membership Replay B", 15);
  const person = db.upsertPerson({
    name: "Duplicate Membership Replay Person",
    profileUrl: "https://www.linkedin.com/in/duplicate-membership-replay-person/",
  });
  db.setPersonFeedMembership(person.id, [feedA.id]);
  const personMembershipRequestId = "duplicate-person-membership-replay-1";
  const profileMembershipRequestId = "duplicate-profile-membership-replay-1";
  const profileUrl = person.profileUrl;
  db.setAppState(`personMembership.${shortHash(person.id)}.${personMembershipRequestId}`, {
    ...db.getPerson(person.id),
    feedIds: [feedA.id, feedA.id],
  });
  db.setAppState(`profileMembership.${shortHash(profileUrl)}.${profileMembershipRequestId}`, {
    person: {
      ...db.getPerson(person.id),
      feedIds: [feedA.id, feedA.id],
    },
    feedIds: [feedA.id, feedB.id],
  });

  const membership = db.setPersonFeedMembership(person.id, [feedB.id], { requestId: personMembershipRequestId });
  const profileStatus = db.upsertPersonWithMembership(
    {
      name: person.name,
      profileUrl,
      feedIds: [feedB.id],
    },
    { requestId: profileMembershipRequestId },
  );

  assert.deepEqual(membership.feedIds, [feedB.id]);
  assert.deepEqual(profileStatus.feedIds, [feedB.id]);
  assert.deepEqual(db.getAppState(`personMembership.${shortHash(person.id)}.${personMembershipRequestId}`)?.value.feedIds, [
    feedB.id,
  ]);
  assert.deepEqual(db.getAppState(`profileMembership.${shortHash(profileUrl)}.${profileMembershipRequestId}`)?.value.feedIds, [
    feedB.id,
  ]);
});

test("malformed bulk people replay state is pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Malformed Bulk Replay Feed", 15);
  const requestId = "malformed-bulk-replay-1";
  const replayKey = `bulkPeople.${shortHash(feed.id)}.${requestId}`;
  db.setAppState(replayKey, {
    received: 1,
    added: 1,
    alreadyInFeed: 1,
    updated: 0,
    skippedInvalid: 0,
    skippedCapacity: 0,
    remainingCapacity: MAX_PEOPLE_PER_FEED + 1,
    errors: [],
  });

  const first = db.bulkAddPeopleToFeed(
    feed.id,
    [{ name: "Malformed Bulk Replay Person", profileUrl: "https://www.linkedin.com/in/malformed-bulk-replay-person/" }],
    { requestId },
  );
  const duplicate = db.bulkAddPeopleToFeed(feed.id, [], { requestId });

  assert.equal(first.received, 1);
  assert.equal(first.added, 1);
  assert.equal(first.remainingCapacity, 199);
  assert.deepEqual(duplicate, first);
  assert.equal(db.getAppState(replayKey)?.value.added, 1);
  assert.equal(db.listPeople("", feed.id).length, 1);
});

test("oversized bulk people replay state is pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Oversized Bulk Replay Feed", 15);
  const requestId = "oversized-bulk-replay-1";
  const replayKey = `bulkPeople.${shortHash(feed.id)}.${requestId}`;
  db.setAppState(replayKey, {
    received: MAX_BULK_PEOPLE_PER_REQUEST + 1,
    added: 0,
    alreadyInFeed: 0,
    updated: 0,
    skippedInvalid: MAX_BULK_PEOPLE_PER_REQUEST + 1,
    skippedCapacity: 0,
    remainingCapacity: MAX_PEOPLE_PER_FEED,
    errors: [],
  });

  const first = db.bulkAddPeopleToFeed(
    feed.id,
    [{ name: "Oversized Replay Person", profileUrl: "https://www.linkedin.com/in/oversized-bulk-replay-person/" }],
    { requestId },
  );
  const duplicate = db.bulkAddPeopleToFeed(feed.id, [], { requestId });

  assert.equal(first.received, 1);
  assert.equal(first.added, 1);
  assert.equal(first.skippedInvalid, 0);
  assert.deepEqual(duplicate, first);
  assert.equal(db.getAppState(replayKey)?.value.received, 1);
  assert.equal(db.listPeople("", feed.id).length, 1);
});

test("impossible bulk people replay error details are pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Impossible Bulk Replay Feed", 15);
  const requestId = "impossible-bulk-replay-1";
  const replayKey = `bulkPeople.${shortHash(feed.id)}.${requestId}`;
  db.setAppState(replayKey, {
    received: 1,
    added: 0,
    alreadyInFeed: 0,
    updated: 0,
    skippedInvalid: 1,
    skippedCapacity: 0,
    remainingCapacity: MAX_PEOPLE_PER_FEED,
    errors: [
      { index: 0, profileUrl: "https://www.linkedin.com/in/impossible-bulk-replay-a/", error: "Invalid." },
      { index: 0, profileUrl: "https://www.linkedin.com/in/impossible-bulk-replay-b/", error: "Also invalid." },
    ],
  });

  const first = db.bulkAddPeopleToFeed(
    feed.id,
    [{ name: "Impossible Bulk Replay Person", profileUrl: "https://www.linkedin.com/in/impossible-bulk-replay-person/" }],
    { requestId },
  );
  const duplicate = db.bulkAddPeopleToFeed(feed.id, [], { requestId });

  assert.equal(first.received, 1);
  assert.equal(first.added, 1);
  assert.equal(first.skippedInvalid, 0);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(duplicate, first);
  assert.equal(db.getAppState(replayKey)?.value.added, 1);
  assert.equal(db.listPeople("", feed.id).length, 1);
});

test("duplicate bulk people replay error indexes are pruned and recomputed", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Duplicate Bulk Error Replay Feed", 15);
  const requestId = "duplicate-bulk-error-replay-1";
  const replayKey = `bulkPeople.${shortHash(feed.id)}.${requestId}`;
  db.setAppState(replayKey, {
    received: 2,
    added: 0,
    alreadyInFeed: 0,
    updated: 0,
    skippedInvalid: 2,
    skippedCapacity: 0,
    remainingCapacity: MAX_PEOPLE_PER_FEED,
    errors: [
      { index: 0, profileUrl: "https://www.linkedin.com/in/duplicate-bulk-error-a/", error: "Invalid." },
      { index: 0, profileUrl: "https://www.linkedin.com/in/duplicate-bulk-error-b/", error: "Also invalid." },
    ],
  });

  const first = db.bulkAddPeopleToFeed(
    feed.id,
    [{ name: "Duplicate Bulk Error Replay Person", profileUrl: "https://www.linkedin.com/in/duplicate-bulk-error-person/" }],
    { requestId },
  );
  const duplicate = db.bulkAddPeopleToFeed(feed.id, [], { requestId });

  assert.equal(first.received, 1);
  assert.equal(first.added, 1);
  assert.equal(first.skippedInvalid, 0);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(duplicate, first);
  assert.equal(db.getAppState(replayKey)?.value.added, 1);
  assert.equal(db.listPeople("", feed.id).length, 1);
});

test("database creates queue, capture, and people listing indexes", async () => {
  const { db } = await createTestDb();
  const rows =
    db.db.exec(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'idx_items_activity_discovered',
          'idx_items_status_activity_discovered',
          'idx_item_feeds_feed_item',
          'idx_items_person_type_activity',
          'idx_items_comment_source_day',
          'idx_feed_people_feed',
          'idx_people_public_id_nocase'
        )
      ORDER BY name
    `)[0]?.values ?? [];

  assert.deepEqual(
    rows.map(([name]) => name),
    [
      "idx_feed_people_feed",
      "idx_item_feeds_feed_item",
      "idx_items_activity_discovered",
      "idx_items_comment_source_day",
      "idx_items_person_type_activity",
      "idx_items_status_activity_discovered",
      "idx_people_public_id_nocase",
    ],
  );
});

test("database saves rotate backup generations", async () => {
  const { db, dbPath } = await createTestDb();
  db.createFeed("Backup Generation One", 15);
  db.createFeed("Backup Generation Two", 15);

  assert.equal(fs.existsSync(`${dbPath}.bak`), true);
  assert.equal(fs.existsSync(`${dbPath}.bak.1`), true);
  assert.equal(fs.existsSync(`${dbPath}.bak.2`), true);

  const latestNames = await feedNamesFromDatabaseFile(`${dbPath}.bak`);
  const previousNames = await feedNamesFromDatabaseFile(`${dbPath}.bak.1`);
  assert.equal(latestNames.includes("Backup Generation Two"), true);
  assert.equal(previousNames.includes("Backup Generation One"), true);
  assert.equal(previousNames.includes("Backup Generation Two"), false);
});

test("database save retries transient file replace locks", async () => {
  const { db, dbPath } = await createTestDb();
  const originalRenameSync = fs.renameSync;
  let transientFailures = 0;

  fs.renameSync = function renameSyncWithTransientLock(source, destination) {
    if (
      transientFailures < 2 &&
      path.basename(String(source)) === "engagement.sqlite.tmp" &&
      path.basename(String(destination)) === "engagement.sqlite"
    ) {
      transientFailures += 1;
      const error = new Error("Simulated transient Windows file lock");
      error.code = "EBUSY";
      throw error;
    }
    return originalRenameSync.call(this, source, destination);
  };

  try {
    db.createFeed("Transient Save Retry", 15);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  const names = await feedNamesFromDatabaseFile(dbPath);

  assert.equal(transientFailures, 2);
  assert.equal(fs.existsSync(dbPath), true);
  assert.equal(fs.existsSync(`${dbPath}.tmp`), false);
  assert.equal(names.includes("Transient Save Retry"), true);
});

test("database backup rotation retries transient file replace locks", async () => {
  const { db, dbPath } = await createTestDb();
  db.createFeed("Backup Rotation Existing One", 15);
  const originalRenameSync = fs.renameSync;
  let transientFailures = 0;

  fs.renameSync = function renameBackupWithTransientLock(source, destination) {
    if (
      transientFailures < 2 &&
      path.basename(String(source)) === "engagement.sqlite.bak" &&
      path.basename(String(destination)) === "engagement.sqlite.bak.1"
    ) {
      transientFailures += 1;
      const error = new Error("Simulated transient Windows backup lock");
      error.code = "EBUSY";
      throw error;
    }
    return originalRenameSync.call(this, source, destination);
  };

  try {
    db.createFeed("Backup Rotation Retry", 15);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  const latestNames = await feedNamesFromDatabaseFile(`${dbPath}.bak`);
  const previousNames = await feedNamesFromDatabaseFile(`${dbPath}.bak.1`);

  assert.equal(transientFailures, 2);
  assert.equal(latestNames.includes("Backup Rotation Retry"), true);
  assert.equal(previousNames.includes("Backup Rotation Existing One"), true);
  assert.equal(previousNames.includes("Backup Rotation Retry"), false);
});

test("database backup rotation retries transient oldest backup removal locks", async () => {
  const { db, dbPath } = await createTestDb();
  db.createFeed("Backup Removal Existing One", 15);
  db.createFeed("Backup Removal Existing Two", 15);
  const originalRmSync = fs.rmSync;
  let transientFailures = 0;

  fs.rmSync = function rmBackupWithTransientLock(target, options) {
    if (
      transientFailures < 2 &&
      path.basename(String(target)) === "engagement.sqlite.bak.2"
    ) {
      transientFailures += 1;
      const error = new Error("Simulated transient Windows oldest backup lock");
      error.code = "EBUSY";
      throw error;
    }
    return originalRmSync.call(this, target, options);
  };

  try {
    db.createFeed("Backup Removal Retry", 15);
  } finally {
    fs.rmSync = originalRmSync;
  }

  const latestNames = await feedNamesFromDatabaseFile(`${dbPath}.bak`);
  const previousNames = await feedNamesFromDatabaseFile(`${dbPath}.bak.1`);
  const olderNames = await feedNamesFromDatabaseFile(`${dbPath}.bak.2`);

  assert.equal(transientFailures, 2);
  assert.equal(latestNames.includes("Backup Removal Retry"), true);
  assert.equal(previousNames.includes("Backup Removal Existing Two"), true);
  assert.equal(previousNames.includes("Backup Removal Retry"), false);
  assert.equal(olderNames.includes("Backup Removal Existing One"), true);
});

test("database recovers a newer pending temp save on startup", async () => {
  const { db, dbPath } = await createTestDb();
  db.createFeed("Primary Before Pending", 15);

  const pendingPath = `${dbPath}.tmp`;
  fs.copyFileSync(dbPath, pendingPath);
  const pendingDb = new AppDatabase(pendingPath);
  await pendingDb.open();
  const pendingFeed = pendingDb.createFeed("Recovered Pending Save", 15);

  const recovered = new AppDatabase(dbPath);
  await recovered.open();

  assert.equal(recovered.getFeed(pendingFeed.id).name, "Recovered Pending Save");
  assert.equal(fs.existsSync(pendingPath), false);
});

test("database transaction state recovers after a save failure", async () => {
  const { db, dbPath } = await createTestDb();
  const originalSave = db.save.bind(db);
  let failSave = true;
  db.save = () => {
    if (failSave) {
      throw new Error("Simulated save failure.");
    }
    originalSave();
  };

  assert.throws(() => db.createFeed("Committed Before Save Failure", 15), /Simulated save failure/);
  assert.equal(db.transactionDepth, 0);
  assert.equal(db.dirty, true);

  failSave = false;
  const recoveredFeed = db.createFeed("Recovered After Save Failure", 15);

  assert.equal(db.transactionDepth, 0);
  assert.equal(db.dirty, false);

  const reopened = await reopenTestDb(dbPath);
  assert.equal(reopened.getFeed(recoveredFeed.id).name, "Recovered After Save Failure");
  assert.equal(
    reopened.listFeeds().some((feed) => feed.name === "Committed Before Save Failure"),
    true,
  );
});

test("database close flushes dirty state before releasing resources", async () => {
  const { db, dbPath } = await createTestDb();
  const originalSave = db.save.bind(db);
  let failSave = true;
  db.save = () => {
    if (failSave) {
      throw new Error("Simulated close flush failure.");
    }
    originalSave();
  };

  assert.throws(() => db.createFeed("Close Flush Pending", 15), /Simulated close flush failure/);
  assert.equal(db.dirty, true);

  failSave = false;
  db.close();
  db.close();

  assert.equal(db.dirty, false);

  const reopened = await reopenTestDb(dbPath);
  assert.equal(
    reopened.listFeeds().some((feed) => feed.name === "Close Flush Pending"),
    true,
  );
});

test("data export includes feeds, people, memberships, items, and counters", async () => {
  const { db } = await createTestDb();
  const feed = db.createFeed("Export Feed", 15);
  const person = db.upsertPerson({ name: "Export Person", profileUrl: "https://www.linkedin.com/in/export-person/" });
  db.setPersonFeedMembership(person.id, [feed.id]);
  db.captureItems(feed.id, [
    {
      personName: person.name,
      profileUrl: person.profileUrl,
      type: "post",
      sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:export/",
      text: "Export item",
      activityAt: new Date().toISOString(),
    },
  ]);
  const item = db.listQueue(feed.id)[0];
  db.setItemStatus(item.id, "done");

  const exported = db.getDataExport();

  assert.equal(exported.app.name, "linkedin-engagement-feed");
  assert.equal(exported.app.schemaVersion, 1);
  assert.ok(exported.feeds.some((entry) => entry.id === feed.id && entry.name === "Export Feed"));
  assert.ok(exported.people.some((entry) => entry.id === person.id && entry.commentCount === 1));
  assert.ok(exported.feedPeople.some((entry) => entry.feedId === feed.id && entry.personId === person.id));
  assert.ok(exported.items.some((entry) => entry.id === item.id && entry.status === "done" && entry.commentCountApplied === 1));
  assert.ok(exported.itemFeeds.some((entry) => entry.itemId === item.id && entry.feedId === feed.id));
  assert.equal(exported.counts.feeds, exported.feeds.length);
  assert.equal(exported.counts.people, exported.people.length);
  assert.equal(exported.counts.items, exported.items.length);
  assert.equal(exported.counts.feedPeople, exported.feedPeople.length);
  assert.equal(exported.counts.itemFeeds, exported.itemFeeds.length);
});

test("database opens from backup when primary file is corrupt", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Backup Feed", 15);
  const backupPath = `${dbPath}.bak`;
  assert.equal(fs.existsSync(backupPath), true);

  fs.writeFileSync(dbPath, "not a sqlite database");
  const recovered = new AppDatabase(dbPath);
  await recovered.open();

  assert.equal(recovered.getFeed(feed.id).name, "Backup Feed");
  assert.equal(fs.existsSync(dbPath), true);
  assert.equal(fs.readdirSync(path.dirname(dbPath)).some((file) => file.startsWith("engagement.sqlite.corrupt-")), true);
});

test("database opens from older backup when primary and latest backup are corrupt", async () => {
  const { db, dbPath } = await createTestDb();
  const feed = db.createFeed("Older Backup Feed", 15);
  fs.copyFileSync(`${dbPath}.bak`, `${dbPath}.bak.1`);

  fs.writeFileSync(dbPath, "not a sqlite database");
  fs.writeFileSync(`${dbPath}.bak`, "not a sqlite backup");

  const recovered = new AppDatabase(dbPath);
  await recovered.open();

  assert.equal(recovered.getFeed(feed.id).name, "Older Backup Feed");
  assert.equal(fs.existsSync(dbPath), true);
  assert.equal(fs.existsSync(`${dbPath}.bak`), true);
  const corruptFiles = fs.readdirSync(path.dirname(dbPath)).filter((file) => file.startsWith("engagement.sqlite.corrupt-"));
  assert.equal(corruptFiles.some((file) => file.includes(".bak")), true);
  assert.equal(corruptFiles.some((file) => !file.includes(".bak")), true);
  assert.equal(recovered.getStorageInfo().corruptBackups.some((entry) => entry.path.includes(".bak")), true);
});
