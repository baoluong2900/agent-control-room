import path from "node:path";
import { BrowserWindow } from "electron";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

export function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    height: 945,
    minHeight: 860,
    minWidth: 1280,
    show: false,
    title: "AgenticOS",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    useContentSize: true,
    width: 1680,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // This webContents owns a privileged preload bridge. The app is an SPA, so no
  // legitimate module change needs top-level navigation; deny navigation and
  // popup creation rather than letting arbitrary content inherit that bridge.
  mainWindow.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  return mainWindow;
}
