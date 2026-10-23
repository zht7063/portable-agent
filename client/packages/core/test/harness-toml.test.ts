import { describe, expect, it } from 'vitest';
import { mergeOwnedToml, parseToml, tomlKeyParts } from '@pa/core/harness';

const USER = `# my codex config
model = "gpt-5" # mine
approval_policy = "never"

[model_providers.pa]
name = "old"
experimental_bearer_token = "x"

[model_providers.pa.auth]
command = "y"

# servers
[mcp_servers.foo]
command = "npx" # keep
args = ["-y", "foo"]

[profiles.fast]
model = "o4-mini"
`;
const PROV = { name: 'Portable Agent', base_url: 'http://h/v1', wire_api: 'responses', auth: { command: '/a b/pa-key', args: ['default', 'codex'] } };

describe('mergeOwnedToml', () => {
  it('replaces top-level keys in place (keeps trailing comment), replaces the provider table and its subtables, keeps the rest byte-for-byte', () => {
    const out = mergeOwnedToml(USER, [{ path: ['model'], value: 'ds' }, { path: ['model_provider'], value: 'pa' }, { path: ['model_providers', 'pa'], value: PROV }]);
    expect(out).toContain('model = "ds" # mine\n');
    expect(out).toContain('approval_policy = "never"\nmodel_provider = "pa"\n');
    expect(out).not.toContain('experimental_bearer_token');
    expect(out).toContain('# servers\n[mcp_servers.foo]\ncommand = "npx" # keep\nargs = ["-y", "foo"]\n');
    const j = parseToml(out);
    expect(j.model_providers).toEqual({ pa: PROV });
    expect(j.profiles).toEqual({ fast: { model: 'o4-mini' } });
    // removal round-trip
    const back = mergeOwnedToml(out, [{ path: ['model'], value: undefined }, { path: ['model_provider'], value: undefined }, { path: ['model_providers', 'pa'], value: undefined }]);
    expect(parseToml(back)).toEqual({ approval_policy: 'never', mcp_servers: { foo: { command: 'npx', args: ['-y', 'foo'] } }, profiles: { fast: { model: 'o4-mini' } } });
  });
  it('inserts into empty files and files that start with a table', () => {
    const e = mergeOwnedToml('', [{ path: ['model'], value: 'ds' }, { path: ['model_providers', 'pa'], value: PROV }]);
    expect(parseToml(e)).toEqual({ model: 'ds', model_providers: { pa: PROV } });
    const t = mergeOwnedToml('[a]\nx = 1\n', [{ path: ['model'], value: 'ds' }]);
    expect(t).toBe('model = "ds"\n\n[a]\nx = 1\n');
  });
  it('refuses inline or dotted definitions it cannot cut out, multi-line top-level values, and invalid TOML', () => {
    expect(() => mergeOwnedToml('[model_providers]\npa = { name = "x" }\n', [{ path: ['model_providers', 'pa'], value: PROV }])).toThrow(/verification failed/);
    expect(() => mergeOwnedToml('model = """\na\n"""\n', [{ path: ['model'], value: 'x' }])).toThrow(/several lines/);
    expect(() => mergeOwnedToml('model = ', [{ path: ['model'], value: 'x' }])).toThrow(/not valid TOML/);
  });
  it('keeps CRLF and parses quoted keys', () => {
    expect(mergeOwnedToml('a = 1\r\n', [{ path: ['model'], value: 'x' }])).toBe('a = 1\r\nmodel = "x"\r\n');
    expect(tomlKeyParts('model_providers."p.a" . auth')).toEqual(['model_providers', 'p.a', 'auth']);
  });
});

describe('toml: user comments inside our table (Aegis low)', () => {
  it('keeps full-line comments from the replaced section above our block, and on removal', async () => {
    const { mergeOwnedToml } = await import('@pa/core/harness');
    const src = 'model = "x"\n\n[model_providers.pa]\n# my note about pa\nname = "old"\n# second note\nbase_url = "http://old"\n\n# servers\n[mcp_servers.a]\ncommand = "npx"\n';
    const out = mergeOwnedToml(src, [{ path: ['model_providers', 'pa'], value: { name: 'Portable Agent', base_url: 'http://h/v1', wire_api: 'responses' } }]);
    expect(out).toContain('# my note about pa');
    expect(out).toContain('# second note');
    expect(out.indexOf('# my note about pa')).toBeLessThan(out.indexOf('[model_providers.pa]'));
    expect(out).toContain('# servers\n[mcp_servers.a]');
    expect(out).not.toContain('http://old');
    const removed = mergeOwnedToml(out, [{ path: ['model_providers', 'pa'], value: undefined }]);
    expect(removed).toContain('# my note about pa');
    expect(removed).not.toContain('[model_providers.pa]');
    expect(removed).toContain('# servers\n[mcp_servers.a]');
  });
});
