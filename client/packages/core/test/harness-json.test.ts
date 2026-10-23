import { describe, expect, it } from 'vitest';
import { mergeOwnedJson, parseJsonc, readJsonPaths } from '@pa/core/harness';

const USER = `{
    // user comment
    "theme": "dark",
    "env": {
        "FOO": "bar" // trailing
    },
    "permissions": { "allow": ["Bash(ls:*)"] },
}
`;

describe('format-preserving JSON merge', () => {
  it('keeps comments, indentation, key order and unknown fields', () => {
    const out = mergeOwnedJson(USER, [
      { path: ['env', 'ANTHROPIC_BASE_URL'], value: 'http://127.0.0.1:9' },
      { path: ['apiKeyHelper'], value: '/opt/pa/pa-key default claude' },
    ]);
    expect(out).toContain('// user comment');
    expect(out).toContain('"FOO": "bar", // trailing\n        "ANTHROPIC_BASE_URL"');
    expect(out).toContain('"permissions": { "allow": ["Bash(ls:*)"] },\n    "apiKeyHelper": "/opt/pa/pa-key default claude",\n}');
    expect(out).toContain('\n        "ANTHROPIC_BASE_URL": "http://127.0.0.1:9"\n    },');
    // Exactly our two lines were added; nothing else reflowed.
    expect(out.split('\n').length).toBe(USER.split('\n').length + 2);
    expect(out.indexOf('"theme"')).toBeLessThan(out.indexOf('"env"'));
    expect(readJsonPaths(out, [['permissions', 'allow'], ['apiKeyHelper']])).toEqual([['Bash(ls:*)'], '/opt/pa/pa-key default claude']);
  });
  it('removes owned settings without touching the rest', () => {
    const withOurs = mergeOwnedJson(USER, [{ path: ['env', 'ANTHROPIC_MODEL'], value: 'm' }]);
    const back = mergeOwnedJson(withOurs, [{ path: ['env', 'ANTHROPIC_MODEL'], value: undefined }]);
    expect(parseJsonc(back)).toEqual(parseJsonc(USER));
    expect(back).toBe(USER); // insert + remove round-trips byte-identically
  });
  it('empty / missing file -> new object; tabs and CRLF preserved', () => {
    expect(JSON.parse(mergeOwnedJson('', [{ path: ['providers', 'pa'], value: { api: 'openai-completions' } }]))).toEqual({ providers: { pa: { api: 'openai-completions' } } });
    const tabs = '{\r\n\t"a": 1\r\n}\r\n';
    const out = mergeOwnedJson(tabs, [{ path: ['b'], value: 2 }]);
    expect(out).toContain('\r\n\t"b": 2');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });
  it('replaces existing values in place (nested objects indented to their depth)', () => {
    const t = '{\n  "providers": {\n    "pa": { "api": "old" },\n    "other": 1\n  }\n}\n';
    const out = mergeOwnedJson(t, [{ path: ['providers', 'pa'], value: { api: 'openai-completions', models: [{ id: 'm' }] } }]);
    expect(out).toContain('"pa": {\n      "api": "openai-completions",\n      "models": [\n        {\n          "id": "m"\n        }\n      ]\n    },\n    "other": 1');
  });
  it('refuses invalid JSON and non-object roots', () => {
    expect(() => mergeOwnedJson('{"a":', [{ path: ['b'], value: 1 }])).toThrow(/not valid JSON/);
    expect(() => mergeOwnedJson('[1]', [{ path: ['b'], value: 1 }])).toThrow(/object/);
  });
});
