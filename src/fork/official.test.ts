import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { officialTools, resetOfficial, wrap } from './official.js';
import { RefusedError } from './core.js';

const remote = [
  { name: 'search_notes', description: 'Search notes', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'send_email', description: 'we have our own', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_calendars', description: 'cal', inputSchema: { type: 'object', properties: {} } },
];

describe('official passthrough', () => {
  it('is empty without a token', async () => {
    resetOfficial();
    delete process.env.FASTMAIL_MCP_TOKEN;
    assert.deepEqual(await officialTools(), []);
  });

  it('exposes only the allowlist, prefixed, and forwards calls', async () => {
    const calls: any[] = [];
    const tools = wrap(remote as any, async (p) => { calls.push(p); return { content: [{ type: 'text', text: 'ok' }] }; }, true);
    assert.deepEqual(tools.map((t) => t.def.name), ['official_search_notes', 'official_list_calendars']);
    assert.equal(tools[0].write, false);
    const r: any = await tools[0].run({ query: 'x' }, {} as any);
    assert.equal(r.content[0].text, 'ok');
    assert.deepEqual(calls, [{ name: 'search_notes', arguments: { query: 'x' } }]);
  });

  it('drops calendar tools when CalDAV is configured', () => {
    const tools = wrap(remote as any, async () => ({}), false);
    assert.deepEqual(tools.map((t) => t.def.name), ['official_search_notes']);
  });

  it('turns an official isError result into a refusal', async () => {
    const [t] = wrap(remote as any, async () => ({ isError: true, content: [{ type: 'text', text: 'nope' }] }), false);
    await assert.rejects(t.run({}, {} as any), (e: any) => e instanceof RefusedError && /nope/.test(e.message));
  });

  it('loads through the factory once and survives a connection failure', async () => {
    resetOfficial();
    process.env.FASTMAIL_MCP_TOKEN = 'fake';
    let n = 0;
    const factory = async () => { n++; throw new Error('offline'); };
    assert.deepEqual(await officialTools(factory), []);
    assert.deepEqual(await officialTools(factory), []);
    assert.equal(n, 1);
    delete process.env.FASTMAIL_MCP_TOKEN;
    resetOfficial();
  });
});
