import { app, BrowserWindow, clipboard, ipcMain, session as electronSession, shell } from 'electron';
import { join } from 'node:path';
import { DEFAULT_SERVER_URL, INVOKE_CHANNELS, type InvokeChannel } from '@pa/core';
import { createTokenStore } from './safe-storage-store';
import { createHandlers, dispatch } from './ipc/handlers';
import { ConfigStore } from './config-store';
import { CoreHost } from './core-host';

let win: BrowserWindow | null = null;

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

  const userData = app.getPath('userData');
  const host = await CoreHost.start({
    // PA_SERVER_URL only seeds the default; a saved config.json wins.
    configStore: new ConfigStore(join(userData, 'config.json'), process.env.PA_SERVER_URL ?? DEFAULT_SERVER_URL),
    tokenStore: createTokenStore(join(userData, 'session.bin')),
    onSessionChange: (v) => win?.webContents.send('session:changed', v),
  });
  const handlers = createHandlers({
    getCore: () => host.core,
    getConfig: () => host.config(),
    setConfig: (patch) => host.set(patch),
    copyToClipboard: (t) => clipboard.writeText(t),
    emitStream: (e) => win?.webContents.send('chat:stream:event', e),
  });
  for (const ch of INVOKE_CHANNELS) {
    ipcMain.handle(ch, (_e, req) => dispatch(handlers, ch as InvokeChannel, req));
  }
  // Handlers are registered before the renderer loads, so its first invoke never races.
  win = createWindow();
});

app.on('window-all-closed', () => app.quit());
