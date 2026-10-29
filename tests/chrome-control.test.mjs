import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  browserIdFromChromeDebugEndpoint,
  buildChromeLaunchArgs,
  chromeDebugBaseUrl,
  EXPECTED_HELPER_VERSION,
  extensionInstallWarning,
  findChromeDebugPort,
  helperLoadedFromSnapshot,
  helperMissingWarning,
  helperStaleFromSnapshot,
  helperStaleWarning,
  helperUnavailableWarning,
  isValidChromeDebugPort,
  MAX_CHROME_OPEN_URLS,
  normalizeChromeUrls,
  openUrlsInDebugChrome,
  pickChromeDebugPort,
  selectReusableChromeTarget,
} from "../dist-electron/chromeControl.js";

const chromeSourcePath = path.resolve("electron", "chrome.ts");

function jsonResponse(body, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("chrome urls normalize to a non-empty deduped list", () => {
  assert.deepEqual(normalizeChromeUrls(), ["https://www.linkedin.com/feed/"]);
  assert.deepEqual(
    normalizeChromeUrls(["", " https://www.linkedin.com/feed/ ", "https://www.linkedin.com/feed/"]),
    ["https://www.linkedin.com/feed/"],
  );
});

test("chrome urls cap tab fan-out after deduping", () => {
  const urls = [
    "https://www.linkedin.com/feed/",
    "https://www.linkedin.com/feed/",
    ...Array.from({ length: MAX_CHROME_OPEN_URLS + 5 }, (_unused, index) => `https://www.linkedin.com/in/capped-${index}/`),
  ];
  const normalized = normalizeChromeUrls(urls);

  assert.equal(MAX_CHROME_OPEN_URLS, 20);
  assert.equal(normalized.length, MAX_CHROME_OPEN_URLS);
  assert.equal(normalized[0], "https://www.linkedin.com/feed/");
  assert.equal(new Set(normalized).size, MAX_CHROME_OPEN_URLS);
  assert.equal(normalized.includes("https://www.linkedin.com/in/capped-18/"), true);
  assert.equal(normalized.includes("https://www.linkedin.com/in/capped-19/"), false);
});

test("chrome urls drop malformed and unsafe browser targets", () => {
  assert.deepEqual(normalizeChromeUrls(["javascript:alert(1)", "file:///etc/passwd", "/relative"]), [
    "https://www.linkedin.com/feed/",
  ]);
  assert.deepEqual(normalizeChromeUrls(["notaurl", "https://www.linkedin.com/feed/#main", "http://127.0.0.1:5173/"]), [
    "https://www.linkedin.com/feed/#main",
    "http://127.0.0.1:5173/",
  ]);
});

test("chrome urls accept copied linkedin urls with wrappers and missing schemes", () => {
  assert.deepEqual(
    normalizeChromeUrls([
      "<https://www.linkedin.com/in/copied-profile/>",
      "www.linkedin.com/feed/).",
      "//www.linkedin.com/in/protocol-relative/",
      "linkedin.com/in/no-scheme/",
    ]),
    [
      "https://www.linkedin.com/in/copied-profile/",
      "https://www.linkedin.com/feed/",
      "https://www.linkedin.com/in/protocol-relative/",
      "https://linkedin.com/in/no-scheme/",
    ],
  );
});

test("chrome launch args include the dedicated profile, extension, and control port", () => {
  const args = buildChromeLaunchArgs({
    profileDir: "C:\\app-data\\LinkedInFeed\\chrome-profile",
    extensionPath: "C:\\repo\\chrome-extension",
    debugPort: 38431,
    urls: ["https://www.linkedin.com/feed/"],
  });

  assert.ok(args.includes("--remote-debugging-port=38431"));
  assert.ok(args.includes("--profile-directory=Default"));
  assert.ok(args.includes("--enable-extensions"));
  assert.ok(args.some((arg) => arg.startsWith("--user-data-dir=")));
  assert.ok(args.some((arg) => arg.startsWith("--load-extension=")));
  assert.equal(args.at(-1), "https://www.linkedin.com/feed/");
});

test("chrome launch validates the helper extension folder before opening Chrome", () => {
  const source = fs.readFileSync(chromeSourcePath, "utf8");
  const launch = source.slice(source.indexOf("async function launchChromeNow"), source.indexOf("async function waitForChromeStartup"));
  const validator = source.slice(source.indexOf("function validateExtensionPath"), source.indexOf("async function helperWarningForChrome"));

  assert.match(launch, /const extensionPath = getExtensionPath\(\);\s+validateExtensionPath\(extensionPath\);/);
  assert.ok(launch.indexOf("validateExtensionPath(extensionPath);") < launch.indexOf("const urls = normalizeChromeUrls(url);"));
  assert.match(validator, /const manifestPath = path\.join\(extensionPath, "manifest\.json"\);/);
  assert.match(validator, /const requiredFiles = \["manifest\.json", "background\.js", "content\.js", "content\.css"\];/);
  assert.match(validator, /fs\.statSync\(extensionPath\)/);
  assert.match(validator, /manifest\.manifest_version !== 3/);
  assert.match(validator, /manifest\.version !== EXPECTED_HELPER_VERSION/);
  assert.match(validator, /manifest version \$\{String\(manifest\.version \|\| "missing"\)\} does not match expected helper version/);
  assert.match(validator, /!manifestDeclaresLinkedInContentScript\(manifest\.content_scripts\)/);
  assert.match(validator, /manifest does not declare the expected LinkedIn content script files/);
  assert.match(validator, /function manifestDeclaresLinkedInContentScript\(contentScripts: unknown\)/);
  assert.match(validator, /matches\.includes\("https:\/\/www\.linkedin\.com\/\*"\) && js\.includes\("content\.js"\) && css\.includes\("content\.css"\)/);
  assert.match(validator, /fs\.statSync\(filePath\)\.isFile\(\)/);
  assert.match(validator, /LinkedIn helper extension is incomplete or unreadable at \$\{extensionPath\}/);
  assert.match(validator, /load the unpacked extension from this folder/);
});

test("chrome control ports are validated before reuse or launch", () => {
  const source = fs.readFileSync(chromeSourcePath, "utf8");
  const markerReader = source.slice(source.indexOf("function readChromeDebugMarker"), source.indexOf("function chromeDebugMarkerPath"));

  assert.equal(isValidChromeDebugPort(1), true);
  assert.equal(isValidChromeDebugPort(65535), true);
  assert.equal(isValidChromeDebugPort(0), false);
  assert.equal(isValidChromeDebugPort(65536), false);
  assert.equal(isValidChromeDebugPort(1.5), false);
  assert.equal(isValidChromeDebugPort(Number.MAX_SAFE_INTEGER + 1), false);
  assert.throws(() => chromeDebugBaseUrl(0), /Chrome control port must be between 1 and 65535/);
  assert.throws(
    () =>
      buildChromeLaunchArgs({
        profileDir: "C:\\app-data\\LinkedInFeed\\chrome-profile",
        extensionPath: "C:\\repo\\chrome-extension",
        debugPort: 65536,
        urls: ["https://www.linkedin.com/feed/"],
      }),
    /Chrome control port must be between 1 and 65535/,
  );
  assert.match(markerReader, /const browserId = String\(marker\.browserId \|\| ""\)\.trim\(\);/);
  assert.match(markerReader, /if \(!isValidChromeDebugPort\(port\) \|\| !browserId\) \{/);
  assert.doesNotMatch(markerReader, /Number\.isInteger\(port\)/);
});

test("chrome launcher fails when the spawned browser exits before control is ready", () => {
  const source = fs.readFileSync(chromeSourcePath, "utf8");
  const launch = source.slice(source.indexOf("async function launchChromeNow"), source.indexOf("async function rememberChromeDebugEndpoint"));
  const startup = source.slice(source.indexOf("async function waitForChromeStartup"), source.indexOf("async function rememberChromeDebugEndpoint"));

  assert.match(launch, /const isControllable = await waitForChromeStartup\(chromeProcess, debugPort\.port\);/);
  assert.match(startup, /Promise\.race\(\[\s+waitForChromeDebugPort\(debugPort\)\.then/);
  assert.match(startup, /processExit\.promise/);
  assert.match(startup, /if \(firstResult\.kind === "debug"\) \{\s+return firstResult\.isControllable;\s+\}/);
  assert.match(startup, /if \(await waitForChromeDebugPort\(debugPort, 1000\)\) \{\s+return true;\s+\}/);
  assert.match(startup, /throw new Error\(chromeProcessExitMessage\(firstResult\)\);/);
  assert.match(startup, /process\.once\("error", onError\);/);
  assert.match(startup, /process\.once\("exit", onExit\);/);
  assert.match(startup, /processExit\.cleanup\(\);/);
  assert.match(startup, /Chrome closed before the workspace control port became available/);
  assert.match(startup, /Chrome could not be started/);
  assert.doesNotMatch(launch, /const isControllable = await waitForChromeDebugPort\(debugPort\.port\);/);
});

test("branded modern Chrome launch warns when helper extension may need manual install", () => {
  assert.match(
    extensionInstallWarning({ Browser: "Chrome/149.0.7827.197" }, "C:\\repo\\chrome-extension"),
    /Load unpacked.*C:\\repo\\chrome-extension/,
  );
  assert.equal(extensionInstallWarning({ Browser: "Chrome/120.0.1" }, "C:\\repo\\chrome-extension"), "");
  assert.equal(extensionInstallWarning({ Browser: "Chromium/149.0.1" }, "C:\\repo\\chrome-extension"), "");
});

test("helper missing warning points at the unpacked extension folder", () => {
  assert.match(helperMissingWarning("C:\\repo\\chrome-extension"), /Load unpacked, select C:\\repo\\chrome-extension/);
});

test("helper stale warning tells the user to reload the unpacked extension", () => {
  assert.match(helperStaleWarning("C:\\repo\\chrome-extension", "1.0.5"), /running helper version 1\.0\.5/);
  assert.match(helperStaleWarning("C:\\repo\\chrome-extension", "1.0.5"), new RegExp(`expects ${EXPECTED_HELPER_VERSION.replace(/\./g, "\\.")}`));
  assert.match(helperStaleWarning("C:\\repo\\chrome-extension", "1.0.5"), /click Reload/);
  assert.match(helperStaleWarning("C:\\repo\\chrome-extension", ""), /Load unpacked and select C:\\repo\\chrome-extension/);
});

test("helper unavailable warning explains incomplete helper verification", () => {
  const warning = helperUnavailableWarning("C:\\repo\\chrome-extension");

  assert.match(warning, /could not verify/);
  assert.match(warning, /after LinkedIn finishes loading/);
  assert.match(warning, /Load unpacked/);
  assert.match(warning, /C:\\repo\\chrome-extension/);
});

test("helper launch warning waits briefly for LinkedIn content script injection", () => {
  const source = fs.readFileSync(chromeSourcePath, "utf8");
  const warning = source.slice(source.indexOf("async function helperWarningForChrome"), source.indexOf("function errorMessage"));

  assert.match(source, /const HELPER_PROBE_RETRY_DELAYS_MS = \[500, 1500\];/);
  assert.match(warning, /let latestProbe: Awaited<ReturnType<typeof probeLinkedInHelper>> \| undefined;/);
  assert.match(warning, /for \(let attempt = 0; attempt <= HELPER_PROBE_RETRY_DELAYS_MS\.length; attempt \+= 1\)/);
  assert.match(warning, /latestProbe = await probeLinkedInHelper\(port\)\.catch\(\(\) => undefined\);/);
  assert.match(warning, /if \(latestProbe\?\.status === "loaded"\) \{\s+return "";\s+\}/);
  assert.match(warning, /if \(latestProbe\?\.status === "stale"\) \{\s+return helperStaleWarning\(extensionPath, latestProbe\.snapshot\?\.dom\?\.helperVersion\);/);
  assert.match(warning, /await delay\(HELPER_PROBE_RETRY_DELAYS_MS\[attempt\]\);/);
  assert.match(warning, /if \(latestProbe\?\.status === "missing"\) \{\s+return helperMissingWarning\(extensionPath\);/);
  assert.match(warning, /if \(latestProbe\?\.status === "unavailable"\) \{/);
  assert.match(warning, /const installWarning = extensionInstallWarning\(endpoint, extensionPath\);/);
  assert.match(warning, /const unavailableWarning = helperUnavailableWarning\(extensionPath\);/);
  assert.match(warning, /return installWarning \? `\$\{unavailableWarning\} \$\{installWarning\}` : unavailableWarning;/);
  assert.match(warning, /return extensionInstallWarning\(endpoint, extensionPath\);/);
  assert.match(source, /function delay\(ms: number\) \{\s+return new Promise\(\(resolve\) => setTimeout\(resolve, ms\)\);/);
});

test("helper probe snapshot requires a fresh current-version helper heartbeat", () => {
  assert.equal(
    helperLoadedFromSnapshot({
      contexts: [{ origin: "chrome-extension://abc", name: "LinkedIn Engagement Feed Helper" }],
      dom: { lefButtons: 0, lefAnchors: 0, injectedLinks: 0, helperMarkerAgeMs: undefined },
    }),
    false,
  );
  assert.equal(
    helperLoadedFromSnapshot({
      contexts: [],
      dom: { lefButtons: 2, lefAnchors: 2, injectedLinks: 2, helperMarkerAgeMs: 1000, helperVersion: EXPECTED_HELPER_VERSION },
    }),
    true,
  );
  assert.equal(
    helperLoadedFromSnapshot({
      contexts: [{ origin: "https://www.linkedin.com", name: "" }],
      dom: { lefButtons: 2, lefAnchors: 2, injectedLinks: 2, helperMarkerAgeMs: 60000 },
    }),
    false,
  );
  assert.equal(
    helperLoadedFromSnapshot({
      contexts: [{ origin: "https://www.linkedin.com", name: "" }],
      dom: { lefButtons: 0, lefAnchors: 0, injectedLinks: 0 },
    }),
    false,
  );
  assert.equal(
    helperLoadedFromSnapshot({
      contexts: [],
      dom: { lefButtons: 2, lefAnchors: 2, injectedLinks: 2, helperMarkerAgeMs: 1000, helperVersion: "1.0.5" },
    }),
    false,
  );
  assert.equal(
    helperStaleFromSnapshot({
      contexts: [],
      dom: { lefButtons: 2, lefAnchors: 2, injectedLinks: 2, helperMarkerAgeMs: 1000, helperVersion: "1.0.5" },
    }),
    true,
  );
  assert.equal(
    helperStaleFromSnapshot({
      contexts: [],
      dom: { lefButtons: 2, lefAnchors: 2, injectedLinks: 2, helperMarkerAgeMs: 60000, helperVersion: "1.0.5" },
    }),
    true,
  );
  assert.equal(
    helperStaleFromSnapshot({
      contexts: [],
      dom: { lefButtons: 2, lefAnchors: 2, injectedLinks: 2, helperMarkerAgeMs: 60000, helperVersion: "" },
    }),
    false,
  );
});

test("chrome target reuse ignores hash-only url differences", () => {
  const target = selectReusableChromeTarget(
    [
      { id: "ignore", type: "iframe", url: "https://www.linkedin.com/feed/" },
      { id: "feed", type: "page", url: "https://www.linkedin.com/feed/#main" },
    ],
    "https://www.linkedin.com/feed/",
  );

  assert.equal(target.id, "feed");
});

test("chrome target reuse ignores malformed page targets without ids", () => {
  const target = selectReusableChromeTarget(
    [
      { type: "page", url: "https://www.linkedin.com/feed/" },
      { id: "   ", type: "page", url: "https://www.linkedin.com/feed/" },
      { id: "usable-feed", type: "page", url: "https://www.linkedin.com/feed/#main" },
    ],
    "https://www.linkedin.com/feed/",
  );

  assert.equal(target.id, "usable-feed");
});

test("chrome debug reuse can require a remembered browser id", async () => {
  const fetcher = async (url) => {
    if (url === `${chromeDebugBaseUrl(38431)}/json/version`) {
      return jsonResponse({
        Browser: "Chrome/120",
        webSocketDebuggerUrl: "ws://127.0.0.1:38431/devtools/browser/remembered",
      });
    }
    if (url === `${chromeDebugBaseUrl(38432)}/json/version`) {
      return jsonResponse({
        Browser: "Chrome/120",
        webSocketDebuggerUrl: "ws://127.0.0.1:38432/devtools/browser/other",
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  assert.equal(
    browserIdFromChromeDebugEndpoint({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/remembered" }),
    "remembered",
  );
  assert.equal(await findChromeDebugPort([38431, 38432], fetcher, "remembered"), 38431);
  assert.equal(await findChromeDebugPort([38431, 38432], fetcher, "missing"), undefined);
});

test("chrome debug port picker reuses a visible app Chrome when the marker is missing", async () => {
  const fetcher = async (url) => {
    if (url === `${chromeDebugBaseUrl(38431)}/json/version`) {
      return jsonResponse({
        Browser: "Chrome/120",
        webSocketDebuggerUrl: "ws://127.0.0.1:38431/devtools/browser/recovered",
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  assert.deepEqual(await pickChromeDebugPort([38431, 38432], fetcher), {
    port: 38431,
    mode: "reused",
  });
});

test("chrome debug port picker recovers when the remembered browser id is stale", async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url === `${chromeDebugBaseUrl(38431)}/json/version`) {
      return jsonResponse({
        Browser: "Chrome/120",
        webSocketDebuggerUrl: "ws://127.0.0.1:38431/devtools/browser/current",
      });
    }
    if (url === `${chromeDebugBaseUrl(38432)}/json/version`) {
      return jsonResponse({
        Browser: "Chrome/120",
        webSocketDebuggerUrl: "ws://127.0.0.1:38432/devtools/browser/other",
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  assert.deepEqual(await pickChromeDebugPort([38431, 38432], fetcher, "stale"), {
    port: 38431,
    mode: "reused",
  });
  assert.deepEqual(calls, [
    `${chromeDebugBaseUrl(38431)}/json/version`,
    `${chromeDebugBaseUrl(38432)}/json/version`,
    `${chromeDebugBaseUrl(38431)}/json/version`,
  ]);
});

test("chrome devtools opening activates existing tabs and creates missing tabs", async () => {
  const calls = [];
  const baseUrl = chromeDebugBaseUrl(38431);
  const fetcher = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    if (url === `${baseUrl}/json/list`) {
      return jsonResponse([{ id: "existing-feed", type: "page", url: "https://www.linkedin.com/feed/" }]);
    }
    if (url === `${baseUrl}/json/activate/existing-feed`) {
      return jsonResponse("Target activated");
    }
    if (url.startsWith(`${baseUrl}/json/new?`)) {
      return jsonResponse({ id: "new-profile", type: "page", url: decodeURIComponent(url.split("?")[1]) });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const targets = await openUrlsInDebugChrome(
    38431,
    ["https://www.linkedin.com/feed/", "https://www.linkedin.com/in/example/"],
    fetcher,
  );

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url.replace(baseUrl, "")}`),
    [
      "GET /json/list",
      "GET /json/activate/existing-feed",
      "GET /json/list",
      "PUT /json/new?https%3A%2F%2Fwww.linkedin.com%2Fin%2Fexample%2F",
    ],
  );
  assert.deepEqual(
    targets.map((target) => target.id),
    ["existing-feed", "new-profile"],
  );
});

test("chrome devtools opening creates a tab when reusable target activation races a closed tab", async () => {
  const calls = [];
  const baseUrl = chromeDebugBaseUrl(38431);
  const targetUrl = "https://www.linkedin.com/feed/";
  const fetcher = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    if (url === `${baseUrl}/json/list`) {
      return jsonResponse([{ id: "closed-before-activate", type: "page", url: targetUrl }]);
    }
    if (url === `${baseUrl}/json/activate/closed-before-activate`) {
      return jsonResponse({ error: "No such target" }, { ok: false, status: 404 });
    }
    if (url.startsWith(`${baseUrl}/json/new?`)) {
      return jsonResponse({ id: "replacement-tab", type: "page", url: decodeURIComponent(url.split("?")[1]) });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const targets = await openUrlsInDebugChrome(38431, [targetUrl], fetcher);

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url.replace(baseUrl, "")}`),
    [
      "GET /json/list",
      "GET /json/activate/closed-before-activate",
      "PUT /json/new?https%3A%2F%2Fwww.linkedin.com%2Ffeed%2F",
    ],
  );
  assert.deepEqual(
    targets.map((target) => target.id),
    ["replacement-tab"],
  );
});

test("chrome devtools opening creates a tab when target listing transiently fails", async () => {
  const calls = [];
  const baseUrl = chromeDebugBaseUrl(38431);
  const targetUrl = "https://www.linkedin.com/in/transient-list-failure/";
  const fetcher = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    if (url === `${baseUrl}/json/list`) {
      return jsonResponse({ error: "temporary DevTools hiccup" }, { ok: false, status: 500 });
    }
    if (url.startsWith(`${baseUrl}/json/new?`)) {
      return jsonResponse({ id: "created-after-list-failure", type: "page", url: decodeURIComponent(url.split("?")[1]) });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const targets = await openUrlsInDebugChrome(38431, [targetUrl], fetcher);

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url.replace(baseUrl, "")}`),
    [
      "GET /json/list",
      "PUT /json/new?https%3A%2F%2Fwww.linkedin.com%2Fin%2Ftransient-list-failure%2F",
    ],
  );
  assert.deepEqual(
    targets.map((target) => target.id),
    ["created-after-list-failure"],
  );
});

test("chrome devtools opening retries transient tab creation failures", async () => {
  const calls = [];
  const baseUrl = chromeDebugBaseUrl(38431);
  const targetUrl = "https://www.linkedin.com/in/transient-create-failure/";
  const fetcher = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    if (url === `${baseUrl}/json/list`) {
      return jsonResponse([]);
    }
    if (url.startsWith(`${baseUrl}/json/new?`)) {
      const creationAttempts = calls.filter((call) => call.url.startsWith(`${baseUrl}/json/new?`)).length;
      if (creationAttempts === 1) {
        return jsonResponse({ error: "temporary DevTools create failure" }, { ok: false, status: 500 });
      }
      return jsonResponse({ id: "created-after-retry", type: "page", url: decodeURIComponent(url.split("?")[1]) });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const targets = await openUrlsInDebugChrome(38431, [targetUrl], fetcher);

  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url.replace(baseUrl, "")}`),
    [
      "GET /json/list",
      "PUT /json/new?https%3A%2F%2Fwww.linkedin.com%2Fin%2Ftransient-create-failure%2F",
      "PUT /json/new?https%3A%2F%2Fwww.linkedin.com%2Fin%2Ftransient-create-failure%2F",
    ],
  );
  assert.deepEqual(
    targets.map((target) => target.id),
    ["created-after-retry"],
  );
});

test("chrome devtools opening rejects malformed target creation responses", async () => {
  const baseUrl = chromeDebugBaseUrl(38431);
  const targetUrl = "https://www.linkedin.com/in/malformed-target/";
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (url === `${baseUrl}/json/list`) {
      return jsonResponse([]);
    }
    if (url.startsWith(`${baseUrl}/json/new?`)) {
      return jsonResponse({ type: "page", url: targetUrl });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await assert.rejects(
    () => openUrlsInDebugChrome(38431, [targetUrl], fetcher),
    /Chrome tab creation returned an invalid target/,
  );
  assert.deepEqual(calls, [`${baseUrl}/json/list`, `${baseUrl}/json/new?https%3A%2F%2Fwww.linkedin.com%2Fin%2Fmalformed-target%2F`]);
});
