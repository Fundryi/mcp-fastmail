import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JmapClient } from '../jmap-client.js';
import { FastmailAuth } from '../auth.js';
import { RefusedError } from './core.js';
import { tools, buildSearchFilter, stripHtml } from './emails.js';

const ACCOUNT_ID = 'acct-1';
const byName = new Map(tools.map((t) => [t.def.name, t]));
const run = (name: string, args: any, client: JmapClient) => byName.get(name)!.run(args, { client });

function makeClient(): JmapClient {
  const client = new JmapClient(new FastmailAuth({ apiToken: 'fake-token' }));
  mock.method(client, 'getSession', async () => ({ apiUrl: 'https://api.example.com/jmap/api/', accountId: ACCOUNT_ID, capabilities: {} }));
  return client;
}

/** Answer each method call by name; records requests for assertions. */
function stub(client: JmapClient, answer: (method: string, args: any, tag: string) => any) {
  const requests: any[] = [];
  mock.method(client, 'makeRequest', async (req: any) => {
    requests.push(req);
    return { methodResponses: req.methodCalls.map(([m, a, tag]: any) => [m, answer(m, a, tag), tag]) };
  });
  return requests;
}

const TREE = [
  { id: 'mb-1', name: 'Inbox', parentId: null, unreadEmails: 2, totalEmails: 10 },
  { id: 'mb-2', name: 'Clients', parentId: 'mb-1', unreadEmails: 1, totalEmails: 5 },
  { id: 'mb-3', name: 'Acme', parentId: 'mb-2', unreadEmails: 0, totalEmails: 3 },
  { id: 'mb-9', name: 'Other', parentId: null, unreadEmails: 4, totalEmails: 4 },
];

describe('fork emails tools', () => {
  let client: JmapClient;
  beforeEach(() => { client = makeClient(); });

  it('list_emails sends query + get with #ids back-reference', async () => {
    const requests = stub(client, (m) => m === 'Email/query'
      ? { ids: ['e1'], total: 1, position: 0 }
      : { list: [{ id: 'e1', mailboxIds: { 'mb-1': true } }] });
    const r: any = await run('list_emails', { mailboxId: 'mb-1', limit: '5', position: 3, fields: ['id', 'mailboxIds'] }, client);
    const [q, g] = requests[0].methodCalls;
    assert.equal(q[0], 'Email/query');
    assert.deepEqual(q[1], { accountId: ACCOUNT_ID, filter: { inMailbox: 'mb-1' }, sort: [{ property: 'receivedAt', isAscending: false }], position: 3, limit: 5, calculateTotal: true });
    assert.equal(g[0], 'Email/get');
    assert.deepEqual(g[1]['#ids'], { resultOf: q[2], name: 'Email/query', path: '/ids' });
    assert.deepEqual(g[1].properties, ['id', 'mailboxIds']);
    assert.deepEqual(r, { total: 1, position: 0, items: [{ id: 'e1', mailboxIds: { 'mb-1': true } }] });
  });

  it('list_emails defaults include mailboxIds and cap limit at 500', async () => {
    const requests = stub(client, () => ({ ids: [], total: 0, list: [] }));
    await run('list_emails', { limit: 9999 }, client);
    const [q, g] = requests[0].methodCalls;
    assert.equal(q[1].limit, 500);
    assert.deepEqual(q[1].filter, {});
    assert.ok(g[1].properties.includes('mailboxIds'));
  });

  it('buildSearchFilter ANDs upstream filter with header, toDomain, cc/body/size', async () => {
    const f = await buildSearchFilter(client, {
      from: 'user@example.com', isUnread: true, mailboxId: 'mb-1',
      cc: 'cc@example.com', body: 'invoice', minSize: 100, maxSize: '5000',
      header: { name: 'List-Id', value: 'news' }, toDomain: '@example.com',
    });
    assert.deepEqual(f, {
      operator: 'AND',
      conditions: [
        { from: 'user@example.com', notKeyword: '$seen', inMailbox: 'mb-1' },
        { cc: 'cc@example.com', body: 'invoice', minSize: 100, maxSize: 5000, header: ['List-Id', 'news'] },
        { to: '@example.com' },
      ],
    });
  });

  it('buildSearchFilter: header without value, single condition unwrapped, empty is {}', async () => {
    assert.deepEqual(await buildSearchFilter(client, { header: { name: 'X-Spam' } }), { header: ['X-Spam'] });
    assert.deepEqual(await buildSearchFilter(client, {}), {});
    await assert.rejects(buildSearchFilter(client, { header: {} }), RefusedError);
  });

  it('buildSearchFilter includeChildren expands mailboxId to OR and excludeMailboxIds to descendants', async () => {
    const requests = stub(client, () => ({ list: TREE.map(({ id, parentId }) => ({ id, parentId })) }));
    const f = await buildSearchFilter(client, { mailboxId: 'mb-1', excludeMailboxIds: ['mb-2'], includeChildren: true, subject: 'x' });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].methodCalls[0][0], 'Mailbox/get');
    assert.deepEqual(requests[0].methodCalls[0][1].properties, ['id', 'parentId']);
    assert.deepEqual(f, {
      operator: 'AND',
      conditions: [
        { subject: 'x', inMailboxOtherThan: ['mb-2', 'mb-3'] },
        { operator: 'OR', conditions: [{ inMailbox: 'mb-1' }, { inMailbox: 'mb-2' }, { inMailbox: 'mb-3' }] },
      ],
    });
  });

  it('advanced_search keeps upstream args and passes the built filter', async () => {
    const requests = stub(client, (m) => m === 'Email/query' ? { ids: ['e1'], total: 7, position: 0 } : { list: [{ id: 'e1' }] });
    const r: any = await run('advanced_search', { query: 'hi', requiredMailboxIds: ['mb-1', 'mb-2'], isPinned: true, ascending: true, limit: 10 }, client);
    const [q] = requests[0].methodCalls;
    assert.deepEqual(q[1].filter, { operator: 'AND', conditions: [{ text: 'hi', hasKeyword: '$flagged' }, { inMailbox: 'mb-1' }, { inMailbox: 'mb-2' }] });
    assert.deepEqual(q[1].sort, [{ property: 'receivedAt', isAscending: true }]);
    assert.equal(q[1].limit, 10);
    assert.equal(r.total, 7);
  });

  it('summarize_mailbox pages and aggregates', async () => {
    const page = (position: number) => Array.from({ length: position === 0 ? 500 : 2 }, (_, i) => ({
      id: `e${position + i}`,
      from: [{ email: i % 2 ? 'A@example.com' : 'b@example.com' }],
      to: [{ email: 'Me@example.com' }],
      subject: i % 2 ? 'Re: Hello' : 'FWD: hello',
      keywords: i % 2 ? { $seen: true } : {},
      receivedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    let lastPos = 0;
    const requests = stub(client, (m, a) => {
      if (m === 'Email/query') { lastPos = a.position; return { ids: page(a.position).map((e) => e.id), total: 502, position: a.position }; }
      return { list: page(lastPos) };
    });
    const r: any = await run('summarize_mailbox', { mailboxId: 'mb-1' }, client);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].methodCalls[1][1].properties, ['from', 'to', 'receivedAt', 'keywords', 'subject']);
    assert.equal(requests[1].methodCalls[0][1].position, 500);
    assert.equal(r.total, 502);
    assert.equal(r.sampled, 502);
    assert.equal(r.unread, 251);
    assert.equal(r.unreadRatio, 0.5);
    assert.deepEqual(r.dateRange, { oldest: '2026-01-01T00:00:00Z', newest: '2026-01-28T00:00:00Z' });
    assert.deepEqual(r.byFrom, [{ address: 'b@example.com', count: 251 }, { address: 'a@example.com', count: 251 }]);
    assert.deepEqual(r.byTo, [{ address: 'me@example.com', count: 502 }]);
    assert.deepEqual(r.bySubject, [{ subject: 'hello', count: 502 }]);
  });

  it('summarize_mailbox honours maxEmails', async () => {
    const requests = stub(client, (m, a) => m === 'Email/query' ? { ids: ['e1'], total: 5000, position: a.position } : { list: [{ id: 'e1' }] });
    await run('summarize_mailbox', { maxEmails: 3 }, client);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].methodCalls[0][1].limit, 3);
  });

  it('list_unread_across walks the tree by path and batches unread queries', async () => {
    const requests = stub(client, (m, a, tag) => {
      if (m === 'Mailbox/get') return { list: TREE };
      if (m === 'Email/query') return { ids: [`u-${a.filter.inMailbox}`] };
      return { list: [{ id: `u-${tag}` }] };
    });
    const r: any = await run('list_unread_across', { path: 'Inbox/Clients', withEmails: true, perMailboxLimit: 3 }, client);
    assert.equal(r.totalUnread, 1);
    assert.deepEqual(r.mailboxes.map((m: any) => [m.id, m.path, m.unread, m.total]), [['mb-2', 'Inbox/Clients', 1, 5], ['mb-3', 'Inbox/Clients/Acme', 0, 3]]);
    assert.equal(requests.length, 2);
    const calls = requests[1].methodCalls;
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0][1].filter, { inMailbox: 'mb-2', notKeyword: '$seen' });
    assert.equal(calls[0][1].limit, 3);
    assert.deepEqual(calls[1][1]['#ids'], { resultOf: calls[0][2], name: 'Email/query', path: '/ids' });
    assert.deepEqual(calls[2][1].filter, { inMailbox: 'mb-3', notKeyword: '$seen' });
    assert.equal(r.mailboxes[0].emails.length, 1);
  });

  it('list_unread_across refuses without a target or with an unknown one', async () => {
    stub(client, () => ({ list: TREE }));
    await assert.rejects(run('list_unread_across', {}, client), /mailboxId or path/);
    await assert.rejects(run('list_unread_across', { path: 'Nope' }, client), /not found/);
    await assert.rejects(run('list_unread_across', { mailboxId: 'mb-404' }, client), /not found/);
    const r: any = await run('list_unread_across', { mailboxId: 'mb-1' }, client);
    assert.equal(r.totalUnread, 3);
    assert.equal(r.mailboxes[0].emails, undefined);
  });

  it('find_duplicates groups by messageId with subject/from/sentAt fallback', async () => {
    const list = [
      { id: 'a', messageId: ['<m1@example.com>'], mailboxIds: { 'mb-1': true }, receivedAt: '2026-01-01T00:00:00Z', size: 10 },
      { id: 'b', messageId: ['<m1@example.com>'], mailboxIds: { 'mb-2': true }, receivedAt: '2026-01-02T00:00:00Z', size: 10 },
      { id: 'c', messageId: ['<m2@example.com>'] },
      { id: 'd', subject: 'Re: Hi', from: [{ email: 'X@example.com' }], sentAt: '2026-01-03T00:00:00Z' },
      { id: 'e', subject: 'hi', from: [{ email: 'x@example.com' }], sentAt: '2026-01-03T00:00:00Z' },
    ];
    const requests = stub(client, (m) => m === 'Email/query' ? { ids: list.map((e) => e.id), total: 5 } : { list });
    const r: any = await run('find_duplicates', { from: 'x' }, client);
    assert.deepEqual(requests[0].methodCalls[1][1].properties, ['id', 'messageId', 'subject', 'from', 'sentAt', 'receivedAt', 'mailboxIds', 'size']);
    assert.deepEqual(r, [
      { key: '<m1@example.com>', count: 2, emails: [{ id: 'a', mailboxIds: { 'mb-1': true }, receivedAt: '2026-01-01T00:00:00Z', size: 10 }, { id: 'b', mailboxIds: { 'mb-2': true }, receivedAt: '2026-01-02T00:00:00Z', size: 10 }] },
      { key: 'hi|x@example.com|2026-01-03T00:00:00Z', count: 2, emails: [{ id: 'd', mailboxIds: undefined, receivedAt: undefined, size: undefined }, { id: 'e', mailboxIds: undefined, receivedAt: undefined, size: undefined }] },
    ]);
  });

  it('extract_codes fetches text bodies and skips years and phone numbers', async () => {
    const list = [
      { id: 'e1', subject: 'Your code', preview: 'Copyright 2026', from: [{ email: 'OTP@example.com' }], to: [{ email: 'me@example.com' }], receivedAt: '2026-09-12T10:00:00Z',
        textBody: [{ partId: '1', type: 'text/plain' }], bodyValues: { '1': { value: 'Call 12345678901 or use 482913 now' } } },
      { id: 'e2', subject: 'Nothing here', preview: 'in 2025', textBody: [], bodyValues: {} },
      { id: 'e3', subject: 'HTML only', textBody: [{ partId: '2', type: 'text/html' }], bodyValues: { '2': { value: '<p>Code: <b>7777</b></p>' } } },
    ];
    const requests = stub(client, (m) => m === 'Email/query' ? { ids: ['e1', 'e2', 'e3'] } : { list });
    const r: any = await run('extract_codes', { from: 'otp', after: '2026-09-12T08:00:00Z', limit: 5 }, client);
    const [q, g] = requests[0].methodCalls;
    assert.deepEqual(q[1].filter, { after: '2026-09-12T08:00:00Z', from: 'otp' });
    assert.equal(q[1].limit, 5);
    assert.equal(g[1].fetchTextBodyValues, true);
    assert.equal(g[1].maxBodyValueBytes, 8192);
    assert.deepEqual(g[1]['#ids'], { resultOf: q[2], name: 'Email/query', path: '/ids' });
    assert.deepEqual(r, [
      { code: '482913', emailId: 'e1', from: 'otp@example.com', to: ['me@example.com'], subject: 'Your code', receivedAt: '2026-09-12T10:00:00Z' },
      { code: '7777', emailId: 'e3', from: undefined, to: [], subject: 'HTML only', receivedAt: undefined },
    ]);
  });

  it('extract_codes defaults after to ~2h ago, uses custom pattern group, refuses bad regex', async () => {
    const requests = stub(client, (m) => m === 'Email/query' ? { ids: ['e1'] } : { list: [{ id: 'e1', subject: 'PIN: 2026', textBody: [], bodyValues: {} }] });
    const r: any = await run('extract_codes', { pattern: 'PIN: (\\d+)' }, client);
    assert.equal(r[0].code, '2026');
    const after = Date.parse(requests[0].methodCalls[0][1].filter.after);
    assert.ok(Math.abs(Date.now() - 2 * 3600 * 1000 - after) < 5000);
    await assert.rejects(run('extract_codes', { pattern: '(' }, client), RefusedError);
  });

  it('get_thread fetches bodies, strips HTML-only messages, drops drafts', async () => {
    const list = [
      { id: 'm1', subject: 'Hi', keywords: {}, textBody: [{ partId: '1', type: 'text/plain' }], bodyValues: { '1': { value: 'plain text', isTruncated: true } } },
      { id: 'm2', subject: 'Re: Hi', keywords: {}, textBody: [{ partId: '2', type: 'text/html' }], bodyValues: { '2': { value: '<html><style>p{}</style><script>x()</script><p>Hello   <b>world</b></p><p>bye &amp; thanks</p></html>' } } },
      { id: 'm3', subject: 'draft', keywords: { $draft: true }, textBody: [], bodyValues: {} },
    ];
    const requests = stub(client, (m) => m === 'Thread/get' ? { list: [{ id: 't1', emailIds: ['m1', 'm2', 'm3'] }], notFound: [] } : { list });
    const r: any = await run('get_thread', { threadId: 't1', maxBodyBytes: 100 }, client);
    const [t, e] = requests[0].methodCalls;
    assert.deepEqual(t[1], { accountId: ACCOUNT_ID, ids: ['t1'] });
    assert.deepEqual(e[1]['#ids'], { resultOf: t[2], name: 'Thread/get', path: '/list/*/emailIds' });
    assert.equal(e[1].fetchTextBodyValues, true);
    assert.equal(e[1].fetchHTMLBodyValues, false);
    assert.equal(e[1].maxBodyValueBytes, 100);
    assert.ok(e[1].properties.includes('textBody') && !e[1].properties.includes('htmlBody'));
    assert.equal(r.threadId, 't1');
    assert.deepEqual(r.messages.map((m: any) => [m.id, m.body, m.truncated]), [['m1', 'plain text', true], ['m2', 'Hello world\nbye & thanks', false]]);
    assert.equal('html' in r.messages[0], false);
  });

  it('get_thread format both returns html, includeDrafts keeps drafts, email id resolves to thread', async () => {
    let calls = 0;
    const requests = stub(client, (m, a) => {
      calls++;
      if (m === 'Thread/get') return a.ids[0] === 't1' ? { list: [{ id: 't1', emailIds: ['m3'] }], notFound: [] } : { list: [], notFound: a.ids };
      if (a.properties?.length === 1) return { list: [{ id: 'm3', threadId: 't1' }] };
      return { list: [{ id: 'm3', keywords: { $draft: true }, textBody: [{ partId: '1', type: 'text/plain' }], htmlBody: [{ partId: '2', type: 'text/html' }], bodyValues: { '1': { value: 'txt' }, '2': { value: '<p>html</p>' } } }] };
    });
    const r: any = await run('get_thread', { threadId: 'm3', includeDrafts: true, format: 'both' }, client);
    assert.equal(requests.length, 3);
    assert.equal(requests[1].methodCalls[0][0], 'Email/get');
    assert.deepEqual(requests[1].methodCalls[0][1].ids, ['m3']);
    assert.equal(requests[2].methodCalls[1][1].fetchHTMLBodyValues, true);
    assert.equal(r.threadId, 't1');
    assert.deepEqual(r.messages.map((m: any) => [m.id, m.body, m.html]), [['m3', 'txt', '<p>html</p>']]);
    assert.ok(calls > 0);
  });

  it('get_thread refuses an unknown thread', async () => {
    stub(client, (m) => m === 'Thread/get' ? { list: [], notFound: ['nope'] } : { list: [] });
    await assert.rejects(run('get_thread', { threadId: 'nope' }, client), /Thread not found/);
    await assert.rejects(run('get_thread', {}, client), /threadId is required/);
  });

  it('stripHtml removes scripts, styles, tags and collapses whitespace', () => {
    assert.equal(stripHtml('<div>a<br>b</div><script>evil()</script>  c &lt;d&gt;'), 'a\nb\nc <d>');
  });

  it('all tools are read-only', () => {
    assert.ok(tools.every((t) => t.write === false));
    assert.deepEqual([...byName.keys()], ['list_emails', 'advanced_search', 'summarize_mailbox', 'list_unread_across', 'find_duplicates', 'extract_codes', 'get_thread']);
  });
});
