import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { buildEmailQueryFilter, type JmapClient } from '../jmap-client.js';
import { type ForkTool, JmapError, RefusedError, jmap, requireString, requireStringArray } from './core.js';

type EmailState = { mailboxIds: Record<string, true>; keywords: Record<string, true> };
type Change = { emailId: string; before: EmailState };
type Operation = { id: string; tool: string; at: string; count: number; changes: Change[] };
type SetFailure = { type: string; description: string };
const operations: Operation[] = [];
const CORE = 'urn:ietf:params:jmap:core';

async function recordOperation(operation: Operation): Promise<{ auditLogError?: string }> {
  operations.push(operation);
  if (operations.length > 50) operations.shift();
  if (process.env.FASTMAIL_AUDIT_LOG) {
    try {
      await fs.appendFile(process.env.FASTMAIL_AUDIT_LOG, JSON.stringify(operation) + '\n', 'utf8');
    } catch (error) {
      return { auditLogError: error instanceof Error ? error.message : String(error) };
    }
  }
  return {};
}

const stringArray = { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 };
const filterProperties: Record<string, any> = {
  from: { type: 'string' }, to: { type: 'string' }, subject: { type: 'string' }, text: { type: 'string' },
  hasAttachment: { type: 'boolean' }, isUnread: { type: 'boolean' }, isPinned: { type: 'boolean' },
  before: { type: 'string' }, after: { type: 'string' },
  mailboxIds: { ...stringArray, description: 'Require membership in ALL listed mailboxes.' },
  excludeMailboxIds: { ...stringArray, description: 'Uses upstream advanced_search inMailboxOtherThan semantics.' },
};

function booleanArg(args: Record<string, any>, key: string, fallback = false): boolean {
  if (args[key] === undefined) return fallback;
  if (typeof args[key] !== 'boolean') throw new RefusedError(`${key} must be a boolean`);
  return args[key];
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RefusedError(`${name} must be a positive integer`);
  }
  return value;
}

function checkCap(count: number, cap: number): void {
  if (count > cap) throw new RefusedError(`${count} emails exceed maxEmails ${cap}; raise maxEmails explicitly to proceed.`);
}

function queryFilter(args: Record<string, any>): any {
  if (args.mailboxId !== undefined) return buildEmailQueryFilter({ mailboxId: requireString(args, 'mailboxId') });
  const filter = args.filter;
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new RefusedError('filter must be an object');
  for (const key of Object.keys(filter)) {
    if (!Object.hasOwn(filterProperties, key)) throw new RefusedError(`Unknown filter field: ${key}`);
    const type = filterProperties[key].type;
    if (type === 'array') requireStringArray(filter, key);
    else if (typeof filter[key] !== type) throw new RefusedError(`filter.${key} must be a ${type}`);
  }
  // Public bulk aliases map to the existing advanced-search builder.
  const { text, mailboxIds, ...rest } = filter;
  return buildEmailQueryFilter({ ...rest, query: text, requiredMailboxIds: mailboxIds });
}

async function selectEmails(client: JmapClient, args: Record<string, any>): Promise<string[]> {
  if (['emailIds', 'mailboxId', 'filter'].filter(key => args[key] !== undefined).length !== 1) {
    throw new RefusedError('Exactly one selector is required: emailIds, mailboxId, or filter.');
  }
  const cap = positiveInteger(args.maxEmails ?? 1000, 'maxEmails');
  if (args.emailIds !== undefined) {
    const ids = [...new Set(requireStringArray(args, 'emailIds'))];
    checkCap(ids.length, cap);
    return ids;
  }
  const filter = queryFilter(args);
  const ids: string[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  do {
    const page = await jmap(client, ['mail'], 'Email/query', {
      filter, calculateTotal: true, position: ids.length, limit: 500,
      sort: [{ property: 'receivedAt', isAscending: false }],
    });
    if (!Number.isSafeInteger(page.total) || page.total < 0 || !Array.isArray(page.ids)
      || !page.ids.every((id: unknown) => typeof id === 'string' && id.length > 0)) {
      throw new RefusedError('Email/query did not return valid ids and a total; refusing an unbounded operation.');
    }
    checkCap(page.total, cap);
    // ponytail: mail arriving mid-run shifts positions; a missed or repeated id is harmless here, so dedupe and carry on
    total = page.total;
    for (const id of page.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    if (page.ids.length === 0) break;
  } while (ids.length < total!);
  return ids;
}

function limit(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 500;
}

function isStateMap(value: unknown): value is Record<string, true> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(flag => flag === true);
}

async function getStates(client: JmapClient, ids: string[], batchSize: number): Promise<Map<string, EmailState>> {
  const states = new Map<string, EmailState>();
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const result = await jmap(client, ['mail'], 'Email/get', { ids: batch, properties: ['id', 'mailboxIds', 'keywords'] });
    if (!Array.isArray(result.list)) throw new JmapError('malformedResponse', 'Email/get omitted list');
    for (const email of result.list) {
      if (!batch.includes(email.id)) continue;
      if (!isStateMap(email.mailboxIds) || !isStateMap(email.keywords)) {
        throw new JmapError('malformedResponse', 'Email/get omitted mailboxIds or keywords; refusing an incomplete snapshot');
      }
      states.set(email.id, structuredClone({ mailboxIds: email.mailboxIds, keywords: email.keywords }));
    }
  }
  return states;
}

async function applyUpdates(client: JmapClient, tool: string, ids: string[], patch: (id: string) => object) {
  const capabilities = (await client.getSession()).capabilities[CORE];
  const getLimit = limit(capabilities?.maxObjectsInGet);
  const setLimit = limit(capabilities?.maxObjectsInSet);
  const before = await getStates(client, ids, getLimit);
  const notUpdated: Record<string, SetFailure> = Object.create(null);
  const changes: Change[] = [];
  for (const id of ids) {
    const state = before.get(id);
    if (state) changes.push({ emailId: id, before: state });
    else notUpdated[id] = { type: 'notFound', description: 'Email/get did not return this email; nothing was written.' };
  }
  const operation: Operation = { id: randomBytes(6).toString('hex'), tool, at: new Date().toISOString(), count: 0, changes: [] };
  const stored: Array<{ id: string } & EmailState> = [];
  let failure: unknown;
  try {
    for (let offset = 0; offset < changes.length; offset += setLimit) {
      const batch = changes.slice(offset, offset + setLimit);
      const result = await jmap(client, ['mail'], 'Email/set', {
        update: Object.fromEntries(batch.map(change => [change.emailId, patch(change.emailId)])),
      });
      const updated: string[] = [];
      for (const change of batch) {
        const id = change.emailId;
        if (result.notUpdated && Object.hasOwn(result.notUpdated, id)) {
          const error = result.notUpdated[id];
          notUpdated[id] = { type: error.type ?? 'setError', description: error.description ?? '' };
        } else if (result.updated && Object.hasOwn(result.updated, id)) {
          operation.changes.push(change);
          operation.count++;
          updated.push(id);
        } else {
          notUpdated[id] = { type: 'malformedResponse', description: 'Email/set did not acknowledge this email.' };
        }
      }
      // Read back stored state rather than echoing the requested patches.
      const after = await getStates(client, updated, getLimit);
      for (const id of updated) {
        const state = after.get(id);
        if (!state) throw new JmapError('notFound', 'An updated email was missing from the read-back');
        stored.push({ id, ...state });
      }
    }
  } catch (error) {
    failure = error;
  }
  // Retain already acknowledged writes even when a later batch/read-back fails.
  const audit = await recordOperation(operation);
  if (failure) {
    throw new JmapError(failure instanceof JmapError ? failure.type : 'requestFailed',
      failure instanceof Error ? failure.message : String(failure),
      { operationId: operation.id, updated: operation.count, notUpdated, ...audit });
  }
  // ponytail: full read-back of every email bloats the payload; 20 is enough to see the stored shape
  return { operationId: operation.id, updated: operation.count, notUpdated: { ...notUpdated }, storedSample: stored.slice(0, 20), ...audit };
}

function findOperation(args: Record<string, any>): Operation {
  const id = requireString(args, 'operationId');
  const operation = operations.find(entry => entry.id === id);
  if (!operation) throw new RefusedError(`Unknown operationId: ${id} (only the last 50 operations in this process are retained).`);
  return operation;
}

const bulkDefinitions = [
  { name: 'bulk_mark_read', description: 'Mark emails read or unread.', properties: { read: { type: 'boolean', default: true } }, required: [] },
  { name: 'bulk_pin', description: 'Pin or unpin emails.', properties: { pinned: { type: 'boolean', default: true } }, required: [] },
  { name: 'bulk_move', description: 'Replace all mailbox memberships with the target mailbox.', properties: { targetMailboxId: { type: 'string' } }, required: ['targetMailboxId'] },
  { name: 'bulk_delete', description: 'Move emails to the mailbox with role trash; never permanently delete. Refuses if no trash role exists.', properties: {}, required: [] },
  { name: 'bulk_add_labels', description: 'Add mailbox labels without changing other memberships.', properties: { mailboxIds: stringArray }, required: ['mailboxIds'] },
  { name: 'bulk_remove_labels', description: 'Remove only the specified mailbox labels.', properties: { mailboxIds: stringArray }, required: ['mailboxIds'] },
];

export const tools: ForkTool[] = bulkDefinitions.map(definition => ({
  def: {
    name: definition.name,
    description: definition.description + ' Select exactly one of emailIds, mailboxId (whole folder), or filter (empty means all mail). '
      + 'Queries use pages of 500; maxEmails defaults to 1000 and larger selections refuse until raised. '
      + 'dryRun returns count, first 200 emailIds and action without writes or logging. Above FASTMAIL_BULK_CONFIRM_THRESHOLD (default 100), require confirm:true. '
      + 'Returns operationId, requested/updated counts, per-id notUpdated, action and storedSample (mailboxIds/keywords of up to 20 emails read back from the server); auditLogError if file logging failed. '
      + 'Undo is available for the last 50 operations of this process via undo_operation.',
    inputSchema: {
      type: 'object',
      properties: {
        emailIds: stringArray,
        mailboxId: { type: 'string', description: 'Select every email in this mailbox.' },
        filter: { type: 'object', properties: filterProperties, additionalProperties: false },
        maxEmails: { type: 'integer', minimum: 1, default: 1000 },
        dryRun: { type: 'boolean', default: false }, confirm: { type: 'boolean', default: false },
        ...definition.properties,
      },
      required: definition.required,
    },
  },
  write: true,
  async run(args, { client }) {
    const dryRun = booleanArg(args, 'dryRun');
    const confirm = booleanArg(args, 'confirm');
    let patch: object;
    let action: string;
    switch (definition.name) {
      case 'bulk_mark_read': {
        const read = booleanArg(args, 'read', true);
        patch = { 'keywords/$seen': read ? true : null };
        action = read ? 'mark as read' : 'mark as unread';
        break;
      }
      case 'bulk_pin': {
        const pinned = booleanArg(args, 'pinned', true);
        patch = { 'keywords/$flagged': pinned ? true : null };
        action = pinned ? 'pin' : 'unpin';
        break;
      }
      case 'bulk_move': {
        const target = requireString(args, 'targetMailboxId');
        patch = { mailboxIds: { [target]: true } };
        action = `move to ${target}`;
        break;
      }
      case 'bulk_delete':
        patch = {};
        action = 'move to Trash';
        break;
      default: {
        const mailboxIds = requireStringArray(args, 'mailboxIds');
        const add = definition.name === 'bulk_add_labels';
        patch = Object.fromEntries(mailboxIds.map(id => [`mailboxIds/${id.replace(/~/g, '~0').replace(/\//g, '~1')}`, add ? true : null]));
        action = `${add ? 'add' : 'remove'} labels: ${mailboxIds.join(', ')}`;
      }
    }
    const ids = await selectEmails(client, args);
    if (dryRun) return { dryRun: true, count: ids.length, emailIds: ids.slice(0, 200), action };
    const threshold = Number(process.env.FASTMAIL_BULK_CONFIRM_THRESHOLD ?? 100);
    if (!Number.isSafeInteger(threshold) || threshold < 0) throw new RefusedError('FASTMAIL_BULK_CONFIRM_THRESHOLD must be a non-negative integer');
    if (ids.length > threshold && !confirm) {
      throw new RefusedError(`Refused: ${ids.length} emails exceed the confirmation threshold ${threshold}. Pass confirm: true to proceed.`, { count: ids.length, threshold });
    }
    if (definition.name === 'bulk_delete' && ids.length) {
      const trash = (await client.getMailboxes({ properties: ['id', 'role'] })).find(mailbox => mailbox.role === 'trash');
      if (!trash || typeof trash.id !== 'string' || !trash.id) throw new RefusedError('No mailbox with role trash exists; refusing bulk_delete.');
      patch = { mailboxIds: { [trash.id]: true } };
    }
    return { requested: ids.length, ...await applyUpdates(client, definition.name, ids, () => patch), action };
  },
}));

tools.push({
  def: {
    name: 'list_operations',
    description: 'List the last 50 process-local bulk/undo operations as id, tool, at (ISO), count (successful updates), without email state. Does not read the audit file.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  write: false,
  async run() {
    return operations.map(({ id, tool, at, count }) => ({ id, tool, at, count }));
  },
}, {
  def: {
    name: 'undo_operation',
    description: 'Restore mailboxIds and keywords from a retained operation using full-property sets; overwrites later changes to those fields. '
      + 'Refuses unknown/expired operationId. dryRun previews count/ids without writing. Returns restored count, notUpdated, stored read-back state and the undo operationId; '
      + 'auditLogError reports optional file-log failure. The undo is itself undoable.',
    inputSchema: { type: 'object', properties: { operationId: { type: 'string' }, dryRun: { type: 'boolean', default: false } }, required: ['operationId'] },
  },
  write: true,
  async run(args, { client }) {
    const operation = findOperation(args);
    const ids = operation.changes.map(change => change.emailId);
    if (booleanArg(args, 'dryRun')) return { dryRun: true, count: ids.length, emailIds: ids.slice(0, 200), action: `undo ${operation.id}` };
    const originals = new Map(operation.changes.map(change => [change.emailId, change.before]));
    const { updated, ...result } = await applyUpdates(client, 'undo_operation', ids, id => structuredClone(originals.get(id)!));
    return { restored: updated, ...result };
  },
}, {
  def: {
    name: 'export_operation_log',
    description: 'Return the full process-local operation ring as JSON, including before-state for undo. Optional operationId returns one entry; refuses an unknown/expired id. Does not read the audit file.',
    inputSchema: { type: 'object', properties: { operationId: { type: 'string' } }, required: [] },
  },
  write: false,
  async run(args) {
    return structuredClone(args.operationId === undefined ? operations : findOperation(args));
  },
});
