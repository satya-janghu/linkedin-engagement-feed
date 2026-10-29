import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("linkedinFeed", {
  getApiBaseUrl: () => ipcRenderer.invoke("app:get-api-base-url"),
  launchChrome: (url?: string | string[]) => ipcRenderer.invoke("chrome:launch", url),
  openPath: (targetPath: string) => ipcRenderer.invoke("app:open-path", targetPath),
  saveJsonExport: (payload: unknown) => ipcRenderer.invoke("app:save-json-export", payload),
});
