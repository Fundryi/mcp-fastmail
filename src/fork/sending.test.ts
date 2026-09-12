import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JmapClient } from '../jmap-client.js';
import { FastmailAuth } from '../auth.js';
import { RefusedError } from './core.js';
import { forwardBody, pickIdentity, tools } from './sending.js';

const ACCOUNT_ID = 'acct-1';
const MAIN = { id: 'id-main', name: 'Me', email: 'me@example.com', mayDelete: false };
const ALIAS = { id: 'id-alias', name: 'Alias', email: 'alias@example.com', mayDelete: true };
const MAILBOXES = [
  { id: 'mb-drafts', name: 'Drafts', role: 'drafts' },
  { id: 'mb-sent', name: 'Sent', role: 'sent' },
  { id: 'mb-inbox', name: 'Inbox', role: 'inbox' },
  { id: 'mb-snoozed', name: 'Snoozed', role: 'snoozed' },
];
const FUTURE = new Date(Date.now() + 3600_000).toISOString();

const tool = (name: string) => tools.find((t) => t.def.name === name)!;

/** Client whose makeRequest answers by method name and records every call. */
function makeClient(opts: { mailboxes?: any[]; capabilities?: any; email?: any } = {}) {
  const client = new JmapClient(new FastmailAuth({ apiToken: 'fake-token' }));
  mock.method(client, 'getSession', async () => ({ apiUrl: 'https://api.example.com/jmap/', accountId: ACCOUNT_ID, capabilities: opts.capabilities ?? {} }));
  mock.method(client, 'getIdentities', async () => [MAIN, ALIAS]);
  mock.method(client, 'getMailboxes', async () => opts.mailboxes ?? MAILBOXES);
  const calls: [string, any][] = [];
  mock.method(client, 'makeRequest', async (req: any) => {
    const responses = req.methodCalls.map(([method, args, tag]: [string, any, string]) => {
      calls.push([method, args]);
      switch (method) {
        case 'Email/set':
          return [method, args.create ? { created: { draft: { id: 'em-new' } } } : { updated: { [Object.keys(args.update)[0]]: null } }, tag];
        case 'EmailSubmission/set':
          return [method, args.create ? { created: { sub: { id: 'sub-1', sendAt: FUTURE, undoStatus: 'pending' } } } : { updated: { [Object.keys(args.update)[0]]: null } }, tag];
        case 'EmailSubmission/query':
          return [method, { ids: ['sub-1'] }, tag];
        case 'EmailSubmission/get':
          return [method, { list: [{ id: 'sub-1', emailId: 'em-1', sendAt: FUTURE, undoStatus: 'pending' }] }, tag];
        case 'Email/get':
          return [method, { list: [opts.email ?? { id: 'em-1', subject: 'Hi', to: [{ email: 'you@example.com' }], mailboxIds: { 'mb-snoozed': true }, snoozed: null }] }, tag];
        default:
          return ['error', { type: 'unknownMethod' }, tag];
      }
    });
    return { methodResponses: responses, sessionState: 's' };
  });
  return { client, calls };
}

const find = (calls: [string, any][], method: string) => calls.find(([m]) => m === method)?.[1];

describe('pickIdentity', () => {
  it('explicit id wins', async () => {
    const { client } = makeClient();
    const id = await pickIdentity(client, { identityId: 'id-alias', fromEmail: 'me@example.com' });
    assert.equal(id.id, 'id-alias');
  });
  it('fromEmail matches case-insensitively', async () => {
    const { client } = makeClient();
    assert.equal((await pickIdentity(client, { fromEmail: 'ALIAS@example.com' })).id, 'id-alias');
  });
  it('unknown fromEmail is refused with the available list', async () => {
    const { client } = makeClient();
    await assert.rejects(pickIdentity(client, { fromEmail: 'nobody@example.com' }), (e: any) => e instanceof RefusedError && /alias@example.com/.test(e.message));
  });
  it('matchAddresses picks the alias the mail was sent to', async () => {
    const { client } = makeClient();
    assert.equal((await pickIdentity(client, { matchAddresses: ['other@example.com', 'alias@example.com'] })).id, 'id-alias');
  });
  it('falls back to the default identity', async () => {
    const { client } = makeClient();
    assert.equal((await pickIdentity(client, { matchAddresses: ['other@example.com'] })).id, 'id-main');
  });
});

describe('send_email', () => {
  it('creates a draft then submits with identity and moves drafts -> sent', async () => {
    const { client, calls } = makeClient();
    const out: any = await tool('send_email').run({ to: 'you@example.com', cc: ['cc@example.com'], subject: 'S', textBody: 'B', fromEmail: 'alias@example.com' }, { client });
    const draft = find(calls, 'Email/set');
    assert.equal(draft.create.draft.from[0].email, 'alias@example.com');
    assert.deepEqual(draft.create.draft.mailboxIds, { 'mb-drafts': true });
    const sub = find(calls, 'EmailSubmission/set');
    assert.equal(sub.accountId, ACCOUNT_ID);
    assert.deepEqual(sub.create.sub, {
      emailId: 'em-new',
      identityId: 'id-alias',
      envelope: { mailFrom: { email: 'alias@example.com' }, rcptTo: [{ email: 'you@example.com' }, { email: 'cc@example.com' }] },
    });
    assert.deepEqual(sub.onSuccessUpdateEmail, {
      '#sub': { 'keywords/$draft': null, 'keywords/$seen': true, 'mailboxIds/mb-drafts': null, 'mailboxIds/mb-sent': true },
    });
    assert.equal(out.submissionId, 'sub-1');
    assert.deepEqual(out.identity, { id: 'id-alias', email: 'alias@example.com', name: 'Alias' });
  });
  it('sendAt becomes holduntil on the envelope, never a create property', async () => {
    const { client, calls } = makeClient();
    const out: any = await tool('send_email').run({ to: ['you@example.com'], subject: 'S', textBody: 'B', sendAt: FUTURE }, { client });
    const sub = find(calls, 'EmailSubmission/set').create.sub;
    assert.equal(sub.sendAt, undefined);
    assert.equal(sub.envelope.mailFrom.parameters.holduntil, FUTURE);
    assert.equal(sub.identityId, 'id-main');
    assert.equal(out.sendAt, FUTURE);
  });
  it('refuses sendAt in the past and a plan without futurerelease', async () => {
    const { client } = makeClient();
    await assert.rejects(tool('send_email').run({ to: ['you@example.com'], subject: 'S', textBody: 'B', sendAt: '2000-01-01T00:00:00Z' }, { client }), RefusedError);
    const noPlan = makeClient({ capabilities: { 'urn:ietf:params:jmap:submission': { maxDelayedSend: 0, submissionExtensions: {} } } });
    await assert.rejects(tool('send_email').run({ to: ['you@example.com'], subject: 'S', textBody: 'B', sendAt: FUTURE }, { client: noPlan.client }), /Scheduled Send not available/);
  });
  it('refuses a missing body', async () => {
    const { client } = makeClient();
    await assert.rejects(tool('send_email').run({ to: ['you@example.com'], subject: 'S' }, { client }), RefusedError);
  });
});

const ORIGINAL = {
  id: 'em-1',
  subject: 'Hello',
  messageId: ['<orig@example.com>'],
  references: ['<root@example.com>'],
  from: [{ name: 'Them', email: 'them@example.com' }],
  to: [{ email: 'alias@example.com' }, { email: 'third@example.com' }],
  cc: [{ email: 'me@example.com' }],
  receivedAt: '2026-01-01T00:00:00Z',
  textBody: [{ partId: '1' }],
  bodyValues: { '1': { value: 'original text' } },
};

describe('reply_email', () => {
  it('threads, replies from the alias the mail was sent to, replyAll skips own identities', async () => {
    const { client, calls } = makeClient({ email: ORIGINAL });
    const out: any = await tool('reply_email').run({ originalEmailId: 'em-1', textBody: 'thanks', replyAll: true }, { client });
    const draft = find(calls, 'Email/set').create.draft;
    assert.equal(draft.subject, 'Re: Hello');
    assert.deepEqual(draft.inReplyTo, ['<orig@example.com>']);
    assert.deepEqual(draft.references, ['<root@example.com>', '<orig@example.com>']);
    assert.equal(draft.from[0].email, 'alias@example.com');
    assert.deepEqual(draft.to, [{ email: 'them@example.com' }]);
    assert.deepEqual(draft.cc, [{ email: 'third@example.com' }]);
    assert.equal(find(calls, 'EmailSubmission/set').create.sub.identityId, 'id-alias');
    assert.equal(out.submissionId, 'sub-1');
  });
  it('send=false saves a draft and skips submission', async () => {
    const { client, calls } = makeClient({ email: ORIGINAL });
    const out: any = await tool('reply_email').run({ originalEmailId: 'em-1', textBody: 'later', send: false }, { client });
    assert.equal(out.draft, true);
    assert.equal(find(calls, 'EmailSubmission/set'), undefined);
  });
  it('refuses an original without Message-ID', async () => {
    const { client } = makeClient({ email: { ...ORIGINAL, messageId: undefined } });
    await assert.rejects(tool('reply_email').run({ originalEmailId: 'em-1', textBody: 'x' }, { client }), RefusedError);
  });
});

describe('forward_email', () => {
  it('lays out the body and re-attaches by blob', async () => {
    const { client, calls } = makeClient({ email: ORIGINAL });
    mock.method(client, 'getEmailAttachments', async () => [{ blobId: 'blob-1', name: 'a.pdf', type: 'application/pdf' }]);
    await tool('forward_email').run({ emailId: 'em-1', to: ['you@example.com'], comment: 'FYI' }, { client });
    const draft = find(calls, 'Email/set').create.draft;
    assert.equal(draft.subject, 'Fwd: Hello');
    assert.equal(
      draft.bodyValues.text.value,
      'FYI\n\n---------- Forwarded message ----------\nFrom: Them <them@example.com>\nDate: 2026-01-01T00:00:00Z\nSubject: Hello\nTo: alias@example.com, third@example.com\nCc: me@example.com\n\noriginal text'
    );
    assert.deepEqual(draft.attachments, [{ blobId: 'blob-1', type: 'application/pdf', name: 'a.pdf', disposition: 'attachment' }]);
    assert.equal(find(calls, 'EmailSubmission/set').create.sub.emailId, 'em-new');
  });
  it('strips HTML when there is no text part and honours includeAttachments=false', async () => {
    const html = { ...ORIGINAL, textBody: [], htmlBody: [{ partId: '2' }], bodyValues: { '2': { value: '<p>Hi <b>there</b></p><p>bye</p>' } } };
    assert.match(forwardBody(html), /\n\nHi there\nbye$/);
    const { client, calls } = makeClient({ email: html });
    const getAtt = mock.method(client, 'getEmailAttachments', async () => [{ blobId: 'x' }]);
    await tool('forward_email').run({ emailId: 'em-1', to: 'you@example.com', includeAttachments: false }, { client });
    assert.equal(getAtt.mock.callCount(), 0);
    assert.equal(find(calls, 'Email/set').create.draft.attachments, undefined);
  });
});

describe('list_scheduled / cancel_send', () => {
  it('queries pending submissions and joins the email subject', async () => {
    const { client, calls } = makeClient();
    const out: any = await tool('list_scheduled').run({}, { client });
    assert.deepEqual(find(calls, 'EmailSubmission/query').filter, { undoStatus: 'pending' });
    assert.deepEqual(find(calls, 'EmailSubmission/get')['#ids'], { resultOf: 'q', name: 'EmailSubmission/query', path: '/ids' });
    assert.deepEqual(out, [{ id: 'sub-1', emailId: 'em-1', sendAt: FUTURE, undoStatus: 'pending', subject: 'Hi', to: ['you@example.com'] }]);
  });
  it('cancel_send updates undoStatus and returns the re-fetched submission', async () => {
    const { client, calls } = makeClient();
    const out: any = await tool('cancel_send').run({ submissionId: 'sub-1' }, { client });
    assert.deepEqual(find(calls, 'EmailSubmission/set').update, { 'sub-1': { undoStatus: 'canceled' } });
    assert.deepEqual(find(calls, 'EmailSubmission/get').ids, ['sub-1']);
    assert.equal(out.id, 'sub-1');
  });
});

describe('snooze_email / unsnooze_email', () => {
  it('snooze patches snoozed + mailboxIds in one update and re-fetches', async () => {
    const { client, calls } = makeClient();
    const out: any = await tool('snooze_email').run({ emailId: 'em-1', until: FUTURE }, { client });
    assert.deepEqual(find(calls, 'Email/set').update, {
      'em-1': { snoozed: { until: FUTURE, moveToMailboxId: 'mb-inbox' }, 'mailboxIds/mb-snoozed': true, 'mailboxIds/mb-inbox': null },
    });
    assert.deepEqual(find(calls, 'Email/get').properties, ['id', 'mailboxIds', 'snoozed']);
    assert.equal(out.id, 'em-1');
  });
  it('unsnooze nulls snoozed and moves back to inbox', async () => {
    const { client, calls } = makeClient();
    await tool('unsnooze_email').run({ emailId: 'em-1' }, { client });
    assert.deepEqual(find(calls, 'Email/set').update, { 'em-1': { snoozed: null, 'mailboxIds/mb-inbox': true, 'mailboxIds/mb-snoozed': null } });
  });
  it('refuses without a snoozed mailbox or with a past until', async () => {
    const noSnooze = makeClient({ mailboxes: MAILBOXES.filter((m) => m.role !== 'snoozed') });
    await assert.rejects(tool('snooze_email').run({ emailId: 'em-1', until: FUTURE }, { client: noSnooze.client }), /role "snoozed"/);
    const { client } = makeClient();
    await assert.rejects(tool('snooze_email').run({ emailId: 'em-1', until: '2000-01-01T00:00:00Z' }, { client }), /in the past/);
  });
});

describe('pickIdentity catch-all', () => {
  it('answers from the alias when only a *@domain identity covers it', async () => {
    const auth = new FastmailAuth({ apiToken: 'fake-token' });
    const client = new JmapClient(auth);
    mock.method(client, 'getIdentities', async () => [
      { id: 'i-main', email: 'me@example.com', mayDelete: false },
      { id: 'i-wild', email: '*@example.org' },
    ]);
    const r = await pickIdentity(client, { matchAddresses: ['shop@example.org'] });
    assert.deepEqual({ id: r.id, email: r.email }, { id: 'i-wild', email: 'shop@example.org' });
  });
});
