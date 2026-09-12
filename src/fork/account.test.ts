import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { JmapClient, type JmapSession } from '../jmap-client.js';
import { FastmailAuth } from '../auth.js';
import { JmapError, RefusedError } from './core.js';
import { tools } from './account.js';

const URN = 'urn:ietf:params:jmap:';
const MASKED = 'https://www.fastmail.com/dev/maskedemail';
const cap = (name: string) => name.includes(':') ? name : URN + name;
const accountId = 'acct-1';
const identity = { id: 'i1', email: 'user@example.com', name: 'User' };
const script = { id: 's1', name: 'old', isActive: true, blobId: 'old-blob' };
const scriptProperties = ['id', 'name', 'isActive', 'blobId'];
const upload = (content: string) => ({ create: { b1: { data: [{ 'data:asText': content }], type: 'application/sieve' } } });
type Call = [string, Record<string, unknown>, any];
type Step = { caps: string[]; calls: Call[] };
const step = (caps: string[], method: string, args: Record<string, unknown>, result: any): Step => ({ caps, calls: [[method, args, result]] });
const scripts = (list = [script], state?: string) => step(['sieve'], 'SieveScript/get', { ids: null, properties: scriptProperties }, { list, ...(state ? { state } : {}) });
const backup = (blob: any = { id: 'old-blob', 'data:asText': 'keep;' }) => step(['blob'], 'Blob/get', { ids: ['old-blob'], properties: ['data:asText'] }, { list: [blob] });
const validation = (content: string, error: any = null): Step => ({ caps: ['blob', 'sieve'], calls: [
  ['Blob/upload', upload(content), { created: { b1: { id: 'new-blob' } } }],
  ['SieveScript/validate', { blobId: '#b1' }, { error }],
] });

function fixture(steps: Step[] = [], sessionPatch: Partial<JmapSession> = {}) {
  const client = new JmapClient(new FastmailAuth({ apiToken: 'fake-token' }));
  const session = { apiUrl: 'https://api.example.com/jmap/', accountId,
    capabilities: Object.fromEntries(['core', 'mail', 'submission', 'sieve', 'blob', 'quota', 'vacationresponse', MASKED].map(c => [cap(c), {}])),
    primaryAccounts: { [MASKED]: 'masked-acct' }, ...sessionPatch };
  mock.method(client, 'getSession', async () => session);
  let index = 0;
  mock.method(client, 'makeRequest', async req => {
    const expected = steps[index++];
    assert.ok(expected, `Unexpected request: ${JSON.stringify(req)}`);
    assert.deepEqual(req.using, ['core', ...expected.caps].map(cap));
    assert.deepEqual(req.methodCalls, expected.calls.map(([method, args], i) => [method, { accountId, ...args }, `c${i}`]));
    return { sessionState: 'state', methodResponses: expected.calls.map(([method, , result], i) =>
      [result?.methodError ? 'error' : method, result?.methodError ?? result, `c${i}`] as [string, any, string]) };
  });
  return { client, session, done: () => assert.equal(index, steps.length, 'all expected requests consumed') };
}

async function run(name: string, args: Record<string, any>, f: ReturnType<typeof fixture>) {
  const tool = tools.find(t => t.def.name === name);
  assert.ok(tool, `${name} is registered`);
  return tool.run(args, { client: f.client }) as Promise<any>;
}

describe('account tools', () => {
  it('registers every tool with the correct write flag', () => {
    assert.deepEqual(Object.fromEntries(tools.map(t => [t.def.name, t.write])), {
      get_session: false, list_sieve_scripts: false, get_sieve_script: false, validate_sieve: false, set_sieve_script: true,
      create_identity: true, update_identity: true, get_vacation_response: false, set_vacation_response: true,
      get_quota: false, list_masked_emails: false, create_masked_email: true, update_masked_email: true,
      get_account_summary: false, list_aliases_with_usage: false,
    });
  });

  it('list_sieve_scripts returns metadata', async () => {
    const f = fixture([scripts()]);
    assert.deepEqual(await run('list_sieve_scripts', {}, f), [script]);
    f.done();
  });

  for (const args of [{ id: 's1' }, { active: true }]) {
    it(`get_sieve_script selects ${JSON.stringify(args)} and reads text`, async () => {
      const f = fixture([step(['sieve'], 'SieveScript/get', { ids: args.id ? ['s1'] : null, properties: scriptProperties }, { list: [script] }), backup()]);
      assert.deepEqual(await run('get_sieve_script', args, f), { ...script, content: 'keep;' });
      f.done();
    });
  }

  for (const error of [null, { type: 'invalidSieve', description: 'Invalid command' }]) {
    it(`validate_sieve returns valid=${!error}`, async () => {
      const f = fixture([validation('  keep;\n', error)]);
      assert.deepEqual(await run('validate_sieve', { content: '  keep;\n' }, f), { valid: !error, error });
      f.done();
    });
  }

  it('set_sieve_script backs up before uploading, activates, and re-fetches stored metadata', async () => {
    const stored = { id: 's2', name: 'stored', isActive: true, blobId: 'new-blob' };
    const f = fixture([scripts([script], 'before'), backup(), { caps: ['blob', 'sieve'], calls: [
      ['Blob/upload', upload('discard;'), { created: { b1: { id: 'new-blob' } } }],
      ['SieveScript/set', { ifInState: 'before', create: { s1: { name: 'mcp', blobId: '#b1' } }, onSuccessActivateScript: '#s1' }, { created: { s1: { id: 's2' } } }],
    ] }, step(['sieve'], 'SieveScript/get', { ids: ['s2'], properties: scriptProperties }, { list: [stored] })]);
    assert.deepEqual(await run('set_sieve_script', { content: 'discard;', activate: true, confirm: true }, f),
      { id: 's2', name: 'stored', isActive: true, previousActive: { id: 's1', name: 'old', content: 'keep;' } });
    f.done();
  });

  it('set_sieve_script updates only the named script without changing activation', async () => {
    const existing = { ...script, name: 'mcp' };
    const f = fixture([scripts([existing]), backup(), { caps: ['blob', 'sieve'], calls: [
      ['Blob/upload', upload(''), { created: { b1: { id: 'new-blob' } } }],
      ['SieveScript/set', { update: { s1: { blobId: '#b1' } } }, { updated: { s1: null } }],
    ] }, step(['sieve'], 'SieveScript/get', { ids: ['s1'], properties: scriptProperties }, { list: [existing] })]);
    assert.equal((await run('set_sieve_script', { content: '', confirm: true }, f)).isActive, true);
    f.done();
  });

  it('set_sieve_script creates inactive by default with no existing active script', async () => {
    const stored = { ...script, name: 'mcp', isActive: false };
    const f = fixture([scripts([]), { caps: ['blob', 'sieve'], calls: [
      ['Blob/upload', upload('keep;'), { created: { b1: { id: 'new-blob' } } }],
      ['SieveScript/set', { create: { s1: { name: 'mcp', blobId: '#b1' } } }, { created: { s1: { id: 's1' } } }],
    ] }, step(['sieve'], 'SieveScript/get', { ids: ['s1'], properties: scriptProperties }, { list: [stored] })]);
    assert.deepEqual(await run('set_sieve_script', { content: 'keep;' }, f), { id: 's1', name: 'mcp', isActive: false, previousActive: null });
    f.done();
  });

  for (const activate of [false, true]) {
    it(`dryRun validates only and previews an overwrite (activate=${activate})`, async () => {
      const f = fixture([scripts([{ ...script, name: 'mcp' }]), validation('keep;')]);
      assert.deepEqual(await run('set_sieve_script', { content: 'keep;', activate, dryRun: true }, f),
        { dryRun: true, valid: true, error: null, action: 'update', id: 's1', name: 'mcp', activate, requiresConfirm: true });
      f.done();
    });
  }

  it('create_identity re-fetches server values', async () => {
    const input = { name: 'User', email: 'user@example.com', replyTo: [{ email: 'reply@example.com', name: 'Reply' }], bcc: null, textSignature: '', htmlSignature: '<p>Hi</p>' };
    const stored = { ...input, ...identity, name: 'Stored name' };
    const f = fixture([step(['submission'], 'Identity/set', { create: { i1: input } }, { created: { i1: { id: 'i1' } } }),
      step(['submission'], 'Identity/get', { ids: ['i1'] }, { list: [stored] })]);
    assert.deepEqual(await run('create_identity', input, f), stored);
    f.done();
  });

  it('update_identity preserves omitted fields and re-fetches', async () => {
    const f = fixture([step(['submission'], 'Identity/set', { update: { i1: { textSignature: '' } } }, { updated: { i1: null } }),
      step(['submission'], 'Identity/get', { ids: ['i1'] }, { list: [{ ...identity, textSignature: '', htmlSignature: 'preserved' }] })]);
    assert.equal((await run('update_identity', { identityId: 'i1', textSignature: '', name: undefined }, f)).htmlSignature, 'preserved');
    f.done();
  });

  it('get_vacation_response gets the singleton', async () => {
    const stored = { id: 'singleton', isEnabled: true };
    const f = fixture([step(['vacationresponse'], 'VacationResponse/get', { ids: ['singleton'] }, { list: [stored] })]);
    assert.deepEqual(await run('get_vacation_response', {}, f), stored);
    f.done();
  });

  it('set_vacation_response patches false, null, and empty without wiping missing fields', async () => {
    const input = { isEnabled: false, fromDate: null, toDate: '2026-10-01T00:00:00Z', subject: '', textBody: 'Away', htmlBody: null };
    const stored = { ...input, id: 'singleton', textBody: 'Stored' };
    const f = fixture([step(['vacationresponse'], 'VacationResponse/set', { update: { singleton: input } }, { updated: { singleton: null } }),
      step(['vacationresponse'], 'VacationResponse/get', { ids: ['singleton'] }, { list: [stored] })]);
    assert.deepEqual(await run('set_vacation_response', input, f), stored);
    f.done();
  });

  it('set_vacation_response sends a one-field patch', async () => {
    const f = fixture([step(['vacationresponse'], 'VacationResponse/set', { update: { singleton: { isEnabled: false } } }, { updated: { singleton: null } }),
      step(['vacationresponse'], 'VacationResponse/get', { ids: ['singleton'] }, { list: [{ id: 'singleton', isEnabled: false, subject: 'Preserved' }] })]);
    assert.equal((await run('set_vacation_response', { isEnabled: false }, f)).subject, 'Preserved');
    f.done();
  });

  it('get_quota returns the quota list', async () => {
    const list = [{ id: 'q1', used: 10, hardLimit: 100 }];
    const f = fixture([step(['quota'], 'Quota/get', { ids: null }, { list })]);
    assert.deepEqual(await run('get_quota', {}, f), list);
    f.done();
  });

  it('list_masked_emails uses the masked primary account', async () => {
    const f = fixture([step([MASKED], 'MaskedEmail/get', { accountId: 'masked-acct', ids: null }, { list: [identity] })]);
    assert.deepEqual(await run('list_masked_emails', {}, f), [identity]);
    f.done();
  });

  it('create_masked_email uses documented fields, defaults enabled, and re-fetches in the masked account', async () => {
    const input = { forDomain: 'https://example.com', description: 'Shopping', emailPrefix: 'shop' };
    const f = fixture([step([MASKED], 'MaskedEmail/set', { accountId: 'masked-acct', create: { m1: { ...input, state: 'enabled' } } }, { created: { m1: { id: 'm1' } } }),
      step([MASKED], 'MaskedEmail/get', { accountId: 'masked-acct', ids: ['m1'] }, { list: [{ id: 'm1', email: 'shop@example.com', state: 'enabled' }] })]);
    assert.equal((await run('create_masked_email', input, f)).email, 'shop@example.com');
    f.done();
  });

  for (const state of ['enabled', 'disabled', 'deleted']) {
    it(`update_masked_email patches state=${state} in the masked account`, async () => {
      const stored = { id: 'm1', state, description: 'Kept' };
      const f = fixture([step([MASKED], 'MaskedEmail/set', { accountId: 'masked-acct', update: { m1: { state } } }, { updated: { m1: null } }),
        step([MASKED], 'MaskedEmail/get', { accountId: 'masked-acct', ids: ['m1'] }, { list: [stored] })]);
      assert.deepEqual(await run('update_masked_email', { id: 'm1', state }, f), stored);
      f.done();
    });
  }

  it('get_account_summary preserves upstream fields and adds domains and quota', async () => {
    const list = [identity, { id: 'i2', email: '*@EXAMPLE.COM', name: '' }, { id: 'i3', email: '@example.org', name: '' }];
    const f = fixture([step(['submission'], 'Identity/get', { ids: null }, { list }), step(['quota'], 'Quota/get', { ids: null }, { list: [{ id: 'q1' }] })]);
    const base = mock.method(f.client, 'getAccountSummary', async () => ({ totalEmails: 42, mailboxCount: 3 }));
    assert.deepEqual(await run('get_account_summary', {}, f), { totalEmails: 42, mailboxCount: 3,
      capabilities: Object.keys(f.session.capabilities), identities: list, domains: ['example.com', 'example.org'],
      catchAllDomains: ['example.com', 'example.org'], quota: [{ id: 'q1' }], warnings: [] });
    assert.equal(base.mock.calls.length, 1);
    f.done();
  });

  it('get_account_summary isolates failing extras into warnings', async () => {
    const f = fixture([step(['submission'], 'Identity/get', { ids: null }, { methodError: { type: 'forbidden' } }),
      step(['quota'], 'Quota/get', { ids: null }, { methodError: { type: 'serverFail' } })]);
    mock.method(f.client, 'getAccountSummary', async () => ({ totalEmails: 42 }));
    const result = await run('get_account_summary', {}, f);
    assert.equal(result.totalEmails, 42);
    assert.deepEqual(result.identities, []);
    assert.equal(result.quota, null);
    assert.equal(result.warnings.length, 2);
    assert.match(result.warnings[0], /identities.*forbidden/);
    assert.match(result.warnings[1], /quota.*serverFail/);
    f.done();
  });

  it('get_account_summary does not request unsupported quota', async () => {
    const f = fixture([step(['submission'], 'Identity/get', { ids: null }, { list: [] })]);
    delete f.session.capabilities[cap('quota')];
    mock.method(f.client, 'getAccountSummary', async () => ({ mailboxCount: 1 }));
    const result = await run('get_account_summary', {}, f);
    assert.equal(result.quota, null);
    assert.deepEqual(result.warnings, []);
    f.done();
  });

  it('list_aliases_with_usage batches all queries and fetches unique newest messages', async () => {
    const list = [identity, { ...identity, id: 'i2', email: 'alias@example.com' }, { ...identity, id: 'i3', email: 'empty@example.com' }];
    const f = fixture([step(['submission'], 'Identity/get', { ids: null }, { list }),
      { caps: ['mail'], calls: list.map((i, n) => ['Email/query', { filter: { to: i.email }, calculateTotal: true, limit: 1, sort: [{ property: 'receivedAt', isAscending: false }] }, { total: n ? 0 : 7, ids: n === 2 ? [] : ['e1'] }]) },
      step(['mail'], 'Email/get', { ids: ['e1'], properties: ['id', 'receivedAt'] }, { list: [{ id: 'e1', receivedAt: '2026-09-01T00:00:00Z' }] })]);
    assert.deepEqual(await run('list_aliases_with_usage', {}, f), list.map((i, n) => ({ ...i, mailCount: n ? 0 : 7, lastReceivedAt: n === 2 ? null : '2026-09-01T00:00:00Z' })));
    f.done();
  });

  it('list_aliases_with_usage returns empty without extra requests', async () => {
    const f = fixture([step(['submission'], 'Identity/get', { ids: null }, { list: [] })]);
    assert.deepEqual(await run('list_aliases_with_usage', {}, f), []);
    f.done();
  });

  it('list_aliases_with_usage accepts exactly 100 identities in one query batch', async () => {
    const list = Array.from({ length: 100 }, (_, i) => ({ ...identity, id: `i${i}` }));
    const f = fixture([step(['submission'], 'Identity/get', { ids: null }, { list }),
      { caps: ['mail'], calls: list.map(i => ['Email/query', { filter: { to: i.email }, calculateTotal: true, limit: 1,
        sort: [{ property: 'receivedAt', isAscending: false }] }, { total: 0, ids: [] }]) }]);
    assert.deepEqual(await run('list_aliases_with_usage', {}, f), list.map(i => ({ ...i, mailCount: 0, lastReceivedAt: null })));
    f.done();
  });

  it('set_sieve_script dryRun previews creation and returns validation errors without writing', async () => {
    const error = { type: 'invalidSieve', description: 'Invalid command' };
    const f = fixture([scripts([]), validation('bad;', error)]);
    assert.deepEqual(await run('set_sieve_script', { content: 'bad;', dryRun: true }, f),
      { dryRun: true, valid: false, error, action: 'create', id: null, name: 'mcp', activate: false, requiresConfirm: false });
    f.done();
  });

  it('update_masked_email supports a metadata-only patch', async () => {
    const patch = { description: '', forDomain: 'https://example.com' };
    const f = fixture([step([MASKED], 'MaskedEmail/set', { accountId: 'masked-acct', update: { m1: patch } }, { updated: { m1: null } }),
      step([MASKED], 'MaskedEmail/get', { accountId: 'masked-acct', ids: ['m1'] }, { list: [{ id: 'm1', state: 'enabled', ...patch }] })]);
    assert.equal((await run('update_masked_email', { id: 'm1', ...patch }, f)).state, 'enabled');
    f.done();
  });

  it('get_account_summary retains quota when identities are unavailable', async () => {
    const f = fixture([step(['quota'], 'Quota/get', { ids: null }, { list: [{ id: 'q1' }] })]);
    delete f.session.capabilities[cap('submission')];
    mock.method(f.client, 'getAccountSummary', async () => ({ totalEmails: 42 }));
    const result = await run('get_account_summary', {}, f);
    assert.equal(result.totalEmails, 42);
    assert.deepEqual(result.quota, [{ id: 'q1' }]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /submission.*scope/);
    f.done();
  });
});

describe('account safety refusals and errors', () => {
  for (const [name, args, requiredCaps] of [
    ['list_sieve_scripts', {}, ['sieve']], ['get_sieve_script', { active: true }, ['sieve', 'blob']],
    ['validate_sieve', { content: 'keep;' }, ['sieve', 'blob']], ['set_sieve_script', { content: 'keep;' }, ['sieve', 'blob']],
    ['create_identity', { name: 'User', email: 'user@example.com' }, ['submission']], ['update_identity', { identityId: 'i1', name: 'User' }, ['submission']],
    ['get_vacation_response', {}, ['vacationresponse']], ['set_vacation_response', { isEnabled: false }, ['vacationresponse']],
    ['get_quota', {}, ['quota']], ['list_masked_emails', {}, [MASKED]], ['create_masked_email', {}, [MASKED]],
    ['update_masked_email', { id: 'm1', state: 'disabled' }, [MASKED]], ['list_aliases_with_usage', {}, ['submission', 'mail']],
  ] as [string, Record<string, any>, string[]][]) {
    for (const capability of requiredCaps) it(`${name} refuses missing ${capability} with a scope hint`, async () => {
      const f = fixture();
      delete f.session.capabilities[cap(capability)];
      await assert.rejects(() => run(name, args, f), (err: any) => err instanceof RefusedError && err.message.includes(cap(capability)) && /scope/i.test(err.message));
      f.done();
    });
  }

  for (const [name, args] of [
    ['get_sieve_script', {}], ['get_sieve_script', { id: 's1', active: true }],
    ['validate_sieve', {}], ['validate_sieve', { content: 1 }],
    ['set_sieve_script', { content: 'keep;', activate: 'true' }], ['set_sieve_script', { content: 'keep;', dryRun: 'true' }],
    ['set_sieve_script', { content: 'keep;', name: '' }],
    ['create_identity', { email: 'user@example.com' }], ['create_identity', { name: 'User', email: '' }],
    ['update_identity', { identityId: 'i1' }], ['update_identity', { name: 'User' }],
    ['update_identity', { identityId: 'i1', name: null }], ['update_identity', { identityId: 'i1', replyTo: 'bad' }],
    ['update_identity', { identityId: 'i1', replyTo: [{ name: 'Missing email' }] }],
    ['set_vacation_response', {}], ['set_vacation_response', { isEnabled: 'false' }], ['set_vacation_response', { fromDate: 42 }],
    ['create_masked_email', { state: 'pending' }], ['create_masked_email', { description: 1 }],
    ['update_masked_email', { id: 'm1' }], ['update_masked_email', { state: 'enabled' }],
    ['update_masked_email', { id: 'm1', state: 'invalid' }],
  ] as [string, Record<string, any>][]) {
    it(`${name} rejects invalid input ${JSON.stringify(args)}`, async () => {
      const f = fixture();
      await assert.rejects(() => run(name, args, f), RefusedError);
      f.done();
    });
  }

  for (const args of [{ content: 'keep;', activate: true }, { content: 'keep;', name: 'old' }, { content: 'keep;', name: 'old', confirm: 'true' }]) {
    it(`set_sieve_script requires literal confirmation for ${JSON.stringify(args)}`, async () => {
      const f = fixture([scripts()]);
      await assert.rejects(() => run('set_sieve_script', args, f), (err: any) => err instanceof RefusedError && /confirm: true/.test(err.message));
      f.done();
    });
  }

  for (const args of [{ id: 'missing' }, { active: true }]) {
    it(`get_sieve_script refuses a missing selection ${JSON.stringify(args)}`, async () => {
      const f = fixture([step(['sieve'], 'SieveScript/get', { ids: args.id ? [args.id] : null, properties: scriptProperties }, { list: [] })]);
      await assert.rejects(() => run('get_sieve_script', args, f), RefusedError);
      f.done();
    });
  }

  for (const blob of [{ id: 'old-blob' }, { id: 'old-blob', 'data:asText': 'partial', isTruncated: true }, { id: 'old-blob', 'data:asText': 'bad', isEncodingProblem: true }]) {
    it(`set_sieve_script never writes with an incomplete backup ${JSON.stringify(blob)}`, async () => {
      const f = fixture([scripts(), backup(blob)]);
      await assert.rejects(() => run('set_sieve_script', { content: 'keep;' }, f), JmapError);
      f.done();
    });
  }

  for (const name of ['list_masked_emails', 'create_masked_email', 'update_masked_email']) {
    it(`${name} refuses a missing masked primary account`, async () => {
      const f = fixture([], { primaryAccounts: {} });
      await assert.rejects(() => run(name, { id: 'm1', state: 'enabled' }, f), (err: any) => err instanceof RefusedError && /primaryAccounts/.test(err.message));
      f.done();
    });
  }

  it('list_aliases_with_usage refuses over 100 identities before any mail queries', async () => {
    const f = fixture([step(['submission'], 'Identity/get', { ids: null }, { list: Array.from({ length: 101 }, (_, n) => ({ ...identity, id: `i${n}` })) })]);
    await assert.rejects(() => run('list_aliases_with_usage', {}, f), (err: any) => err instanceof RefusedError && /100/.test(err.message));
    f.done();
  });

  it('update_identity propagates set errors without reporting success', async () => {
    const f = fixture([step(['submission'], 'Identity/set', { update: { i1: { name: 'User' } } }, { notUpdated: { i1: { type: 'forbidden' } } })]);
    await assert.rejects(() => run('update_identity', { identityId: 'i1', name: 'User' }, f), (err: any) => err instanceof JmapError && err.type === 'forbidden');
    f.done();
  });

  it('set_sieve_script preserves the backup-before-write order on an overwrite activation failure', async () => {
    const f = fixture([scripts([script], 'before'), backup(), { caps: ['blob', 'sieve'], calls: [
      ['Blob/upload', upload('bad;'), { created: { b1: { id: 'new-blob' } } }],
      ['SieveScript/set', { ifInState: 'before', update: { s1: { blobId: '#b1' } }, onSuccessActivateScript: 's1' },
        { notUpdated: { s1: { type: 'invalidSieve' } } }],
    ] }]);
    await assert.rejects(() => run('set_sieve_script', { content: 'bad;', name: 'old', activate: true, confirm: true }, f),
      (err: any) => err instanceof JmapError && err.type === 'invalidSieve');
    f.done();
  });

  it('validate_sieve reports an upload failure', async () => {
    const f = fixture([{ caps: ['blob', 'sieve'], calls: [
      ['Blob/upload', upload('keep;'), { notCreated: { b1: { type: 'overQuota' } } }],
      ['SieveScript/validate', { blobId: '#b1' }, { error: { type: 'blobNotFound' } }],
    ] }]);
    await assert.rejects(() => run('validate_sieve', { content: 'keep;' }, f), (err: any) => err instanceof JmapError && err.type === 'overQuota');
    f.done();
  });

  it('update_identity rejects a missing set success confirmation', async () => {
    const f = fixture([step(['submission'], 'Identity/set', { update: { i1: { name: 'User' } } }, {})]);
    await assert.rejects(() => run('update_identity', { identityId: 'i1', name: 'User' }, f), JmapError);
    f.done();
  });

  it('create_identity does not substitute submitted values for a missing re-fetch', async () => {
    const f = fixture([step(['submission'], 'Identity/set', { create: { i1: { name: 'User', email: identity.email } } }, { created: { i1: { id: 'i1' } } }),
      step(['submission'], 'Identity/get', { ids: ['i1'] }, { list: [], notFound: ['i1'] })]);
    await assert.rejects(() => run('create_identity', { name: 'User', email: identity.email }, f), JmapError);
    f.done();
  });

  for (const query of [{ ids: [] }, { total: 0 }, { ids: [null], total: 0 }]) {
    it(`list_aliases_with_usage rejects incomplete query results ${JSON.stringify(query)}`, async () => {
      const f = fixture([step(['submission'], 'Identity/get', { ids: null }, { list: [identity] }),
        step(['mail'], 'Email/query', { filter: { to: identity.email }, calculateTotal: true, limit: 1,
          sort: [{ property: 'receivedAt', isAscending: false }] }, query)]);
      await assert.rejects(() => run('list_aliases_with_usage', {}, f), JmapError);
      f.done();
    });
  }
});
