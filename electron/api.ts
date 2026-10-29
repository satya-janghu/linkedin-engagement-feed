import http from "node:http";
import { URL } from "node:url";
import { AppDatabase, AppError, CaptureResult } from "./database.js";
import { RefreshSessionManager } from "./refreshSessions.js";

export const API_PORT = 38421;
export const API_PORTS = [38421, 38422, 38423, 38424, 38425];
export const API_BASE_URL = `http://127.0.0.1:${API_PORT}`;
export const API_IDENTITY_HEADER = "X-LinkedIn-Engagement-Feed";
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 12000;

type HandlerContext = {
  db: AppDatabase;
  refreshSessions: RefreshSessionManager;
  requestBodyTimeoutMs: number;
};

export type ApiServer = http.Server & {
  port: number;
  baseUrl: string;
};

export type ApiServerOptions = {
  requestBodyTimeoutMs?: number;
};

export function startApiServer(
  db: AppDatabase,
  refreshSessions: RefreshSessionManager,
  ports = API_PORTS,
  options: ApiServerOptions = {},
) {
  if (ports.length === 0) {
    throw new AppError("No local API ports were configured.", 500);
  }

  const requestHandler = createRequestHandler(db, refreshSessions, normalizeRequestBodyTimeoutMs(options.requestBodyTimeoutMs));
  return listenOnAvailablePort(requestHandler, ports);
}

function createRequestHandler(db: AppDatabase, refreshSessions: RefreshSessionManager, requestBodyTimeoutMs: number) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!isAllowedOrigin(req.headers.origin, req.method || "GET", req.url || "/", req.headers)) {
      json(res, 403, { error: "Origin is not allowed." });
      return;
    }

    setCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const requestUrl = new URL(req.url || "/", API_BASE_URL);
      const result = await route({ db, refreshSessions, requestBodyTimeoutMs }, req, requestUrl);
      json(res, 200, result);
    } catch (error) {
      const statusCode = error instanceof AppError ? error.statusCode : 500;
      const message = error instanceof Error ? error.message : "Unknown error";
      json(res, statusCode, { error: message }, retryHeadersForStatus(statusCode));
    }
  };
}

function listenOnAvailablePort(
  requestHandler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
  ports: number[],
): Promise<ApiServer> {
  const [port, ...remainingPorts] = ports;
  const server = http.createServer((req, res) => {
    requestHandler(req, res);
  });

  return new Promise<ApiServer>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("error", onError);
      if (error.code === "EADDRINUSE" && remainingPorts.length > 0) {
        listenOnAvailablePort(requestHandler, remainingPorts).then(resolve).catch(reject);
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const apiServer = server as ApiServer;
      apiServer.port = port;
      apiServer.baseUrl = apiBaseUrlForPort(port);
      resolve(apiServer);
    });
  });
}

function apiBaseUrlForPort(port: number) {
  return `http://127.0.0.1:${port}`;
}

function normalizeRequestBodyTimeoutMs(value: number | undefined) {
  if (value === undefined) {
    return DEFAULT_REQUEST_BODY_TIMEOUT_MS;
  }
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_REQUEST_BODY_TIMEOUT_MS;
  }
  return Math.max(25, Math.min(60_000, Math.round(timeoutMs)));
}

async function route({ db, refreshSessions, requestBodyTimeoutMs }: HandlerContext, req: http.IncomingMessage, url: URL) {
  const method = req.method || "GET";
  const path = trimTrailingSlash(url.pathname);

  if (method === "GET" && path === "/health") {
    return { ok: true };
  }

  if (method === "GET" && path === "/api/feeds") {
    return db.listFeeds();
  }

  if (method === "GET" && path === "/api/storage") {
    return db.getStorageInfo();
  }

  if (method === "GET" && path === "/api/export") {
    return db.getDataExport();
  }

  if (method === "POST" && path === "/api/feeds") {
    const body = await readJson<{ name: string; lookbackDays?: number; requestId?: string }>(req, requestBodyTimeoutMs);
    const input = feedCreateInput(body);
    return db.createFeed(input.name, input.lookbackDays ?? 15, { requestId: input.requestId });
  }

  if (method === "POST" && path === "/api/feeds/get-or-create") {
    const body = await readJson<{ name: string; lookbackDays?: number; requestId?: string }>(req, requestBodyTimeoutMs);
    const input = feedCreateInput(body);
    return db.getOrCreateFeed(input.name, input.lookbackDays ?? 15, { requestId: input.requestId });
  }

  const feedMatch = path.match(/^\/api\/feeds\/([^/]+)$/);
  if (feedMatch && method === "PATCH") {
    const feedId = decodePathParam(feedMatch[1], "feed id");
    const body = await readJson<{ name?: string; lookbackDays?: number; requestId?: string }>(req, requestBodyTimeoutMs);
    const input = feedUpdateInput(body);
    const feed = db.updateFeed(feedId, input, { requestId: input.requestId });
    syncRefreshSessionSettingsForFeed(refreshSessions, feedId);
    return feed;
  }

  if (feedMatch && method === "DELETE") {
    const feedId = decodePathParam(feedMatch[1], "feed id");
    try {
      db.deleteFeed(feedId);
      const canceledRefreshSessions = refreshSessions.cancelFeed(feedId);
      return { ok: true, canceledRefreshSessions: canceledRefreshSessions.length };
    } catch (error) {
      if (isNotFoundError(error)) {
        const canceledRefreshSessions = refreshSessions.cancelFeed(feedId);
        return { ok: true, canceledRefreshSessions: canceledRefreshSessions.length, alreadyDeleted: true };
      }
      throw error;
    }
  }

  if (method === "GET" && path === "/api/people") {
    return db.listPeople(optionalTrimmedQuery(url.searchParams, "query") || "", optionalTrimmedQuery(url.searchParams, "feedId"));
  }

  if (method === "POST" && path === "/api/people") {
    const body = await readJson<{ name: string; profileUrl: string; headline?: string; feedIds?: string[]; requestId?: string }>(
      req,
      requestBodyTimeoutMs,
    );
    const input = personSaveInput(body);
    if (input.feedIds !== undefined) {
      const before = db.getProfileStatus(input.profileUrl);
      const status = db.upsertPersonWithMembership(
        {
          name: input.name,
          profileUrl: input.profileUrl,
          headline: input.headline,
          feedIds: input.feedIds,
        },
        { requestId: input.requestId },
      );
      syncRefreshSessionsForFeeds(refreshSessions, [...before.feedIds, ...status.feedIds]);
      return status;
    }
    const before = db.getProfileStatus(input.profileUrl);
    const person = db.upsertPerson(input, { requestId: input.requestId });
    const status = db.getProfileStatus(person.profileUrl);
    syncRefreshSessionsForFeeds(refreshSessions, [...before.feedIds, ...status.feedIds]);
    return status;
  }

  const personMatch = path.match(/^\/api\/people\/([^/]+)$/);
  if (personMatch && method === "DELETE") {
    const personId = decodePathParam(personMatch[1], "person id");
    try {
      const person = db.getPerson(personId);
      db.deletePerson(personId);
      syncRefreshSessionsForFeeds(refreshSessions, person.feedIds);
      return { ok: true };
    } catch (error) {
      if (isNotFoundError(error)) {
        refreshSessions.reconcileRunningSessions();
        return { ok: true, alreadyDeleted: true };
      }
      throw error;
    }
  }

  const membershipMatch = path.match(/^\/api\/people\/([^/]+)\/memberships$/);
  if (membershipMatch && method === "POST") {
    const personId = decodePathParam(membershipMatch[1], "person id");
    const body = await readJson<{ feedIds: string[]; knownFeedIds?: string[]; requestId?: string }>(req, requestBodyTimeoutMs);
    const input = personMembershipInput(body);
    let beforeFeedIds: string[] = [];
    try {
      beforeFeedIds = db.getPerson(personId).feedIds;
    } catch (error) {
      if (!input.requestId || !isNotFoundError(error)) {
        throw error;
      }
    }
    const person = db.setPersonFeedMembership(personId, input.feedIds, {
      knownFeedIds: input.knownFeedIds,
      requestId: input.requestId,
    });
    syncRefreshSessionsForFeeds(refreshSessions, [...beforeFeedIds, ...person.feedIds, ...(input.knownFeedIds ?? [])]);
    return person;
  }

  if (method === "GET" && path === "/api/profile-status") {
    const profileUrl = optionalTrimmedQuery(url.searchParams, "profileUrl") || "";
    return db.getProfileStatus(profileUrl);
  }

  if (method === "POST" && path === "/api/profile-statuses") {
    const body = await readJson<{ profileUrls: string[] }>(req, requestBodyTimeoutMs);
    const profileUrls = requiredStringArrayField(body, "profileUrls", "Profile urls");
    return db.getProfileStatuses(profileUrls);
  }

  if (method === "POST" && path === "/api/profile-memberships") {
    const body = await readJson<{
      name: string;
      profileUrl: string;
      feedIds: string[];
      knownFeedIds?: string[];
      requestId?: string;
    }>(req, requestBodyTimeoutMs);
    const input = profileMembershipInput(body);
    const before = db.getProfileStatus(input.profileUrl);
    const status = db.upsertPersonWithMembership(
      input,
      { ignoreMissingFeedIds: true, knownFeedIds: input.knownFeedIds, requestId: input.requestId },
    );
    syncRefreshSessionsForFeeds(refreshSessions, [...before.feedIds, ...status.feedIds, ...(input.knownFeedIds ?? [])]);
    return status;
  }

  const feedPersonMatch = path.match(/^\/api\/feeds\/([^/]+)\/people$/);
  if (feedPersonMatch && method === "POST") {
    const feedId = decodePathParam(feedPersonMatch[1], "feed id");
    const body = await readJson<{ name: string; profileUrl: string; headline?: string; requestId?: string }>(
      req,
      requestBodyTimeoutMs,
    );
    const input = personCreateInput(body);
    const person = db.addPersonToFeed(feedId, input, { requestId: input.requestId });
    syncRefreshSessionsForFeeds(refreshSessions, [feedId]);
    return person;
  }

  const bulkPeopleMatch = path.match(/^\/api\/feeds\/([^/]+)\/people\/bulk$/);
  if (bulkPeopleMatch && method === "POST") {
    const feedId = decodePathParam(bulkPeopleMatch[1], "feed id");
    const body = await readJson<{ people: Parameters<AppDatabase["bulkAddPeopleToFeed"]>[1]; requestId?: string }>(
      req,
      requestBodyTimeoutMs,
    );
    const people = requiredArray<Parameters<AppDatabase["bulkAddPeopleToFeed"]>[1][number]>(body.people, "People");
    const requestId = optionalStringField(body, "requestId", "Bulk people request id");
    const result = db.bulkAddPeopleToFeed(feedId, people, { requestId });
    if (result.added > 0 || result.updated > 0) {
      syncRefreshSessionsForFeeds(refreshSessions, [feedId]);
    }
    return result;
  }

  const counterMatch = path.match(/^\/api\/people\/([^/]+)\/counters$/);
  if (counterMatch && method === "PATCH") {
    const personId = decodePathParam(counterMatch[1], "person id");
    const body = await readJson<{
      commentCount?: number;
      likeCount?: number;
      backCommentCount?: number;
      requestId?: string;
    }>(req, requestBodyTimeoutMs);
    const input = counterUpdateInput(body);
    return db.updateCounters(personId, input, { requestId: input.requestId });
  }

  const counterAdjustMatch = path.match(/^\/api\/people\/([^/]+)\/counters\/adjust$/);
  if (counterAdjustMatch && method === "PATCH") {
    const personId = decodePathParam(counterAdjustMatch[1], "person id");
    const body = await readJson<{
      commentCount?: number;
      likeCount?: number;
      backCommentCount?: number;
      requestId?: string;
    }>(req, requestBodyTimeoutMs);
    const input = counterAdjustmentInput(body);
    return db.adjustCounters(personId, input, { requestId: input.requestId });
  }

  if (method === "GET" && path === "/api/queue") {
    const input = queueReadInput(url.searchParams);
    return db.listQueue(input.feedId, input.status, input.options);
  }

  if (method === "GET" && path === "/api/queue-view") {
    const input = queueReadInput(url.searchParams);
    return db.getQueueView(input.feedId, input.status, input.options);
  }

  if (method === "GET" && path === "/api/queue-counts") {
    return db.getQueueCounts(optionalTrimmedQuery(url.searchParams, "feedId"));
  }

  const itemStatusMatch = path.match(/^\/api\/items\/([^/]+)\/status$/);
  if (itemStatusMatch && method === "POST") {
    const itemId = decodePathParam(itemStatusMatch[1], "item id");
    const body = await readJson<{ status: "new" | "done" | "skipped"; feedId?: string; requestId?: string }>(
      req,
      requestBodyTimeoutMs,
    );
    const input = itemStatusInput(body);
    return db.setItemStatus(itemId, input.status, { feedId: input.feedId, requestId: input.requestId });
  }

  if (method === "POST" && path === "/api/capture-items/multi") {
    const body = await readJson<{
      feedIds: string[];
      items: Parameters<AppDatabase["captureItems"]>[1];
      requestId?: string;
    }>(req, requestBodyTimeoutMs);
    const input = captureItemsForFeedsInput(body);
    return db.captureItemsForFeeds(input.feedIds, input.items, { requestId: input.requestId });
  }

  if (method === "POST" && path === "/api/capture-items") {
    const body = await readJson<{ feedId: string; items: Parameters<AppDatabase["captureItems"]>[1]; requestId?: string }>(
      req,
      requestBodyTimeoutMs,
    );
    const input = captureItemsInput(body);
    return db.captureItems(input.feedId, input.items, { requestId: input.requestId });
  }

  if (method === "GET" && path === "/api/refresh-sessions") {
    return refreshSessions.list(optionalTrimmedQuery(url.searchParams, "feedId"));
  }

  if (method === "POST" && path === "/api/refresh-sessions") {
    const body = await readJson<{ feedId: string; requestId?: string }>(req, requestBodyTimeoutMs);
    const input = refreshCreateInput(body);
    return refreshSessions.create(input.feedId, { requestId: input.requestId });
  }

  if (method === "GET" && path === "/api/refresh-sessions/active") {
    return refreshSessions.getActive(optionalActiveRefreshSessionId(url.searchParams)) || { active: false };
  }

  const refreshMatch = path.match(/^\/api\/refresh-sessions\/([^/]+)$/);
  if (refreshMatch && method === "GET") {
    return refreshSessions.get(decodePathParam(refreshMatch[1], "refresh session id"));
  }

  if (refreshMatch && method === "DELETE") {
    const sessionId = decodePathParam(refreshMatch[1], "refresh session id");
    try {
      return refreshSessions.cancel(sessionId);
    } catch (error) {
      if (isNotFoundError(error)) {
        return { ok: true, id: sessionId, alreadyCanceled: true };
      }
      throw error;
    }
  }

  const refreshHeartbeatMatch = path.match(/^\/api\/refresh-sessions\/([^/]+)\/heartbeat$/);
  if (refreshHeartbeatMatch && method === "POST") {
    const body = await readJson<{ message?: string; targetIndex?: number; url?: string }>(req, requestBodyTimeoutMs);
    return refreshSessions.recordHeartbeat(
      decodePathParam(refreshHeartbeatMatch[1], "refresh session id"),
      refreshHeartbeatInput(body),
    );
  }

  const refreshCompleteMatch = path.match(/^\/api\/refresh-sessions\/([^/]+)\/complete-target$/);
  if (refreshCompleteMatch && method === "POST") {
    const body = await readJson<{
      targetIndex?: number;
      url?: string;
      captureResult?: ReturnType<AppDatabase["captureItems"]>;
      error?: string;
      requestId?: string;
    }>(req, requestBodyTimeoutMs);
    return refreshSessions.recordTargetComplete(
      decodePathParam(refreshCompleteMatch[1], "refresh session id"),
      refreshTargetCompleteInput(body),
    );
  }

  throw new AppError(`No route for ${method} ${path}`, 404);
}

function setCors(req: http.IncomingMessage, res: http.ServerResponse) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin, req.method || "GET", req.url || "/", req.headers)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", `Content-Type, ${API_IDENTITY_HEADER}`);
  res.setHeader("Access-Control-Expose-Headers", API_IDENTITY_HEADER);
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function syncRefreshSessionsForFeeds(refreshSessions: RefreshSessionManager, feedIds: string[]) {
  try {
    refreshSessions.syncFeedMemberships(feedIds);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    refreshSessions.reconcileRunningSessions();
  }
}

function syncRefreshSessionSettingsForFeed(refreshSessions: RefreshSessionManager, feedId: string) {
  try {
    refreshSessions.syncFeedSettings(feedId);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    refreshSessions.reconcileRunningSessions();
  }
}

function isNotFoundError(error: unknown) {
  return error instanceof AppError && error.statusCode === 404;
}

function requiredArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) {
    throw new AppError(`${label} must be an array.`, 400);
  }
  return value as T[];
}

function requiredStringArrayField(record: Record<string, unknown>, key: string, label: string) {
  return requiredStringArray(record[key], label);
}

function optionalStringArrayField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  return requiredStringArray(value, label);
}

function requiredStringArray(value: unknown, label: string) {
  const values = requiredArray<string>(value, label);
  for (const [index, entry] of values.entries()) {
    if (typeof entry !== "string") {
      throw new AppError(`${label} must contain only strings. Invalid entry at position ${index + 1}.`, 400);
    }
    if (!entry.trim()) {
      throw new AppError(`${label} must not contain blank strings. Invalid entry at position ${index + 1}.`, 400);
    }
    if (entry !== entry.trim()) {
      throw new AppError(`${label} entries must not have surrounding whitespace. Invalid entry at position ${index + 1}.`, 400);
    }
  }
  return values;
}

function feedCreateInput(body: Record<string, unknown>) {
  return {
    name: requiredStringField(body, "name", "Feed name"),
    lookbackDays: optionalIntegerInRangeField(body, "lookbackDays", "Feed lookback days", 1, 365),
    requestId: optionalStringField(body, "requestId", "Feed create request id"),
  };
}

function personCreateInput(body: Record<string, unknown>) {
  return {
    name: requiredStringField(body, "name", "Person name"),
    profileUrl: requiredStringField(body, "profileUrl", "Person profile URL"),
    headline: optionalStringField(body, "headline", "Person headline"),
    requestId: optionalStringField(body, "requestId", "Person request id"),
  };
}

function personSaveInput(body: Record<string, unknown>) {
  return {
    ...personCreateInput(body),
    feedIds: optionalStringArrayField(body, "feedIds", "Feed memberships"),
  };
}

function personMembershipInput(body: Record<string, unknown>) {
  return {
    feedIds: requiredStringArrayField(body, "feedIds", "Feed memberships"),
    knownFeedIds: optionalStringArrayField(body, "knownFeedIds", "Known feed memberships"),
    requestId: optionalStringField(body, "requestId", "Membership request id"),
  };
}

function profileMembershipInput(body: Record<string, unknown>) {
  return {
    ...personCreateInput(body),
    feedIds: requiredStringArrayField(body, "feedIds", "Feed memberships"),
    knownFeedIds: optionalStringArrayField(body, "knownFeedIds", "Known feed memberships"),
  };
}

function feedUpdateInput(body: Record<string, unknown>) {
  return {
    name: optionalStringField(body, "name", "Feed name"),
    lookbackDays: optionalIntegerInRangeField(body, "lookbackDays", "Feed lookback days", 1, 365),
    requestId: optionalStringField(body, "requestId", "Feed settings request id"),
  };
}

function counterUpdateInput(body: Record<string, unknown>) {
  return {
    commentCount: optionalNonNegativeIntegerField(body, "commentCount", "Comment counter"),
    likeCount: optionalNonNegativeIntegerField(body, "likeCount", "Like counter"),
    backCommentCount: optionalNonNegativeIntegerField(body, "backCommentCount", "Back-comment counter"),
    requestId: optionalStringField(body, "requestId", "Counter request id"),
  };
}

function counterAdjustmentInput(body: Record<string, unknown>) {
  return {
    commentCount: optionalIntegerField(body, "commentCount", "Comment counter adjustment"),
    likeCount: optionalIntegerField(body, "likeCount", "Like counter adjustment"),
    backCommentCount: optionalIntegerField(body, "backCommentCount", "Back-comment counter adjustment"),
    requestId: optionalStringField(body, "requestId", "Counter adjustment request id"),
  };
}

function itemStatusInput(body: Record<string, unknown>) {
  return {
    status: requiredQueueStatusField(body, "status", "Queue item status"),
    feedId: optionalNonBlankStringField(body, "feedId", "Queue feed id"),
    requestId: optionalStringField(body, "requestId", "Queue status request id"),
  };
}

function captureItemsInput(body: Record<string, unknown>) {
  return {
    feedId: requiredNonBlankStringField(body, "feedId", "Capture feed id"),
    items: requiredArray<Parameters<AppDatabase["captureItems"]>[1][number]>(body.items, "Captured items"),
    requestId: optionalStringField(body, "requestId", "Capture request id"),
  };
}

function captureItemsForFeedsInput(body: Record<string, unknown>) {
  return {
    feedIds: requiredStringArrayField(body, "feedIds", "Capture feed ids"),
    items: requiredArray<Parameters<AppDatabase["captureItems"]>[1][number]>(body.items, "Captured items"),
    requestId: optionalStringField(body, "requestId", "Multi-feed capture request id"),
  };
}

function refreshCreateInput(body: Record<string, unknown>) {
  return {
    feedId: requiredNonBlankStringField(body, "feedId", "Refresh feed id"),
    requestId: optionalStringField(body, "requestId", "Refresh request id"),
  };
}

function refreshHeartbeatInput(body: Record<string, unknown>) {
  return {
    message: optionalStringField(body, "message", "Refresh heartbeat message"),
    targetIndex: optionalNonNegativeIntegerField(body, "targetIndex", "Refresh target index"),
    url: optionalStringField(body, "url", "Refresh heartbeat URL"),
  };
}

function refreshTargetCompleteInput(body: Record<string, unknown>) {
  return {
    targetIndex: optionalNonNegativeIntegerField(body, "targetIndex", "Refresh target index"),
    url: optionalStringField(body, "url", "Refresh target URL"),
    captureResult: optionalCaptureResultField(body, "captureResult", "Refresh capture result"),
    error: optionalStringField(body, "error", "Refresh target error"),
    requestId: optionalStringField(body, "requestId", "Refresh target request id"),
  };
}

function requiredStringField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (typeof value !== "string") {
    throw new AppError(`${label} must be a string.`, 400);
  }
  return value;
}

function requiredNonBlankStringField(record: Record<string, unknown>, key: string, label: string) {
  const value = requiredStringField(record, key, label);
  return validateNonBlankString(value, label);
}

function requiredQueueStatusField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): "new" | "done" | "skipped" {
  const value = requiredStringField(record, key, label);
  if (value !== "new" && value !== "done" && value !== "skipped") {
    throw new AppError(`${label} must be new, done, or skipped.`, 400);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AppError(`${label} must be a string.`, 400);
  }
  return value;
}

function optionalNonBlankStringField(record: Record<string, unknown>, key: string, label: string) {
  const value = optionalStringField(record, key, label);
  if (value === undefined) {
    return undefined;
  }
  return validateNonBlankString(value, label);
}

function validateNonBlankString(value: string, label: string) {
  if (!value.trim()) {
    throw new AppError(`${label} must not be blank.`, 400);
  }
  if (value !== value.trim()) {
    throw new AppError(`${label} must not have surrounding whitespace.`, 400);
  }
  return value;
}

function optionalIntegerField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isSafeInteger(value)) {
    throw new AppError(`${label} must be a whole number.`, 400);
  }
  return value;
}

function optionalNonNegativeIntegerField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isSafeInteger(value) || value < 0) {
    throw new AppError(`${label} must be a non-negative whole number.`, 400);
  }
  return value;
}

function requiredNonNegativeIntegerField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (!isSafeInteger(value) || value < 0) {
    throw new AppError(`${label} ${key} must be a non-negative whole number.`, 400);
  }
  return value;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function optionalIntegerInRangeField(
  record: Record<string, unknown>,
  key: string,
  label: string,
  minimum: number,
  maximum: number,
) {
  const value = optionalIntegerField(record, key, label);
  if (value === undefined) {
    return undefined;
  }
  if (value < minimum || value > maximum) {
    throw new AppError(`${label} must be between ${minimum} and ${maximum}.`, 400);
  }
  return value;
}

function optionalRecordField<T extends Record<string, unknown>>(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    throw new AppError(`${label} must be a JSON object.`, 400);
  }
  return value as T;
}

function optionalCaptureResultField(record: Record<string, unknown>, key: string, label: string): CaptureResult | undefined {
  const value = optionalRecordField<Record<string, unknown>>(record, key, label);
  if (value === undefined) {
    return undefined;
  }
  const result = {
    received: requiredNonNegativeIntegerField(value, "received", label),
    inserted: requiredNonNegativeIntegerField(value, "inserted", label),
    updated: requiredNonNegativeIntegerField(value, "updated", label),
    skippedOlder: requiredNonNegativeIntegerField(value, "skippedOlder", label),
    skippedUntracked: requiredNonNegativeIntegerField(value, "skippedUntracked", label),
    skippedInvalid: requiredNonNegativeIntegerField(value, "skippedInvalid", label),
  };
  for (const [countKey, count] of Object.entries(result)) {
    if (countKey !== "received" && count > result.received) {
      throw new AppError(`${label} ${countKey} cannot exceed received.`, 400);
    }
  }
  const processed =
    result.inserted + result.updated + result.skippedOlder + result.skippedUntracked + result.skippedInvalid;
  if (processed > result.received) {
    throw new AppError(`${label} counts cannot exceed received.`, 400);
  }
  return result;
}

function decodePathParam(value: string, label: string) {
  let decoded = "";
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new AppError(`Malformed ${label}.`, 400);
  }
  const clean = validateNonBlankString(decoded, label);
  if (/[/\\?#\x00-\x1f\x7f]/.test(clean)) {
    throw new AppError(`${label} contains unsupported characters.`, 400);
  }
  return clean;
}

function isAllowedOrigin(
  origin: string | undefined,
  method = "GET",
  requestUrl = "/",
  headers: http.IncomingHttpHeaders = {},
) {
  if (!origin || origin === "null" || origin === "file://") {
    return true;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.hostname === "www.linkedin.com" || parsed.hostname === "linkedin.com") {
      return isLinkedInDiscoveryRequest(method, requestUrl) || isLinkedInHelperRequest(method, headers);
    }
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.protocol === "chrome-extension:"
    );
  } catch {
    return false;
  }
}

function isLinkedInDiscoveryRequest(method: string, requestUrl: string) {
  if (method !== "GET") {
    return false;
  }
  try {
    return trimTrailingSlash(new URL(requestUrl || "/", API_BASE_URL).pathname) === "/health";
  } catch {
    return false;
  }
}

function isLinkedInHelperRequest(method: string, headers: http.IncomingHttpHeaders) {
  if (method === "OPTIONS") {
    return headerListIncludes(headers["access-control-request-headers"], API_IDENTITY_HEADER);
  }
  return headerValue(headers[API_IDENTITY_HEADER.toLowerCase()]) === "1";
}

function headerListIncludes(value: string | string[] | undefined, headerName: string) {
  const needle = headerName.toLowerCase();
  return headerValue(value)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .includes(needle);
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.join(",") : value || "";
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json", [API_IDENTITY_HEADER]: "1", ...headers });
  res.end(JSON.stringify(body));
}

function retryHeadersForStatus(status: number): http.OutgoingHttpHeaders {
  if (status === 408 || status === 429 || status >= 500) {
    return { "Retry-After": "1" };
  }
  return {};
}

function readJson<T>(req: http.IncomingMessage, timeoutMs: number): Promise<T> {
  const declaredBodyBytes = contentLengthBytes(req.headers["content-length"]);
  if (declaredBodyBytes > MAX_BODY_BYTES) {
    req.resume();
    return Promise.reject(new AppError("Request body is too large.", 413));
  }

  return new Promise((resolve, reject) => {
    let data = "";
    let received = 0;
    let settled = false;
    let tooLarge = false;
    let timeout: NodeJS.Timeout | undefined;
    const clearReadTimeout = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };
    const cleanup = () => {
      clearReadTimeout();
      req.off("data", handleData);
      req.off("end", handleEnd);
      req.off("aborted", handleAborted);
      req.off("error", rejectOnce);
    };
    const resolveOnce = (value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const handleData = (chunk: Buffer) => {
      received += chunk.length;
      if (tooLarge) {
        return;
      }
      if (received > MAX_BODY_BYTES) {
        tooLarge = true;
        req.resume();
        rejectOnce(new AppError("Request body is too large.", 413));
        return;
      }
      data += chunk.toString("utf8");
    };
    const handleEnd = () => {
      if (settled) {
        return;
      }
      if (!data) {
        resolveOnce({} as T);
        return;
      }
      try {
        const body = JSON.parse(data);
        if (!isJsonObject(body)) {
          rejectOnce(new AppError("Request body must be a JSON object.", 400));
          return;
        }
        resolveOnce(body as T);
      } catch {
        rejectOnce(new AppError("Request body must be valid JSON.", 400));
      }
    };
    const handleAborted = () => {
      rejectOnce(new AppError("Request body was aborted before it finished.", 400));
    };

    timeout = setTimeout(() => {
      tooLarge = true;
      req.resume();
      rejectOnce(new AppError("Request body timed out before it finished.", 408));
    }, timeoutMs);
    timeout.unref?.();

    req.on("data", handleData);
    req.on("end", handleEnd);
    req.on("aborted", handleAborted);
    req.on("error", rejectOnce);
  });
}

function trimTrailingSlash(path: string) {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentLengthBytes(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    return 0;
  }
  const length = Number(raw);
  return Number.isFinite(length) && length > 0 ? length : 0;
}

function optionalNumber(value: string | null, label = "Queue limit", minimum = 1) {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new AppError(`${label} must be a number.`, 400);
  }
  if (!Number.isSafeInteger(number)) {
    throw new AppError(`${label} must be a safe whole number.`, 400);
  }
  if (number < minimum) {
    throw new AppError(`${label} must be at least ${minimum}.`, 400);
  }
  return number;
}

function optionalTrimmedQuery(searchParams: URLSearchParams, key: string) {
  const value = searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  const cleanValue = value.trim();
  return cleanValue || undefined;
}

function queueReadInput(searchParams: URLSearchParams): {
  feedId: string | undefined;
  status: Parameters<AppDatabase["listQueue"]>[1];
  options: Parameters<AppDatabase["listQueue"]>[2];
} {
  return {
    feedId: optionalTrimmedQuery(searchParams, "feedId"),
    status: optionalQueueStatus(searchParams.get("status")),
    options: {
      limit: optionalNumber(searchParams.get("limit")),
      offset: optionalNumber(searchParams.get("offset"), "Queue offset", 0),
      after: optionalQueueCursor(searchParams),
    },
  };
}

function optionalQueueStatus(value: string | null): Parameters<AppDatabase["listQueue"]>[1] {
  const status = value?.trim() || "new";
  if (status !== "new" && status !== "done" && status !== "skipped" && status !== "all") {
    throw new AppError("Queue status filter must be new, done, skipped, or all.", 400);
  }
  return status;
}

function optionalActiveRefreshSessionId(searchParams: URLSearchParams) {
  if (!searchParams.has("id")) {
    return undefined;
  }
  const id = searchParams.get("id")?.trim() || "";
  if (!id) {
    throw new AppError("Refresh session id must not be blank.", 400);
  }
  return id;
}

function optionalQueueCursor(searchParams: URLSearchParams) {
  const activityAt = searchParams.get("afterActivityAt")?.trim() || "";
  const discoveredAt = searchParams.get("afterDiscoveredAt")?.trim() || "";
  const id = normalizeQueueCursorId(searchParams.get("afterId"));
  if (!activityAt && !discoveredAt && !id) {
    return undefined;
  }
  if (!activityAt || !discoveredAt || !id) {
    throw new AppError("Queue cursor must include activityAt, discoveredAt, and id.", 400);
  }
  return {
    activityAt: normalizeQueueCursorDate(activityAt),
    discoveredAt: normalizeQueueCursorDate(discoveredAt),
    id,
  };
}

function normalizeQueueCursorDate(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new AppError("Queue cursor dates are invalid.", 400);
  }
  return new Date(timestamp).toISOString();
}

function normalizeQueueCursorId(value: string | null) {
  const id = value?.trim() || "";
  if (!id) {
    return "";
  }
  if (id.length > 80) {
    throw new AppError("Queue cursor id must be 80 characters or fewer.", 400);
  }
  if (/[/\\?#\x00-\x1f\x7f]/.test(id)) {
    throw new AppError("Queue cursor id contains unsupported characters.", 400);
  }
  return id;
}
