import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { JmapClient } from '../jmap-client.js';
import { FastmailAuth } from '../auth.js';
import { RefusedError, JmapError } from './core.js';
import { tools, parseListUnsubscribe } from './ops.js';

const ACCOUNT_ID = 'acct-1';
const byName = Object.fromEntries(tools.map((t) => [t.def.name, t]));

type Handler = (method: string, args: any, tag: string) => any;

/** Client whose makeRequest answers each method call through `handler` and records every call. */
function makeClient(handler: Handler) {
  const client = new JmapClient(new FastmailAuth({ apiToken: 'fake-token' }));
  const calls: [string, any, string][] = [];
  mock.method(client, 'getSession', async () => ({
    apiUrl: 'https://api.example.com/jmap/api/',
    accountId: ACCOUNT_ID,
    capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInSet: 2 } },
  }));
  mock.method(client, 'makeRequest', async (req: any) => {
    const methodResponses = req.methodCalls.map(([method, args, tag]: [string, any, string]) => {
      calls.push([method, args, tag]);
      const r = handler(method, args, tag);
      return r?.__error ? ['error', r.__error, tag] : [method, r, tag];
    });
    return { methodResponses };
  });
  return { client, calls };
}

const run = (name: string, args: any, client: JmapClient) => byName[name].run(args, { client });

describe('unsubscribe', () => {
  afterEach(() => mock.restoreAll());

  const email = (headers: Record<string, string | null>) => ({
    list: [{ id: 'e1', from: [{ email: 'user@example.com' }], subject: 'News', ...headers }],
  });

  it('parses the header', () => {
    assert.deepEqual(parseListUnsubscribe('<mailto:u@example.com>, <https://example.com/u?x=1>'), {
      https: ['https://example.com/u?x=1'], mailto: ['u@example.com'],
    });
    assert.deepEqual(parseListUnsubscribe('<http://example.com/u>'), { https: [], mailto: [] });
  });

  it('inspects without confirm and asks for the right headers', async () => {
    const { client, calls } = makeClient(() => email({
      'header:List-Unsubscribe:asText': '<https://example.com/u>, <mailto:u@example.com>',
      'header:List-Unsubscribe-Post:asText': 'List-Unsubscribe=One-Click',
    }));
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(''));
    const r: any = await run('unsubscribe', { emailId: 'e1' }, client);
    assert.equal(calls[0][0], 'Email/get');
    assert.deepEqual(calls[0][1].ids, ['e1']);
    assert.ok(calls[0][1].properties.includes('header:List-Unsubscribe:asText'));
    assert.ok(calls[0][1].properties.includes('header:List-Unsubscribe-Post:asText'));
    assert.equal(r.action, 'none');
    assert.equal(r.oneClick, true);
    assert.deepEqual(r.https, ['https://example.com/u']);
    assert.deepEqual(r.mailto, ['u@example.com']);
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it('POSTs one-click with confirm', async () => {
    const { client } = makeClient(() => email({
      'header:List-Unsubscribe:asText': '<https://example.com/u>',
      'header:List-Unsubscribe-Post:asText': 'List-Unsubscribe=One-Click',
    }));
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('', { status: 202 }));
    const r: any = await run('unsubscribe', { emailId: 'e1', confirm: true }, client);
    assert.deepEqual(r, { ...r, action: 'posted', url: 'https://example.com/u', status: 202 });
    const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(url, 'https://example.com/u');
    assert.equal(init.method, 'POST');
    assert.equal(init.body, 'List-Unsubscribe=One-Click');
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.ok(init.signal instanceof AbortSignal);
  });

  it('refuses mailto-only and names the address', async () => {
    const { client } = makeClient(() => email({ 'header:List-Unsubscribe:asText': '<mailto:u@example.com>', 'header:List-Unsubscribe-Post:asText': null }));
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(''));
    await assert.rejects(run('unsubscribe', { emailId: 'e1', confirm: true }, client), (e: any) => e instanceof RefusedError && /u@example\.com/.test(e.message));
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it('refuses non-https and non-one-click links', async () => {
    const { client } = makeClient(() => email({ 'header:List-Unsubscribe:asText': '<http://example.com/u>', 'header:List-Unsubscribe-Post:asText': 'List-Unsubscribe=One-Click' }));
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(''));
    await assert.rejects(run('unsubscribe', { emailId: 'e1', confirm: true }, client), RefusedError);
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it('refuses when the header is missing', async () => {
    const { client } = makeClient(() => email({ 'header:List-Unsubscribe:asText': null, 'header:List-Unsubscribe-Post:asText': null }));
    await assert.rejects(run('unsubscribe', { emailId: 'e1' }, client), RefusedError);
  });
});

describe('report_spam / report_not_spam', () => {
  const handler: Handler = (method, args) => {
    if (method === 'Mailbox/get') return { list: [{ id: 'mb-inbox', role: 'inbox' }, { id: 'mb-junk', role: 'junk' }, { id: 'mb-1', role: null }] };
    if (method === 'Email/get') return { list: [{ id: 'e1', mailboxIds: { 'mb-inbox': true, 'mb-1': true } }, { id: 'e2', mailboxIds: { 'mb-junk': true } }] };
    if (method === 'Email/set') return { updated: Object.fromEntries(Object.keys(args.update).map((k) => [k, null])), notUpdated: {} };
    throw new Error(method);
  };

  it('moves to junk, dropping every other folder', async () => {
    const { client, calls } = makeClient(handler);
    const r: any = await run('report_spam', { emailIds: ['e1', 'e2', 'e3'] }, client);
    assert.deepEqual(calls.map((c) => c[0]), ['Mailbox/get', 'Email/get', 'Email/set']);
    assert.deepEqual(calls[1][1].ids, ['e1', 'e2', 'e3']);
    assert.deepEqual(calls[2][1].update, {
      e1: { 'mailboxIds/mb-inbox': null, 'mailboxIds/mb-1': null, 'mailboxIds/mb-junk': true },
      e2: { 'mailboxIds/mb-junk': true },
    });
    assert.deepEqual(r.updated, ['e1', 'e2']);
    assert.deepEqual(r.notUpdated, { e3: { type: 'notFound' } });
  });

  it('report_not_spam targets the inbox', async () => {
    const { client, calls } = makeClient(handler);
    const r: any = await run('report_not_spam', { emailIds: ['e2'] }, client);
    assert.deepEqual(calls[2][1].update, { e2: { 'mailboxIds/mb-junk': null, 'mailboxIds/mb-inbox': true } });
    assert.equal(r.mailboxId, 'mb-inbox');
  });

  it('refuses an empty list', async () => {
    const { client } = makeClient(handler);
    await assert.rejects(run('report_spam', { emailIds: [] }, client), RefusedError);
  });
});

describe('import_email', () => {
  afterEach(() => mock.restoreAll());

  it('uploads the file and imports it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-'));
    const file = join(dir, 'm.eml');
    await writeFile(file, 'Subject: hi\r\n\r\nbody');
    try {
      const { client, calls } = makeClient((method, args) => {
        if (method === 'Email/import') return { created: { i1: { id: 'e9', blobId: args.emails.i1.blobId, threadId: 't9', size: 20 } } };
        throw new Error(method);
      });
      const upload = mock.method(client, 'uploadBlob', async (buf: Buffer, type: string) => ({ blobId: 'b1', type, size: buf.length }));
      const r: any = await run('import_email', { localPath: 'm.eml', mailboxId: 'mb-1', downloadDir: dir, receivedAt: '2026-01-01T00:00:00Z' }, client);
      assert.equal(upload.mock.calls[0].arguments[1], 'message/rfc822');
      assert.equal(calls[0][0], 'Email/import');
      assert.deepEqual(calls[0][1].emails, { i1: { blobId: 'b1', mailboxIds: { 'mb-1': true }, keywords: { $seen: true }, receivedAt: '2026-01-01T00:00:00Z' } });
      assert.deepEqual(r, { id: 'e9', blobId: 'b1', threadId: 't9', size: 20 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses without a target mailbox', async () => {
    const { client } = makeClient(() => ({}));
    await assert.rejects(run('import_email', { localPath: 'm.eml' }, client), RefusedError);
  });

  it('refuses a path outside the download directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-'));
    try {
      const { client } = makeClient(() => ({}));
      await assert.rejects(run('import_email', { localPath: '../escape.eml', mailboxId: 'mb-1', downloadDir: dir }, client));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('empty_mailbox', () => {
  const ids = ['a', 'b', 'c'];
  const handler: Handler = (method, args) => {
    if (method === 'Mailbox/get') return { list: [{ id: 'mb-trash', role: 'trash' }, { id: 'mb-junk', role: 'junk' }] };
    if (method === 'Email/query') return { ids: ids.slice(args.position ?? 0, (args.position ?? 0) + args.limit), total: ids.length };
    if (method === 'Email/get') {
      const wanted: string[] = args.ids ?? ids;
      return { list: wanted.map((id) => ({ id, subject: 's', receivedAt: 'r', mailboxIds: id === 'd' ? { 'mb-trash': true, 'mb-1': true } : { 'mb-trash': true } })) };
    }
    if (method === 'Email/set') return { destroyed: args.destroy, notDestroyed: {} };
    throw new Error(method);
  };

  it('skips mail that also sits in another folder', async () => {
    const both: Handler = (method, args) => {
      if (method === 'Email/query') return { ids: ['a', 'd'].slice(args.position ?? 0), total: 2 };
      return handler(method, args);
    };
    const { client, calls } = makeClient(both);
    const r: any = await run('empty_mailbox', { role: 'trash', confirm: true }, client);
    assert.deepEqual(calls.filter((c) => c[0] === 'Email/set').map((c) => c[1].destroy), [['a']]);
    assert.deepEqual(r.skippedInOtherFolders, ['d']);
  });

  it('destroys in maxObjectsInSet batches', async () => {
    const { client, calls } = makeClient(handler);
    const r: any = await run('empty_mailbox', { role: 'trash', confirm: true, olderThan: '2026-01-01T00:00:00Z' }, client);
    const q = calls.find((c) => c[0] === 'Email/query')!;
    assert.deepEqual(q[1].filter, { inMailbox: 'mb-trash', before: '2026-01-01T00:00:00Z' });
    assert.equal(q[1].calculateTotal, true);
    const sets = calls.filter((c) => c[0] === 'Email/set').map((c) => c[1].destroy);
    assert.deepEqual(sets, [['a', 'b'], ['c']]);
    assert.deepEqual(r, { mailboxId: 'mb-trash', destroyed: ['a', 'b', 'c'], notDestroyed: {}, skippedInOtherFolders: [], total: 3 });
  });

  it('dryRun counts and samples without Email/set', async () => {
    const { client, calls } = makeClient(handler);
    const r: any = await run('empty_mailbox', { role: 'junk', confirm: true, dryRun: true }, client);
    assert.ok(!calls.some((c) => c[0] === 'Email/set'));
    assert.equal(calls.find((c) => c[0] === 'Email/query')![1].limit, 20);
    assert.equal(r.total, 3);
    assert.equal(r.sample.length, 3);
  });

  it('refuses without confirm', async () => {
    const { client, calls } = makeClient(handler);
    await assert.rejects(run('empty_mailbox', { role: 'trash' }, client), RefusedError);
    assert.ok(!calls.some((c) => c[0] === 'Email/set'));
  });

  it('refuses any role but trash/junk', async () => {
    const { client, calls } = makeClient(handler);
    await assert.rejects(run('empty_mailbox', { role: 'inbox', confirm: true }, client), RefusedError);
    assert.equal(calls.length, 0);
  });
});

describe('get_changes', () => {
  it('returns current states without sinceState', async () => {
    const { client, calls } = makeClient((method) => ({ state: method === 'Mailbox/get' ? 'm1' : 'e1', list: [] }));
    const r = await run('get_changes', {}, client);
    assert.deepEqual(calls.map((c) => [c[0], c[1].ids]), [['Mailbox/get', []], ['Email/get', []]]);
    assert.deepEqual(r, { mailbox: { state: 'm1' }, email: { state: 'e1' } });
  });

  it('fetches changes and the created emails', async () => {
    const { client, calls } = makeClient((method) => {
      if (method === 'Mailbox/changes') return { oldState: 'm1', newState: 'm2', hasMoreChanges: false, created: [], updated: ['mb-1'], destroyed: [] };
      if (method === 'Email/changes') return { oldState: 'e1', newState: 'e2', hasMoreChanges: true, created: ['x'], updated: [], destroyed: ['y'] };
      if (method === 'Mailbox/get') return { list: [{ id: 'mb-1', name: 'Inbox', unreadEmails: 1, totalEmails: 2 }] };
      if (method === 'Email/get') return { list: [{ id: 'x', subject: 'new' }] };
      throw new Error(method);
    });
    const r: any = await run('get_changes', { sinceState: { mailbox: 'm1', email: 'e1' } }, client);
    assert.deepEqual(calls.map((c) => c[0]), ['Mailbox/changes', 'Mailbox/get', 'Mailbox/get', 'Email/changes', 'Email/get']);
    assert.deepEqual(calls[0][1], { accountId: ACCOUNT_ID, sinceState: 'm1', maxChanges: 500 });
    assert.deepEqual(calls[4][1]['#ids'], { resultOf: 'emc', name: 'Email/changes', path: '/created' });
    assert.equal(r.email.hasMoreChanges, true);
    assert.deepEqual(r.email.destroyed, ['y']);
    assert.deepEqual(r.email.createdEmails, [{ id: 'x', subject: 'new' }]);
    assert.equal(r.mailbox.newState, 'm2');
  });

  it('rethrows cannotCalculateChanges with a resync hint', async () => {
    const { client } = makeClient(() => ({ __error: { type: 'cannotCalculateChanges' } }));
    await assert.rejects(run('get_changes', { sinceState: { email: 'old' } }, client), (e: any) => e instanceof JmapError && e.type === 'cannotCalculateChanges' && /without sinceState/.test(e.message));
  });
});

describe('list_attachments', () => {
  const handler: Handler = (method) => {
    if (method === 'Email/query') return { ids: ['e1'] };
    if (method === 'Email/get') return {
      list: [{
        id: 'e1', subject: 'Invoice', from: [{ email: 'user@example.com' }], receivedAt: '2026-01-01T00:00:00Z',
        attachments: [
          { partId: '2', blobId: 'b2', name: 'invoice.pdf', type: 'application/pdf', size: 1000, disposition: 'attachment' },
          { partId: '3', blobId: 'b3', name: 'logo.png', type: 'image/png', size: 50, disposition: 'inline' },
          { partId: '4', blobId: 'b4', name: 'photo.jpg', type: 'image/jpeg', size: 5000, disposition: 'attachment' },
        ],
      }],
    };
    throw new Error(method);
  };

  it('queries with hasAttachment and flattens, skipping inline', async () => {
    const { client, calls } = makeClient(handler);
    const r: any = await run('list_attachments', { mailboxId: 'mb-1', filter: { from: 'user@example.com' } }, client);
    assert.deepEqual(calls[0][1].filter, { from: 'user@example.com', hasAttachment: true, inMailbox: 'mb-1' });
    assert.equal(calls[0][1].limit, 100);
    assert.ok(calls[1][1].properties.includes('attachments'));
    assert.deepEqual(r.attachments.map((a: any) => a.attachmentId), ['2', '4']);
    assert.equal(r.attachments[0].emailId, 'e1');
    assert.equal(r.attachments[0].name, 'invoice.pdf');
  });

  it('filters by type, size, name and includeInline', async () => {
    const { client } = makeClient(handler);
    const img: any = await run('list_attachments', { type: 'image/', includeInline: true }, client);
    assert.deepEqual(img.attachments.map((a: any) => a.attachmentId), ['3', '4']);
    const big: any = await run('list_attachments', { minSize: 2000 }, client);
    assert.deepEqual(big.attachments.map((a: any) => a.attachmentId), ['4']);
    const named: any = await run('list_attachments', { nameContains: 'INVOICE', maxSize: 1000 }, client);
    assert.deepEqual(named.attachments.map((a: any) => a.attachmentId), ['2']);
  });
});
