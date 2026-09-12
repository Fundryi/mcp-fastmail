import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { coerceArgs, guardReadOnly, mergeForkTools, toMcpError } from './index.js';
import { JmapError, RefusedError } from './core.js';

describe('fork registry', () => {
  it('fork definitions come first and shadow upstream tools with the same name', () => {
    const merged = mergeForkTools([
      { name: 'list_mailboxes', description: 'up', inputSchema: {} },
      { name: 'create_mailbox', description: 'up', inputSchema: {} },
    ]);
    const names = merged.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, 'no duplicate names');
    assert.ok(names.includes('list_mailboxes'));
  });

  it('read-only mode blocks upstream write tools and allows reads', () => {
    process.env.FASTMAIL_READ_ONLY = '1';
    try {
      assert.throws(() => guardReadOnly('bulk_delete'), (e: any) => e instanceof McpError && e.data?.readOnly === true);
      assert.doesNotThrow(() => guardReadOnly('list_mailboxes'));
      assert.throws(() => guardReadOnly('anything', true));
    } finally {
      delete process.env.FASTMAIL_READ_ONLY;
    }
  });

  it('keeps the JMAP error type as structured data', () => {
    const e = toMcpError(new JmapError('invalidArguments', 'bad property', { properties: ['color'] }));
    assert.equal(e.code, ErrorCode.InternalError);
    assert.deepEqual((e.data as any).jmap.type, 'invalidArguments');
    assert.match(e.message, /invalidArguments/);
  });

  it('maps refusals to InvalidRequest and other errors to the generic wrapper', () => {
    const r = toMcpError(new RefusedError('Refused: x', { needsConfirm: true }));
    assert.equal(r.code, ErrorCode.InvalidRequest);
    assert.equal((r.data as any).needsConfirm, true);
    const g = toMcpError(new Error('boom'));
    assert.match(g.message, /^MCP error .*Tool execution failed: boom/);
  });

  it('coerces string arguments by schema type', () => {
    const def = { name: 't', description: '', inputSchema: { type: 'object', properties: {
      dryRun: { type: 'boolean' }, limit: { type: ['number', 'string'] }, fields: { type: 'array' }, parentId: { type: ['string', 'null'] }, name: { type: 'string' }, n: { type: 'number' },
    } } };
    assert.deepEqual(coerceArgs(def, { dryRun: 'true', limit: '5', fields: '["a","b"]', parentId: 'null', name: 'x', n: '7' }),
      { dryRun: true, limit: '5', fields: ['a', 'b'], parentId: 'null', name: 'x', n: 7 });
    assert.deepEqual(coerceArgs(def, { fields: 'a, b' }), { fields: ['a', 'b'] });
  });
});
