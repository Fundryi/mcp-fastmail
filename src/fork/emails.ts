// Read-only email tools. list_emails, advanced_search and get_thread override
// upstream (every upstream arg keeps working); the rest are new.
import { buildEmailQueryFilter, EmailQueryFilters, JmapClient } from '../jmap-client.js';
import { ForkTool, RefusedError, jmap, jmapBatch, requireString } from './core.js';

const MAIL = ['mail'];
const MAX_LIMIT = 500;
const DEFAULT_FIELDS = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'subject', 'receivedAt', 'preview', 'hasAttachment', 'size'];

function num(v: unknown, dflt: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : dflt;
}

function strArray(args: Record<string, any>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x)) throw new RefusedError(`${key} must be an array of strings`);
  return v;
}

// ---------- shared query ----------

export interface QueryOpts {
  filter: any;
  fields?: string[];
  limit?: number;
  position?: number;
  ascending?: boolean;
  sortBy?: string;
}

/** Email/query + Email/get via #ids back-reference, one request. */
export async function queryEmails(client: JmapClient, o: QueryOpts): Promise<{ total: number; position: number; items: any[] }> {
  const [q, g] = await jmapBatch(client, MAIL, [
    ['Email/query', {
      filter: o.filter,
      sort: [{ property: o.sortBy ?? 'receivedAt', isAscending: o.ascending === true }],
      position: Math.max(0, o.position ?? 0),
      limit: Math.min(Math.max(1, o.limit ?? 20), MAX_LIMIT),
      calculateTotal: true,
    }, 'q'],
    ['Email/get', {
      '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
      properties: o.fields ?? DEFAULT_FIELDS,
    }, 'g'],
  ]);
  return { total: q.total ?? g.list?.length ?? 0, position: q.position ?? 0, items: g.list ?? [] };
}

/** Page through a filter in chunks of MAX_LIMIT until maxEmails or the end. */
async function pageAll(client: JmapClient, filter: any, fields: string[], maxEmails: number): Promise<{ total: number; items: any[] }> {
  const items: any[] = [];
  let total = 0;
  for (let position = 0; items.length < maxEmails; position += MAX_LIMIT) {
    const limit = Math.min(MAX_LIMIT, maxEmails - items.length);
    const page = await queryEmails(client, { filter, fields, position, limit });
    total = page.total;
    items.push(...page.items);
    if (page.items.length < limit || position + limit >= total) break;
  }
  return { total, items };
}

// ---------- mailbox tree ----------

async function mailboxTree(client: JmapClient, properties: string[]): Promise<any[]> {
  const r = await jmap(client, MAIL, 'Mailbox/get', { ids: null, properties });
  return r.list ?? [];
}

/** ids plus every descendant, in tree order, de-duplicated. */
function withDescendants(ids: string[], all: any[]): string[] {
  const children = new Map<string, string[]>();
  for (const mb of all) {
    if (mb.parentId) children.set(mb.parentId, [...(children.get(mb.parentId) ?? []), mb.id]);
  }
  const out = new Set<string>();
  const walk = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    for (const c of children.get(id) ?? []) walk(c);
  };
  ids.forEach(walk);
  return [...out];
}

function pathOf(id: string, byId: Map<string, any>): string {
  const parts: string[] = [];
  for (let cur = byId.get(id), depth = 0; cur && depth < 100; cur = cur.parentId ? byId.get(cur.parentId) : null, depth++) {
    parts.unshift(cur.name);
  }
  return parts.join('/');
}

// ---------- search filter ----------

const FILTER_PROPS = {
  query: { type: 'string', description: 'Free text (subject, body, addresses).' },
  from: { type: 'string', description: 'Sender contains this text.' },
  to: { type: 'string', description: 'To header contains this text (substring, so "@example.com" matches a domain).' },
  cc: { type: 'string', description: 'Cc header contains this text.' },
  bcc: { type: 'string', description: 'Bcc header contains this text.' },
  subject: { type: 'string', description: 'Subject contains this text.' },
  body: { type: 'string', description: 'Body contains this text.' },
  toDomain: { type: 'string', description: 'Recipient domain, e.g. "example.com". Sent as to: "@example.com".' },
  header: {
    type: 'object',
    properties: { name: { type: 'string' }, value: { type: 'string' } },
    required: ['name'],
    description: 'Header must exist ({name}) or contain value ({name, value}). JMAP header: [name] / [name, value].',
  },
  hasAttachment: { type: 'boolean' },
  isUnread: { type: 'boolean' },
  isPinned: { type: 'boolean', description: '$flagged keyword.' },
  minSize: { type: 'number', description: 'Bytes, inclusive.' },
  maxSize: { type: 'number', description: 'Bytes, exclusive (JMAP maxSize).' },
  mailboxId: { type: 'string', description: 'Only this mailbox. With includeChildren: this mailbox or any descendant.' },
  requiredMailboxIds: { type: 'array', items: { type: 'string' }, description: 'Member of ALL of these (intersection). Not expanded by includeChildren.' },
  excludeMailboxIds: { type: 'array', items: { type: 'string' }, description: 'Member of NONE of these. Expanded by includeChildren.' },
  includeChildren: { type: 'boolean', description: 'Expand mailboxId and excludeMailboxIds to include every descendant mailbox (one extra Mailbox/get).' },
  after: { type: 'string', description: 'receivedAt >= this ISO 8601 date.' },
  before: { type: 'string', description: 'receivedAt < this ISO 8601 date.' },
};

const PAGE_PROPS = {
  limit: { type: ['number', 'string'], description: 'Max results (default 50, cap 500).' },
  position: { type: 'number', description: 'Offset for paging (default 0).' },
  ascending: { type: 'boolean', description: 'Oldest first (default newest first).' },
  fields: { type: 'array', items: { type: 'string' }, description: `Email properties to return. Default: ${DEFAULT_FIELDS.join(', ')}.` },
};

const FILTER_KEYS: (keyof EmailQueryFilters)[] = ['query', 'from', 'to', 'subject', 'hasAttachment', 'isUnread', 'isPinned', 'mailboxId', 'requiredMailboxIds', 'excludeMailboxIds', 'after', 'before'];

/** Upstream filter (buildEmailQueryFilter) AND the fork-only conditions. */
export async function buildSearchFilter(client: JmapClient, args: Record<string, any>): Promise<any> {
  const base: EmailQueryFilters = {};
  for (const k of FILTER_KEYS) if (args[k] !== undefined) (base as any)[k] = args[k];
  strArray(args, 'requiredMailboxIds');
  strArray(args, 'excludeMailboxIds');

  const extra: any[] = [];
  if (args.includeChildren === true && (base.mailboxId || base.excludeMailboxIds?.length)) {
    const all = await mailboxTree(client, ['id', 'parentId']);
    if (base.mailboxId) {
      const ids = withDescendants([base.mailboxId], all);
      delete base.mailboxId;
      extra.push(ids.length === 1 ? { inMailbox: ids[0] } : { operator: 'OR', conditions: ids.map((id) => ({ inMailbox: id })) });
    }
    if (base.excludeMailboxIds?.length) base.excludeMailboxIds = withDescendants(base.excludeMailboxIds, all);
  }

  const cond: any = {};
  for (const k of ['cc', 'bcc', 'body'] as const) if (typeof args[k] === 'string' && args[k]) cond[k] = args[k];
  if (args.minSize !== undefined) cond.minSize = num(args.minSize, 0);
  if (args.maxSize !== undefined) cond.maxSize = num(args.maxSize, 0);
  if (args.header) {
    const name = requireString(args.header, 'name');
    cond.header = typeof args.header.value === 'string' ? [name, args.header.value] : [name];
  }
  if (Object.keys(cond).length) extra.push(cond);
  if (typeof args.toDomain === 'string' && args.toDomain) {
    extra.push({ to: '@' + args.toDomain.replace(/^@/, '') });
  }

  const built = buildEmailQueryFilter(base);
  const conditions = [
    ...(built.operator === 'AND' ? built.conditions : Object.keys(built).length ? [built] : []),
    ...extra,
  ];
  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { operator: 'AND', conditions };
}

// ---------- body helpers ----------

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** Join body parts to one string; HTML parts are stripped. Returns [text, truncated]. */
function partsText(parts: any[] | undefined, bodyValues: any): [string, boolean] {
  let truncated = false;
  const chunks: string[] = [];
  for (const p of parts ?? []) {
    const v = bodyValues?.[p.partId];
    if (!v) continue;
    if (v.isTruncated) truncated = true;
    chunks.push(p.type === 'text/html' ? stripHtml(v.value ?? '') : (v.value ?? ''));
  }
  return [chunks.join('\n').trim(), truncated];
}

function addr(list: any[] | undefined): string | undefined {
  const a = list?.[0]?.email;
  return typeof a === 'string' ? a.toLowerCase() : undefined;
}

function normaliseSubject(s: unknown): string {
  return String(s ?? '').replace(/^(\s*(re|fwd?|aw|wg)\s*:\s*)+/i, '').toLowerCase().trim().slice(0, 60);
}

function top(counts: Map<string, number>, key: string, n = 50): any[] {
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, count]) => ({ [key]: k, count }));
}

function bump(m: Map<string, number>, k: string | undefined) {
  if (k) m.set(k, (m.get(k) ?? 0) + 1);
}

// ---------- tools ----------

export const tools: ForkTool[] = [
  {
    def: {
      name: 'list_emails',
      description: 'List emails, newest first, optionally scoped to one mailbox. Returns { total, position, items }. Every item carries mailboxIds by default; pass fields to choose Email properties. Page with position. limit caps at 500. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          mailboxId: { type: 'string', description: 'Only this mailbox (default: all).' },
          ...PAGE_PROPS,
          limit: { type: ['number', 'string'], description: 'Max results (default 20, cap 500).' },
        },
      },
    },
    write: false,
    async run(args, { client }) {
      return queryEmails(client, {
        filter: args.mailboxId ? { inMailbox: String(args.mailboxId) } : {},
        fields: strArray(args, 'fields'),
        limit: num(args.limit, 20),
        position: num(args.position, 0),
        ascending: args.ascending === true,
      });
    },
  },
  {
    def: {
      name: 'advanced_search',
      description: 'Search emails with any mix of filters (all ANDed): free text, from/to/cc/bcc/subject/body substrings, toDomain, header presence or value, size, attachment, unread, pinned, date range, and mailbox scoping (mailboxId, requiredMailboxIds intersection, excludeMailboxIds, includeChildren to expand mailboxId and excludeMailboxIds to their descendants). Returns { total, position, items }. Read-only. cc/bcc/body/minSize/maxSize/header are RFC 8621 filter fields, not yet confirmed against live Fastmail.',
      inputSchema: { type: 'object', properties: { ...FILTER_PROPS, ...PAGE_PROPS } },
    },
    write: false,
    async run(args, { client }) {
      return queryEmails(client, {
        filter: await buildSearchFilter(client, args),
        fields: strArray(args, 'fields'),
        limit: num(args.limit, 50),
        position: num(args.position, 0),
        ascending: args.ascending === true,
      });
    },
  },
  {
    def: {
      name: 'summarize_mailbox',
      description: 'Aggregate statistics over emails matching the same filters as advanced_search. Pages through up to maxEmails (default 2000) fetching headers only. Returns { total, sampled, unread, unreadRatio, dateRange, byFrom, byTo, bySubject } with top-50 lists; addresses lowercased, subjects stripped of Re:/Fwd:/AW:/WG: and cut to 60 chars. Read-only.',
      inputSchema: {
        type: 'object',
        properties: { ...FILTER_PROPS, maxEmails: { type: 'number', description: 'Sample size cap (default 2000).' } },
      },
    },
    write: false,
    async run(args, { client }) {
      const filter = await buildSearchFilter(client, args);
      const { total, items } = await pageAll(client, filter, ['from', 'to', 'receivedAt', 'keywords', 'subject'], num(args.maxEmails, 2000));
      const byFrom = new Map<string, number>(), byTo = new Map<string, number>(), bySubject = new Map<string, number>();
      let unread = 0, oldest: string | undefined, newest: string | undefined;
      for (const e of items) {
        if (!e.keywords?.$seen) unread++;
        bump(byFrom, addr(e.from));
        for (const t of e.to ?? []) bump(byTo, addr([t]));
        bump(bySubject, normaliseSubject(e.subject));
        if (e.receivedAt) {
          if (!oldest || e.receivedAt < oldest) oldest = e.receivedAt;
          if (!newest || e.receivedAt > newest) newest = e.receivedAt;
        }
      }
      return {
        total, sampled: items.length, unread,
        unreadRatio: items.length ? Math.round((unread / items.length) * 1000) / 1000 : 0,
        dateRange: { oldest: oldest ?? null, newest: newest ?? null },
        byFrom: top(byFrom, 'address'), byTo: top(byTo, 'address'), bySubject: top(bySubject, 'subject'),
      };
    },
  },
  {
    def: {
      name: 'list_unread_across',
      description: 'Unread and total counts for a parent mailbox and every descendant, each with its full path, plus totalUnread. Name the parent by mailboxId or path ("Inbox/Clients"). withEmails: true also returns up to perMailboxLimit (default 10) unread email headers per mailbox, fetched in one batched request. Refuses when neither mailboxId nor path is given or the parent does not exist. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          mailboxId: { type: 'string' },
          path: { type: 'string', description: 'Slash-separated mailbox path, alternative to mailboxId.' },
          withEmails: { type: 'boolean' },
          perMailboxLimit: { type: 'number', description: 'Unread headers per mailbox when withEmails (default 10, cap 500).' },
        },
      },
    },
    write: false,
    async run(args, { client }) {
      const all = await mailboxTree(client, ['id', 'name', 'parentId', 'unreadEmails', 'totalEmails']);
      const byId = new Map<string, any>(all.map((m) => [m.id, m]));
      let rootId: string;
      if (typeof args.mailboxId === 'string' && args.mailboxId) rootId = args.mailboxId;
      else if (typeof args.path === 'string' && args.path) {
        const hit = all.find((m) => pathOf(m.id, byId) === args.path);
        if (!hit) throw new RefusedError(`Mailbox not found: ${args.path}`);
        rootId = hit.id;
      } else throw new RefusedError('mailboxId or path is required');
      if (!byId.has(rootId)) throw new RefusedError(`Mailbox not found: ${rootId}`);

      const ids = withDescendants([rootId], all);
      const mailboxes = ids.map((id) => {
        const m = byId.get(id);
        return { id, name: m.name, path: pathOf(id, byId), parentId: m.parentId ?? null, unread: m.unreadEmails ?? 0, total: m.totalEmails ?? 0, emails: undefined as any[] | undefined };
      });

      if (args.withEmails === true) {
        const limit = Math.min(num(args.perMailboxLimit, 10), MAX_LIMIT);
        const calls = mailboxes.flatMap((m, i): [string, any, string][] => [
          ['Email/query', { filter: { inMailbox: m.id, notKeyword: '$seen' }, sort: [{ property: 'receivedAt', isAscending: false }], limit }, `q${i}`],
          ['Email/get', { '#ids': { resultOf: `q${i}`, name: 'Email/query', path: '/ids' }, properties: ['id', 'threadId', 'from', 'subject', 'receivedAt', 'hasAttachment'] }, `g${i}`],
        ]);
        const results = await jmapBatch(client, MAIL, calls);
        mailboxes.forEach((m, i) => { m.emails = results[i * 2 + 1]?.list ?? []; });
      } else {
        for (const m of mailboxes) delete m.emails;
      }
      return { totalUnread: mailboxes.reduce((s, m) => s + m.unread, 0), mailboxes };
    },
  },
  {
    def: {
      name: 'find_duplicates',
      description: 'Find duplicate emails among those matching the same filters as advanced_search, scanning up to maxEmails (default 2000). Groups by Message-ID header; when missing, by subject+from+sentAt. Returns only groups with 2+ members: [{ key, count, emails: [{ id, mailboxIds, receivedAt, size }] }]. Read-only; pair with a move/trash tool to act on the result.',
      inputSchema: {
        type: 'object',
        properties: { ...FILTER_PROPS, maxEmails: { type: 'number', description: 'Scan cap (default 2000).' } },
      },
    },
    write: false,
    async run(args, { client }) {
      const filter = await buildSearchFilter(client, args);
      const { items } = await pageAll(client, filter, ['id', 'messageId', 'subject', 'from', 'sentAt', 'receivedAt', 'mailboxIds', 'size'], num(args.maxEmails, 2000));
      const groups = new Map<string, any[]>();
      for (const e of items) {
        const key = e.messageId?.[0] ?? `${normaliseSubject(e.subject)}|${addr(e.from) ?? ''}|${e.sentAt ?? ''}`;
        groups.set(key, [...(groups.get(key) ?? []), { id: e.id, mailboxIds: e.mailboxIds, receivedAt: e.receivedAt, size: e.size }]);
      }
      return [...groups].filter(([, g]) => g.length > 1).map(([key, emails]) => ({ key, count: emails.length, emails }));
    },
  },
  {
    def: {
      name: 'extract_codes',
      description: 'Pull one-time codes (OTP, verification, 2FA) out of recent emails. Searches subject, preview and text body for pattern (regex, default 4 to 8 digit numbers) in emails received after `after` (default: 2 hours ago), optionally filtered by from/to/mailboxId. With the default pattern, years (1900-2099) and 10+ digit numbers are skipped. Returns [{ code, emailId, from, to, subject, receivedAt }], newest first, first match per email. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          mailboxId: { type: 'string' },
          after: { type: 'string', description: 'ISO 8601, default now minus 2 hours.' },
          limit: { type: ['number', 'string'], description: 'Emails to scan (default 20, cap 500).' },
          pattern: { type: 'string', description: 'Regex for the code (default \\b\\d{4,8}\\b). Group 1 is used when present.' },
        },
      },
    },
    write: false,
    async run(args, { client }) {
      const custom = typeof args.pattern === 'string' && args.pattern !== '';
      let re: RegExp;
      try { re = new RegExp(custom ? args.pattern : '\\b\\d{4,8}\\b', 'g'); }
      catch (e: any) { throw new RefusedError(`pattern is not a valid regex: ${e.message}`); }

      const filter: any = { after: typeof args.after === 'string' && args.after ? args.after : new Date(Date.now() - 2 * 3600 * 1000).toISOString() };
      if (args.from) filter.from = String(args.from);
      if (args.to) filter.to = String(args.to);
      if (args.mailboxId) filter.inMailbox = String(args.mailboxId);

      const [, g] = await jmapBatch(client, MAIL, [
        ['Email/query', { filter, sort: [{ property: 'receivedAt', isAscending: false }], limit: Math.min(num(args.limit, 20), MAX_LIMIT) }, 'q'],
        ['Email/get', {
          '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
          properties: ['id', 'textBody', 'bodyValues', 'preview', 'from', 'to', 'subject', 'receivedAt'],
          fetchTextBodyValues: true,
          maxBodyValueBytes: 8192,
        }, 'g'],
      ]);

      const looksWrong = (s: string) => !custom && (s.length >= 10 || /^(19|20)\d{2}$/.test(s));
      const out: any[] = [];
      for (const e of g.list ?? []) {
        const [body] = partsText(e.textBody, e.bodyValues);
        const hay = [e.subject, e.preview, body].filter(Boolean).join('\n');
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(hay))) {
          const code = m[1] ?? m[0];
          if (looksWrong(code)) continue;
          out.push({ code, emailId: e.id, from: addr(e.from), to: (e.to ?? []).map((t: any) => t.email), subject: e.subject, receivedAt: e.receivedAt });
          break;
        }
      }
      return out;
    },
  },
  {
    def: {
      name: 'get_thread',
      description: 'Every message in a conversation with its body. threadId may also be an email id (resolved to its thread). format: text (default; HTML-only messages are tag-stripped), html, or both. Each message: id, from, to, cc, subject, receivedAt, keywords, mailboxIds, hasAttachment, body (and html for html/both), truncated when maxBodyBytes (default 20000 per part) cut it. $draft messages are excluded unless includeDrafts. Refuses when the thread does not exist. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string', description: 'Thread id, or an email id.' },
          includeDrafts: { type: 'boolean', description: 'Include $draft messages (default false).' },
          format: { type: 'string', enum: ['text', 'html', 'both'], description: 'Body format (default text).' },
          maxBodyBytes: { type: 'number', description: 'Max bytes per body part (default 20000).' },
        },
        required: ['threadId'],
      },
    },
    write: false,
    async run(args, { client }) {
      let threadId = requireString(args, 'threadId');
      const format = args.format === 'html' || args.format === 'both' ? args.format : 'text';
      const wantText = format !== 'html', wantHtml = format !== 'text';
      const properties = ['id', 'from', 'to', 'cc', 'subject', 'receivedAt', 'keywords', 'mailboxIds', 'hasAttachment', 'bodyValues', ...(wantText ? ['textBody'] : []), ...(wantHtml ? ['htmlBody'] : [])];
      const fetch = async () => jmapBatch(client, MAIL, [
        ['Thread/get', { ids: [threadId] }, 't'],
        ['Email/get', {
          '#ids': { resultOf: 't', name: 'Thread/get', path: '/list/*/emailIds' },
          properties,
          fetchTextBodyValues: wantText,
          fetchHTMLBodyValues: wantHtml,
          maxBodyValueBytes: num(args.maxBodyBytes, 20000),
        }, 'e'],
      ]);

      let [t, e] = await fetch();
      if (t.notFound?.includes(threadId)) {
        // Maybe an email id: resolve its thread and retry once.
        const probe = await jmap(client, MAIL, 'Email/get', { ids: [threadId], properties: ['threadId'] });
        const resolved = probe.list?.[0]?.threadId;
        if (!resolved) throw new RefusedError(`Thread not found: ${threadId}`);
        threadId = resolved;
        [t, e] = await fetch();
        if (t.notFound?.includes(threadId)) throw new RefusedError(`Thread not found: ${threadId}`);
      }

      const messages = (e.list ?? [])
        .filter((m: any) => args.includeDrafts === true || !m.keywords?.$draft)
        .map((m: any) => {
          const [text, tt] = wantText ? partsText(m.textBody, m.bodyValues) : ['', false];
          const [html, ht] = wantHtml ? partsText(m.htmlBody?.map((p: any) => ({ ...p, type: 'text/plain' })), m.bodyValues) : ['', false];
          const out: any = {
            id: m.id, from: m.from, to: m.to, cc: m.cc, subject: m.subject, receivedAt: m.receivedAt,
            keywords: m.keywords, mailboxIds: m.mailboxIds, hasAttachment: m.hasAttachment,
            body: wantText ? text : stripHtml(html),
            truncated: tt || ht,
          };
          if (wantHtml) out.html = html;
          return out;
        });
      return { threadId, messages };
    },
  },
];
