import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JmapClient } from '../jmap-client.js';
import { FastmailAuth } from '../auth.js';
import { RefusedError } from './core.js';
import { tools, parseQuery } from './search.js';

const ACCOUNT_ID = 'acct-1';
const NOW = new Date('2026-09-12T12:00:00Z');
const byName = new Map(tools.map((t) => [t.def.name, t]));
const run = (name: string, args: any, client: JmapClient) => byName.get(name)!.run(args, { client });

function makeClient(): JmapClient {
  const client = new JmapClient(new FastmailAuth({ apiToken: 'fake-token' }));
  mock.method(client, 'getSession', async () => ({ apiUrl: 'https://api.example.com/jmap/api/', accountId: ACCOUNT_ID, capabilities: {}, primaryAccounts: { 'urn:ietf:params:jmap:contacts': 'acct-c' } }));
  return client;
}

function stub(client: JmapClient, answer: (method: string, args: any, tag: string) => any) {
  const requests: any[] = [];
  mock.method(client, 'makeRequest', async (req: any) => {
    requests.push(req);
    return { methodResponses: req.methodCalls.map(([m, a, tag]: any) => [m, answer(m, a, tag), tag]) };
  });
  return requests;
}

describe('parseQuery', () => {
  it('address and text operators, quoted values, free words', () => {
    const p = parseQuery('from:user@example.com to:"Jane Doe" subject:"steam guard" body:code cc:x bcc:y hello world');
    assert.deepEqual(p.args, { from: 'user@example.com', to: 'Jane Doe', subject: 'steam guard', body: 'code', cc: 'x', bcc: 'y', query: 'hello world' });
    assert.equal(p.in, undefined);
    assert.deepEqual(p.notIn, []);
  });

  it('flags: has:attachment, is:unread/read/flagged/starred/unflagged, case-insensitive', () => {
    assert.deepEqual(parseQuery('HAS:Attachment IS:Unread').args, { hasAttachment: true, isUnread: true });
    assert.deepEqual(parseQuery('is:read is:starred').args, { isUnread: false, isPinned: true });
    assert.deepEqual(parseQuery('is:flagged').args, { isPinned: true });
    assert.deepEqual(parseQuery('is:unflagged').args, { isPinned: false });
  });

  it('in: and -in: stay unresolved for the tool', () => {
    const p = parseQuery('in:"Clients/Acme" -in:trash -in:spam');
    assert.equal(p.in, 'Clients/Acme');
    assert.deepEqual(p.notIn, ['trash', 'spam']);
    assert.deepEqual(p.args, {});
    assert.throws(() => parseQuery('in:inbox in:sent'), RefusedError);
  });

  it('after/before become UTC midnight', () => {
    assert.deepEqual(parseQuery('after:2026-01-01 before:2026-02-01').args, { after: '2026-01-01T00:00:00Z', before: '2026-02-01T00:00:00Z' });
    assert.throws(() => parseQuery('after:01/01/2026'), RefusedError);
  });

  it('newer_than/older_than do the date maths from now', () => {
    assert.equal(parseQuery('newer_than:7d', NOW).args.after, '2026-09-05T12:00:00Z');
    assert.equal(parseQuery('older_than:2w', NOW).args.before, '2026-08-29T12:00:00Z');
    assert.equal(parseQuery('newer_than:1m', NOW).args.after, '2026-08-13T12:00:00Z');
    assert.equal(parseQuery('older_than:1y', NOW).args.before, '2025-09-12T12:00:00Z');
    assert.throws(() => parseQuery('newer_than:7'), RefusedError);
  });

  it('larger/smaller map to bytes', () => {
    assert.deepEqual(parseQuery('larger:10M smaller:500k').args, { minSize: 10 * 1024 * 1024, maxSize: 500 * 1024 });
    assert.deepEqual(parseQuery('larger:1000').args, { minSize: 1000 });
    assert.throws(() => parseQuery('larger:big'), RefusedError);
  });

  it('header and domain', () => {
    assert.deepEqual(parseQuery('header:List-Id=foo header:X-Spam').args, { header: { name: 'X-Spam' } });
    assert.deepEqual(parseQuery('header:List-Id=foo').args, { header: { name: 'List-Id', value: 'foo' } });
    assert.deepEqual(parseQuery('domain:example.com').args, { toDomain: 'example.com' });
  });

  it('refuses an unknown operator, accepts it quoted', () => {
    assert.throws(() => parseQuery('https://example.com'), (e: any) => e instanceof RefusedError && /Unknown operator "https:"/.test(e.message) && /from, to, cc/.test(e.message));
    assert.throws(() => parseQuery('frmo:x'), RefusedError);
    assert.deepEqual(parseQuery('"https://example.com"').args, { query: 'https://example.com' });
  });
});

describe('search tools', () => {
  let client: JmapClient;
  beforeEach(() => { client = makeClient(); mock.timers.enable({ apis: ['Date'], now: NOW }); });
  afterEach(() => { mock.timers.reset(); });

  it('search_emails builds the JMAP filter end to end', async () => {
    const requests = stub(client, (m, a) => {
      if (m === 'Mailbox/get') return { list: [{ id: 'mb-1', name: 'Inbox', role: 'inbox', parentId: null }, { id: 'mb-2', name: 'Sent', role: 'sent', parentId: null }] };
      if (m === 'Email/query') return { ids: ['e1'], total: 1, position: 0 };
      return { list: [{ id: 'e1' }] };
    });
    const r: any = await run('search_emails', { query: 'from:steampowered.com in:inbox is:unread newer_than:7d', limit: '5', excludeDrafts: true }, client);
    const q = requests.flatMap((r) => r.methodCalls).find(([m]: any) => m === 'Email/query')!;
    assert.deepEqual(q[1].filter, {
      operator: 'AND',
      conditions: [
        { from: 'steampowered.com', after: '2026-09-05T12:00:00Z', notKeyword: '$seen' },
        { inMailbox: 'mb-1' },
        { notKeyword: '$draft' },
      ],
    });
    assert.equal(q[1].limit, 5);
    assert.deepEqual(q[1].sort, [{ property: 'receivedAt', isAscending: false }]);
    assert.deepEqual(r.items, [{ id: 'e1' }]);
    assert.equal(r.total, 1);
    assert.deepEqual(r.parsed, { from: 'steampowered.com', isUnread: true, after: '2026-09-05T12:00:00Z', includeChildren: true, mailboxId: 'mb-1' });
  });

  it('search_emails resolves -in: paths via byPath and refuses a missing role', async () => {
    mock.method(client, 'getMailboxByName', async (p: string) => { if (p === 'Clients/Acme') return { id: 'mb-3', name: 'Acme', parentId: null, path: p }; throw new Error('nope'); });
    stub(client, (m) => m === 'Mailbox/get' ? { list: [{ id: 'mb-1', role: 'inbox', parentId: null }] } : m === 'Email/query' ? { ids: [], total: 0, position: 0 } : { list: [] });
    const r: any = await run('search_emails', { query: 'x -in:Clients/Acme', includeChildren: false }, client);
    assert.deepEqual(r.parsed.excludeMailboxIds, ['mb-3']);
    await assert.rejects(run('search_emails', { query: 'in:trash' }, client), (e: any) => e instanceof RefusedError && /role "trash"/.test(e.message));
  });

  it('list_address_books calls AddressBook/get under the contacts capability', async () => {
    const requests = stub(client, () => ({ list: [{ id: 'ab-1', name: 'Personal', isDefault: true, isSubscribed: true, extra: 1 }] }));
    const r: any = await run('list_address_books', {}, client);
    const [m, a] = requests[0].methodCalls[0];
    assert.equal(m, 'AddressBook/get');
    assert.deepEqual(a, { accountId: 'acct-c', ids: null });
    assert.ok(requests[0].using.includes('urn:ietf:params:jmap:contacts'));
    assert.deepEqual(r, [{ id: 'ab-1', name: 'Personal', description: undefined, isSubscribed: true, isDefault: true, shareWith: undefined, myRights: undefined }]);
  });
});
