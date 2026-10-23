import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { isTrustedSender, untrustedSender, type FrameLike } from '../src/main/ipc/sender';

const APP = pathToFileURL('/opt/pa/dist/renderer/index.html').href;
function fixture(url = APP) {
  const mainFrame: FrameLike = { url, parent: null };
  const webContents = { mainFrame };
  let destroyed = false;
  const win = { webContents, isDestroyed: () => destroyed, destroy: () => { destroyed = true; } };
  return { win, webContents, mainFrame };
}

describe('isTrustedSender', () => {
  it('accepts our window main frame on the app URL (hash/query ignored)', () => {
    const { win, webContents, mainFrame } = fixture();
    expect(isTrustedSender({ sender: webContents, senderFrame: mainFrame }, win, APP)).toBe(true);
    mainFrame.url = APP + '?x=1#/keys';
    expect(isTrustedSender({ sender: webContents, senderFrame: mainFrame }, win, APP)).toBe(true);
  });
  it('rejects sub-frames (iframes) of our window', () => {
    const { win, webContents, mainFrame } = fixture();
    const child: FrameLike = { url: APP, parent: mainFrame };
    expect(isTrustedSender({ sender: webContents, senderFrame: child }, win, APP)).toBe(false);
  });
  it('rejects another webContents / window even with the same URL', () => {
    const ours = fixture();
    const other = fixture();
    expect(isTrustedSender({ sender: other.webContents, senderFrame: other.mainFrame }, ours.win, APP)).toBe(false);
    expect(isTrustedSender({ sender: ours.webContents, senderFrame: other.mainFrame }, ours.win, APP)).toBe(false);
  });
  it.each([
    'https://evil.example/index.html',
    'file:///tmp/evil/index.html',
    pathToFileURL('/opt/pa/dist/renderer/other.html').href,
    'devtools://devtools/bundled/inspector.html',
    'about:blank',
    'not a url',
  ])('rejects navigated/foreign URL %s', (url) => {
    const { win, webContents, mainFrame } = fixture(url);
    expect(isTrustedSender({ sender: webContents, senderFrame: mainFrame }, win, APP)).toBe(false);
  });
  it('rejects null frame, missing or destroyed window', () => {
    const { win, webContents, mainFrame } = fixture();
    expect(isTrustedSender({ sender: webContents, senderFrame: null }, win, APP)).toBe(false);
    expect(isTrustedSender({ sender: webContents, senderFrame: mainFrame }, null, APP)).toBe(false);
    win.destroy();
    expect(isTrustedSender({ sender: webContents, senderFrame: mainFrame }, win, APP)).toBe(false);
  });
  it('rejection is a Result error', () => {
    expect(untrustedSender()).toEqual({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Untrusted IPC sender' } });
  });
});
