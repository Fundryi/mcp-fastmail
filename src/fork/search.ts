// Gmail-style search string on top of the shared search filter, plus the
// address book list. search_emails overrides upstream (query, limit,
// ascending, excludeDrafts all keep working).
import { JmapClient } from '../jmap-client.js';
import { ForkTool, RefusedError, byPath, jmap, requireString } from './core.js';
import { buildSearchFilter, queryEmails } from './emails.js';

const MAIL = ['mail'];
const CONTACTS = ['urn:ietf:params:jmap:contacts'];
const ROLES: Record<string, string> = { inbox: 'inbox', trash: 'trash', spam: 'junk', junk: 'junk', sent: 'sent', drafts: 'drafts', archive: 'archive' };
const SIZE: Record<string, number> = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
const DAYS: Record<string, number> = { d: 1, w: 7, m: 30, y: 365 };
const OPERATORS = ['from', 'to', 'cc', 'bcc', 'subject', 'body', 'has', 'is', 'in', '-in', 'after', 'before', 'newer_than', 'older_than', 'larger', 'smaller', 'header', 'domain'];

export interface ParsedQuery {
  /** Args in buildSearchFilter's shape (mailboxId / excludeMailboxIds still unresolved, see `in`). */
  args: Record<string, any>;
  /** `in:` value: folder path, id or role name. Resolved by the tool. */
  in?: string;
  /** `-in:` values. */
  notIn: string[];
}

function bad(op: string, value: string, why: string): never {
  throw new RefusedError(`${op}:${value} ${why}`);
}

function dateOf(op: string, v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) bad(op, v, 'must be YYYY-MM-DD');
  return v + 'T00:00:00Z';
}

function relative(op: string, v: string, now: Date): string {
  const m = /^(\d+)([dwmy])$/i.exec(v);
  if (!m) bad(op, v, 'must be a number followed by d, w, m or y (e.g. 7d, 2w, 1m, 1y)');
  const d = new Date(now.getTime() - Number(m[1]) * DAYS[m[2].toLowerCase()] * 86400000);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function bytes(op: string, v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(v);
  if (!m) bad(op, v, 'must be bytes with an optional k, M or G suffix (e.g. 10M, 500k, 1000)');
  return Math.round(Number(m[1]) * SIZE[m[2].toLowerCase()]);
}

/** Parse a Gmail-style query string. `now` only matters for newer_than / older_than. */
export function parseQuery(query: string, now: Date = new Date()): ParsedQuery {
  const args: Record<string, any> = {};
  const parsed: ParsedQuery = { args, notIn: [] };
  const words: string[] = [];
  // token = optional operator prefix, then a quoted or bare value
  const re = /(?:(-?[A-Za-z_]+):)?(?:"([^"]*)"|(\S+))/g;
  for (let m = re.exec(query); m; m = re.exec(query)) {
    const value = m[2] ?? m[3] ?? '';
    if (!m[1]) { words.push(value); continue; }
    const op = m[1].toLowerCase();
    const v = value.toLowerCase();
    switch (op) {
      case 'from': case 'to': case 'cc': case 'bcc': case 'subject': case 'body':
        args[op] = args[op] ? `${args[op]} ${value}` : value; break;
      case 'has':
        if (v !== 'attachment') bad(op, value, 'is not supported; only has:attachment');
        args.hasAttachment = true; break;
      case 'is':
        if (v === 'unread') args.isUnread = true;
        else if (v === 'read') args.isUnread = false;
        else if (v === 'flagged' || v === 'starred') args.isPinned = true;
        else if (v === 'unflagged' || v === 'unstarred') args.isPinned = false;
        else bad(op, value, 'is not supported; use unread, read, flagged/starred or unflagged');
        break;
      case 'in':
        if (parsed.in) bad(op, value, 'cannot combine with a second in:; use -in: to exclude');
        parsed.in = value; break;
      case '-in':
        parsed.notIn.push(value); break;
      case 'after': args.after = dateOf(op, value); break;
      case 'before': args.before = dateOf(op, value); break;
      case 'newer_than': args.after = relative(op, value, now); break;
      case 'older_than': args.before = relative(op, value, now); break;
      case 'larger': args.minSize = bytes(op, value); break;
      case 'smaller': args.maxSize = bytes(op, value); break;
      case 'header': {
        const eq = value.indexOf('=');
        args.header = eq < 0 ? { name: value } : { name: value.slice(0, eq), value: value.slice(eq + 1) };
        if (!args.header.name) bad(op, value, 'needs a header name');
        break;
      }
      case 'domain': args.toDomain = value; break;
      default:
        throw new RefusedError(`Unknown operator "${m[1]}:" in query. Supported: ${OPERATORS.join(', ')}. Quote a bare word that contains a colon, e.g. "https://example.com".`);
    }
  }
  if (words.length) args.query = words.join(' ');
  return parsed;
}

/** Folder path, mailbox id, or a role word (inbox, trash, spam, sent, drafts, archive) -> mailbox id. */
async function resolveMailbox(client: JmapClient, ref: string): Promise<string> {
  const role = ROLES[ref.toLowerCase()];
  if (role) {
    const r = await jmap(client, MAIL, 'Mailbox/get', { ids: null, properties: ['id', 'role'] });
    const mb = (r.list ?? []).find((x: any) => x.role === role);
    if (!mb) throw new RefusedError(`No mailbox with role "${role}" for in:${ref}`);
    return mb.id;
  }
  try {
    return (await byPath(client, ref)).id;
  } catch (e) {
    const r = await jmap(client, MAIL, 'Mailbox/get', { ids: [ref], properties: ['id'] });
    if (r.list?.length) return r.list[0].id;
    throw e;
  }
}

export const tools: ForkTool[] = [
  {
    write: false,
    def: {
      name: 'search_emails',
      description: 'Search mail with a Gmail-style query string. Operators (case-insensitive, values may be quoted: subject:"steam guard"): from:, to:, cc:, bcc:, subject:, body:, has:attachment, is:unread, is:read, is:flagged (alias is:starred), is:unflagged, in:<folder path, mailbox id, or inbox|trash|spam|junk|sent|drafts|archive>, -in:<same> to exclude, after:YYYY-MM-DD, before:YYYY-MM-DD, newer_than:7d|2w|1m|1y, older_than:..., larger:10M|500k|1000, smaller:..., header:Name=value or header:Name, domain:example.com (recipient domain). Remaining words are free text over subject, body and addresses. in: includes child folders unless includeChildren is false. Returns {total, position, items, parsed}; parsed shows how the string was read. Refuses an unknown operator (a bare word with a colon, such as a URL, must be quoted), a malformed date, size or duration, and an unresolvable in: folder.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail-style query, e.g. from:example.com in:inbox is:unread newer_than:7d' },
          limit: { type: ['number', 'string'], description: 'Max results (default 20, cap 500).', default: 20 },
          position: { type: 'number', description: 'Offset for paging (default 0).' },
          ascending: { type: 'boolean', description: 'Oldest first (default newest first).' },
          excludeDrafts: { type: 'boolean', description: 'Omit drafts ($draft keyword). Default false.' },
          includeChildren: { type: 'boolean', description: 'Expand in: and -in: to child folders. Default true.' },
          fields: { type: 'array', items: { type: 'string' }, description: 'Email properties to return (default: id, threadId, mailboxIds, keywords, from, to, subject, receivedAt, preview, hasAttachment, size).' },
        },
        required: ['query'],
      },
    },
    async run(args, { client }) {
      const parsed = parseQuery(requireString(args, 'query'));
      const filterArgs: Record<string, any> = { ...parsed.args, includeChildren: args.includeChildren !== false };
      if (parsed.in) filterArgs.mailboxId = await resolveMailbox(client, parsed.in);
      if (parsed.notIn.length) filterArgs.excludeMailboxIds = await Promise.all(parsed.notIn.map((p) => resolveMailbox(client, p)));
      let filter = await buildSearchFilter(client, filterArgs);
      if (args.excludeDrafts === true || args.excludeDrafts === 'true') {
        const conditions = filter.operator === 'AND' ? filter.conditions : Object.keys(filter).length ? [filter] : [];
        filter = { operator: 'AND', conditions: [...conditions, { notKeyword: '$draft' }] };
      }
      const limit = Number(args.limit);
      const page = await queryEmails(client, {
        filter,
        fields: Array.isArray(args.fields) ? args.fields : undefined,
        limit: Number.isFinite(limit) ? limit : 20,
        position: args.position,
        ascending: args.ascending === true,
      });
      return { ...page, parsed: filterArgs };
    },
  },
  {
    write: false,
    def: {
      name: 'list_address_books',
      description: 'List the address books on the account (AddressBook/get, RFC 9610). Returns [{id, name, description, isSubscribed, isDefault, shareWith, myRights}] as the server gives them. Use it to see whether a shared company directory is a second address book. Refuses when the token lacks the contacts capability.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    async run(_args, { client }) {
      const r = await jmap(client, CONTACTS, 'AddressBook/get', { ids: null });
      return (r.list ?? []).map((b: any) => ({ id: b.id, name: b.name, description: b.description, isSubscribed: b.isSubscribed, isDefault: b.isDefault, shareWith: b.shareWith, myRights: b.myRights }));
    },
  },
];
