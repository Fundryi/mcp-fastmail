// Sending tools: send / reply / forward with identity choice and scheduling,
// list and cancel pending submissions, snooze and unsnooze. Overrides
// upstream `send_email` and `reply_email` (every upstream arg kept).
import type { JmapClient } from '../jmap-client.js';
import { coerceBool, coerceStringArray } from '../coerce.js';
import { ForkTool, RefusedError, assertSet, jmap, jmapBatch, requireString } from './core.js';

const SEND = ['mail', 'submission'];
const UNCONFIRMED = 'Scheduling relies on the submission capability being visible in the session; when it is not, the send is attempted and the server decides.';

function downloadDir(): string | undefined {
  for (const k of ['FASTMAIL_DOWNLOAD_DIR', 'USER_CONFIG_FASTMAIL_DOWNLOAD_DIR', 'USER_CONFIG_fastmail_download_dir', 'fastmail_download_dir']) {
    const v = process.env[k];
    if (v && v.trim() && !/\$\{[^}]+\}/.test(v)) return v.trim();
  }
  return undefined;
}

function matches(identityEmail: string, address: string): boolean {
  const id = identityEmail.toLowerCase();
  const addr = address.toLowerCase();
  if (id === addr) return true;
  return id.startsWith('*@') && /^[^\s@,;"]+@[^\s@,;"]+$/.test(addr) && addr.endsWith(id.slice(1));
}

/**
 * Pick the sending identity. Explicit id wins, then `fromEmail`, then the
 * first identity that appears in `matchAddresses` (reply-as-alias), then the
 * account default. Returns `{ id, email }` where email is the address to put
 * in From (the caller's address when the identity is a `*@domain` wildcard).
 */
export async function pickIdentity(
  client: JmapClient,
  opts: { identityId?: string; fromEmail?: string; matchAddresses?: string[] }
): Promise<{ id: string; email: string; name?: string }> {
  const identities = await client.getIdentities();
  if (!identities?.length) throw new RefusedError('No sending identities on this account');
  const available = identities.map((i: any) => i.email);
  let picked: any;
  let matched: string | undefined;
  if (opts.identityId) {
    picked = identities.find((i: any) => i.id === opts.identityId);
    if (!picked) throw new RefusedError(`Unknown identityId "${opts.identityId}"`, { available: identities.map((i: any) => ({ id: i.id, email: i.email })) });
  } else if (opts.fromEmail) {
    picked = identities.find((i: any) => matches(i.email, opts.fromEmail!));
    if (!picked) throw new RefusedError(`No sending identity matches "${opts.fromEmail}". Available: ${available.join(', ')}`, { available });
  } else if (opts.matchAddresses?.length) {
    // Address order matters: To before Cc, so the identity the mail was addressed to wins.
    // Exact identity first, then a `*@domain` catch-all identity for that address.
    for (const addr of opts.matchAddresses) {
      picked = identities.find((i: any) => String(i.email).toLowerCase() === addr.toLowerCase())
        ?? identities.find((i: any) => matches(String(i.email), addr));
      if (picked) { matched = addr; break; }
    }
  }
  picked ??= await client.getDefaultIdentity();
  const wanted = opts.fromEmail ?? matched;
  const email = wanted && String(picked.email).startsWith('*@') ? wanted : picked.email;
  return { id: picked.id, email, name: picked.name };
}

function identityArgs(args: Record<string, any>) {
  return { identityId: args.identityId, fromEmail: args.fromEmail ?? args.from };
}

function sendAtOf(args: Record<string, any>): string | undefined {
  if (args.sendAt == null || args.sendAt === '') return undefined;
  const d = new Date(args.sendAt);
  if (isNaN(d.getTime())) throw new RefusedError(`sendAt "${args.sendAt}" is not an ISO 8601 date`);
  if (d.getTime() < Date.now()) throw new RefusedError(`sendAt "${args.sendAt}" is in the past`);
  return d.toISOString();
}

/** Refuse scheduling when the session says the account cannot hold mail. Silent when the session does not say. */
async function assertCanSchedule(client: JmapClient): Promise<void> {
  const cap = (await client.getSession()).capabilities?.['urn:ietf:params:jmap:submission'];
  if (!cap) return; // account-level capability is not exposed by the session cache; attempt and let the server decide
  const ext = cap.submissionExtensions ?? {};
  const hasFuture = Object.keys(ext).some((k) => k.toLowerCase() === 'futurerelease');
  if (!cap.maxDelayedSend || !hasFuture) throw new RefusedError('Scheduled Send not available on this plan', { maxDelayedSend: cap.maxDelayedSend ?? 0, submissionExtensions: ext });
}

/**
 * Submit an already-created draft. On success the email loses $draft, gains
 * $seen, leaves `fromMailboxId` and lands in Sent. A `sendAt` becomes SMTP
 * FUTURERELEASE (`holduntil`) on the envelope; the server itself parks the
 * held copy in its Scheduled folder and reports `sendAt` back on the submission.
 */
async function submit(
  client: JmapClient,
  emailId: string,
  identity: { id: string; email: string },
  rcpt: string[],
  fromMailboxId: string,
  sendAt?: string
) {
  if (sendAt) await assertCanSchedule(client);
  const sent = (await client.getMailboxes()).find((m: any) => m.role === 'sent');
  if (!sent) throw new RefusedError('No mailbox with role "sent" on this account');
  const result = await jmap(client, SEND, 'EmailSubmission/set', {
    create: {
      sub: {
        emailId,
        identityId: identity.id,
        envelope: {
          mailFrom: { email: identity.email, ...(sendAt && { parameters: { holduntil: sendAt } }) },
          rcptTo: rcpt.map((email) => ({ email })),
        },
      },
    },
    onSuccessUpdateEmail: {
      '#sub': {
        'keywords/$draft': null,
        'keywords/$seen': true,
        [`mailboxIds/${fromMailboxId}`]: null,
        [`mailboxIds/${sent.id}`]: true,
      },
    },
  });
  const echo = assertSet(result, 'created', 'sub') ?? {};
  return { emailId, submissionId: echo.id, identity, sendAt: echo.sendAt ?? sendAt ?? null, undoStatus: echo.undoStatus };
}

async function draftsId(client: JmapClient): Promise<string> {
  const mb = (await client.getMailboxes()).find((m: any) => m.role === 'drafts');
  if (!mb) throw new RefusedError('No mailbox with role "drafts" on this account');
  return mb.id;
}

const attachmentsSchema = {
  type: 'array',
  description: 'Files to attach. Each entry uses EXACTLY ONE source: localPath (inside FASTMAIL_DOWNLOAD_DIR), emailId + attachmentId (re-use an existing attachment, no bytes copied), or blobId. Optional name/type override.',
  items: {
    type: 'object',
    properties: {
      localPath: { type: 'string' },
      emailId: { type: 'string' },
      attachmentId: { type: 'string', description: 'partId, blobId or zero-based index within the source email' },
      blobId: { type: 'string' },
      name: { type: 'string' },
      type: { type: 'string' },
    },
  },
};

const recipientSchema = (what: string) => ({
  oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
  description: `${what} addresses (array, or comma-separated string)`,
});

const identitySchema = {
  identityId: { type: 'string', description: 'Sending identity id (see list_identities). Wins over fromEmail.' },
  fromEmail: { type: 'string', description: 'Send as this verified identity address. Refused if no identity matches; the error lists the available ones.' },
  from: { type: 'string', description: 'Alias of fromEmail (upstream name).' },
  sendAt: { type: 'string', description: 'ISO 8601 time to send at instead of now (SMTP FUTURERELEASE). Fastmail parks the mail in its Scheduled folder until then; cancel with cancel_send. Refused when the plan has no Scheduled Send.' },
};

function bodyOf(args: Record<string, any>) {
  const textBody = typeof args.textBody === 'string' ? args.textBody : undefined;
  const htmlBody = typeof args.htmlBody === 'string' ? args.htmlBody : undefined;
  if (!textBody && !htmlBody) throw new RefusedError('Either textBody or htmlBody is required');
  return { textBody, htmlBody };
}

const sendEmail: ForkTool = {
  write: true,
  def: {
    name: 'send_email',
    description: `Send an email now or at sendAt. Picks the From identity by identityId, then fromEmail, then the account default. Returns { emailId, submissionId, identity, sendAt, undoStatus } as stored by the server. Refuses an unknown fromEmail (lists the available identities), a sendAt in the past, and a missing body. ${UNCONFIRMED}`,
    inputSchema: {
      type: 'object',
      properties: {
        to: recipientSchema('Recipient'),
        cc: recipientSchema('CC'),
        bcc: recipientSchema('BCC'),
        replyTo: recipientSchema('Reply-To'),
        subject: { type: 'string' },
        textBody: { type: 'string' },
        htmlBody: { type: 'string' },
        mailboxId: { type: 'string', description: 'Mailbox to create the draft in before sending (default Drafts).' },
        inReplyTo: { type: 'array', items: { type: 'string' } },
        references: { type: 'array', items: { type: 'string' } },
        attachments: attachmentsSchema,
        ...identitySchema,
      },
      required: ['to', 'subject'],
    },
  },
  async run(args, { client }) {
    const to = coerceStringArray(args.to);
    if (!to?.length) throw new RefusedError('to is required');
    const subject = requireString(args, 'subject');
    const identity = await pickIdentity(client, identityArgs(args));
    const sendAt = sendAtOf(args);
    const mailboxId = typeof args.mailboxId === 'string' && args.mailboxId ? args.mailboxId : await draftsId(client);
    const cc = coerceStringArray(args.cc);
    const bcc = coerceStringArray(args.bcc);
    const emailId = await client.createDraft({
      to,
      cc,
      bcc,
      replyTo: coerceStringArray(args.replyTo),
      from: identity.email,
      mailboxId,
      subject,
      ...bodyOf(args),
      inReplyTo: coerceStringArray(args.inReplyTo),
      references: coerceStringArray(args.references),
      attachments: args.attachments,
      downloadDir: downloadDir(),
    });
    return submit(client, emailId, identity, [...to, ...(cc ?? []), ...(bcc ?? [])], mailboxId, sendAt);
  },
};

const addrs = (list: any): string[] => (Array.isArray(list) ? list.map((a: any) => a?.email).filter(Boolean) : []);

const replyEmail: ForkTool = {
  write: true,
  def: {
    name: 'reply_email',
    description: `Reply to an email with In-Reply-To / References threading and a "Re:" subject. The From identity is the one the original was addressed to (so a mail sent to an alias is answered from that alias), unless identityId or fromEmail says otherwise. replyAll=true adds the original To/Cc minus your own identities. send=false saves a draft instead. Returns the same shape as send_email (or { emailId, draft: true }). ${UNCONFIRMED}`,
    inputSchema: {
      type: 'object',
      properties: {
        originalEmailId: { type: 'string' },
        to: recipientSchema('Recipient (default: original sender)'),
        cc: recipientSchema('CC'),
        bcc: recipientSchema('BCC'),
        replyTo: recipientSchema('Reply-To'),
        replyAll: { type: 'boolean', description: 'Also reply to every original To/Cc address (default false).' },
        textBody: { type: 'string' },
        htmlBody: { type: 'string' },
        send: { type: ['boolean', 'string'], description: 'Send now (default true); false saves a draft.' },
        attachments: attachmentsSchema,
        ...identitySchema,
      },
      required: ['originalEmailId'],
    },
  },
  async run(args, { client }) {
    const originalEmailId = requireString(args, 'originalEmailId');
    const shouldSend = coerceBool(args.send) ?? true;
    const original = await client.getEmailById(originalEmailId);
    const messageId = original.messageId?.[0];
    if (!messageId) throw new RefusedError('Original email has no Message-ID; cannot thread a reply');
    const received = [...addrs(original.to), ...addrs(original.cc)];
    const identity = await pickIdentity(client, { ...identityArgs(args), matchAddresses: received });
    const mine = new Set((await client.getIdentities()).map((i: any) => String(i.email).toLowerCase()));
    mine.add(identity.email.toLowerCase());
    const sender = addrs(original.replyTo).length ? addrs(original.replyTo) : addrs(original.from);
    let to = coerceStringArray(args.to);
    if (!to?.length) to = sender;
    let cc = coerceStringArray(args.cc) ?? [];
    if (args.replyAll === true) {
      const extra = received.filter((a) => !mine.has(a.toLowerCase()) && !to!.includes(a) && !cc.includes(a));
      cc = [...cc, ...extra];
    }
    if (!to.length) throw new RefusedError('Could not determine a recipient; pass "to" explicitly');
    const subject = /^Re:/i.test(original.subject || '') ? original.subject : `Re: ${original.subject || ''}`;
    const body = shouldSend ? bodyOf(args) : { textBody: args.textBody, htmlBody: args.htmlBody };
    const bcc = coerceStringArray(args.bcc);
    const mailboxId = await draftsId(client);
    const emailId = await client.createDraft({
      to,
      cc,
      bcc,
      replyTo: coerceStringArray(args.replyTo),
      from: identity.email,
      mailboxId,
      subject,
      ...body,
      inReplyTo: [messageId],
      references: [...(original.references || []), messageId],
      attachments: args.attachments,
      downloadDir: downloadDir(),
    });
    if (!shouldSend) return { emailId, draft: true, identity, subject };
    return submit(client, emailId, identity, [...to, ...cc, ...(bcc ?? [])], mailboxId, sendAtOf(args));
  },
};

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain-text body of a fetched email: text parts joined, else stripped HTML. */
export function textOf(email: any): string {
  const values = email.bodyValues || {};
  const join = (parts: any[]) => (parts || []).map((p: any) => values[p.partId]?.value ?? '').filter(Boolean).join('\n');
  const text = join(email.textBody);
  if (text) return text;
  return stripHtml(join(email.htmlBody));
}

const fmt = (list: any) => (Array.isArray(list) ? list.map((a: any) => (a?.name ? `${a.name} <${a.email}>` : a?.email)).filter(Boolean).join(', ') : '');

/** Forward body: comment, blank line, header block, original text. */
export function forwardBody(original: any, comment?: string): string {
  const head = [
    '---------- Forwarded message ----------',
    `From: ${fmt(original.from)}`,
    `Date: ${original.receivedAt ?? ''}`,
    `Subject: ${original.subject ?? ''}`,
    `To: ${fmt(original.to)}`,
    ...(Array.isArray(original.cc) && original.cc.length ? [`Cc: ${fmt(original.cc)}`] : []),
  ].join('\n');
  return `${comment ? comment + '\n\n' : ''}${head}\n\n${textOf(original)}`;
}

const forwardEmail: ForkTool = {
  write: true,
  def: {
    name: 'forward_email',
    description: `Forward an email as plain text: your comment, a "Forwarded message" header block, then the original text (HTML-only mail is stripped to text). Attachments are re-attached by blob reference unless includeAttachments=false. Subject gets "Fwd: ". Identity and sendAt as in send_email. Returns the same shape as send_email. ${UNCONFIRMED}`,
    inputSchema: {
      type: 'object',
      properties: {
        emailId: { type: 'string' },
        to: recipientSchema('Recipient'),
        cc: recipientSchema('CC'),
        bcc: recipientSchema('BCC'),
        comment: { type: 'string', description: 'Text placed above the forwarded block.' },
        includeAttachments: { type: 'boolean', description: 'Default true.' },
        ...identitySchema,
      },
      required: ['emailId', 'to'],
    },
  },
  async run(args, { client }) {
    const emailId = requireString(args, 'emailId');
    const to = coerceStringArray(args.to);
    if (!to?.length) throw new RefusedError('to is required');
    const original = await client.getEmailById(emailId);
    const identity = await pickIdentity(client, identityArgs(args));
    const sendAt = sendAtOf(args);
    const include = args.includeAttachments !== false;
    const attachments = include
      ? (await client.getEmailAttachments(emailId)).map((a: any) => ({ blobId: a.blobId, name: a.name, type: a.type }))
      : [];
    const subject = /^Fwd?:/i.test(original.subject || '') ? original.subject : `Fwd: ${original.subject || ''}`;
    const mailboxId = await draftsId(client);
    const cc = coerceStringArray(args.cc);
    const bcc = coerceStringArray(args.bcc);
    const draftId = await client.createDraft({
      to,
      cc,
      bcc,
      from: identity.email,
      mailboxId,
      subject,
      textBody: forwardBody(original, typeof args.comment === 'string' ? args.comment : undefined),
      attachments: attachments.length ? attachments : undefined,
      downloadDir: downloadDir(),
    });
    return submit(client, draftId, identity, [...to, ...(cc ?? []), ...(bcc ?? [])], mailboxId, sendAt);
  },
};

const listScheduled: ForkTool = {
  write: false,
  def: {
    name: 'list_scheduled',
    description: 'List pending email submissions: scheduled sends and mail still inside the undo-send window. Returns [{ id, emailId, sendAt, undoStatus, subject, to }]. Cancel one with cancel_send.',
    inputSchema: { type: 'object', properties: {} },
  },
  async run(_args, { client }) {
    const [, subs, emails] = await jmapBatch(client, SEND, [
      ['EmailSubmission/query', { filter: { undoStatus: 'pending' } }, 'q'],
      ['EmailSubmission/get', { '#ids': { resultOf: 'q', name: 'EmailSubmission/query', path: '/ids' }, properties: ['id', 'emailId', 'sendAt', 'undoStatus'] }, 'g'],
      ['Email/get', { '#ids': { resultOf: 'g', name: 'EmailSubmission/get', path: '/list/*/emailId' }, properties: ['id', 'subject', 'to'] }, 'e'],
    ]);
    const byId = new Map<string, any>((emails?.list ?? []).map((e: any) => [e.id, e]));
    return (subs?.list ?? []).map((s: any) => ({
      id: s.id,
      emailId: s.emailId,
      sendAt: s.sendAt,
      undoStatus: s.undoStatus,
      subject: byId.get(s.emailId)?.subject,
      to: addrs(byId.get(s.emailId)?.to),
    }));
  },
};

const cancelSend: ForkTool = {
  write: true,
  def: {
    name: 'cancel_send',
    description: 'Cancel a pending submission (a scheduled send, or a just-sent mail still in the undo window). Sets undoStatus to canceled and returns the submission as re-fetched. Fails with a JMAP error once the mail has left the server. The email itself stays where it is.',
    inputSchema: { type: 'object', properties: { submissionId: { type: 'string' } }, required: ['submissionId'] },
  },
  async run(args, { client }) {
    const id = requireString(args, 'submissionId');
    const [set, get] = await jmapBatch(client, SEND, [
      ['EmailSubmission/set', { update: { [id]: { undoStatus: 'canceled' } } }],
      ['EmailSubmission/get', { ids: [id], properties: ['id', 'emailId', 'sendAt', 'undoStatus'] }],
    ]);
    assertSet(set, 'updated', id);
    return get?.list?.[0] ?? null;
  },
};

async function snoozePatch(client: JmapClient, emailId: string, patch: Record<string, unknown>) {
  const [set, get] = await jmapBatch(client, ['mail'], [
    ['Email/set', { update: { [emailId]: patch } }],
    ['Email/get', { ids: [emailId], properties: ['id', 'mailboxIds', 'snoozed'] }],
  ]);
  assertSet(set, 'updated', emailId);
  return get?.list?.[0] ?? null;
}

async function roles(client: JmapClient) {
  const mailboxes = await client.getMailboxes();
  const find = (role: string) => mailboxes.find((m: any) => m.role === role);
  const snoozed = find('snoozed');
  const inbox = find('inbox');
  if (!snoozed) throw new RefusedError('No mailbox with role "snoozed" on this account; Fastmail creates it once snooze is used in the web app');
  if (!inbox) throw new RefusedError('No mailbox with role "inbox" on this account');
  return { snoozed, inbox };
}

const snoozeEmail: ForkTool = {
  write: true,
  def: {
    name: 'snooze_email',
    description: 'Snooze an email until an ISO 8601 time: moves it from Inbox to the Snoozed folder and the server brings it back to moveToMailboxId (default Inbox) at `until`. Returns { id, mailboxIds, snoozed } as re-fetched. Refuses when the account has no mailbox with role "snoozed". The `snoozed` property shape ({ until, moveToMailboxId }) follows draft-ietf-jmap-snooze.',
    inputSchema: {
      type: 'object',
      properties: {
        emailId: { type: 'string' },
        until: { type: 'string', description: 'ISO 8601 time.' },
        moveToMailboxId: { type: 'string', description: 'Where the mail reappears (default: Inbox).' },
      },
      required: ['emailId', 'until'],
    },
  },
  async run(args, { client }) {
    const emailId = requireString(args, 'emailId');
    const d = new Date(requireString(args, 'until'));
    if (isNaN(d.getTime())) throw new RefusedError(`until "${args.until}" is not an ISO 8601 date`);
    if (d.getTime() < Date.now()) throw new RefusedError(`until "${args.until}" is in the past`);
    const { snoozed, inbox } = await roles(client);
    const moveTo = typeof args.moveToMailboxId === 'string' && args.moveToMailboxId ? args.moveToMailboxId : inbox.id;
    return snoozePatch(client, emailId, {
      snoozed: { until: d.toISOString(), moveToMailboxId: moveTo },
      [`mailboxIds/${snoozed.id}`]: true,
      [`mailboxIds/${inbox.id}`]: null,
    });
  },
};

const unsnoozeEmail: ForkTool = {
  write: true,
  def: {
    name: 'unsnooze_email',
    description: 'Cancel a snooze: clears `snoozed`, puts the email back in Inbox and removes it from the Snoozed folder. Returns { id, mailboxIds, snoozed } as re-fetched. Refuses when the account has no mailbox with role "snoozed". Follows draft-ietf-jmap-snooze.',
    inputSchema: { type: 'object', properties: { emailId: { type: 'string' } }, required: ['emailId'] },
  },
  async run(args, { client }) {
    const emailId = requireString(args, 'emailId');
    const { snoozed, inbox } = await roles(client);
    return snoozePatch(client, emailId, {
      snoozed: null,
      [`mailboxIds/${inbox.id}`]: true,
      [`mailboxIds/${snoozed.id}`]: null,
    });
  },
};

export const tools: ForkTool[] = [sendEmail, replyEmail, forwardEmail, listScheduled, cancelSend, snoozeEmail, unsnoozeEmail];
