// Operational tools: unsubscribe, spam training, .eml import, emptying
// Trash/Junk, change sync and attachment listing.
import { readFile } from 'fs/promises';
import { JmapClient, buildEmailQueryFilter } from '../jmap-client.js';
import { ForkTool, JmapError, RefusedError, assertSet, jmap, jmapBatch, requireConfirm, requireString, requireStringArray } from './core.js';
import { byPath } from './core.js';

const MAIL = ['mail'];
const CORE_CAP = 'urn:ietf:params:jmap:core';

async function maxSet(client: JmapClient): Promise<number> {
  return (await client.getSession()).capabilities?.[CORE_CAP]?.maxObjectsInSet ?? 500;
}

async function mailboxByRole(client: JmapClient, role: string): Promise<string> {
  const res = await jmap(client, MAIL, 'Mailbox/get', { ids: null, properties: ['id', 'role'] });
  const mb = (res?.list ?? []).find((m: any) => m.role === role);
  if (!mb) throw new RefusedError(`No mailbox with role "${role}"`);
  return mb.id;
}

async function resolveMailboxId(client: JmapClient, args: Record<string, any>): Promise<string | undefined> {
  if (typeof args.mailboxId === 'string' && args.mailboxId.trim()) return args.mailboxId.trim();
  if (typeof args.path === 'string' && args.path.trim()) return (await byPath(client, args.path.trim())).id;
  return undefined;
}

/** `<a>, <b>` → ['a', 'b'] (RFC 2369). */
export function parseListUnsubscribe(header: string | null | undefined): { https: string[]; mailto: string[] } {
  const out = { https: [] as string[], mailto: [] as string[] };
  for (const m of (header ?? '').matchAll(/<([^>]+)>/g)) {
    const url = m[1].trim();
    if (/^https:\/\//i.test(url)) out.https.push(url);
    else if (/^mailto:/i.test(url)) out.mailto.push(url.slice(7));
  }
  return out;
}

const unsubscribe: ForkTool = {
  write: true,
  def: {
    name: 'unsubscribe',
    description:
      'Unsubscribe from a mailing list via the List-Unsubscribe header (RFC 2369 / RFC 8058). ' +
      'Without confirm it only reports what the email offers: { oneClick, https, mailto, action: "none" }. ' +
      'With confirm: true and oneClick it POSTs "List-Unsubscribe=One-Click" to the first https URL (no auth, no redirects, 10 s timeout) and returns { action: "posted", url, status }. ' +
      'Refuses when the header is missing, when no https one-click endpoint exists (non-https URLs are never fetched), or when only a mailto address exists; in the mailto case send an email to the returned address with send_email instead. ' +
      'A plain https link without List-Unsubscribe-Post is not fetched either, because those pages often need a browser.',
    inputSchema: {
      type: 'object',
      properties: {
        emailId: { type: 'string', description: 'Email id.' },
        confirm: { type: 'boolean', description: 'Actually send the one-click POST. Default false: inspect only.' },
      },
      required: ['emailId'],
    },
  },
  async run(args, { client }) {
    const emailId = requireString(args, 'emailId');
    const res = await jmap(client, MAIL, 'Email/get', {
      ids: [emailId],
      properties: ['from', 'subject', 'header:List-Unsubscribe:asText', 'header:List-Unsubscribe-Post:asText'],
    });
    const email = res?.list?.[0];
    if (!email) throw new RefusedError(`Email not found: ${emailId}`);
    const header = email['header:List-Unsubscribe:asText'];
    if (!header) throw new RefusedError('Refused: email has no List-Unsubscribe header', { from: email.from, subject: email.subject });
    const { https, mailto } = parseListUnsubscribe(header);
    const post = email['header:List-Unsubscribe-Post:asText'] ?? '';
    const oneClick = /List-Unsubscribe=One-Click/i.test(post) && https.length > 0;
    const info = { from: email.from, subject: email.subject, oneClick, https, mailto };
    if (args.confirm !== true) return { ...info, action: 'none' };
    if (!oneClick) {
      if (https.length === 0 && mailto.length > 0) {
        throw new RefusedError(`Refused: only a mailto unsubscribe exists. Send an email to ${mailto[0]} with send_email.`, info);
      }
      throw new RefusedError('Refused: no RFC 8058 one-click https endpoint; open the link in a browser instead.', info);
    }
    const url = https[0];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10_000);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        redirect: 'manual',
        signal: ac.signal,
      });
      return { ...info, action: 'posted', url, status: r.status };
    } finally {
      clearTimeout(timer);
    }
  },
};

function spamTool(name: string, role: 'junk' | 'inbox', description: string): ForkTool {
  return {
    write: true,
    def: {
      name,
      description,
      inputSchema: {
        type: 'object',
        properties: { emailIds: { type: 'array', items: { type: 'string' }, description: 'Email ids to move.' } },
        required: ['emailIds'],
      },
    },
    async run(args, { client }) {
      const ids = requireStringArray(args, 'emailIds');
      const [mbRes, emRes] = await jmapBatch(client, MAIL, [
        ['Mailbox/get', { ids: null, properties: ['id', 'role'] }],
        ['Email/get', { ids, properties: ['id', 'mailboxIds'] }],
      ]);
      const to = (mbRes?.list ?? []).find((m: any) => m.role === role)?.id;
      if (!to) throw new RefusedError(`No mailbox with role "${role}"`);
      const update: Record<string, any> = {};
      const notUpdated: Record<string, any> = {};
      for (const id of ids) {
        const email = (emRes?.list ?? []).find((e: any) => e.id === id);
        if (!email) { notUpdated[id] = { type: 'notFound' }; continue; }
        const patch: Record<string, unknown> = {};
        for (const from of Object.keys(email.mailboxIds ?? {})) if (from !== to) patch[`mailboxIds/${from}`] = null;
        patch[`mailboxIds/${to}`] = true;
        update[id] = patch;
      }
      const updated: string[] = [];
      const entries = Object.entries(update);
      const size = await maxSet(client);
      for (let i = 0; i < entries.length; i += size) {
        const res = await jmap(client, MAIL, 'Email/set', { update: Object.fromEntries(entries.slice(i, i + size)) });
        updated.push(...Object.keys(res?.updated ?? {}));
        Object.assign(notUpdated, res?.notUpdated ?? {});
      }
      return { mailboxId: to, updated, notUpdated };
    },
  };
}

const reportSpam = spamTool(
  'report_spam',
  'junk',
  'Move emails into the Junk folder (role "junk"), removing them from every other folder. Fastmail trains its spam filter on the move. Returns { mailboxId, updated, notUpdated }.'
);
const reportNotSpam = spamTool(
  'report_not_spam',
  'inbox',
  'Move emails out of Junk into the Inbox (role "inbox"), removing them from every other folder. Fastmail trains its spam filter on the move. Returns { mailboxId, updated, notUpdated }.'
);

const importEmail: ForkTool = {
  write: true,
  def: {
    name: 'import_email',
    description:
      'Import a local .eml file (RFC 5322 message) into a mailbox via Email/import. The path must resolve inside the download directory (FASTMAIL_DOWNLOAD_DIR, default ~/Downloads/fastmail-mcp/), same rule as attachments. ' +
      'Keywords default to { "$seen": true }. Returns the created email as stored: { id, blobId, threadId, size }.',
    inputSchema: {
      type: 'object',
      properties: {
        localPath: { type: 'string', description: 'Path to the .eml file, inside the download directory.' },
        mailboxId: { type: 'string', description: 'Target mailbox id. Give this or `path`.' },
        path: { type: 'string', description: 'Target folder path like "Parent/Child". Give this or `mailboxId`.' },
        keywords: { type: 'object', description: 'JMAP keywords map, e.g. { "$seen": true, "$flagged": true }. Default { "$seen": true }.' },
        receivedAt: { type: 'string', description: 'ISO 8601 UTC date to record as received. Default: server decides (usually Date header or now).' },
      },
      required: ['localPath'],
    },
  },
  async run(args, { client }) {
    const localPath = requireString(args, 'localPath');
    const mailboxId = await resolveMailboxId(client, args);
    if (!mailboxId) throw new RefusedError('mailboxId or path is required');
    const canonical = await JmapClient.validateReadPath(localPath, args.downloadDir ?? process.env.FASTMAIL_DOWNLOAD_DIR);
    const buffer = await readFile(canonical);
    const { blobId } = await client.uploadBlob(buffer, 'message/rfc822');
    const email: Record<string, unknown> = {
      blobId,
      mailboxIds: { [mailboxId]: true },
      keywords: args.keywords && typeof args.keywords === 'object' ? args.keywords : { $seen: true },
    };
    if (typeof args.receivedAt === 'string' && args.receivedAt) email.receivedAt = args.receivedAt;
    const res = await jmap(client, MAIL, 'Email/import', { emails: { i1: email } });
    return assertSet(res, 'created', 'i1');
  },
};

const emptyMailbox: ForkTool = {
  write: true,
  def: {
    name: 'empty_mailbox',
    description:
      'PERMANENTLY destroy every email in Trash or Junk. This cannot be undone; the mail is gone, not moved. ' +
      'Only role "trash" or "junk" is accepted. Requires confirm: true. Use dryRun: true first: it returns { total, sample } with the first 20 ids, subjects and dates and destroys nothing. ' +
      'olderThan (ISO date) limits the destroy to mail received before that time. Stops after maxEmails (default 5000) per call. Mail that also sits in another folder is skipped and listed in skippedInOtherFolders. Returns { destroyed, notDestroyed, skippedInOtherFolders, total }.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['trash', 'junk'], description: 'Which system folder to empty.' },
        confirm: { type: 'boolean', description: 'Must be true. The destroy is permanent.' },
        dryRun: { type: 'boolean', description: 'Count and sample only, destroy nothing.' },
        olderThan: { type: 'string', description: 'ISO 8601 date. Only destroy mail received before it.' },
        maxEmails: { type: 'number', description: 'Cap per call. Default 5000.' },
      },
      required: ['role'],
    },
  },
  async run(args, { client }) {
    const role = requireString(args, 'role');
    if (role !== 'trash' && role !== 'junk') throw new RefusedError('Refused: role must be "trash" or "junk"');
    const mailboxId = await mailboxByRole(client, role);
    const filter: Record<string, unknown> = { inMailbox: mailboxId };
    if (typeof args.olderThan === 'string' && args.olderThan) filter.before = args.olderThan;
    const cap = typeof args.maxEmails === 'number' && args.maxEmails > 0 ? args.maxEmails : 5000;

    if (args.dryRun === true) {
      const [q, g] = await jmapBatch(client, MAIL, [
        ['Email/query', { filter, calculateTotal: true, limit: 20 }],
        ['Email/get', { '#ids': { resultOf: 'c0', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject', 'receivedAt'] }],
      ]);
      return { dryRun: true, mailboxId, total: q?.total ?? 0, sample: g?.list ?? [] };
    }
    requireConfirm(args, `empty_mailbox permanently destroys every email in ${role}`);

    const ids: string[] = [];
    let total = 0;
    for (let position = 0; ids.length < cap; ) {
      const q = await jmap(client, MAIL, 'Email/query', { filter, calculateTotal: true, position, limit: Math.min(500, cap - ids.length) });
      total = q?.total ?? total;
      const page: string[] = q?.ids ?? [];
      if (page.length === 0) break;
      ids.push(...page);
      position += page.length;
    }
    // Folders are labels. A mail that also sits in another folder is not "in the
    // trash" from the user's view, so leave it alone and report it.
    const skipped: string[] = [];
    const only: string[] = [];
    const size = await maxSet(client);
    for (let i = 0; i < ids.length; i += 500) {
      const g = await jmap(client, MAIL, 'Email/get', { ids: ids.slice(i, i + 500), properties: ['id', 'mailboxIds'] });
      for (const e of g?.list ?? []) {
        const boxes = Object.keys(e.mailboxIds ?? {});
        (boxes.length === 1 && boxes[0] === mailboxId ? only : skipped).push(e.id);
      }
    }
    const destroyed: string[] = [];
    const notDestroyed: Record<string, any> = {};
    for (let i = 0; i < only.length; i += size) {
      const res = await jmap(client, MAIL, 'Email/set', { destroy: only.slice(i, i + size) });
      destroyed.push(...(res?.destroyed ?? []));
      Object.assign(notDestroyed, res?.notDestroyed ?? {});
    }
    return { mailboxId, destroyed, notDestroyed, skippedInOtherFolders: skipped, total };
  },
};

const getChanges: ForkTool = {
  write: false,
  def: {
    name: 'get_changes',
    description:
      'Incremental sync. Without sinceState returns the current { mailbox, email } state strings. ' +
      'With sinceState: { mailbox?, email? } returns what changed since: { mailbox: { oldState, newState, hasMoreChanges, created, updated, destroyed, mailboxes }, email: { ..., createdEmails } }. ' +
      'createdEmails carries up to 100 new emails (id, mailboxIds, from, to, subject, receivedAt, keywords). Up to 500 changes per call; hasMoreChanges means call again with newState. ' +
      'If the server no longer knows the old state (cannotCalculateChanges) call again without sinceState and resync.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceState: {
          type: 'object',
          properties: { mailbox: { type: 'string' }, email: { type: 'string' } },
          description: 'State strings from a previous call. Omit to fetch current states.',
        },
      },
    },
  },
  async run(args, { client }) {
    const since = args.sinceState && typeof args.sinceState === 'object' ? args.sinceState : undefined;
    if (!since || (!since.mailbox && !since.email)) {
      const [mb, em] = await jmapBatch(client, MAIL, [
        ['Mailbox/get', { ids: [], properties: ['id'] }],
        ['Email/get', { ids: [], properties: ['id'] }],
      ]);
      return { mailbox: { state: mb?.state }, email: { state: em?.state } };
    }
    const calls: [string, Record<string, unknown>, string][] = [];
    if (since.mailbox) {
      calls.push(['Mailbox/changes', { sinceState: since.mailbox, maxChanges: 500 }, 'mbc']);
      calls.push(['Mailbox/get', {
        '#ids': { resultOf: 'mbc', name: 'Mailbox/changes', path: '/created' }, properties: ['id', 'name', 'unreadEmails', 'totalEmails'],
      }, 'mbcreated']);
      calls.push(['Mailbox/get', {
        '#ids': { resultOf: 'mbc', name: 'Mailbox/changes', path: '/updated' }, properties: ['id', 'name', 'unreadEmails', 'totalEmails'],
      }, 'mbupdated']);
    }
    if (since.email) {
      calls.push(['Email/changes', { sinceState: since.email, maxChanges: 500 }, 'emc']);
      calls.push(['Email/get', {
        '#ids': { resultOf: 'emc', name: 'Email/changes', path: '/created' },
        properties: ['id', 'mailboxIds', 'from', 'to', 'subject', 'receivedAt', 'keywords'],
      }, 'emcreated']);
    }
    let results: any[];
    try {
      results = await jmapBatch(client, MAIL, calls);
    } catch (e) {
      if (e instanceof JmapError && e.type === 'cannotCalculateChanges') {
        throw new JmapError(e.type, 'State too old. Call get_changes without sinceState and resync from the current state.', e.detail);
      }
      throw e;
    }
    const byTag = Object.fromEntries(calls.map((c, i) => [c[2], results[i]]));
    const out: Record<string, unknown> = {};
    const pick = (r: any) => ({
      oldState: r?.oldState, newState: r?.newState, hasMoreChanges: r?.hasMoreChanges ?? false,
      created: r?.created ?? [], updated: r?.updated ?? [], destroyed: r?.destroyed ?? [],
    });
    if (since.mailbox) {
      out.mailbox = { ...pick(byTag.mbc), mailboxes: [...(byTag.mbcreated?.list ?? []), ...(byTag.mbupdated?.list ?? [])] };
    }
    if (since.email) {
      out.email = { ...pick(byTag.emc), createdEmails: (byTag.emcreated?.list ?? []).slice(0, 100) };
    }
    return out;
  },
};

const listAttachments: ForkTool = {
  write: false,
  def: {
    name: 'list_attachments',
    description:
      'List attachments across emails in one flat array: [{ emailId, subject, from, receivedAt, attachmentId, name, type, size }]. ' +
      'attachmentId is the part id that get_email_attachments / download_attachment accept. Scope by mailboxId, path, or filter (same keys as advanced_search: query, from, to, subject, after, before, isUnread, ...); ' +
      'then narrow client-side by type (MIME prefix like "application/pdf" or "image/"), minSize/maxSize (bytes), nameContains. ' +
      'Inline parts (disposition "inline", typically embedded images) are skipped unless includeInline: true. limit is the number of emails scanned (default 100, max 500), newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        mailboxId: { type: 'string', description: 'Restrict to a mailbox id.' },
        path: { type: 'string', description: 'Restrict to a folder path like "Parent/Child".' },
        filter: { type: 'object', description: 'advanced_search filter keys. hasAttachment is always forced to true.' },
        type: { type: 'string', description: 'MIME type prefix, e.g. "application/pdf" or "image/".' },
        minSize: { type: 'number', description: 'Minimum attachment size in bytes.' },
        maxSize: { type: 'number', description: 'Maximum attachment size in bytes.' },
        nameContains: { type: 'string', description: 'Case-insensitive substring of the file name.' },
        includeInline: { type: 'boolean', description: 'Also list inline parts. Default false.' },
        limit: { type: 'number', description: 'Emails to scan. Default 100, max 500.' },
      },
    },
  },
  async run(args, { client }) {
    const filters = { ...(args.filter && typeof args.filter === 'object' ? args.filter : {}), hasAttachment: true };
    const mailboxId = await resolveMailboxId(client, args);
    if (mailboxId) filters.mailboxId = mailboxId;
    const limit = Math.min(500, Math.max(1, Number(args.limit) || 100));
    const [, g] = await jmapBatch(client, MAIL, [
      ['Email/query', { filter: buildEmailQueryFilter(filters), sort: [{ property: 'receivedAt', isAscending: false }], limit }],
      ['Email/get', { '#ids': { resultOf: 'c0', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject', 'from', 'receivedAt', 'attachments'] }],
    ]);
    const type = typeof args.type === 'string' ? args.type.toLowerCase() : '';
    const name = typeof args.nameContains === 'string' ? args.nameContains.toLowerCase() : '';
    const out: any[] = [];
    for (const email of g?.list ?? []) {
      for (const a of email.attachments ?? []) {
        if (a.disposition === 'inline' && args.includeInline !== true) continue;
        if (type && !String(a.type ?? '').toLowerCase().startsWith(type)) continue;
        if (typeof args.minSize === 'number' && (a.size ?? 0) < args.minSize) continue;
        if (typeof args.maxSize === 'number' && (a.size ?? 0) > args.maxSize) continue;
        if (name && !String(a.name ?? '').toLowerCase().includes(name)) continue;
        out.push({
          emailId: email.id, subject: email.subject, from: email.from, receivedAt: email.receivedAt,
          attachmentId: a.partId ?? a.blobId, blobId: a.blobId, name: a.name, type: a.type, size: a.size,
        });
      }
    }
    return { count: out.length, emailsScanned: (g?.list ?? []).length, attachments: out };
  },
};

export const tools: ForkTool[] = [unsubscribe, reportSpam, reportNotSpam, importEmail, emptyMailbox, getChanges, listAttachments];
