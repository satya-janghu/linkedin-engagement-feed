import fs from "node:fs";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { app } from "electron";
import {
  browserIdFromChromeDebugEndpoint,
  buildChromeLaunchArgs,
  ChromeLaunchResult,
  EXPECTED_HELPER_VERSION,
  extensionInstallWarning,
  getChromeDebugEndpoint,
  helperMissingWarning,
  helperStaleWarning,
  helperUnavailableWarning,
  isValidChromeDebugPort,
  normalizeChromeUrls,
  openUrlsInDebugChrome,
  pickChromeDebugPort,
  probeLinkedInHelper,
  waitForChromeDebugPort,
} from "./chromeControl.js";

let chromeProcess: ChildProcess | undefined;
let launchQueue: Promise<unknown> = Promise.resolve();
const HELPER_PROBE_RETRY_DELAYS_MS = [500, 1500];

type ChromeDebugMarker = {
  port: number;
  browserId: string;
};

export function getChromeProfileDir() {
  return path.join(app.getPath("userData"), "chrome-profile");
}

export function getExtensionPath() {
  const devPath = path.join(process.cwd(), "chrome-extension");
  if (fs.existsSync(devPath)) {
    return devPath;
  }
  return path.join(process.resourcesPath, "chrome-extension");
}

export function findChromeExecutable() {
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          path.join(app.getPath("home"), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
      : process.platform === "win32"
        ? [
            path.join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
            path.join(process.env["PROGRAMFILES(X86)"] || "", "Google/Chrome/Application/chrome.exe"),
            path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
          ]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) {
    throw new Error("Google Chrome was not found. Install Chrome, then launch the LinkedIn workspace again.");
  }
  return found;
}

export function launchChrome(url: string | string[] = "https://www.linkedin.com/feed/"): Promise<ChromeLaunchResult> {
  const launch = launchQueue.catch(() => undefined).then(() => launchChromeNow(url));
  launchQueue = launch.catch(() => undefined);
  return launch;
}

async function launchChromeNow(url: string | string[] = "https://www.linkedin.com/feed/"): Promise<ChromeLaunchResult> {
  const profileDir = getChromeProfileDir();
  const extensionPath = getExtensionPath();
  validateExtensionPath(extensionPath);
  const urls = normalizeChromeUrls(url);
  fs.mkdirSync(profileDir, { recursive: true });

  const marker = readChromeDebugMarker(profileDir);
  const debugPort = await pickChromeDebugPort(undefined, fetch, marker?.browserId);
  if (debugPort.mode === "reused") {
    await openUrlsInDebugChrome(debugPort.port, urls);
    const endpoint = await rememberChromeDebugEndpoint(profileDir, debugPort.port);
    const helperWarning = await helperWarningForChrome(debugPort.port, endpoint, extensionPath);
    return {
      profileDir,
      extensionPath,
      debugPort: debugPort.port,
      mode: "reused",
      openedUrls: urls,
      warning: helperWarning || undefined,
    };
  }

  const chromePath = findChromeExecutable();
  const args = buildChromeLaunchArgs({
    profileDir,
    extensionPath,
    debugPort: debugPort.port,
    urls,
  });

  chromeProcess = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
  });
  chromeProcess.unref();

  const isControllable = await waitForChromeStartup(chromeProcess, debugPort.port);
  let endpoint = undefined;
  if (isControllable) {
    endpoint = await rememberChromeDebugEndpoint(profileDir, debugPort.port);
  }
  const warnings = [
    isControllable
      ? ""
      : "Chrome opened, but the app could not confirm the workspace control port. If future refresh navigation stalls, close the dedicated Chrome window and open it again from the app.",
    isControllable ? await helperWarningForChrome(debugPort.port, endpoint, extensionPath) : extensionInstallWarning(endpoint, extensionPath),
  ].filter(Boolean);
  return {
    profileDir,
    extensionPath,
    debugPort: debugPort.port,
    mode: "launched",
    openedUrls: urls,
    warning: warnings.length > 0 ? warnings.join(" ") : undefined,
  };
}

type ChromeProcessExit = {
  kind: "exit";
  code: number | null;
  signal: NodeJS.Signals | null;
};

type ChromeProcessError = {
  kind: "error";
  error: Error;
};

async function waitForChromeStartup(process: ChildProcess, debugPort: number) {
  const processExit = monitorChromeProcessExit(process);
  try {
    const firstResult = await Promise.race([
      waitForChromeDebugPort(debugPort).then((isControllable) => ({ kind: "debug" as const, isControllable })),
      processExit.promise,
    ]);
    if (firstResult.kind === "debug") {
      return firstResult.isControllable;
    }
    if (await waitForChromeDebugPort(debugPort, 1000)) {
      return true;
    }
    throw new Error(chromeProcessExitMessage(firstResult));
  } finally {
    processExit.cleanup();
  }
}

function monitorChromeProcessExit(process: ChildProcess) {
  let settled = false;
  let resolveExit: (result: ChromeProcessExit | ChromeProcessError) => void = () => {};
  const promise = new Promise<ChromeProcessExit | ChromeProcessError>((resolve) => {
    resolveExit = resolve;
  });
  const cleanup = () => {
    process.off("error", onError);
    process.off("exit", onExit);
  };
  const settle = (result: ChromeProcessExit | ChromeProcessError) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    resolveExit(result);
  };
  const onError = (error: Error) => settle({ kind: "error", error });
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => settle({ kind: "exit", code, signal });
  process.once("error", onError);
  process.once("exit", onExit);
  return { promise, cleanup };
}

function chromeProcessExitMessage(result: ChromeProcessExit | ChromeProcessError) {
  if (result.kind === "error") {
    return `Chrome could not be started: ${result.error.message}`;
  }
  const detail = result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? "unknown"}`;
  return `Chrome closed before the workspace control port became available (${detail}). Close any stuck Chrome windows for this profile and try again.`;
}

async function rememberChromeDebugEndpoint(profileDir: string, port: number) {
  const endpoint = await getChromeDebugEndpoint(port);
  const browserId = browserIdFromChromeDebugEndpoint(endpoint);
  if (!browserId) {
    return endpoint;
  }
  fs.writeFileSync(chromeDebugMarkerPath(profileDir), JSON.stringify({ port, browserId } satisfies ChromeDebugMarker), "utf8");
  return endpoint;
}

function readChromeDebugMarker(profileDir: string): ChromeDebugMarker | undefined {
  try {
    const marker = JSON.parse(fs.readFileSync(chromeDebugMarkerPath(profileDir), "utf8")) as Partial<ChromeDebugMarker>;
    const port = Number(marker.port);
    const browserId = String(marker.browserId || "").trim();
    if (!isValidChromeDebugPort(port) || !browserId) {
      return undefined;
    }
    return { port, browserId };
  } catch {
    return undefined;
  }
}

function chromeDebugMarkerPath(profileDir: string) {
  return path.join(profileDir, ".lef-chrome-debug.json");
}

function validateExtensionPath(extensionPath: string) {
  const manifestPath = path.join(extensionPath, "manifest.json");
  const requiredFiles = ["manifest.json", "background.js", "content.js", "content.css"];
  try {
    const extensionStats = fs.statSync(extensionPath);
    if (!extensionStats.isDirectory()) {
      throw new Error("path is not a directory");
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      manifest_version?: unknown;
      version?: unknown;
      content_scripts?: unknown;
    };
    if (manifest.manifest_version !== 3) {
      throw new Error("manifest is not Manifest V3");
    }
    if (manifest.version !== EXPECTED_HELPER_VERSION) {
      throw new Error(`manifest version ${String(manifest.version || "missing")} does not match expected helper version ${EXPECTED_HELPER_VERSION}`);
    }
    if (!manifestDeclaresLinkedInContentScript(manifest.content_scripts)) {
      throw new Error("manifest does not declare the expected LinkedIn content script files");
    }
    for (const fileName of requiredFiles) {
      const filePath = path.join(extensionPath, fileName);
      if (!fs.statSync(filePath).isFile()) {
        throw new Error(`${fileName} is not a file`);
      }
    }
  } catch (error) {
    throw new Error(
      `LinkedIn helper extension is incomplete or unreadable at ${extensionPath}: ${errorMessage(error)}. Rebuild the app or load the unpacked extension from this folder after fixing it.`,
    );
  }
}

function manifestDeclaresLinkedInContentScript(contentScripts: unknown) {
  if (!Array.isArray(contentScripts)) {
    return false;
  }
  return contentScripts.some((entry) => {
    const script = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const matches = Array.isArray(script.matches) ? script.matches.map((value) => String(value || "")) : [];
    const js = Array.isArray(script.js) ? script.js.map((value) => String(value || "")) : [];
    const css = Array.isArray(script.css) ? script.css.map((value) => String(value || "")) : [];
    return matches.includes("https://www.linkedin.com/*") && js.includes("content.js") && css.includes("content.css");
  });
}

async function helperWarningForChrome(port: number, endpoint: Awaited<ReturnType<typeof getChromeDebugEndpoint>>, extensionPath: string) {
  let latestProbe: Awaited<ReturnType<typeof probeLinkedInHelper>> | undefined;
  for (let attempt = 0; attempt <= HELPER_PROBE_RETRY_DELAYS_MS.length; attempt += 1) {
    latestProbe = await probeLinkedInHelper(port).catch(() => undefined);
    if (latestProbe?.status === "loaded") {
      return "";
    }
    if (latestProbe?.status === "stale") {
      return helperStaleWarning(extensionPath, latestProbe.snapshot?.dom?.helperVersion);
    }
    if (attempt < HELPER_PROBE_RETRY_DELAYS_MS.length) {
      await delay(HELPER_PROBE_RETRY_DELAYS_MS[attempt]);
    }
  }
  if (latestProbe?.status === "missing") {
    return helperMissingWarning(extensionPath);
  }
  if (latestProbe?.status === "unavailable") {
    const installWarning = extensionInstallWarning(endpoint, extensionPath);
    const unavailableWarning = helperUnavailableWarning(extensionPath);
    return installWarning ? `${unavailableWarning} ${installWarning}` : unavailableWarning;
  }
  return extensionInstallWarning(endpoint, extensionPath);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}
