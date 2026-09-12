// Shared plumbing for fork-only tools. Upstream files stay untouched; every
// new tool lives under src/fork/ and registers through this module.
import type { JmapClient } from '../jmap-client.js';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface Ctx {
  client: JmapClient;
}

export interface ForkTool {
  def: ToolDef;
  /** true when the tool changes server state. Blocked by FASTMAIL_READ_ONLY. */
  write: boolean;
  run(args: Record<string, any>, ctx: Ctx): Promise<unknown>;
}

/** A JMAP method- or set-level error, kept structured so the caller can branch on `type`. */
export class JmapError extends Error {
  constructor(
    public readonly type: string,
    public readonly description?: string,
    public readonly detail?: unknown
  ) {
    super(`JMAP ${type}${description ? ': ' + description : ''}`);
    this.name = 'JmapError';
  }
}

/** Refused on purpose: missing confirm, dryRun, read-only, unsafe target. */
export class RefusedError extends Error {
  constructor(message: string, public readonly detail?: unknown) {
    super(message);
    this.name = 'RefusedError';
  }
}

const URN = 'urn:ietf:params:jmap:';
const CORE = URN + 'core';

/** Expand short capability names ("mail") to full URIs; full URIs pass through. */
export function using(...caps: string[]): string[] {
  const out = new Set<string>([CORE]);
  for (const c of caps) out.add(c.includes(':') ? c : URN + c);
  return [...out];
}

export type MethodCall = [method: string, args: Record<string, unknown>, tag?: string];

/**
 * Run several JMAP methods in one request. Returns one result per call, in
 * order. A method-level error throws JmapError.
 */
export async function jmapBatch(client: JmapClient, caps: string[], calls: MethodCall[]): Promise<any[]> {
  const session = await client.getSession();
  // RFC 8620 §2: each capability names its own primary account. Sieve, blob,
  // quota or vacation may live on a different account than mail.
  const accountId = using(...caps).slice(1).map((c) => session.primaryAccounts?.[c]).find(Boolean) ?? session.accountId;
  const methodCalls: [string, any, string][] = calls.map(([method, args, tag], i) => [
    method,
    { accountId, ...args },
    tag ?? `c${i}`,
  ]);
  const response = await client.makeRequest({ using: using(...caps), methodCalls });
  return calls.map((_, i) => {
    const entry = response.methodResponses[i];
    if (!Array.isArray(entry) || entry.length < 2) {
      throw new JmapError('malformedResponse', `response ${i} is malformed`);
    }
    const [tag, result] = entry;
    if (tag === 'error') throw new JmapError(result?.type ?? 'unknown', result?.description, result);
    return result;
  });
}

/** One JMAP method. Returns its result. */
export async function jmap(client: JmapClient, caps: string[], method: string, args: Record<string, unknown>): Promise<any> {
  const [result] = await jmapBatch(client, caps, [[method, args]]);
  return result;
}

/**
 * Throw if a Foo/set response reports a failure for the given id. Returns
 * the created/updated record (server echo) when present.
 */
export function assertSet(result: any, kind: 'created' | 'updated' | 'destroyed', id: string): any {
  const failed = result?.[`not${kind[0].toUpperCase()}${kind.slice(1)}`]?.[id];
  if (failed) {
    const props = Array.isArray(failed.properties) ? ` (properties: ${failed.properties.join(', ')})` : '';
    throw new JmapError(failed.type ?? 'setError', (failed.description ?? '') + props || undefined, failed);
  }
  const ok = result?.[kind];
  if (Array.isArray(ok)) {
    if (!ok.includes(id)) throw new JmapError('setError', `${id} not in ${kind}`);
    return id;
  }
  if (ok && !(id in ok)) throw new JmapError('setError', `${id} not in ${kind}`);
  return ok?.[id] ?? null;
}

/** MCP text result. */
export function text(value: unknown) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

export function isReadOnly(): boolean {
  const v = (process.env.FASTMAIL_READ_ONLY ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function requireString(args: Record<string, any>, key: string): string {
  const v = args?.[key];
  if (typeof v !== 'string' || v.trim() === '') throw new RefusedError(`${key} is required`);
  return v.trim();
}

export function requireStringArray(args: Record<string, any>, key: string): string[] {
  const v = args?.[key];
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && x)) {
    throw new RefusedError(`${key} must be a non-empty array of strings`);
  }
  return v;
}

/** Explicit confirm gate for a named target with hidden cost. */
export function requireConfirm(args: Record<string, any>, what: string): void {
  if (args?.confirm !== true) {
    throw new RefusedError(`Refused: ${what}. Pass confirm: true to proceed.`, { needsConfirm: true });
  }
}

/**
 * Resolve a folder path. Fastmail nests every user folder under Inbox, so
 * "FUNDRYI.DE/STEAM" is tried as given and then as "Inbox/FUNDRYI.DE/STEAM".
 */
export async function byPath(client: JmapClient, path: string): Promise<{ id: string; name: string; parentId: string | null; path: string }> {
  try {
    return await client.getMailboxByName(path);
  } catch (e) {
    if (/^Inbox\//i.test(path)) throw e;
    try {
      return await client.getMailboxByName('Inbox/' + path);
    } catch {
      throw new RefusedError(`Mailbox not found: ${path} (also tried Inbox/${path})`);
    }
  }
}
