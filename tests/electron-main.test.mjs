import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const mainProcessSourcePath = path.resolve("electron", "main.ts");
const viteConfigSourcePath = path.resolve("vite.config.ts");

test("json exports are written asynchronously from the main process", () => {
  const source = fs.readFileSync(mainProcessSourcePath, "utf8");
  const saveJsonExportHandler = source.slice(
    source.indexOf('ipcMain.handle("app:save-json-export"'),
    source.indexOf("await createWindow();"),
  );

  assert.match(saveJsonExportHandler, /await fs\.promises\.writeFile\(result\.filePath,/);
  assert.match(saveJsonExportHandler, /JSON\.stringify\(payload, null, 2\)/);
  assert.doesNotMatch(saveJsonExportHandler, /writeFileSync/);
});

test("second app instances quit before booting local services", () => {
  const source = fs.readFileSync(mainProcessSourcePath, "utf8");
  const lockBranch = source.slice(source.indexOf("const hasSingleInstanceLock"), source.indexOf("async function createWindow"));
  const primaryBranch = source.slice(source.indexOf("} else {"));

  assert.match(lockBranch, /const hasSingleInstanceLock = app\.requestSingleInstanceLock\(\);/);
  assert.match(lockBranch, /if \(!hasSingleInstanceLock\) \{\s+app\.quit\(\);\s+\} else \{/);
  assert.doesNotMatch(lockBranch, /app\.whenReady\(\)/);
  assert.doesNotMatch(lockBranch, /startApiServer/);
  assert.match(primaryBranch, /app\.whenReady\(\)\.then\(boot\)/);
  assert.match(primaryBranch, /apiServer = await startApiServer\(appDatabase, refreshSessions\);/);
  assert.match(primaryBranch, /app\.on\("second-instance"/);
});

test("main process closes local services before quitting", () => {
  const source = fs.readFileSync(mainProcessSourcePath, "utf8");
  const shutdown = source.slice(source.indexOf("function shutdownLocalServices"), source.indexOf("async function createWindow"));
  const boot = source.slice(source.indexOf("async function boot"), source.indexOf("app.whenReady()"));

  assert.match(source, /import \{ startApiServer, type ApiServer \} from "\.\/api\.js";/);
  assert.match(source, /let apiServer: ApiServer \| undefined;/);
  assert.match(source, /let database: AppDatabase \| undefined;/);
  assert.match(shutdown, /const server = apiServer;\s+apiServer = undefined;/);
  assert.match(shutdown, /if \(server\?\.listening\) \{\s+server\.close\(\(error\) => \{/);
  assert.match(shutdown, /server\.closeAllConnections\?\.\(\);/);
  assert.match(shutdown, /database\?\.close\(\);/);
  assert.match(shutdown, /database = undefined;/);
  assert.match(boot, /const appDatabase = new AppDatabase/);
  assert.match(boot, /database = appDatabase;/);
  assert.match(boot, /apiServer = await startApiServer\(appDatabase, refreshSessions\);/);
  assert.match(boot, /const startedApiServer = apiServer;/);
  assert.match(boot, /ipcMain\.handle\("app:get-api-base-url", \(\) => startedApiServer\.baseUrl\);/);
  assert.match(source, /app\.on\("before-quit", shutdownLocalServices\);/);
});

test("main window lifecycle does not keep stale destroyed references", () => {
  const source = fs.readFileSync(mainProcessSourcePath, "utf8");
  const createWindow = source.slice(source.indexOf("async function createWindow"), source.indexOf("async function boot"));
  const secondInstance = source.slice(source.indexOf('app.on("second-instance"'), source.indexOf('app.on("window-all-closed"'));

  assert.match(createWindow, /const window = new BrowserWindow\(\{/);
  assert.match(createWindow, /mainWindow = window;/);
  assert.match(createWindow, /window\.on\("closed", \(\) => \{\s+if \(mainWindow === window\) \{\s+mainWindow = undefined;/);
  assert.match(createWindow, /await window\.loadURL\(process\.env\.VITE_DEV_SERVER_URL\);/);
  assert.match(createWindow, /await window\.loadFile\(path\.join\(process\.cwd\(\), "dist\/index\.html"\)\);/);
  assert.doesNotMatch(createWindow, /await mainWindow\.loadURL/);
  assert.doesNotMatch(createWindow, /await mainWindow\.loadFile/);
  assert.match(secondInstance, /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) \{\s+return;\s+\}/);
  assert.match(secondInstance, /if \(mainWindow\.isMinimized\(\)\) \{\s+mainWindow\.restore\(\);/);
  assert.match(secondInstance, /mainWindow\.focus\(\);/);
});

test("production electron renderer can load preload and relative assets", () => {
  const mainSource = fs.readFileSync(mainProcessSourcePath, "utf8");
  const viteConfig = fs.readFileSync(viteConfigSourcePath, "utf8");

  assert.match(mainSource, /preload: path\.join\(__dirname, "preload\.cjs"\)/);
  assert.match(viteConfig, /base:\s*"\.\/"/);
});
