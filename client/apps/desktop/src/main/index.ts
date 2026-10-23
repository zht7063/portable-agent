import { pathToFileURL } from 'node:url';
import { isTrustedSender, untrustedSender } from './ipc/sender';
import { app, BrowserWindow, clipboard, ipcMain, session as electronSession, shell } from 'electron';
import { join } from 'node:path';
import { DEFAULT_SERVER_URL, INVOKE_CHANNELS, type InvokeChannel } from '@pa/core';
import { createTokenStore } from './safe-storage-store';
import { createHandlers, dispatch } from './ipc/handlers';
import { ConfigStore } from './config-store';
import { CoreHost } from './core-host';

let win: BrowserWindow | null = null;

const RENDERER_PATH = join(__dirname, '../renderer/index.html');
/** The only origin allowed to call IPC: our bundled renderer, loaded via file://. */
const RENDERER_URL = pathToFileURL(RENDERER_PATH).href;

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
  if (process.env.PA_SMOKE === '1') runSmoke(win);
  void win.loadFile(RENDERER_PATH);
  return win;
}

/** Dev smoke check (PA_SMOKE=1): verify isolation + bridge + first render, print JSON, quit. */
function runSmoke(win: BrowserWindow) {
  const finish = (r: unknown, code: number) => { console.log('PA_SMOKE ' + JSON.stringify(r)); app.exit(code); };
  const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }, 1), 20000);
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      win.webContents.executeJavaScript(`(async () => ({
        bridge: typeof window.pa?.invoke === 'function' && typeof window.pa?.on === 'function',
        noNode: typeof require === 'undefined' && typeof process === 'undefined',
        title: document.querySelector('h2')?.textContent ?? null,
        loginShown: [...document.querySelectorAll('button')].some((b) => b.textContent === '登录'),
        session: (await window.pa.invoke('auth:session', {})).data?.status ?? null,
      }))()`).then((r: Record<string, unknown>) => {
        clearTimeout(timer);
        finish(r, r.bridge && r.noNode && r.title === 'Portable Agent' && r.loginShown ? 0 : 1);
      }, (e: unknown) => { clearTimeout(timer); finish({ ok: false, reason: String(e) }, 1); });
    }, 1500);
  });
}

if (process.env.PA_SMOKE === '1' && process.env.PA_USER_DATA) app.setPath('userData', process.env.PA_USER_DATA);

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
    ipcMain.handle(ch, (e, req) => (isTrustedSender(e, win, RENDERER_URL) ? dispatch(handlers, ch as InvokeChannel, req) : untrustedSender()));
  }
  // Handlers are registered before the renderer loads, so its first invoke never races.
  win = createWindow();
});

app.on('window-all-closed', () => app.quit());
