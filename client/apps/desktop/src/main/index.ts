import { app, BrowserWindow, clipboard, ipcMain, session as electronSession, shell } from 'electron';
import { join } from 'node:path';
import { createCore, DEFAULT_SERVER_URL, INVOKE_CHANNELS, type ClientConfig, type InvokeChannel } from '@pa/core';
import { createTokenStore } from './safe-storage-store';
import { createHandlers, defaultConfig, dispatch } from './ipc/handlers';

let config: ClientConfig = defaultConfig(process.env.PA_SERVER_URL ?? DEFAULT_SERVER_URL); // M3a: persist in userData/config.json

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  // Block navigation and new windows; open external links in the OS browser only.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

app.whenReady().then(async () => {
  // Renderer never talks to the network; deny all permission requests.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));

  const store = createTokenStore(join(app.getPath('userData'), 'session.bin'));
  const core = createCore({ serverUrl: config.serverUrl, store });
  const handlers = createHandlers({
    core,
    getConfig: () => config,
    setConfig: (patch) => (config = { ...config, ...patch, insecureTransport: !(patch.serverUrl ?? config.serverUrl).startsWith('https://') }),
    copyToClipboard: (t) => clipboard.writeText(t),
  });
  for (const ch of INVOKE_CHANNELS) {
    ipcMain.handle(ch, (_e, req) => dispatch(handlers, ch as InvokeChannel, req));
  }
  const win = createWindow();
  core.session.onChange((v) => win.webContents.send('session:changed', v));
  await core.session.restore();
});

app.on('window-all-closed', () => app.quit());
