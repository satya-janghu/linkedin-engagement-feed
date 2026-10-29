/// <reference types="vite/client" />

interface AppBridge {
  getApiBaseUrl: () => Promise<string>;
  launchChrome: (url?: string | string[]) => Promise<{
    ok: boolean;
    error?: string;
    warning?: string;
    mode?: "reused" | "launched";
    debugPort?: number;
    openedUrls?: string[];
  }>;
  openPath: (targetPath: string) => Promise<{ ok: boolean; error?: string }>;
  saveJsonExport: (payload: unknown) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string; error?: string }>;
}

interface Window {
  linkedinFeed: AppBridge;
}
