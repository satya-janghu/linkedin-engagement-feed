import net from "node:net";

export const DEFAULT_LINKEDIN_URL = "https://www.linkedin.com/feed/";
export const CHROME_DEBUG_PORTS = [38431, 38432, 38433, 38434, 38435];
export const MAX_CHROME_OPEN_URLS = 20;
const CHROME_TARGET_CREATE_RETRY_DELAYS_MS = [150, 450];
const HELPER_MARKER_MAX_AGE_MS = 20_000;
export const EXPECTED_HELPER_VERSION = "1.0.32";

export type ChromeLaunchMode = "reused" | "launched";

export type ChromeLaunchResult = {
  profileDir: string;
  extensionPath: string;
  debugPort: number;
  mode: ChromeLaunchMode;
  openedUrls: string[];
  warning?: string;
};

export type ChromeTarget = {
  id: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

export type ChromeDebugEndpoint = {
  Browser?: string;
  webSocketDebuggerUrl?: string;
};

type ChromeRuntimeContext = {
  origin?: string;
  name?: string;
  auxData?: {
    isDefault?: boolean;
    type?: string;
    frameId?: string;
  };
};

type ChromeRuntimeEvent = {
  method?: string;
  params?: {
    context?: ChromeRuntimeContext;
  };
};

type ChromeCommandResponse = {
  id?: number;
  result?: {
    result?: {
      value?: unknown;
    };
  };
  error?: {
    message?: string;
  };
};

export type ChromeHelperProbeSnapshot = {
  contexts: ChromeRuntimeContext[];
  dom?: {
    lefButtons?: number;
    lefAnchors?: number;
    injectedLinks?: number;
    helperMarkerAgeMs?: number;
    helperVersion?: string;
  };
};

export type ChromeHelperProbeResult = {
  status: "loaded" | "missing" | "stale" | "unavailable";
  reason: string;
  snapshot?: ChromeHelperProbeSnapshot;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

export function isValidChromeDebugPort(port: unknown): port is number {
  return typeof port === "number" && Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}

export function normalizeChromeUrls(url: string | string[] = DEFAULT_LINKEDIN_URL) {
  const rawUrls = Array.isArray(url) ? url : [url];
  const urls = rawUrls
    .map((entry) => normalizeBrowserUrl(entry))
    .filter((entry): entry is string => Boolean(entry));
  return [...new Set(urls.length > 0 ? urls : [DEFAULT_LINKEDIN_URL])].slice(0, MAX_CHROME_OPEN_URLS);
}

function normalizeBrowserUrl(url: unknown) {
  const value = normalizeBrowserUrlInput(url);
  if (!value) {
    return "";
  }
  try {
    const withScheme = value.startsWith("//")
      ? `https:${value}`
      : /^https?:\/\//i.test(value)
        ? value
        : /^(?:www\.)?linkedin\.com\//i.test(value)
          ? `https://${value}`
          : value;
    const parsed = new URL(withScheme);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function normalizeBrowserUrlInput(url: unknown) {
  return String(url || "")
    .trim()
    .replace(/^[<([{\s]+/, "")
    .replace(/[>\])}\s]+$/, "")
    .replace(/[.,;:!]+$/, "")
    .replace(/[>\])}\s]+$/, "");
}

export function buildChromeLaunchArgs({
  profileDir,
  extensionPath,
  debugPort,
  urls,
}: {
  profileDir: string;
  extensionPath: string;
  debugPort: number;
  urls: string[];
}) {
  if (!isValidChromeDebugPort(debugPort)) {
    throw new Error("Chrome control port must be between 1 and 65535.");
  }
  return [
    `--user-data-dir=${profileDir}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-extensions",
    `--remote-debugging-port=${debugPort}`,
    `--load-extension=${extensionPath}`,
    ...urls,
  ];
}

export function extensionInstallWarning(endpoint: ChromeDebugEndpoint | undefined, extensionPath: string) {
  const browser = String(endpoint?.Browser || "");
  const match = browser.match(/^Chrome\/(\d+)/i);
  if (!match) {
    return "";
  }
  const majorVersion = Number(match[1]);
  if (!Number.isInteger(majorVersion) || majorVersion < 137) {
    return "";
  }
  return `Recent Google Chrome versions may not load unpacked extensions from the command line. If LinkedIn does not show Feeds buttons, open chrome://extensions/, enable Developer mode, choose Load unpacked, and select ${extensionPath}.`;
}

export function helperMissingWarning(extensionPath: string) {
  return `The LinkedIn helper extension does not appear active in the LinkedIn tab yet. Open chrome://extensions/, enable Developer mode, choose Load unpacked, select ${extensionPath}, then reload LinkedIn.`;
}

export function helperStaleWarning(extensionPath: string, loadedVersion = "") {
  const versionDetail = loadedVersion ? ` Chrome is running helper version ${loadedVersion}; the app expects ${EXPECTED_HELPER_VERSION}.` : "";
  return `The LinkedIn helper extension in Chrome is stale.${versionDetail} Open chrome://extensions/, click Reload on LinkedIn Engagement Feed Helper, then reload LinkedIn. If it is not listed, choose Load unpacked and select ${extensionPath}.`;
}

export function helperUnavailableWarning(extensionPath: string) {
  return `The app could not verify that the LinkedIn helper extension is active yet. If Feeds buttons do not appear after LinkedIn finishes loading, reload LinkedIn. If they still do not appear, open chrome://extensions/, enable Developer mode, choose Load unpacked, and select ${extensionPath}.`;
}

export function helperLoadedFromSnapshot(snapshot: ChromeHelperProbeSnapshot) {
  const markerAgeMs = Number(snapshot.dom?.helperMarkerAgeMs);
  return (
    snapshot.dom?.helperVersion === EXPECTED_HELPER_VERSION &&
    Number.isFinite(markerAgeMs) &&
    markerAgeMs >= 0 &&
    markerAgeMs <= HELPER_MARKER_MAX_AGE_MS
  );
}

export function helperStaleFromSnapshot(snapshot: ChromeHelperProbeSnapshot) {
  const loadedVersion = String(snapshot.dom?.helperVersion || "").trim();
  return Boolean(loadedVersion && loadedVersion !== EXPECTED_HELPER_VERSION);
}

export async function probeLinkedInHelper(port: number, options: { timeoutMs?: number; fetcher?: FetchLike } = {}): Promise<ChromeHelperProbeResult> {
  const timeoutMs = Math.max(500, Math.min(5000, Math.round(options.timeoutMs ?? 2500)));
  const fetcher = options.fetcher ?? fetch;
  let target: ChromeTarget | undefined;
  try {
    target = await findLinkedInPageTarget(chromeDebugBaseUrl(port), fetcher);
  } catch {
    return { status: "unavailable", reason: "Chrome target list is unavailable." };
  }
  if (!target) {
    return { status: "unavailable", reason: "No LinkedIn page is open in the dedicated Chrome workspace." };
  }
  if (!target.webSocketDebuggerUrl) {
    return { status: "unavailable", reason: "LinkedIn page debugging endpoint is unavailable." };
  }

  try {
    const snapshot = await readLinkedInHelperSnapshot(target.webSocketDebuggerUrl, timeoutMs);
    if (helperLoadedFromSnapshot(snapshot)) {
      return { status: "loaded", reason: "Helper extension is active in the LinkedIn page.", snapshot };
    }
    if (helperStaleFromSnapshot(snapshot)) {
      return { status: "stale", reason: "LinkedIn page is running a stale helper extension.", snapshot };
    }
    return { status: "missing", reason: "LinkedIn page is open, but the helper extension is not active.", snapshot };
  } catch {
    return { status: "unavailable", reason: "Helper extension status could not be checked." };
  }
}

export function chromeDebugBaseUrl(port: number) {
  if (!isValidChromeDebugPort(port)) {
    throw new Error("Chrome control port must be between 1 and 65535.");
  }
  return `http://127.0.0.1:${port}`;
}

export function browserIdFromChromeDebugEndpoint(endpoint: ChromeDebugEndpoint | undefined) {
  const match = String(endpoint?.webSocketDebuggerUrl || "").match(/\/devtools\/browser\/([^/?#]+)/i);
  return match?.[1] ?? "";
}

export async function getChromeDebugEndpoint(port: number, fetcher: FetchLike = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 650);
  try {
    const response = await fetcher(`${chromeDebugBaseUrl(port)}/json/version`, { signal: controller.signal });
    if (!response.ok) {
      return undefined;
    }
    const data = (await response.json()) as ChromeDebugEndpoint;
    return /Chrome|Chromium/i.test(String(data.Browser || "")) ? data : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function findChromeDebugPort(ports = CHROME_DEBUG_PORTS, fetcher: FetchLike = fetch, expectedBrowserId = "") {
  for (const port of ports) {
    const endpoint = await getChromeDebugEndpoint(port, fetcher);
    if (endpoint && (!expectedBrowserId || browserIdFromChromeDebugEndpoint(endpoint) === expectedBrowserId)) {
      return port;
    }
  }
  return undefined;
}

export async function pickChromeDebugPort(ports = CHROME_DEBUG_PORTS, fetcher: FetchLike = fetch, expectedBrowserId = "") {
  const existingPort = await findChromeDebugPort(ports, fetcher, expectedBrowserId);
  if (existingPort) {
    return { port: existingPort, mode: "reused" as const };
  }

  const recoveredPort = expectedBrowserId ? await findChromeDebugPort(ports, fetcher) : undefined;
  if (recoveredPort) {
    return { port: recoveredPort, mode: "reused" as const };
  }

  for (const port of ports) {
    if (!(await isTcpPortOpen(port))) {
      return { port, mode: "launched" as const };
    }
  }

  throw new Error(`Chrome control ports ${ports.join(", ")} are already in use. Close the other local service and try again.`);
}

export async function waitForChromeDebugPort(port: number, timeoutMs = 9000, fetcher: FetchLike = fetch) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await getChromeDebugEndpoint(port, fetcher)) {
      return true;
    }
    await delay(250);
  }
  return false;
}

export async function openUrlsInDebugChrome(port: number, urls: string[], fetcher: FetchLike = fetch) {
  const baseUrl = chromeDebugBaseUrl(port);
  const openedTargets: ChromeTarget[] = [];
  for (const url of normalizeChromeUrls(urls)) {
    const existing = await tryFindReusableChromeTarget(baseUrl, url, fetcher);
    if (existing) {
      const activated = await tryActivateChromeTarget(baseUrl, existing.id, fetcher);
      if (activated) {
        openedTargets.push(existing);
        continue;
      }
      openedTargets.push(await createChromeTarget(baseUrl, url, fetcher));
      continue;
    }
    openedTargets.push(await createChromeTarget(baseUrl, url, fetcher));
  }
  return openedTargets;
}

export function selectReusableChromeTarget(targets: ChromeTarget[], url: string) {
  return targets.find((target) => hasChromeTargetId(target) && target.type === "page" && target.url && sameChromeUrl(target.url, url));
}

async function findReusableChromeTarget(baseUrl: string, url: string, fetcher: FetchLike) {
  const response = await fetcher(`${baseUrl}/json/list`);
  if (!response.ok) {
    throw new Error(`Chrome target list failed: ${response.status}`);
  }
  const targets = (await response.json()) as ChromeTarget[];
  return selectReusableChromeTarget(Array.isArray(targets) ? targets : [], url);
}

async function findLinkedInPageTarget(baseUrl: string, fetcher: FetchLike) {
  const response = await fetcher(`${baseUrl}/json/list`);
  if (!response.ok) {
    throw new Error(`Chrome target list failed: ${response.status}`);
  }
  const targets = (await response.json()) as ChromeTarget[];
  return (Array.isArray(targets) ? targets : []).find(
    (target) => hasChromeTargetId(target) && target.type === "page" && isLinkedInUrl(target.url || ""),
  );
}

async function tryFindReusableChromeTarget(baseUrl: string, url: string, fetcher: FetchLike) {
  try {
    return await findReusableChromeTarget(baseUrl, url, fetcher);
  } catch {
    return undefined;
  }
}

async function activateChromeTarget(baseUrl: string, targetId: string, fetcher: FetchLike) {
  const response = await fetcher(`${baseUrl}/json/activate/${encodeURIComponent(targetId)}`);
  if (!response.ok) {
    throw new Error(`Chrome tab activation failed: ${response.status}`);
  }
}

async function tryActivateChromeTarget(baseUrl: string, targetId: string, fetcher: FetchLike) {
  try {
    await activateChromeTarget(baseUrl, targetId, fetcher);
    return true;
  } catch {
    return false;
  }
}

async function createChromeTarget(baseUrl: string, url: string, fetcher: FetchLike) {
  const targetUrl = `${baseUrl}/json/new?${encodeURIComponent(url)}`;
  let lastError: unknown;
  for (let attempt = 0; attempt <= CHROME_TARGET_CREATE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      let response = await fetcher(targetUrl, { method: "PUT" });
      if (!response.ok && response.status === 405) {
        response = await fetcher(targetUrl);
      }
      if (!response.ok) {
        if (isRetryableChromeDevtoolsStatus(response.status) && attempt < CHROME_TARGET_CREATE_RETRY_DELAYS_MS.length) {
          lastError = new Error(`Chrome tab creation failed: ${response.status}`);
          await delay(CHROME_TARGET_CREATE_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw new Error(`Chrome tab creation failed: ${response.status}`);
      }
      const target = (await response.json()) as ChromeTarget;
      if (!hasChromeTargetId(target)) {
        throw new Error("Chrome tab creation returned an invalid target.");
      }
      return target;
    } catch (error) {
      lastError = error;
      if (!isRetryableChromeDevtoolsError(error) || attempt >= CHROME_TARGET_CREATE_RETRY_DELAYS_MS.length) {
        break;
      }
      await delay(CHROME_TARGET_CREATE_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Chrome tab creation failed.");
}

function isRetryableChromeDevtoolsStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableChromeDevtoolsError(error: unknown) {
  if (error instanceof TypeError) {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  const status = Number(message.match(/Chrome tab creation failed: (\d+)/)?.[1]);
  return Number.isInteger(status) && isRetryableChromeDevtoolsStatus(status);
}

function hasChromeTargetId(target: ChromeTarget | undefined): target is ChromeTarget & { id: string } {
  return typeof target?.id === "string" && target.id.trim().length > 0;
}

function sameChromeUrl(left: string, right: string) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.toString() === rightUrl.toString();
  } catch {
    return left === right;
  }
}

function isLinkedInUrl(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (host === "linkedin.com" || host.endsWith(".linkedin.com")) && /^\/(?:feed|in|posts|pulse|comments|company)\b/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function readLinkedInHelperSnapshot(webSocketDebuggerUrl: string, timeoutMs: number) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const contexts: ChromeRuntimeContext[] = [];
  const pending = new Map<number, (response: ChromeCommandResponse) => void>();
  let nextId = 1;

  const cleanup = () => {
    try {
      socket.close();
    } catch {
      // Best-effort diagnostic socket cleanup.
    }
  };

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Chrome websocket failed.")), { once: true });
        socket.addEventListener("message", (event) => {
          const message = parseChromeMessage(event.data);
          if (!message) {
            return;
          }
          if (message.method === "Runtime.executionContextCreated" && message.params?.context) {
            contexts.push(message.params.context);
            return;
          }
          if (typeof message.id === "number") {
            const resolvePending = pending.get(message.id);
            if (resolvePending) {
              pending.delete(message.id);
              resolvePending(message);
            }
          }
        });
      }),
      timeoutMs,
    );

    const sendCommand = (method: string, params: Record<string, unknown> = {}) => {
      const id = nextId;
      nextId += 1;
      socket.send(JSON.stringify({ id, method, params }));
      return withTimeout(
        new Promise<ChromeCommandResponse>((resolve) => {
          pending.set(id, resolve);
        }),
        timeoutMs,
      );
    };

    await sendCommand("Runtime.enable");
    await delay(Math.min(900, timeoutMs));
    const domResponse = await sendCommand("Runtime.evaluate", {
      expression:
        '(() => { const activeAt = Number(document.documentElement.getAttribute("data-lef-helper-active-at") || 0); return { lefButtons: document.querySelectorAll(".lef-button").length, lefAnchors: document.querySelectorAll(".lef-anchor").length, injectedLinks: document.querySelectorAll("[data-lef-injected=\\"true\\"]").length, helperMarkerAgeMs: activeAt > 0 ? Date.now() - activeAt : undefined, helperVersion: document.documentElement.getAttribute("data-lef-helper-version") || "" }; })()',
      returnByValue: true,
      awaitPromise: true,
    });
    return {
      contexts,
      dom: normalizeHelperDomSnapshot(domResponse.result?.result?.value),
    };
  } finally {
    cleanup();
  }
}

function parseChromeMessage(data: unknown): (ChromeRuntimeEvent & ChromeCommandResponse) | undefined {
  try {
    const raw = typeof data === "string" ? data : data instanceof Buffer ? data.toString("utf8") : String(data || "");
    return JSON.parse(raw) as ChromeRuntimeEvent & ChromeCommandResponse;
  } catch {
    return undefined;
  }
}

function normalizeHelperDomSnapshot(value: unknown) {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    lefButtons: Number(raw.lefButtons || 0),
    lefAnchors: Number(raw.lefAnchors || 0),
    injectedLinks: Number(raw.injectedLinks || 0),
    helperMarkerAgeMs: typeof raw.helperMarkerAgeMs === "number" ? raw.helperMarkerAgeMs : undefined,
    helperVersion: String(raw.helperVersion || "").trim(),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out.")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isTcpPortOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(350);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
