import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { AppDatabase } from "./database.js";
import { startApiServer, type ApiServer } from "./api.js";
import { launchChrome } from "./chrome.js";
import { RefreshSessionManager } from "./refreshSessions.js";

let mainWindow: BrowserWindow | undefined;
let apiServer: ApiServer | undefined;
let database: AppDatabase | undefined;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  if (process.env.LINKEDIN_FEED_USER_DATA_DIR) {
    app.setPath("userData", process.env.LINKEDIN_FEED_USER_DATA_DIR);
  }

  function shutdownLocalServices() {
    const server = apiServer;
    apiServer = undefined;
    if (server?.listening) {
      server.close((error) => {
        if (error) {
          console.warn(error);
        }
      });
      server.closeAllConnections?.();
    }
    try {
      database?.close();
    } catch (error) {
      console.warn(error);
    } finally {
      database = undefined;
    }
  }

  async function createWindow() {
    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 1040,
      minHeight: 720,
      title: "LinkedIn Engagement Feed",
      backgroundColor: "#f6f7f4",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    mainWindow = window;
    window.on("closed", () => {
      if (mainWindow === window) {
        mainWindow = undefined;
      }
    });

    if (process.env.VITE_DEV_SERVER_URL) {
      await window.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
      await window.loadFile(path.join(process.cwd(), "dist/index.html"));
    }
  }

  async function boot() {
    const appDatabase = new AppDatabase(path.join(app.getPath("userData"), "engagement.sqlite"));
    database = appDatabase;
    await appDatabase.open();
    const refreshSessions = new RefreshSessionManager(appDatabase);
    apiServer = await startApiServer(appDatabase, refreshSessions);
    const startedApiServer = apiServer;

    ipcMain.handle("app:get-api-base-url", () => startedApiServer.baseUrl);
    ipcMain.handle("chrome:launch", async (_event, url?: string | string[]) => {
      try {
        const result = await launchChrome(url);
        return { ok: true, ...result };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Unable to launch Chrome." };
      }
    });
    ipcMain.handle("app:open-path", async (_event, targetPath: string) => {
      try {
        const result = await shell.openPath(targetPath);
        return result ? { ok: false, error: result } : { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Unable to open path." };
      }
    });
    ipcMain.handle("app:save-json-export", async (_event, payload: unknown) => {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const options = {
          title: "Export LinkedIn Engagement Feed Data",
          defaultPath: `linkedin-engagement-feed-export-${timestamp}.json`,
          filters: [{ name: "JSON", extensions: ["json"] }],
        };
        const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) {
          return { ok: false, canceled: true };
        }
        await fs.promises.writeFile(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        return { ok: true, filePath: result.filePath };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Unable to save export." };
      }
    });

    await createWindow();
  }

  app.whenReady().then(boot).catch((error) => {
    console.error(error);
    app.quit();
  });

  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", shutdownLocalServices);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch(console.error);
    }
  });
}
