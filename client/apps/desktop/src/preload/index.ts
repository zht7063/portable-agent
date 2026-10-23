import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS, type PaBridge } from '@pa/core/contract';

const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

const bridge: PaBridge = {
  invoke: (channel, req) => {
    if (!invokeAllowed.has(channel)) return Promise.resolve({ ok: false, error: { code: 'VALIDATION', message: 'Unknown channel' } });
    return ipcRenderer.invoke(channel, req);
  },
  on: (channel, listener) => {
    if (!eventAllowed.has(channel)) return () => {};
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('pa', bridge);
