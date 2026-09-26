// Optional passthrough to Fastmail's own MCP server (https://api.fastmail.com/mcp).
// Enabled only when FASTMAIL_MCP_TOKEN is set (an API token of type "MCP").
// Exposes the official tools our JMAP token cannot reach, under the prefix
// `official_`, so both servers can run in one client without name clashes.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ForkTool, ToolDef } from './core.js';
import { RefusedError } from './core.js';

export const OFFICIAL_URL = 'https://api.fastmail.com/mcp';
export const PREFIX = 'official_';

/** Official tools that add something JMAP tokens lack. Everything else we do ourselves. */
const ALWAYS = new Set([
  'create_note', 'read_note', 'search_notes', 'update_note', 'add_to_note', 'delete_note',
  'set_memo', 'search_org_contacts', 'rsvp_event', 'compose_event',
]);
/** Calendar tools: only when CalDAV is not configured, since our CalDAV tools cover them. */
const CALENDAR = new Set(['list_calendars', 'search_events', 'create_event', 'update_event', 'delete_event']);
const WRITES = new Set(['create_note', 'update_note', 'add_to_note', 'delete_note', 'set_memo', 'rsvp_event', 'compose_event', 'create_event', 'update_event', 'delete_event']);

export interface OfficialClient {
  listTools(): Promise<{ tools: ToolDef[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<any>;
}

export function officialToken(): string | undefined {
  const v = process.env.FASTMAIL_MCP_TOKEN?.trim();
  return v && !/\$\{[^}]+\}/.test(v) ? v : undefined;
}

function caldavConfigured(): boolean {
  return ['FASTMAIL_CALDAV_USERNAME', 'USER_CONFIG_FASTMAIL_CALDAV_USERNAME'].some((k) => process.env[k]?.trim());
}

async function connect(token: string): Promise<OfficialClient> {
  const transport = new StreamableHTTPClientTransport(new URL(OFFICIAL_URL), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'fastmail-mcp-fork', version: '1.0.0' });
  await client.connect(transport);
  return client as unknown as OfficialClient;
}

/** Wrap the official tool list into ForkTools. Exported for tests. */
export function wrap(remote: ToolDef[], call: OfficialClient['callTool'], withCalendar: boolean): ForkTool[] {
  return remote
    .filter((t) => ALWAYS.has(t.name) || (withCalendar && CALENDAR.has(t.name)))
    .map((t) => ({
      def: {
        ...t,
        name: PREFIX + t.name,
        description: `[Fastmail official MCP, via FASTMAIL_MCP_TOKEN] ${t.description ?? ''}`,
      },
      write: WRITES.has(t.name),
      async run(args) {
        const res = await call({ name: t.name, arguments: args });
        if (res?.isError) {
          const msg = (res.content ?? []).map((c: any) => c?.text ?? '').join('\n');
          throw new RefusedError(`official ${t.name}: ${msg || 'error'}`, { official: true });
        }
        return res;
      },
    }));
}

let loading: Promise<ForkTool[]> | null = null;

/** Tools from the official server, or [] when no token is set. Cached for the process. */
export function officialTools(factory: (token: string) => Promise<OfficialClient> = connect): Promise<ForkTool[]> {
  if (loading) return loading;
  const token = officialToken();
  if (!token) return (loading = Promise.resolve([]));
  loading = (async () => {
    try {
      const c = await factory(token);
      const { tools } = await c.listTools();
      return wrap(tools, (p) => c.callTool(p), !caldavConfigured());
    } catch (e) {
      console.error(`Fastmail official MCP not reachable, passthrough disabled: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  })();
  return loading;
}

/** Test hook. */
export function resetOfficial(): void {
  loading = null;
}
