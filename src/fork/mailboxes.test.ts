import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JmapClient } from '../jmap-client.js';
import { FastmailAuth } from '../auth.js';
import { tools } from './mailboxes.js';

const ACCOUNT_ID = 'acct-123';
const tool = (name: string) => tools.find((t) => t.def.name === name)!;

// Tree: Inbox (role), Parent > Child, Other. Parent holds 2 emails.
const TREE = [
  { id: 'mb-inbox', name: 'Inbox', parentId: null, role: 'inbox', totalEmails: 5, totalThreads: 5 },
  { id: 'mb-1', name: 'Parent', parentId: null, role: null, totalEmails: 2, totalThreads: 2 },
  { id: 'mb-2', name: 'Child', parentId: 'mb-1', role: null, totalEmails: 0, totalThreads: 0 },
  { id: 'mb-3', name: 'Other', parentId: null, role: null, totalEmails: 0, totalThreads: 0 },
];

type Call = [string, any, string];

/** Client whose makeRequest answers each method call via `handler` and records every call. */
function makeClient(handler: (method: string, args: any) => any, maxObjectsInSet?: number) {
  const client = new JmapClient(new FastmailAuth({ apiToken: 'fake-token' }));
  const calls: Call[] = [];
  mock.method(client, 'getSession', async () => ({
    apiUrl: 'https://api.example.com/jmap/api/',
    accountId: ACCOUNT_ID,
    capabilities: maxObjectsInSet ? { 'urn:ietf:params:jmap:core': { maxObjectsInSet } } : {},
  }));
  mock.method(client, 'makeRequest', async (req: any) => {
    calls.push(...req.methodCalls);
    return { methodResponses: req.methodCalls.map(([m, a, tag]: Call) => [m, handler(m, a), tag]) };
  });
  return { client, calls };
}

/** Default handler: Mailbox/get serves TREE, everything else succeeds. */
function defaultHandler(m: string, a: any): any {
  if (m === 'Mailbox/get') {
    const list = a.ids ? TREE.filter((mb) => a.ids.includes(mb.id)) : TREE;
    return { list, notFound: [] };
  }
  if (m === 'Mailbox/set') {
    return {
      created: a.create ? Object.fromEntries(Object.keys(a.create).map((k) => [k, { id: 'mb-new' }])) : undefined,
      updated: a.update ? Object.fromEntries(Object.keys(a.update).map((k) => [k, null])) : undefined,
      destroyed: a.destroy ?? [],
    };
  }
  if (m === 'Email/query') return { ids: ['e1', 'e2'] };
  if (m === 'Email/set') return { updated: Object.fromEntries(Object.keys(a.update).map((k) => [k, null])) };
  throw new Error(`unexpected ${m}`);
}

const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: any) => { assert.equal(e.name, 'RefusedError'); assert.match(e.message, re); return true; });

describe('get_mailbox', () => {
  it('fetches one id with no properties filter', async () => {
    const { client, calls } = makeClient(defaultHandler);
    const out: any = await tool('get_mailbox').run({ mailboxId: 'mb-1' }, { client });
    assert.equal(out.name, 'Parent');
    assert.deepEqual(calls, [['Mailbox/get', { accountId: ACCOUNT_ID, ids: ['mb-1'] }, 'c0']]);
  });

  it('resolves a path via getMailboxByName', async () => {
    const { client, calls } = makeClient(defaultHandler);
    const out: any = await tool('get_mailbox').run({ path: 'Parent/Child' }, { client });
    assert.equal(out.id, 'mb-2');
    assert.deepEqual(calls.at(-1)?.[1], { accountId: ACCOUNT_ID, ids: ['mb-2'] });
  });

  it('refuses without id or path', async () => {
    const { client } = makeClient(defaultHandler);
    await rejects(tool('get_mailbox').run({}, { client }), /mailboxId or path is required/);
  });
});

describe('create_mailbox', () => {
  it('sends all fields plus extra and returns the stored object', async () => {
    const { client, calls } = makeClient((m, a) => (m === 'Mailbox/get' && a.ids?.[0] === 'mb-new' ? { list: [{ id: 'mb-new', name: 'New', sortOrder: 3 }] } : defaultHandler(m, a)));
    const out: any = await tool('create_mailbox').run({ name: 'New', parentId: 'mb-1', sortOrder: 3, autoPurge: true, extra: { x: 1 } }, { client });
    assert.deepEqual(out, { id: 'mb-new', name: 'New', sortOrder: 3 });
    assert.deepEqual(calls[0][1], { accountId: ACCOUNT_ID, create: { new: { parentId: 'mb-1', name: 'New', sortOrder: 3, x: 1 } } });
    assert.deepEqual(calls[1], ['Mailbox/get', { accountId: ACCOUNT_ID, ids: ['mb-new'] }, 'c0']);
  });

  it('refuses a slash in the name', async () => {
    const { client, calls } = makeClient(defaultHandler);
    await rejects(tool('create_mailbox').run({ name: 'a/b' }, { client }), /must not contain/);
    assert.equal(calls.length, 0);
  });
});

describe('update_mailbox', () => {
  it('sends only the given fields and re-fetches', async () => {
    const { client, calls } = makeClient(defaultHandler);
    const out: any = await tool('update_mailbox').run({ mailboxId: 'mb-3', name: 'Renamed', parentId: null }, { client });
    assert.equal(out.id, 'mb-3');
    assert.deepEqual(calls[0], ['Mailbox/set', { accountId: ACCOUNT_ID, update: { 'mb-3': { name: 'Renamed', parentId: null } } }, 'c0']);
    assert.deepEqual(calls[1][1], { accountId: ACCOUNT_ID, ids: ['mb-3'] });
  });

  it('refuses with no field', async () => {
    const { client } = makeClient(defaultHandler);
    await rejects(tool('update_mailbox').run({ mailboxId: 'mb-3' }, { client }), /no field/);
  });

  it('refuses moving under itself or a descendant', async () => {
    const { client, calls } = makeClient(defaultHandler);
    await rejects(tool('update_mailbox').run({ mailboxId: 'mb-1', parentId: 'mb-2' }, { client }), /descendants/);
    await rejects(tool('update_mailbox').run({ mailboxId: 'mb-1', parentId: 'mb-1' }, { client }), /descendants/);
    assert.ok(calls.every(([m]) => m === 'Mailbox/get'));
  });
});

describe('delete_mailbox', () => {
  it('moves contents in batches then destroys', async () => {
    const tree = TREE.filter((m) => m.id !== 'mb-2');
    const { client, calls } = makeClient((m, a) => (m === 'Mailbox/get' ? { list: a.ids ? tree.filter((mb) => a.ids.includes(mb.id)) : tree } : defaultHandler(m, a)), 1);
    const out = await tool('delete_mailbox').run({ mailboxId: 'mb-1', moveContentsTo: 'Other', confirm: true }, { client });
    assert.deepEqual(out, { destroyed: 'mb-1', movedEmails: 2, name: 'Parent', path: 'Parent' });
    const q = calls.find(([m]) => m === 'Email/query')!;
    assert.deepEqual(q[1], { accountId: ACCOUNT_ID, filter: { inMailbox: 'mb-1' }, position: 0, limit: 500 });
    const sets = calls.filter(([m]) => m === 'Email/set').map(([, a]) => a.update);
    assert.deepEqual(sets, [
      { e1: { 'mailboxIds/mb-1': null, 'mailboxIds/mb-3': true } },
      { e2: { 'mailboxIds/mb-1': null, 'mailboxIds/mb-3': true } },
    ]);
    assert.deepEqual(calls.at(-1)?.[1], { accountId: ACCOUNT_ID, destroy: ['mb-1'], onDestroyRemoveEmails: false });
  });

  it('dryRun returns the plan and writes nothing', async () => {
    const { client, calls } = makeClient(defaultHandler);
    const out = await tool('delete_mailbox').run({ mailboxId: 'mb-3', dryRun: true, onDestroyRemoveEmails: true }, { client });
    assert.deepEqual(out, { dryRun: true, name: 'Other', path: 'Other', totalEmails: 0, totalThreads: 0, moveEmailsTo: null, destroyEmails: false });
    assert.ok(calls.every(([m]) => m === 'Mailbox/get'));
  });

  it('refuses a system folder', async () => {
    const { client } = makeClient(defaultHandler);
    await rejects(tool('delete_mailbox').run({ mailboxId: 'mb-inbox', confirm: true }, { client }), /system folder/);
  });

  it('refuses a folder with children', async () => {
    const { client } = makeClient(defaultHandler);
    await rejects(tool('delete_mailbox').run({ mailboxId: 'mb-1', confirm: true }, { client }), /has children/);
  });

  it('refuses a non-empty folder without moveContentsTo or onDestroyRemoveEmails', async () => {
    const tree = TREE.filter((m) => m.id !== 'mb-2');
    const { client } = makeClient((m, a) => (m === 'Mailbox/get' ? { list: tree } : defaultHandler(m, a)));
    await rejects(tool('delete_mailbox').run({ mailboxId: 'mb-1', confirm: true }, { client }), /holds 2 emails/);
  });

  it('refuses without confirm', async () => {
    const { client, calls } = makeClient(defaultHandler);
    await rejects(tool('delete_mailbox').run({ mailboxId: 'mb-3' }, { client }), /confirm: true/);
    assert.ok(calls.every(([m]) => m === 'Mailbox/get'));
  });
});

describe('merge_mailbox', () => {
  it('moves mail then destroys the source', async () => {
    const tree = TREE.filter((m) => m.id !== 'mb-2');
    const { client, calls } = makeClient((m, a) => (m === 'Mailbox/get' ? { list: tree } : defaultHandler(m, a)));
    const out = await tool('merge_mailbox').run({ source: 'mb-1', target: 'mb-3', confirm: true }, { client });
    assert.deepEqual(out, { destroyed: 'mb-1', movedEmails: 2, source: 'Parent', target: 'Other', totalEmails: 2, totalThreads: 2 });
    const set = calls.find(([m]) => m === 'Email/set')!;
    assert.deepEqual(set[1].update, {
      e1: { 'mailboxIds/mb-1': null, 'mailboxIds/mb-3': true },
      e2: { 'mailboxIds/mb-1': null, 'mailboxIds/mb-3': true },
    });
    assert.deepEqual(calls.at(-1)?.[1], { accountId: ACCOUNT_ID, destroy: ['mb-1'], onDestroyRemoveEmails: false });
  });

  it('dryRun returns the plan', async () => {
    const { client, calls } = makeClient(defaultHandler);
    const out = await tool('merge_mailbox').run({ source: 'mb-2', target: 'Other', dryRun: true }, { client });
    assert.deepEqual(out, { dryRun: true, source: 'Parent/Child', target: 'Other', totalEmails: 0, totalThreads: 0 });
    assert.ok(calls.every(([m]) => m === 'Mailbox/get'));
  });

  it('refuses a source with children, a role, or equal to target', async () => {
    const { client } = makeClient(defaultHandler);
    await rejects(tool('merge_mailbox').run({ source: 'mb-1', target: 'mb-3', confirm: true }, { client }), /has children/);
    await rejects(tool('merge_mailbox').run({ source: 'mb-inbox', target: 'mb-3', confirm: true }, { client }), /system folder/);
    await rejects(tool('merge_mailbox').run({ source: 'mb-3', target: 'mb-3', confirm: true }, { client }), /same mailbox/);
  });

  it('refuses without confirm', async () => {
    const { client } = makeClient(defaultHandler);
    await rejects(tool('merge_mailbox').run({ source: 'mb-2', target: 'mb-3' }, { client }), /confirm: true/);
  });

  it('get_mailbox_by_name falls back to the Inbox prefix', async () => {
    const { client } = makeClient(defaultHandler);
    let calls = 0;
    mock.method(client, 'getMailboxByName', async (path: string) => {
      calls++;
      if (path === 'Inbox/A/B') return { id: 'mb-b', name: 'B', parentId: 'mb-a', path };
      throw new Error(`Mailbox not found: ${path}`);
    });
    const out: any = await tool('get_mailbox_by_name').run({ path: 'A/B' }, { client });
    assert.equal(out.id, 'mb-b');
    assert.equal(calls, 2);
  });
});
