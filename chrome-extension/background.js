const LOCAL_API_BASES = new Set([
  "http://127.0.0.1:38421",
  "http://127.0.0.1:38422",
  "http://127.0.0.1:38423",
  "http://127.0.0.1:38424",
  "http://127.0.0.1:38425",
]);

chrome.runtime.onInstalled.addListener(() => {
  // Keeps the helper visible in Chrome's extension manager.
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "lef-local-api-request") {
    return false;
  }

  forwardLocalApiRequest(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Local API request failed.",
        name: error instanceof Error ? error.name : "Error",
      }),
    );
  return true;
});

async function forwardLocalApiRequest(message) {
  const base = normalizeLocalApiBase(message.base);
  const path = normalizeLocalApiPath(message.path);
  const method = normalizeLocalApiMethod(message.method);
  const timeoutMs = normalizeLocalApiTimeout(message.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: message.body === undefined ? undefined : JSON.stringify(message.body),
      signal: controller.signal,
    });
    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      ok: response.ok,
      headers,
      bodyText: await response.text(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeLocalApiBase(base) {
  if (!LOCAL_API_BASES.has(base)) {
    throw new Error("Unsupported local API base.");
  }
  return base;
}

function normalizeLocalApiPath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Unsupported local API path.");
  }
  return path;
}

function normalizeLocalApiMethod(method) {
  const clean = String(method || "GET").toUpperCase();
  if (!["GET", "POST", "PATCH", "DELETE"].includes(clean)) {
    throw new Error("Unsupported local API method.");
  }
  return clean;
}

function normalizeLocalApiTimeout(timeoutMs) {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value)) {
    return 10000;
  }
  return Math.max(250, Math.min(60000, Math.round(value)));
}
