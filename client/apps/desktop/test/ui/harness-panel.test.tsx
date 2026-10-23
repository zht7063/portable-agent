// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Plan } from '@pa/core/contract';
import { HarnessPanel } from '../../src/renderer/src/panels/HarnessPanel';
import { mockPa } from './mock-pa';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const det = { harnesses: [{ id: 'pi', installed: true, version: '0.70.2', configDir: '/tmp/h/.pi/agent', files: [], notes: ['auth.json exists: x'] }], registered: ['pi'] };
const plan = (conflicts: Plan['conflicts'] = []): Plan => ({
  id: 'pi', profileId: 'default', createdAt: '', baseFingerprints: {}, warnings: ['w1'], externalUnownedChange: [], conflicts,
  changes: [{ file: '/tmp/h/.pi/agent/models.json', setting: 'providers.pa', kind: 'create', before: null, after: '{"apiKey":"!pa-key default pi"}' }],
});
const hist = { id: 'pi', attached: true, firstWrite: true, snapshots: [
  { snapshotId: '2026-10-23T13-00-00.000Z-aaaaaa', at: '2026-10-23T13:00:00.000Z', action: 'apply', available: true },
  { snapshotId: '2026-10-22T13-00-00.000Z-bbbbbb', at: '2026-10-22T13:00:00.000Z', action: 'apply', available: false },
] };
function setup(p: Plan, keyringAvailable = true, extra: Parameters<typeof mockPa>[0] = {}) {
  return mockPa({
    'harness:detect': () => det,
    'harness:keyring:status': () => ({ available: keyringAvailable, backend: keyringAvailable ? 'memory' : 'none', entries: [], ...(keyringAvailable ? {} : { fallback: 'env' }) }),
    'harness:profile:list': () => ({ profiles: [] }),
    'harness:profile:upsert': (r: unknown) => r,
    'models:list': () => [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
    'harness:plan': () => p,
    'harness:apply': () => ({ id: 'pi', written: ['/tmp/h/.pi/agent/models.json'], warnings: [] }),
    'harness:rollback': () => ({ id: 'pi', written: [], warnings: [] }),
    'harness:history': () => hist,
    'harness:rollback:preview': (r: { target: unknown }) => ({ id: 'pi', target: r.target, files: [{ path: '/tmp/h/.pi/agent/models.json', kind: 'modify' }], changes: [{ file: '/tmp/h/.pi/agent/models.json', setting: 'providers.pa', kind: 'remove', before: '{"apiKey":"!pa-key default pi"}', after: null }], warnings: [] }),
    ...extra,
  });
}

describe('HarnessPanel (Pi)', () => {
  it('previews masked diff, apply needs confirm and sends confirm:true', async () => {
    const pa = setup(plan());
    render(<HarnessPanel keyId={3} serverUrl="http://h:3000" />);
    expect(await screen.findByText(/已安装 0.70.2/)).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText('主模型') as HTMLSelectElement).value).toBe('deepseek-flash'));
    await userEvent.click(screen.getByText('预览变更'));
    expect(pa.calls('harness:profile:upsert')[0]).toEqual({ id: 'default', serverUrl: 'http://h:3000', keyId: 3, keyMode: 'command', models: { main: 'deepseek-flash' } });
    expect(await screen.findByText('providers.pa')).toBeTruthy();
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(screen.getByText('应用'));
    expect(pa.calls('harness:apply')).toEqual([]);
    await userEvent.click(screen.getByText('应用'));
    await waitFor(() => expect(pa.calls('harness:apply')[0]).toMatchObject({ id: 'pi', confirm: true, acknowledge: [] }));
    expect(await screen.findByText(/已写入/)).toBeTruthy();
  });
  it('conflicts block apply until resolved; resolution is sent as an ack', async () => {
    const pa = setup(plan([{ id: 'c1', kind: 'name-collision', message: 'exists' }]));
    render(<HarnessPanel keyId={3} serverUrl="http://h:3000" />);
    await screen.findByText(/已安装/);
    await userEvent.click(screen.getByText('预览变更'));
    const btn = await screen.findByText('应用');
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    await userEvent.selectOptions(screen.getByLabelText('冲突处理 c1'), 'overwrite');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(btn);
    await waitFor(() => expect(pa.calls('harness:apply')[0]).toMatchObject({ acknowledge: [{ conflictId: 'c1', resolution: 'overwrite' }] }));
  });
  it('no keychain -> env mode preselected and keychain option disabled; rollback needs confirm', async () => {
    const pa = setup(plan(), false);
    render(<HarnessPanel keyId={3} serverUrl="http://h:3000" />);
    await waitFor(() => expect((screen.getByLabelText('取 key 方式') as HTMLSelectElement).value).toBe('env'));
    const c = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(screen.getByText('移除我们的配置'));
    // preview first: nothing written, confirm not yet asked
    expect(await screen.findByRole('region', { name: '回滚预览' })).toBeTruthy();
    expect(screen.getByRole('table', { name: '回滚预览变更' }).textContent).toContain('providers.pa');
    expect(c).not.toHaveBeenCalled();
    expect(pa.calls('harness:rollback')).toEqual([]);
    await userEvent.click(screen.getByText('确认移除我们的配置'));
    await waitFor(() => expect(pa.calls('harness:rollback')[0]).toEqual({ id: 'pi', target: 'detach', confirm: true }));
    expect(c).toHaveBeenCalledTimes(1);
  });
});

describe('HarnessPanel (Claude Code)', () => {
  it('targets claude and keeps the other harness options of the shared profile', async () => {
    const pa = mockPa({
      'harness:detect': () => ({ harnesses: [...det.harnesses, { id: 'claude', installed: true, version: '2.1.250', configDir: '/tmp/h/.claude', files: [], notes: ['Project .claude/settings.json found'] }], registered: ['pi', 'claude'] }),
      'harness:keyring:status': () => ({ available: true, backend: 'memory', entries: [] }),
      'harness:profile:list': () => ({ profiles: [{ id: 'default', serverUrl: 'http://h:3000', keyId: 3, keyMode: 'command', models: { main: 'deepseek-flash' }, pi: { setDefault: false } }] }),
      'harness:profile:upsert': (r: unknown) => r,
      'models:list': () => [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
      'harness:plan': () => ({ ...plan(), id: 'claude', changes: [{ file: '/tmp/h/.claude/settings.json', setting: 'apiKeyHelper', kind: 'create', before: null, after: "'/x/pa-key' default claude" }] }),
      'harness:apply': () => ({ id: 'claude', written: [], warnings: [] }),
      'harness:rollback': () => ({ id: 'claude', written: [], warnings: [] }),
    });
    render(<HarnessPanel keyId={3} serverUrl="http://h:3000" harness="claude" />);
    expect(await screen.findByText('Harness · Claude Code')).toBeTruthy();
    expect(await screen.findByText(/已安装 2.1.250/)).toBeTruthy();
    expect(screen.getByText(/Project .claude/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('主模型'), 'deepseek-v4-pro');
    await userEvent.selectOptions(screen.getByLabelText('备选模型'), 'deepseek-flash');
    await userEvent.click(screen.getByText('预览变更'));
    expect(pa.calls('harness:profile:upsert')[0]).toMatchObject({ models: { main: 'deepseek-v4-pro', small: 'deepseek-flash' }, pi: { setDefault: false } });
    await waitFor(() => expect(pa.calls('harness:plan')[0]).toEqual({ id: 'claude', profileId: 'default' }));
    expect(await screen.findByText('apiKeyHelper')).toBeTruthy();
  });
});

describe('HarnessPanel (Codex)', () => {
  it('shows "server channel not ready" until probed; probe result shown; model goes to models.codex', async () => {
    let state = 'model-missing';
    const pa = mockPa({
      'harness:detect': () => ({ harnesses: [{ id: 'codex', installed: true, version: '0.164.0', configDir: '/tmp/h/.codex', files: [], notes: [] }], registered: ['pi', 'claude', 'codex'] }),
      'harness:keyring:status': () => ({ available: true, backend: 'memory', entries: [] }),
      'harness:profile:list': () => ({ profiles: [{ id: 'default', serverUrl: 'http://h:3000', keyId: 3, keyMode: 'command', models: { main: 'deepseek-flash', small: 'x' } }] }),
      'harness:profile:upsert': (r: unknown) => r,
      'harness:channel:probe': () => ({ state, model: 'deepseek-v4-pro', checkedAt: 'now' }),
      'models:list': () => [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
      'harness:plan': () => ({ ...plan(), id: 'codex' }),
    });
    render(<HarnessPanel keyId={3} serverUrl="http://h:3000" harness="codex" />);
    expect(await screen.findByText(/服务端渠道未就绪（未探测）/)).toBeTruthy();
    expect(screen.queryByLabelText('备选模型')).toBeNull();
    await userEvent.click(screen.getByText('探测服务端渠道'));
    expect(await screen.findByText(/没有该模型/)).toBeTruthy();
    state = 'model-listed';
    await userEvent.click(screen.getByText('探测服务端渠道'));
    expect(await screen.findByText(/Responses 通道未经 live 验证/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('主模型'), 'deepseek-v4-pro');
    await userEvent.click(screen.getByText('预览变更'));
    expect(pa.calls('harness:profile:upsert')[0]).toMatchObject({ models: { main: 'deepseek-flash', small: 'x', codex: 'deepseek-v4-pro' }, codex: { setDefault: false } });
    await userEvent.click(screen.getByLabelText('设为 Codex 默认'));
    await userEvent.click(screen.getByText('预览变更'));
    expect(pa.calls('harness:profile:upsert')[1]).toMatchObject({ codex: { setDefault: true } });
    await waitFor(() => expect(pa.calls('harness:plan')[0]).toEqual({ id: 'codex', profileId: 'default' }));
  });
});

describe('HarnessPanel rollback external edits (Aegis #1)', () => {
  it('asks a second time and sends overwriteExternal only when the user confirms', async () => {
    const pa = setup(plan(), true, { 'harness:rollback:preview': () => ({ id: 'pi', target: 'last', files: [], changes: [], warnings: [], externalEdits: ['/tmp/h/.pi/agent/models.json'] }) });
    render(<HarnessPanel keyId={3} serverUrl="http://h:3000" />);
    await screen.findByText(/已安装 0.70.2/);
    const c = vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(false);
    await userEvent.click(screen.getByText('回滚到上一版'));
    expect(await screen.findByText(/上次写入后被修改过/)).toBeTruthy();
    await userEvent.click(screen.getByText('确认回滚到上一版'));
    await waitFor(() => expect(c).toHaveBeenCalledTimes(2));
    expect(pa.calls('harness:rollback')).toEqual([]);
    c.mockReturnValue(true);
    await userEvent.click(screen.getByText('确认回滚到上一版'));
    await waitFor(() => expect(pa.calls('harness:rollback')[0]).toEqual({ id: 'pi', target: 'last', confirm: true, overwriteExternal: true }));
  });
});

describe('HarnessPanel rollback UX (H4)', () => {
  it('lists snapshots (pruned ones not restorable), previews a snapshot, cancel writes nothing', async () => {
    const pa = setup(plan());
    render(<HarnessPanel keyId={3} serverUrl="http://h:3000" />);
    const list = await screen.findByRole('list', { name: '快照列表' });
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(list.textContent).toContain('已清理');
    expect(screen.getAllByText('预览恢复')).toHaveLength(1);
    expect(screen.getByLabelText('接管状态').textContent).toBe('已接管');
    await userEvent.click(screen.getByText('预览恢复'));
    await waitFor(() => expect(pa.calls('harness:rollback:preview')[0]).toEqual({ id: 'pi', target: { snapshotId: '2026-10-23T13-00-00.000Z-aaaaaa' } }));
    expect(await screen.findByText(/models.json（修改）/)).toBeTruthy();
    await userEvent.click(screen.getByText('取消'));
    expect(screen.queryByRole('region', { name: '回滚预览' })).toBeNull();
    expect(pa.calls('harness:rollback')).toEqual([]);
  });

  it('blocked preview disables confirm and shows why; empty history disables presets', async () => {
    setup(plan(), true, {
      'harness:history': () => ({ id: 'pi', attached: true, firstWrite: false, snapshots: [] }),
      'harness:rollback:preview': (r: { target: unknown }) => ({ id: 'pi', target: r.target, files: [], changes: [], warnings: [], blocked: 'Managed settings were changed outside Portable Agent' }),
    });
    render(<HarnessPanel keyId={3} serverUrl="http://h:3000" />);
    expect(await screen.findByText(/还没有快照/)).toBeTruthy();
    expect((screen.getByText('回滚到上一版') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('恢复到首次写入前') as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByText('移除我们的配置'));
    expect(await screen.findByText(/无法执行：Managed settings were changed/)).toBeTruthy();
    expect((screen.getByText('确认移除我们的配置') as HTMLButtonElement).disabled).toBe(true);
  });

  it('plan with no changes says so; cancel closes the plan; errors surface as alerts', async () => {
    setup({ ...plan(), changes: [], warnings: [] }, true, { 'harness:apply': () => { throw new Error('unused'); } });
    render(<HarnessPanel keyId={3} serverUrl="http://h:3000" />);
    await waitFor(() => expect((screen.getByLabelText('主模型') as HTMLSelectElement).value).toBe('deepseek-flash'));
    await userEvent.click(screen.getByText('预览变更'));
    expect(await screen.findByText('没有托管设置的变更')).toBeTruthy();
    await userEvent.click(screen.getByText('取消'));
    expect(screen.queryByText('应用')).toBeNull();
    render(<HarnessPanel serverUrl="http://h:3000" />);
    await userEvent.click(screen.getAllByText('预览变更')[1]!);
    expect((await screen.findByRole('alert')).textContent).toMatch(/请先在 API Keys 中选择一个 key/);
  });
});
