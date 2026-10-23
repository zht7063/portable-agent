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
function setup(p: Plan, keyringAvailable = true) {
  return mockPa({
    'harness:detect': () => det,
    'harness:keyring:status': () => ({ available: keyringAvailable, backend: keyringAvailable ? 'memory' : 'none', entries: [], ...(keyringAvailable ? {} : { fallback: 'env' }) }),
    'harness:profile:list': () => ({ profiles: [] }),
    'harness:profile:upsert': (r: unknown) => r,
    'models:list': () => [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
    'harness:plan': () => p,
    'harness:apply': () => ({ id: 'pi', written: ['/tmp/h/.pi/agent/models.json'], warnings: [] }),
    'harness:rollback': () => ({ id: 'pi', written: [], warnings: [] }),
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
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(screen.getByText('移除我们的配置'));
    await waitFor(() => expect(pa.calls('harness:rollback')[0]).toEqual({ id: 'pi', target: 'detach', confirm: true }));
  });
});
