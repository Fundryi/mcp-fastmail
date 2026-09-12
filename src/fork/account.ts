import type { JmapClient } from '../jmap-client.js';
import { type ForkTool, JmapError, RefusedError, assertSet, jmap, jmapBatch, requireConfirm, requireString, using } from './core.js';

const MASKED = 'https://www.fastmail.com/dev/maskedemail';
const SCRIPT_PROPERTIES = ['id', 'name', 'isActive', 'blobId'];
const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const boolean = { type: 'boolean' };
const addresses = { type: ['array', 'null'], items: {
  type: 'object', properties: { name: nullableString, email: string }, required: ['email'],
} };
const identityProperties = { name: string, email: string, replyTo: addresses, bcc: addresses, textSignature: string, htmlSignature: string };
const vacationProperties = { isEnabled: boolean, fromDate: { ...nullableString, format: 'date-time' },
  toDate: { ...nullableString, format: 'date-time' }, subject: nullableString, textBody: nullableString, htmlBody: nullableString };
const maskedProperties = { state: { type: 'string', enum: ['enabled', 'disabled', 'deleted'] }, description: string, forDomain: string };
const capabilityHelp = ' Refuses unavailable capabilities with the likely missing API token scope.';

async function capabilities(client: JmapClient, ...caps: string[]) {
  const session = await client.getSession();
  for (const uri of using(...caps).slice(1)) {
    if (!Object.hasOwn(session.capabilities, uri)) {
      throw new RefusedError(`Missing capability ${uri}; the API token likely lacks scope ${uri}. Check token permissions and server support.`, { capability: uri, likelyMissingScope: uri });
    }
  }
  return session;
}

// Validate the fields we accept; undefined stays omitted and null stays explicit.
function fields(args: Record<string, any>, properties: Record<string, any>): Record<string, any> {
  const patch: Record<string, any> = {};
  for (const [key, schema] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined) continue;
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (![schema.type].flat().includes(type) || (schema.enum && !schema.enum.includes(value))) {
      throw new RefusedError(`Invalid ${key}: expected ${schema.enum?.join('|') ?? [schema.type].flat().join('|')}`);
    }
    if (type === 'array' && !value.every((address: any) => address && typeof address === 'object'
      && typeof address.email === 'string' && address.email.trim()
      && (address.name == null || typeof address.name === 'string'))) {
      throw new RefusedError(`${key} must contain email address objects with an email and optional name`);
    }
    patch[key] = value;
  }
  return patch;
}

function requirePatch(patch: Record<string, any>) {
  if (!Object.keys(patch).length) throw new RefusedError('At least one field must be given to update');
  return patch;
}

function list(result: any): any[] {
  if (!Array.isArray(result?.list)) throw new JmapError('malformedResponse', 'Expected a list in the get response');
  return result.list;
}

function stored(result: any, id: string) {
  const object = list(result).find(item => item.id === id);
  if (!object) throw new JmapError('notFound', `${id} was not returned by the server`);
  return object;
}

function setId(result: any, kind: 'created' | 'updated', id: string): string {
  const echo = assertSet(result, kind, id);
  if (!result?.[kind] || !Object.hasOwn(result[kind], id) || (kind === 'created' && typeof echo?.id !== 'string')) {
    throw new JmapError('malformedResponse', `Missing ${kind} confirmation for ${id}`);
  }
  return kind === 'created' ? echo.id : id;
}

async function save(client: JmapClient, cap: string, type: string, id: string, patch: Record<string, any>, create = false, account?: string) {
  const accountArgs = account === undefined ? {} : { accountId: account };
  const result = await jmap(client, [cap], `${type}/set`, { ...accountArgs, [create ? 'create' : 'update']: { [id]: patch } });
  const savedId = setId(result, create ? 'created' : 'updated', id);
  return stored(await jmap(client, [cap], `${type}/get`, { ...accountArgs, ids: [savedId] }), savedId);
}

async function maskedAccount(client: JmapClient) {
  const session = await capabilities(client, MASKED);
  const accountId = session.primaryAccounts?.[MASKED];
  if (typeof accountId !== 'string' || !accountId.trim()) throw new RefusedError(`Missing session.primaryAccounts[${MASKED}]; cannot select the masked email account`);
  return accountId;
}

function contentArg(args: Record<string, any>): string {
  if (typeof args.content !== 'string') throw new RefusedError('content must be a string (an empty Sieve script is allowed)');
  return args.content;
}

function upload(content: string) {
  return { create: { b1: { data: [{ 'data:asText': content }], type: 'application/sieve' } } };
}

async function scriptContent(client: JmapClient, blobId: string): Promise<string> {
  const blob = stored(await jmap(client, ['blob'], 'Blob/get', { ids: [blobId], properties: ['data:asText'] }), blobId);
  if (typeof blob['data:asText'] !== 'string' || blob.isTruncated || blob.isEncodingProblem) {
    throw new JmapError('invalidBlob', 'Cannot read complete Sieve script text; no script will be changed');
  }
  return blob['data:asText'];
}

async function validate(client: JmapClient, content: string) {
  // RFC 9404 creation references use #b1; Blob/upload returns created.b1.id.
  const [blob, result] = await jmapBatch(client, ['blob', 'sieve'], [
    ['Blob/upload', upload(content)], ['SieveScript/validate', { blobId: '#b1' }],
  ]);
  setId(blob, 'created', 'b1');
  if (!Object.hasOwn(result, 'error')) throw new JmapError('malformedResponse', 'Missing Sieve validation error result');
  return { valid: result.error === null, error: result.error };
}

export const tools: ForkTool[] = [
  {
    def: { name: 'get_session', description: 'Fetch the raw JMAP session and return username, apiUrl, primaryAccounts, the session capabilities and, per account, its name and accountCapabilities. Use it to see which JMAP extensions this API token can reach (sieve, blob, quota, maskedemail) before calling the tools that need them.',
      inputSchema: { type: 'object', properties: {}, required: [] } },
    write: false,
    async run(_args, { client }) {
      // The client keeps auth private; the session URL and headers are the only things needed here.
      const auth = (client as any).auth;
      const res = await fetch(auth.getSessionUrl(), { headers: auth.getAuthHeaders() });
      if (!res.ok) throw new JmapError('sessionFailed', `${res.status} ${res.statusText}`);
      const s: any = await res.json();
      const accounts: Record<string, any> = {};
      for (const [id, a] of Object.entries<any>(s.accounts ?? {})) {
        accounts[id] = { name: a.name, isPersonal: a.isPersonal, isReadOnly: a.isReadOnly, accountCapabilities: a.accountCapabilities };
      }
      return { username: s.username, apiUrl: s.apiUrl, state: s.state, primaryAccounts: s.primaryAccounts, capabilities: s.capabilities, accounts };
    },
  },
  {
    def: { name: 'list_sieve_scripts', description: 'List all Sieve scripts as id, name, isActive, and blobId.' + capabilityHelp,
      inputSchema: { type: 'object', properties: {}, required: [] } },
    write: false,
    async run(_args, { client }) {
      await capabilities(client, 'sieve');
      return list(await jmap(client, ['sieve'], 'SieveScript/get', { ids: null, properties: SCRIPT_PROPERTIES }));
    },
  },
  {
    def: { name: 'get_sieve_script', description: 'Get script metadata and full content by id or active: true (exactly one). Refuses a missing script.' + capabilityHelp,
      inputSchema: { type: 'object', properties: { id: string, active: boolean }, required: [] } },
    write: false,
    async run(args, { client }) {
      fields(args, { active: boolean });
      const hasId = args.id !== undefined;
      if (hasId === (args.active === true) || (hasId && args.active !== undefined)) throw new RefusedError('Give exactly one of id or active: true');
      const id = hasId ? requireString(args, 'id') : null;
      await capabilities(client, 'sieve', 'blob');
      const scripts = list(await jmap(client, ['sieve'], 'SieveScript/get', { ids: id ? [id] : null, properties: SCRIPT_PROPERTIES }));
      const script = scripts.find(s => id ? s.id === id : s.isActive);
      if (!script) throw new RefusedError(id ? `Sieve script ${id} was not found` : 'No active Sieve script exists');
      return { ...script, content: await scriptContent(client, script.blobId) };
    },
  },
  {
    def: { name: 'validate_sieve', description: 'Validate Sieve content and return { valid, error }. Uploads a temporary blob for RFC validation, without creating or activating a script.' + capabilityHelp,
      inputSchema: { type: 'object', properties: { content: string }, required: ['content'] } },
    write: false,
    async run(args, { client }) {
      const content = contentArg(args);
      await capabilities(client, 'sieve', 'blob');
      return validate(client, content);
    },
  },
  {
    def: { name: 'set_sieve_script', description: 'Create or overwrite a named Sieve script. Defaults to name mcp and activate false. Overwriting or activating requires confirm: true. Reads a complete active-script backup before writing and returns stored id/name/isActive plus previousActive { id, name, content }, or null. dryRun uploads a temporary blob and validates only, returning the proposed action and confirmation requirement. Updating an already active script leaves it active. Refuses an unreadable backup or a concurrent script change. Fastmail keeps the rules from its web UI as generated blocks inside the active script: read it first with get_sieve_script and keep those blocks byte for byte, or the UI rules break.' + capabilityHelp,
      inputSchema: { type: 'object', properties: { content: string, name: { ...string, default: 'mcp' }, activate: { ...boolean, default: false }, confirm: boolean, dryRun: boolean }, required: ['content'] } },
    write: true,
    async run(args, { client }) {
      const content = contentArg(args);
      fields(args, { activate: boolean, dryRun: boolean });
      const name = args.name === undefined ? 'mcp' : requireString(args, 'name');
      const activate = args.activate === true;
      await capabilities(client, 'sieve', 'blob');
      const current = await jmap(client, ['sieve'], 'SieveScript/get', { ids: null, properties: SCRIPT_PROPERTIES });
      const scripts = list(current);
      const existing = scripts.find(s => s.name === name);
      const requiresConfirm = activate || !!existing;
      if (args.dryRun === true) {
        return { dryRun: true, ...await validate(client, content), action: existing ? 'update' : 'create', id: existing?.id ?? null, name, activate, requiresConfirm };
      }
      if (requiresConfirm) requireConfirm(args, `writing ${name} will ${existing ? 'overwrite the existing script' : 'create a script'}${activate ? ' and activate it for incoming mail' : ''}`);
      const active = scripts.find(s => s.isActive);
      const previousActive = active ? { id: active.id, name: active.name, content: await scriptContent(client, active.blobId) } : null;
      const setArgs: Record<string, any> = existing
        ? { update: { [existing.id]: { blobId: '#b1' } } }
        : { create: { s1: { name, blobId: '#b1' } } };
      if (current.state !== undefined) setArgs.ifInState = current.state;
      if (activate) setArgs.onSuccessActivateScript = existing?.id ?? '#s1';
      const [blob, result] = await jmapBatch(client, ['blob', 'sieve'], [['Blob/upload', upload(content)], ['SieveScript/set', setArgs]]);
      setId(blob, 'created', 'b1');
      const id = setId(result, existing ? 'updated' : 'created', existing?.id ?? 's1');
      const saved = stored(await jmap(client, ['sieve'], 'SieveScript/get', { ids: [id], properties: SCRIPT_PROPERTIES }), id);
      return { id: saved.id, name: saved.name, isActive: saved.isActive, previousActive };
    },
  },
  {
    def: { name: 'create_identity', description: 'Create a sending identity with name, email, and optional replyTo/bcc address arrays and signatures. Returns the re-fetched identity; server restrictions on identity creation still apply.' + capabilityHelp,
      inputSchema: { type: 'object', properties: identityProperties, required: ['name', 'email'] } },
    write: true,
    async run(args, { client }) {
      const patch = fields(args, identityProperties);
      if (patch.name === undefined) throw new RefusedError('name is required');
      requireString(args, 'email');
      await capabilities(client, 'submission');
      return save(client, 'submission', 'Identity', 'i1', patch, true);
    },
  },
  {
    def: { name: 'update_identity', description: 'Patch only supplied identity fields and return the re-fetched identity. Refuses an empty patch. Server restrictions on editable identity fields still apply.' + capabilityHelp,
      inputSchema: { type: 'object', properties: { identityId: string, ...identityProperties }, required: ['identityId'] } },
    write: true,
    async run(args, { client }) {
      const id = requireString(args, 'identityId');
      const patch = requirePatch(fields(args, identityProperties));
      if (patch.email !== undefined) requireString(patch, 'email');
      await capabilities(client, 'submission');
      return save(client, 'submission', 'Identity', id, patch);
    },
  },
  {
    def: { name: 'get_vacation_response', description: 'Return the vacation-response singleton and its current settings.' + capabilityHelp,
      inputSchema: { type: 'object', properties: {}, required: [] } },
    write: false,
    async run(_args, { client }) {
      await capabilities(client, 'vacationresponse');
      return stored(await jmap(client, ['vacationresponse'], 'VacationResponse/get', { ids: ['singleton'] }), 'singleton');
    },
  },
  {
    def: { name: 'set_vacation_response', description: 'Patch only supplied vacation settings on singleton and return the re-fetched response. Use null to clear dates or text fields. Refuses an empty patch.' + capabilityHelp,
      inputSchema: { type: 'object', properties: vacationProperties, required: [] } },
    write: true,
    async run(args, { client }) {
      const patch = requirePatch(fields(args, vacationProperties));
      await capabilities(client, 'vacationresponse');
      return save(client, 'vacationresponse', 'VacationResponse', 'singleton', patch);
    },
  },
  {
    def: { name: 'get_quota', description: 'Return all account quota records, including usage and server limits.' + capabilityHelp,
      inputSchema: { type: 'object', properties: {}, required: [] } },
    write: false,
    async run(_args, { client }) {
      await capabilities(client, 'quota');
      return list(await jmap(client, ['quota'], 'Quota/get', { ids: null }));
    },
  },
  {
    def: { name: 'list_masked_emails', description: 'List masked email records from the masked-email primary account. Refuses a missing primary account.' + capabilityHelp,
      inputSchema: { type: 'object', properties: {}, required: [] } },
    write: false,
    async run(_args, { client }) {
      const accountId = await maskedAccount(client);
      return list(await jmap(client, [MASKED], 'MaskedEmail/get', { accountId, ids: null }));
    },
  },
  {
    def: { name: 'create_masked_email', description: 'Create a masked address and return its re-fetched record. state defaults to enabled. forDomain is the site using the address, not the generated email domain; emailPrefix requests the generated local-part prefix. Uses the masked-email primary account and refuses if it is missing.' + capabilityHelp,
      inputSchema: { type: 'object', properties: { ...maskedProperties, state: { ...maskedProperties.state, default: 'enabled' }, emailPrefix: string }, required: [] } },
    write: true,
    async run(args, { client }) {
      const patch = { state: 'enabled', ...fields(args, { ...maskedProperties, emailPrefix: string }) };
      const accountId = await maskedAccount(client);
      return save(client, MASKED, 'MaskedEmail', 'm1', patch, true, accountId);
    },
  },
  {
    def: { name: 'update_masked_email', description: 'Patch supplied state, description, or forDomain and return the re-fetched masked address. enabled receives normally; disabled sends new mail to Trash; deleted bounces new mail. Does not destroy the record. Refuses an empty patch or missing masked-email primary account.' + capabilityHelp,
      inputSchema: { type: 'object', properties: { id: string, ...maskedProperties }, required: ['id'] } },
    write: true,
    async run(args, { client }) {
      const id = requireString(args, 'id');
      const patch = requirePatch(fields(args, maskedProperties));
      const accountId = await maskedAccount(client);
      return save(client, MASKED, 'MaskedEmail', id, patch, false, accountId);
    },
  },
  {
    def: { name: 'get_account_summary', description: 'Return the upstream account summary plus capability URIs, identities, unique lowercase identity domains, catch-all domains, quota (null when unavailable), and warnings. Failures in added fields become warnings and preserve the upstream summary.',
      inputSchema: { type: 'object', properties: {}, required: [] } },
    write: false,
    async run(_args, { client }) {
      const base = await client.getAccountSummary();
      const extra = { capabilities: [] as string[], identities: [] as { id: string; email: string; name: string }[],
        domains: [] as string[], catchAllDomains: [] as string[], quota: null as any[] | null, warnings: [] as string[] };
      const warn = (field: string, error: unknown) => extra.warnings.push(`${field}: ${error instanceof Error ? error.message : String(error)}`);
      try {
        extra.capabilities = Object.keys((await client.getSession()).capabilities);
      } catch (error) {
        warn('capabilities', error);
      }
      try {
        await capabilities(client, 'submission');
        extra.identities = list(await jmap(client, ['submission'], 'Identity/get', { ids: null })).map(({ id, email, name }) => ({ id, email, name }));
        const domains = new Set<string>();
        const catchAll = new Set<string>();
        for (const { email } of extra.identities) {
          if (typeof email !== 'string') continue;
          const at = email.lastIndexOf('@');
          const domain = email.slice(at + 1).toLowerCase();
          if (at < 0 || !domain) continue;
          domains.add(domain);
          if (email.slice(0, at) === '*' || at === 0) catchAll.add(domain);
        }
        extra.domains = [...domains];
        extra.catchAllDomains = [...catchAll];
      } catch (error) {
        warn('identities', error);
      }
      if (extra.capabilities.includes(using('quota')[1])) {
        try {
          extra.quota = list(await jmap(client, ['quota'], 'Quota/get', { ids: null }));
        } catch (error) {
          warn('quota', error);
        }
      }
      return { ...base, ...extra };
    },
  },
  {
    def: { name: 'list_aliases_with_usage', description: 'Return each identity with mailCount and lastReceivedAt (null if none found), using one batched set of recipient Email/query calls. Counts are mail matching the identity email in To, not delivery logs. Refuses more than 100 identities.' + capabilityHelp,
      inputSchema: { type: 'object', properties: {}, required: [] } },
    write: false,
    async run(_args, { client }) {
      await capabilities(client, 'submission', 'mail');
      const identities = list(await jmap(client, ['submission'], 'Identity/get', { ids: null }));
      if (identities.length > 100) throw new RefusedError('Usage lookup is limited to 100 identities per request');
      if (!identities.length) return [];
      // A `*@domain` catch-all identity matches every address on that domain; JMAP `to` is a substring match.
      const queries = await jmapBatch(client, ['mail'], identities.map(({ email }) => ['Email/query', {
        filter: { to: String(email).replace(/^\*@/, '@') }, calculateTotal: true, limit: 1, sort: [{ property: 'receivedAt', isAscending: false }],
      }]));
      for (const query of queries) {
        if (!Array.isArray(query?.ids) || !query.ids.every((id: unknown) => typeof id === 'string')
          || !Number.isSafeInteger(query.total) || query.total < 0) {
          throw new JmapError('malformedResponse', 'Email/query did not return message ids and a valid total');
        }
      }
      const ids = [...new Set<string>(queries.flatMap(query => query.ids))];
      const emails = ids.length ? list(await jmap(client, ['mail'], 'Email/get', { ids, properties: ['id', 'receivedAt'] })) : [];
      const dates = new Map(emails.map(email => [email.id, email.receivedAt]));
      return identities.map(({ id, email, name }, i) => ({ id, email, name, mailCount: queries[i].total,
        lastReceivedAt: dates.get(queries[i].ids[0]) ?? null }));
    },
  },
];
