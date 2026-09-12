import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { FastmailAuth } from '../auth.js';
import { JmapClient, type JmapRequest } from '../jmap-client.js';
import { JmapError, RefusedError } from './core.js';
import { tools } from './bulk.js';

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
const original = { mailboxIds: { 'mb-1': true, 'mb-2': true }, keywords: { $seen: true, $flagged: true, custom: true } };
const env = { audit: process.env.FASTMAIL_AUDIT_LOG, threshold: process.env.FASTMAIL_BULK_CONFIRM_THRESHOLD };

beforeEach(() => {
  delete process.env.FASTMAIL_AUDIT_LOG;
  delete process.env.FASTMAIL_BULK_CONFIRM_THRESHOLD;
});
afterEach(() => {
  mock.restoreAll();
  for (const [key, value] of Object.entries({ FASTMAIL_AUDIT_LOG: env.audit, FASTMAIL_BULK_CONFIRM_THRESHOLD: env.threshold })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setup(options: {
  ids?: string[];
  capabilities?: Record<string, unknown>;
  reply?: (method: string, args: any) => any;
} = {}) {
  const client = new JmapClient(new FastmailAuth({ apiToken: 'fake-token' }));
  const states = new Map((options.ids ?? ['email-1', 'email-2']).map(id => [id, structuredClone(original)]));
  const calls: Array<{ method: string; args: any }> = [];
  mock.method(client, 'getSession', async () => ({
    apiUrl: 'https://api.example.com/jmap/api/', accountId: 'acct-1',
    capabilities: { [CORE]: options.capabilities ?? { maxObjectsInSet: 2, maxObjectsInGet: 2 } },
  }));
  mock.method(client, 'makeRequest', async (request: JmapRequest) => {
    assert.deepEqual(request.using, [CORE, MAIL]);
    assert.equal(request.methodCalls.length, 1);
    const [method, args, tag] = request.methodCalls[0];
    assert.equal(args.accountId, 'acct-1');
    calls.push({ method, args: structuredClone(args) });
    let result = options.reply?.(method, args);
    if (result === undefined) {
      switch (method) {
        case 'Email/get':
          assert.deepEqual(args.properties, ['id', 'mailboxIds', 'keywords']);
          result = {
            list: args.ids.filter((id: string) => states.has(id)).map((id: string) => ({ id, ...structuredClone(states.get(id)) })),
            notFound: args.ids.filter((id: string) => !states.has(id)),
          };
          break;
        case 'Email/set':
          assert.deepEqual(Object.keys(args).sort(), ['accountId', 'update']);
          result = { updated: Object.fromEntries(Object.keys(args.update).map(id => [id, null])) };
          break;
        case 'Email/query': {
          const ids = [...states.keys()];
          result = { ids: ids.slice(args.position, args.position + args.limit), total: ids.length, queryState: 'q1', position: args.position };
          break;
        }
        case 'Mailbox/get':
          result = { list: [{ id: 'mb-3', role: 'trash' }] };
          break;
        default: assert.fail(`Unexpected JMAP method: ${method}`);
      }
    }
    return { methodResponses: [[method, result, tag]], sessionState: 's1' };
  });
  const run = async (name: string, args: Record<string, any> = {}): Promise<any> => {
    const tool = tools.find(entry => entry.def.name === name);
    assert.ok(tool, name);
    return tool.run(args, { client });
  };
  return { client, calls, states, run, sets: () => calls.filter(call => call.method === 'Email/set') };
}

describe('bulk patches and before-state', () => {
  for (const [name, args, patch] of [
    ['bulk_mark_read', {}, { 'keywords/$seen': true }],
    ['bulk_mark_read', { read: false }, { 'keywords/$seen': null }],
    ['bulk_pin', {}, { 'keywords/$flagged': true }],
    ['bulk_pin', { pinned: false }, { 'keywords/$flagged': null }],
    ['bulk_move', { targetMailboxId: 'mb-4' }, { mailboxIds: { 'mb-4': true } }],
    ['bulk_delete', {}, { mailboxIds: { 'mb-3': true } }],
    ['bulk_add_labels', { mailboxIds: ['mb-4', 'mb-5'] }, { 'mailboxIds/mb-4': true, 'mailboxIds/mb-5': true }],
    ['bulk_remove_labels', { mailboxIds: ['mb-1', 'mb-2'] }, { 'mailboxIds/mb-1': null, 'mailboxIds/mb-2': null }],
  ] as const) {
    it(`${name} ${JSON.stringify(args)} sends exact Email/set properties`, async () => {
      const h = setup();
      const result = await h.run(name, { emailIds: ['email-1', 'email-2'], ...args });
      assert.deepEqual(h.sets(), [{ method: 'Email/set', args: { accountId: 'acct-1', update: { 'email-1': patch, 'email-2': patch } } }]);
      const getCalls = h.calls.filter(call => call.method === 'Email/get');
      assert.deepEqual(getCalls, [0, 1].map(() => ({ method: 'Email/get', args: {
        accountId: 'acct-1', ids: ['email-1', 'email-2'], properties: ['id', 'mailboxIds', 'keywords'],
      } })));
      assert.ok(h.calls.findIndex(call => call.method === 'Email/get') < h.calls.findIndex(call => call.method === 'Email/set'));
      assert.equal(result.requested, 2);
      assert.equal(result.updated, 2);
      assert.deepEqual(result.notUpdated, {});
      assert.match(result.operationId, /^[a-f0-9]{12}$/);
      const log = await h.run('export_operation_log', { operationId: result.operationId });
      assert.equal(log.count, 2);
      assert.equal(log.tool, name);
      assert.deepEqual(log.changes, ['email-1', 'email-2'].map(emailId => ({ emailId, before: original })));
    });
  }

  it('finds Trash strictly by role, not by a misleading name', async () => {
    const h = setup({ reply: method => method === 'Mailbox/get' ? { list: [
      { id: 'mb-2', role: null, name: 'Trash' }, { id: 'mb-3', role: 'trash', name: 'Deleted' },
    ] } : undefined });
    await h.run('bulk_delete', { emailIds: ['email-1'] });
    assert.deepEqual(h.calls[0], { method: 'Mailbox/get', args: { accountId: 'acct-1', properties: ['id', 'role'] } });
    assert.deepEqual(h.sets()[0].args.update, { 'email-1': { mailboxIds: { 'mb-3': true } } });
  });

  it('refuses a missing trash role without any Email/set', async () => {
    const h = setup({ reply: method => method === 'Mailbox/get' ? { list: [{ id: 'mb-2', role: null, name: 'Trash' }] } : undefined });
    await assert.rejects(h.run('bulk_delete', { emailIds: ['email-1'] }), /No mailbox with role trash/);
    assert.equal(h.sets().length, 0);
  });

  it('escapes JSON Pointer segments for label patches', async () => {
    const h = setup();
    await h.run('bulk_remove_labels', { emailIds: ['email-1'], mailboxIds: ['mb/~1'] });
    assert.deepEqual(h.sets()[0].args.update, { 'email-1': { 'mailboxIds/mb~1~01': null } });
  });

  it('returns server read-back values rather than the requested patch', async () => {
    let wrote = false;
    const stored = { mailboxIds: { 'mb-4': true }, keywords: { custom: true } };
    const h = setup({ reply: method => {
      if (method === 'Email/set') wrote = true;
      if (method === 'Email/get' && wrote) return { list: [{ id: 'email-1', ...stored }] };
    } });
    const result = await h.run('bulk_move', { emailIds: ['email-1'], targetMailboxId: 'mb-4' });
    assert.deepEqual(result.storedSample, [{ id: 'email-1', ...stored }]);
  });
});

describe('selectors and safety gates', () => {
  it('previews a whole mailbox in 500-id pages, caps the preview at 200 and writes/logs nothing', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `email-${i}`);
    const h = setup({ ids });
    const log = await h.run('export_operation_log');
    process.env.FASTMAIL_AUDIT_LOG = 'audit-test.jsonl';
    const append = mock.method(fs, 'appendFile', async () => {});
    const result = await h.run('bulk_mark_read', { mailboxId: 'mb-1', dryRun: true });
    assert.deepEqual(result, { dryRun: true, count: 501, emailIds: ids.slice(0, 200), action: 'mark as read' });
    assert.deepEqual(h.calls, [0, 500].map(position => ({ method: 'Email/query', args: {
      accountId: 'acct-1', filter: { inMailbox: 'mb-1' }, calculateTotal: true, position, limit: 500,
      sort: [{ property: 'receivedAt', isAscending: false }],
    } })));
    assert.deepEqual(await h.run('export_operation_log'), log);
    assert.equal(append.mock.calls.length, 0);
  });

  it('maps every requested advanced filter field through the upstream builder', async () => {
    const h = setup();
    await h.run('bulk_pin', { dryRun: true, filter: {
      from: 'user@example.com', to: 'user@example.com', subject: 'subject', text: 'body',
      hasAttachment: false, isUnread: true, isPinned: true, before: '2026-09-12T00:00:00Z', after: '2026-01-01T00:00:00Z',
      mailboxIds: ['mb-1', 'mb-2'], excludeMailboxIds: ['mb-3'],
    } });
    assert.deepEqual(h.calls[0].args.filter, { operator: 'AND', conditions: [
      { text: 'body', from: 'user@example.com', to: 'user@example.com', subject: 'subject', hasAttachment: false,
        after: '2026-01-01T00:00:00Z', before: '2026-09-12T00:00:00Z', inMailboxOtherThan: ['mb-3'] },
      { inMailbox: 'mb-1' }, { inMailbox: 'mb-2' }, { notKeyword: '$seen' }, { hasKeyword: '$flagged' },
    ] });
  });

  it('writes query-selected emails and keeps label arguments separate from the folder selector', async () => {
    const h = setup();
    const result = await h.run('bulk_add_labels', { mailboxId: 'mb-1', mailboxIds: ['mb-4'] });
    assert.equal(result.updated, 2);
    assert.deepEqual(h.calls[0].args.filter, { inMailbox: 'mb-1' });
    assert.deepEqual(h.sets()[0].args.update, { 'email-1': { 'mailboxIds/mb-4': true }, 'email-2': { 'mailboxIds/mb-4': true } });
  });

  for (const args of [
    {}, { emailIds: ['email-1'], mailboxId: 'mb-1' }, { filter: {}, mailboxId: 'mb-1' },
    { emailIds: ['email-1'], filter: {} }, { emailIds: ['email-1'], filter: {}, mailboxId: 'mb-1' },
  ]) {
    it(`refuses ambiguous or absent selectors: ${JSON.stringify(args)}`, async () => {
      const h = setup();
      await assert.rejects(h.run('bulk_pin', args), /Exactly one selector/);
      assert.equal(h.calls.length, 0);
    });
  }

  for (const [args, message] of [
    [{ emailIds: [] }, /emailIds must be a non-empty/],
    [{ emailIds: [42] }, /emailIds must be a non-empty/],
    [{ mailboxId: '' }, /mailboxId is required/],
    [{ filter: null }, /filter must be an object/],
    [{ filter: [] }, /filter must be an object/],
    [{ filter: { sender: 'user@example.com' } }, /Unknown filter field/],
    [{ filter: { isUnread: 'yes' } }, /filter.isUnread must be a boolean/],
    [{ filter: { mailboxIds: [] } }, /mailboxIds must be a non-empty/],
    [{ emailIds: ['email-1'], maxEmails: 0 }, /maxEmails must be a positive integer/],
    [{ emailIds: ['email-1'], maxEmails: 1.5 }, /maxEmails must be a positive integer/],
    [{ emailIds: ['email-1'], confirm: 'true' }, /confirm must be a boolean/],
    [{ emailIds: ['email-1'], dryRun: 'true' }, /dryRun must be a boolean/],
    [{ emailIds: ['email-1'], pinned: null }, /pinned must be a boolean/],
  ] as const) {
    it(`refuses invalid inputs: ${JSON.stringify(args)}`, async () => {
      const h = setup();
      await assert.rejects(h.run('bulk_pin', args), message);
      assert.equal(h.calls.length, 0);
    });
  }

  for (const [name, args, message] of [
    ['bulk_move', {}, /targetMailboxId is required/],
    ['bulk_add_labels', {}, /mailboxIds must be a non-empty/],
    ['bulk_remove_labels', { mailboxIds: [] }, /mailboxIds must be a non-empty/],
    ['bulk_mark_read', { read: 'false' }, /read must be a boolean/],
  ] as const) {
    it(`${name} refuses missing or malformed action arguments`, async () => {
      const h = setup();
      await assert.rejects(h.run(name, { emailIds: ['email-1'], ...args }), message);
      assert.equal(h.calls.length, 0);
    });
  }

  it('refuses a query total above the default cap before any write and allows an explicit higher cap', async () => {
    const h = setup({ ids: Array.from({ length: 1001 }, (_, i) => `email-${i}`) });
    await assert.rejects(h.run('bulk_pin', { filter: {}, dryRun: true }), /1001 emails exceed maxEmails 1000/);
    assert.equal(h.calls.length, 1);
    const result = await h.run('bulk_pin', { filter: {}, maxEmails: 1001, dryRun: true });
    assert.equal(result.count, 1001);
    assert.equal(h.sets().length, 0);
  });

  it('deduplicates explicit ids and applies maxEmails to unique ids', async () => {
    const h = setup();
    const result = await h.run('bulk_pin', { emailIds: ['email-1', 'email-1'], maxEmails: 1 });
    assert.equal(result.requested, 1);
    await assert.rejects(h.run('bulk_pin', { emailIds: ['email-1', 'email-2'], maxEmails: 1 }), /2 emails exceed maxEmails 1/);
    assert.equal(h.sets().length, 1);
  });

  it('states the exact count and default threshold in a refusal; confirm:true permits the write', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `email-${i}`);
    const h = setup({ ids, capabilities: {} });
    await assert.rejects(h.run('bulk_pin', { emailIds: ids }), error => {
      assert.ok(error instanceof RefusedError);
      assert.equal(error.message, 'Refused: 101 emails exceed the confirmation threshold 100. Pass confirm: true to proceed.');
      return true;
    });
    assert.equal(h.calls.length, 0);
    assert.equal((await h.run('bulk_pin', { emailIds: ids, confirm: true })).updated, 101);
  });

  it('uses the environment threshold and requires confirmation only above it', async () => {
    process.env.FASTMAIL_BULK_CONFIRM_THRESHOLD = '1';
    const h = setup();
    assert.equal((await h.run('bulk_pin', { emailIds: ['email-1'] })).updated, 1);
    await assert.rejects(h.run('bulk_pin', { emailIds: ['email-1', 'email-2'] }), /2 emails exceed the confirmation threshold 1/);
    assert.equal(h.sets().length, 1);
  });

  it('refuses an invalid environment threshold without writing', async () => {
    process.env.FASTMAIL_BULK_CONFIRM_THRESHOLD = 'invalid';
    const h = setup();
    await assert.rejects(h.run('bulk_pin', { emailIds: ['email-1'] }), /must be a non-negative integer/);
    assert.equal(h.calls.length, 0);
  });

  for (const [page, message] of [
    [{ ids: ['email-1'] }, /did not return valid ids and a total/],
  ] as const) {
    it(`refuses an unsafe query response: ${JSON.stringify(page)}`, async () => {
      const h = setup({ reply: method => method === 'Email/query' ? page : undefined });
      await assert.rejects(h.run('bulk_delete', { filter: {} }), message);
      assert.equal(h.sets().length, 0);
    });
  }

  it('dedupes repeated ids and stops on an empty page', async () => {
    const h = setup({ reply: (method, args) => method === 'Email/query'
      ? { ids: args.position === 0 ? ['email-1', 'email-1'] : [], total: 3 } : undefined });
    const result = await h.run('bulk_pin', { filter: {}, dryRun: true });
    assert.deepEqual(result.emailIds, ['email-1']);
  });

  it('returns zero for an empty selection without Email/get or Email/set', async () => {
    const h = setup({ ids: [] });
    const result = await h.run('bulk_delete', { filter: {} });
    assert.equal(result.requested, 0);
    assert.equal(result.updated, 0);
    assert.deepEqual(h.calls.map(call => call.method), ['Email/query']);
  });
});

describe('batching, partial results and undo', () => {
  it('honors separate get/set capability limits, captures all before-state before writing and batches undo', async () => {
    const ids = ['email-1', 'email-2', 'email-3', 'email-4', 'email-5'];
    const h = setup({ ids, capabilities: { maxObjectsInSet: 2, maxObjectsInGet: 3 } });
    const result = await h.run('bulk_pin', { emailIds: ids });
    assert.deepEqual(h.calls.slice(0, 2).map(call => call.args.ids), [ids.slice(0, 3), ids.slice(3)]);
    assert.deepEqual(h.sets().map(call => Object.keys(call.args.update)), [ids.slice(0, 2), ids.slice(2, 4), ids.slice(4)]);
    const changed = { mailboxIds: { 'mb-5': true }, keywords: { custom: true } };
    for (const id of ids) h.states.set(id, changed as typeof original);
    const undone = await h.run('undo_operation', { operationId: result.operationId });
    assert.equal(undone.restored, 5);
    assert.deepEqual(undone.notUpdated, {});
    assert.deepEqual(h.sets().slice(3).map(call => call.args.update), [ids.slice(0, 2), ids.slice(2, 4), ids.slice(4)]
      .map(batch => Object.fromEntries(batch.map(id => [id, original]))));
    const undoLog = await h.run('export_operation_log', { operationId: undone.operationId });
    assert.equal(undoLog.tool, 'undo_operation');
    assert.deepEqual(undoLog.changes, ids.map(emailId => ({ emailId, before: changed })));
  });

  it('falls back to 500 objects per get/set when capabilities are absent', async () => {
    const h = setup({ ids: Array.from({ length: 501 }, (_, i) => `email-${i}`), capabilities: {} });
    const result = await h.run('bulk_pin', { filter: {}, confirm: true });
    assert.equal(result.updated, 501);
    assert.deepEqual(h.sets().map(call => Object.keys(call.args.update).length), [500, 1]);
    assert.ok(h.calls.filter(call => call.method === 'Email/get').every(call => call.args.ids.length <= 500));
  });

  it('reports notFound/notUpdated per id and only undoes successful updates', async () => {
    const h = setup({ reply: (method, args) => method === 'Email/set' && args.update['email-2'] ? {
      updated: { 'email-1': null }, notUpdated: { 'email-2': { type: 'forbidden', description: 'Read only' } },
    } : undefined });
    const result = await h.run('bulk_mark_read', { emailIds: ['email-1', 'email-2', 'email-3'] });
    assert.equal(result.requested, 3);
    assert.equal(result.updated, 1);
    assert.deepEqual(result.notUpdated, {
      'email-2': { type: 'forbidden', description: 'Read only' },
      'email-3': { type: 'notFound', description: 'Email/get did not return this email; nothing was written.' },
    });
    await h.run('undo_operation', { operationId: result.operationId });
    assert.deepEqual(h.sets()[1].args.update, { 'email-1': original });
  });

  it('does not count an unacknowledged update as successful', async () => {
    const h = setup({ reply: method => method === 'Email/set' ? {} : undefined });
    const result = await h.run('bulk_pin', { emailIds: ['email-1'] });
    assert.equal(result.updated, 0);
    assert.equal(result.notUpdated['email-1'].type, 'malformedResponse');
  });

  it('refuses an incomplete before-state rather than writing or inventing empty maps', async () => {
    const h = setup({ reply: method => method === 'Email/get' ? { list: [{ id: 'email-1', mailboxIds: { 'mb-1': true } }] } : undefined });
    await assert.rejects(h.run('bulk_pin', { emailIds: ['email-1'] }), /refusing an incomplete snapshot/);
    assert.equal(h.sets().length, 0);
  });

  it('keeps earlier successful batches undoable when a later request fails', async () => {
    let sets = 0;
    const h = setup({ capabilities: { maxObjectsInSet: 1 }, reply: method => {
      if (method === 'Email/set' && ++sets === 2) throw new Error('Transport failed');
    } });
    let operationId = '';
    await assert.rejects(h.run('bulk_pin', { emailIds: ['email-1', 'email-2'] }), error => {
      assert.ok(error instanceof JmapError);
      operationId = (error.detail as any).operationId;
      assert.equal((error.detail as any).updated, 1);
      return true;
    });
    const log = await h.run('export_operation_log', { operationId });
    assert.deepEqual(log.changes, [{ emailId: 'email-1', before: original }]);
    await h.run('undo_operation', { operationId });
    assert.deepEqual(h.sets()[2].args.update, { 'email-1': original });
  });

  it('keeps acknowledged writes undoable after a read-back failure', async () => {
    let wrote = false;
    const h = setup({ reply: method => {
      if (method === 'Email/set') wrote = true;
      if (method === 'Email/get' && wrote) throw new Error('Read-back failed');
    } });
    await assert.rejects(h.run('bulk_pin', { emailIds: ['email-1'] }), error => {
      assert.ok(error instanceof JmapError);
      assert.equal((error.detail as any).updated, 1);
      return true;
    });
    const log = await h.run('export_operation_log');
    assert.deepEqual(log.at(-1).changes, [{ emailId: 'email-1', before: original }]);
  });

  it('undo dryRun returns recorded ids and performs no network calls or logging', async () => {
    const h = setup();
    const result = await h.run('bulk_pin', { emailIds: ['email-1'] });
    const callCount = h.calls.length;
    const log = await h.run('export_operation_log');
    assert.deepEqual(await h.run('undo_operation', { operationId: result.operationId, dryRun: true }), {
      dryRun: true, count: 1, emailIds: ['email-1'], action: `undo ${result.operationId}`,
    });
    assert.equal(h.calls.length, callCount);
    assert.deepEqual(await h.run('export_operation_log'), log);
  });

  for (const name of ['undo_operation', 'export_operation_log']) {
    it(`${name} refuses an unknown id`, async () => {
      const h = setup();
      await assert.rejects(h.run(name, { operationId: 'unknown-id' }), /Unknown operationId: unknown-id/);
      assert.equal(h.calls.length, 0);
    });
  }

  it('undo refuses missing operationId', async () => {
    const h = setup();
    await assert.rejects(h.run('undo_operation'), /operationId is required/);
    assert.equal(h.calls.length, 0);
  });
});

describe('operation ring and audit file', () => {
  it('lists only metadata, exports full snapshots and protects the ring from caller mutation', async () => {
    const h = setup();
    const result = await h.run('bulk_pin', { emailIds: ['email-1'] });
    const full = await h.run('export_operation_log', { operationId: result.operationId });
    const list = await h.run('list_operations');
    assert.deepEqual(list.at(-1), { id: full.id, tool: full.tool, at: full.at, count: 1 });
    assert.equal(new Date(full.at).toISOString(), full.at);
    full.changes[0].before.keywords = {};
    await h.run('undo_operation', { operationId: result.operationId });
    assert.deepEqual(h.sets()[1].args.update, { 'email-1': original });
    assert.equal(tools.find(tool => tool.def.name === 'list_operations')?.write, false);
    assert.equal(tools.find(tool => tool.def.name === 'export_operation_log')?.write, false);
  });

  it('retains exactly the latest 50 operations and refuses an evicted operation', async () => {
    const h = setup();
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) ids.push((await h.run('bulk_pin', { emailIds: ['email-1'] })).operationId);
    assert.deepEqual((await h.run('list_operations')).map((operation: any) => operation.id), ids.slice(1));
    assert.equal((await h.run('export_operation_log')).length, 50);
    await assert.rejects(h.run('undo_operation', { operationId: ids[0] }), /Unknown operationId/);
  });

  it('appends one full JSON line per bulk operation and undo', async () => {
    process.env.FASTMAIL_AUDIT_LOG = 'audit-test.jsonl';
    const lines: string[] = [];
    mock.method(fs, 'appendFile', async (path, data, encoding) => {
      assert.equal(path, 'audit-test.jsonl');
      assert.equal(encoding, 'utf8');
      lines.push(String(data));
    });
    const h = setup();
    const result = await h.run('bulk_pin', { emailIds: ['email-1'] });
    await h.run('undo_operation', { operationId: result.operationId });
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.equal(line.split('\n').length, 2);
      const entry = JSON.parse(line);
      assert.deepEqual(entry, await h.run('export_operation_log', { operationId: entry.id }));
    }
    assert.deepEqual(lines.map(line => JSON.parse(line).tool), ['bulk_pin', 'undo_operation']);
  });

  it('reports an audit error without throwing, printing it, or losing the undo record', async () => {
    process.env.FASTMAIL_AUDIT_LOG = 'audit-test.jsonl';
    mock.method(fs, 'appendFile', async () => { throw new Error('Audit unavailable'); });
    const printed = mock.method(console, 'error', () => {});
    const warned = mock.method(console, 'warn', () => {});
    const h = setup();
    const result = await h.run('bulk_pin', { emailIds: ['email-1'] });
    assert.equal(result.auditLogError, 'Audit unavailable');
    assert.equal(result.updated, 1);
    const undo = await h.run('undo_operation', { operationId: result.operationId });
    assert.equal(undo.restored, 1);
    assert.equal(undo.auditLogError, 'Audit unavailable');
    assert.equal(printed.mock.calls.length, 0);
    assert.equal(warned.mock.calls.length, 0);
  });
});
