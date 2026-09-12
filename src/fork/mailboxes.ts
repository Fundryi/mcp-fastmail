// Mailbox (folder) tools: raw get, create with extra properties, update,
// delete with contents handling, merge. Every tool takes `mailboxId` or a
// `path` like `Parent/Child`.
import type { JmapClient } from '../jmap-client.js';
import { ForkTool, RefusedError, assertSet, jmap, requireConfirm, requireString } from './core.js';

const MAIL = ['mail'];
const TREE_PROPS = ['id', 'name', 'parentId', 'role', 'totalEmails', 'totalThreads'];

// ponytail: unconfirmed against live Fastmail, verify with a raw get
const UNCONFIRMED = 'color is the property Cyrus (the server Fastmail runs) stores, hex string like "#ff0000"; identityRef is NOT a confirmed property name. Run get_mailbox on a folder that has a default address set and pass the real name via `extra` if it differs.';

const target = {
  mailboxId: { type: 'string', description: 'Mailbox id. Give this or `path`.' },
  path: { type: 'string', description: 'Full folder path, e.g. "Parent/Child". Give this or `mailboxId`.' },
};

const editable = {
  name: { type: 'string', description: 'Leaf name. Must not contain "/".' },
  parentId: { type: ['string', 'null'], description: 'Parent mailbox id, null for top level.' },
  isSubscribed: { type: 'boolean' },
  sortOrder: { type: 'number' },
  color: { type: ['string', 'null'], description: 'Folder colour as a hex string, null to clear.' },
  identityRef: { type: 'string', description: 'Identity id linked to the folder. Unconfirmed property name.' },
  extra: { type: 'object', description: 'Raw Mailbox properties passed through untouched.' },
};

async function resolveId(client: JmapClient, args: Record<string, any>, idKey = 'mailboxId', pathKey = 'path'): Promise<string> {
  if (typeof args[idKey] === 'string' && args[idKey].trim()) return args[idKey].trim();
  if (typeof args[pathKey] === 'string' && args[pathKey].trim()) return (await client.getMailboxByName(args[pathKey].trim())).id;
  throw new RefusedError(`${idKey} or ${pathKey} is required`);
}

/** Mailbox/get for one id. No `properties` means the server returns every property it stores. */
async function getOne(client: JmapClient, id: string, properties?: string[]): Promise<any> {
  const res = await jmap(client, MAIL, 'Mailbox/get', { ids: [id], ...(properties ? { properties } : {}) });
  const mb = res?.list?.[0];
  if (!mb) throw new RefusedError(`Mailbox not found: ${id}`);
  return mb;
}

async function getTree(client: JmapClient): Promise<any[]> {
  return (await jmap(client, MAIL, 'Mailbox/get', { ids: null, properties: TREE_PROPS }))?.list ?? [];
}

/** An id from the tree, else a path resolved with getMailboxByName. */
async function resolveRef(client: JmapClient, tree: any[], args: Record<string, any>, key: string): Promise<string> {
  const v = requireString(args, key);
  return tree.some((m) => m.id === v) ? v : (await client.getMailboxByName(v)).id;
}

function pathOf(tree: any[], id: string): string {
  const byId = new Map(tree.map((m) => [m.id, m]));
  const parts: string[] = [];
  for (let cur = byId.get(id), depth = 0; cur && depth < 100; cur = cur.parentId ? byId.get(cur.parentId) : undefined, depth++) parts.unshift(cur.name);
  return parts.join('/');
}

function isSelfOrDescendant(tree: any[], id: string, candidateParent: string): boolean {
  const byId = new Map(tree.map((m) => [m.id, m]));
  for (let cur = candidateParent, depth = 0; cur && depth < 100; cur = byId.get(cur)?.parentId, depth++) if (cur === id) return true;
  return false;
}

function patchFrom(args: Record<string, any>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of ['name', 'parentId', 'isSubscribed', 'sortOrder', 'color', 'identityRef']) {
    if (key in args && args[key] !== undefined) patch[key] = args[key];
  }
  if (typeof patch.name === 'string' && patch.name.includes('/')) {
    throw new RefusedError('name must not contain "/". Pass a leaf name and use parentId to nest');
  }
  if (args.extra && typeof args.extra === 'object') Object.assign(patch, args.extra);
  return patch;
}

function assertDeletable(tree: any[], mb: any, what: string): void {
  if (mb.role) throw new RefusedError(`Refused: ${what} "${mb.name}" is a system folder (role: ${mb.role})`);
  const children = tree.filter((m) => m.parentId === mb.id).map((m) => m.name);
  if (children.length) throw new RefusedError(`Refused: ${what} "${mb.name}" has children, delete or move them first`, { children });
}

/** Move every email out of `from` into `to`. Folders are labels, so this patches mailboxIds per email. Returns the count. */
async function moveAll(client: JmapClient, from: string, to: string): Promise<number> {
  const session = await client.getSession();
  const batch = session.capabilities?.['urn:ietf:params:jmap:core']?.maxObjectsInSet ?? 500;
  const ids: string[] = [];
  for (let position = 0; ; position += 500) {
    const page = await jmap(client, MAIL, 'Email/query', { filter: { inMailbox: from }, position, limit: 500 });
    ids.push(...(page?.ids ?? []));
    if (!page?.ids?.length || page.ids.length < 500) break;
  }
  for (let i = 0; i < ids.length; i += batch) {
    const update: Record<string, unknown> = {};
    for (const id of ids.slice(i, i + batch)) update[id] = { [`mailboxIds/${from}`]: null, [`mailboxIds/${to}`]: true };
    const res = await jmap(client, MAIL, 'Email/set', { update });
    for (const id of Object.keys(update)) assertSet(res, 'updated', id);
  }
  return ids.length;
}

async function destroy(client: JmapClient, id: string, onDestroyRemoveEmails: boolean): Promise<void> {
  assertSet(await jmap(client, MAIL, 'Mailbox/set', { destroy: [id], onDestroyRemoveEmails }), 'destroyed', id);
}

export const tools: ForkTool[] = [
  {
    def: {
      name: 'get_mailbox',
      description: 'Fetch one mailbox with every property Fastmail stores (no properties filter), including whatever it uses for folder colour and identity link. Returns the raw Mailbox object. Refuses when neither mailboxId nor path is given or the mailbox does not exist.',
      inputSchema: { type: 'object', properties: { ...target } },
    },
    write: false,
    async run(args, { client }) {
      return getOne(client, await resolveId(client, args));
    },
  },
  {
    def: {
      name: 'create_mailbox',
      description: `Create a mailbox (folder). Sends name, parentId (null = top level), isSubscribed, sortOrder, color, identityRef and any raw properties in \`extra\`, then re-fetches and returns the stored Mailbox object as the server has it. Refuses a name containing "/". ${UNCONFIRMED}`,
      inputSchema: { type: 'object', properties: { ...editable }, required: ['name'] },
    },
    write: true,
    async run(args, { client }) {
      const name = requireString(args, 'name');
      const create = { parentId: null, ...patchFrom({ ...args, name }) };
      const echo = assertSet(await jmap(client, MAIL, 'Mailbox/set', { create: { new: create } }), 'created', 'new');
      return getOne(client, echo.id);
    },
  },
  {
    def: {
      name: 'update_mailbox',
      description: `Patch one mailbox: name, parentId (null = top level), isSubscribed, sortOrder, color, identityRef, or raw properties in \`extra\`. Only the fields given are sent. Returns the re-fetched stored Mailbox object. Refuses when no field is given, when name contains "/", or when parentId is the mailbox itself or one of its descendants. ${UNCONFIRMED}`,
      inputSchema: { type: 'object', properties: { ...target, ...editable } },
    },
    write: true,
    async run(args, { client }) {
      const id = await resolveId(client, args);
      const patch = patchFrom(args);
      if (!Object.keys(patch).length) throw new RefusedError('Refused: no field to update was given');
      if (typeof patch.parentId === 'string' && isSelfOrDescendant(await getTree(client), id, patch.parentId)) {
        throw new RefusedError('Refused: parentId is the mailbox itself or one of its descendants');
      }
      assertSet(await jmap(client, MAIL, 'Mailbox/set', { update: { [id]: patch } }), 'updated', id);
      return getOne(client, id);
    },
  },
  {
    def: {
      name: 'delete_mailbox',
      description: 'Permanently destroy a mailbox (folder). Requires confirm: true. Refuses system folders (any with a role) and folders that still have children. When the folder holds mail: with moveContentsTo (id or path) every email is moved there first; without it the call refuses unless onDestroyRemoveEmails: true is passed explicitly, and then emails whose ONLY folder is this one are destroyed permanently (not trashed, cannot be undone). dryRun: true returns the plan (counts, what would move, what would be destroyed) without writing. Returns { destroyed, movedEmails, name, path }.',
      inputSchema: {
        type: 'object',
        properties: {
          ...target,
          moveContentsTo: { type: 'string', description: 'Mailbox id or path to move all emails into before destroying.' },
          onDestroyRemoveEmails: { type: 'boolean', description: 'Permanently destroy emails whose only folder is this one. Default false.' },
          dryRun: { type: 'boolean', description: 'Report the plan, write nothing.' },
          confirm: { type: 'boolean', description: 'Must be true. The destroy is permanent.' },
        },
      },
    },
    write: true,
    async run(args, { client }) {
      const id = await resolveId(client, args);
      const tree = await getTree(client);
      const mb = tree.find((m) => m.id === id);
      if (!mb) throw new RefusedError(`Mailbox not found: ${id}`);
      assertDeletable(tree, mb, 'mailbox');
      const to = args.moveContentsTo ? await resolveRef(client, tree, args, 'moveContentsTo') : null;
      const removeEmails = args.onDestroyRemoveEmails === true;
      if (mb.totalEmails > 0 && !to && !removeEmails) {
        throw new RefusedError(`Refused: "${mb.name}" holds ${mb.totalEmails} emails. Pass moveContentsTo, or onDestroyRemoveEmails: true to destroy them permanently.`, { totalEmails: mb.totalEmails });
      }
      const plan = {
        name: mb.name, path: pathOf(tree, id), totalEmails: mb.totalEmails, totalThreads: mb.totalThreads,
        moveEmailsTo: to, destroyEmails: !to && removeEmails && mb.totalEmails > 0,
      };
      if (args.dryRun === true) return { dryRun: true, ...plan };
      requireConfirm(args, `delete_mailbox destroys "${plan.path}" permanently`);
      const movedEmails = to && mb.totalEmails > 0 ? await moveAll(client, id, to) : 0;
      await destroy(client, id, removeEmails);
      return { destroyed: id, movedEmails, name: plan.name, path: plan.path };
    },
  },
  {
    def: {
      name: 'merge_mailbox',
      description: 'Move every email from source into target, then permanently destroy the now-empty source folder. Requires confirm: true. Refuses when source is a system folder (has a role), has children, or equals target. dryRun: true returns the plan without writing. Returns { destroyed, movedEmails, source, target }.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Mailbox id or path to empty and destroy.' },
          target: { type: 'string', description: 'Mailbox id or path that receives the mail.' },
          dryRun: { type: 'boolean', description: 'Report the plan, write nothing.' },
          confirm: { type: 'boolean', description: 'Must be true. The destroy of source is permanent.' },
        },
        required: ['source', 'target'],
      },
    },
    write: true,
    async run(args, { client }) {
      const tree = await getTree(client);
      const src = await resolveRef(client, tree, args, 'source');
      const dst = await resolveRef(client, tree, args, 'target');
      if (src === dst) throw new RefusedError('Refused: source and target are the same mailbox');
      const mb = tree.find((m) => m.id === src);
      if (!mb) throw new RefusedError(`Mailbox not found: ${src}`);
      assertDeletable(tree, mb, 'source');
      const plan = { source: pathOf(tree, src), target: pathOf(tree, dst), totalEmails: mb.totalEmails, totalThreads: mb.totalThreads };
      if (args.dryRun === true) return { dryRun: true, ...plan };
      requireConfirm(args, `merge_mailbox destroys "${plan.source}" permanently after moving its mail`);
      const movedEmails = mb.totalEmails > 0 ? await moveAll(client, src, dst) : 0;
      await destroy(client, src, false);
      return { destroyed: src, movedEmails, ...plan };
    },
  },
];
