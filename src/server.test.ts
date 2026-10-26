import assert from 'node:assert/strict';
import test from 'node:test';

import { createUsageServer } from './server-app.js';

type FakeClient = {
  calls: string[];
  closed: boolean;
  request(method: string): Promise<unknown>;
  close(): void;
};

function fakeClient(): FakeClient {
  return {
    calls: [],
    closed: false,
    async request(method: string) {
      this.calls.push(method);
      if (method === 'account/rateLimits/read') {
        return { rateLimits: { primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1_800_000_000 } } };
      }
      return { dailyUsageBuckets: [{ startDate: new Date().toISOString().slice(0, 10), tokens: 123 }] };
    },
    close() {
      this.closed = true;
    },
  };
}

async function listen(server: ReturnType<typeof createUsageServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('HTTP routes call the corresponding Codex account methods', async () => {
  const client = fakeClient();
  const server = createUsageServer(client);
  const baseUrl = await listen(server);
  try {
    const limits = await fetch(`${baseUrl}/rate-limits`);
    const activity = await fetch(`${baseUrl}/activity?days=7`);
    assert.equal(limits.status, 200);
    assert.equal(activity.status, 200);
    assert.deepEqual(client.calls, ['account/rateLimits/read', 'account/usage/read']);
    assert.equal((await activity.json() as { days: number }).days, 7);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(client.closed, true);
});

test('HTTP routes return JSON errors without leaking stack traces', async () => {
  const client = fakeClient();
  client.request = async () => { throw new Error('sign in required'); };
  const server = createUsageServer(client);
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/rate-limits`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'sign in required' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

type AccountFixture = {
  id: string;
  codexHome: string;
  enabled?: boolean;
  signedIn?: boolean;
  fail?: string;
  failUsage?: string;
  usedPercent?: number;
  reached?: string;
  email?: string;
  tokens?: number;
};

function multiAccountServer(fixtures: AccountFixture[], mode: 'round_robin' | 'backup' = 'round_robin') {
  const created: string[] = [];
  const closed: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  let current = fixtures;
  const server = createUsageServer({
    readRegistry: async () => ({
      mode,
      primaryAccountId: current[0]!.id,
      minHeadroomPercent: 5,
      planWeights: { plus: 2 },
      roundRobinCursor: current[0]!.id,
      accounts: current.map((fixture) => ({
        id: fixture.id,
        label: fixture.id.toUpperCase(),
        codexHome: fixture.codexHome,
        enabled: fixture.enabled ?? true,
      })),
    }),
    authExists: async (codexHome) => current.find((fixture) => fixture.codexHome === codexHome)?.signedIn !== false,
    createClient: (account) => {
      created.push(account.id);
      const fixture = () => current.find((candidate) => candidate.id === account.id)!;
      return {
        async request(method: string) {
          const f = fixture();
          if (f.fail) throw new Error(f.fail);
          if (method === 'account/read') return { account: { type: 'chatgpt', email: f.email ?? `${f.id}@example.com`, planType: 'pro' } };
          if (method === 'account/rateLimits/read') {
            return {
              rateLimits: {
                primary: { usedPercent: f.usedPercent ?? 10, windowDurationMins: 300, resetsAt: 1_800_000_000 },
                rateLimitReachedType: f.reached ?? null,
              },
            };
          }
          if (f.failUsage) throw new Error(f.failUsage);
          return { summary: { lifetimeTokens: f.tokens ?? 0 }, dailyUsageBuckets: [{ startDate: today, tokens: f.tokens ?? 0 }] };
        },
        close() {
          closed.push(account.id);
        },
      };
    },
  });
  return { server, created, closed, setAccounts(next: AccountFixture[]) { current = next; } };
}

async function closeServer(server: ReturnType<typeof createUsageServer>): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('GET /accounts reports every account and isolates a failing one', async () => {
  const { server } = multiAccountServer([
    { id: 'default', codexHome: '/h/default', usedPercent: 40 },
    { id: 'broken', codexHome: '/h/broken', fail: 'app-server exploded' },
    { id: 'new', codexHome: '/h/new', signedIn: false },
    { id: 'off', codexHome: '/h/off', enabled: false, usedPercent: 1 },
  ], 'backup');
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/accounts`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      mode: string;
      primaryAccountId: string;
      accounts: { id: string; signedIn: boolean; enabled: boolean; isPrimary: boolean; email: string | null; planType: string | null; limits: { limits: unknown[] } | null; error: string | null }[];
    };
    assert.equal(body.mode, 'backup');
    assert.equal(body.primaryAccountId, 'default');
    assert.deepEqual((body as unknown as { planWeights: unknown }).planWeights, { plus: 2 });
    assert.equal((body as unknown as { roundRobinCursor: unknown }).roundRobinCursor, 'default');
    assert.deepEqual(body.accounts.map((account) => account.id), ['default', 'broken', 'new', 'off']);
    const [ok, broken, signedOut, disabled] = body.accounts;
    assert.equal(ok?.signedIn, true);
    assert.equal(ok?.isPrimary, true);
    assert.equal(ok?.email, 'default@example.com');
    assert.equal(ok?.planType, 'pro');
    assert.equal(ok?.limits?.limits.length, 1);
    assert.equal(ok?.error, null);
    assert.equal(broken?.signedIn, true);
    assert.equal(broken?.limits, null);
    assert.equal(broken?.error, 'app-server exploded');
    assert.equal(signedOut?.signedIn, false);
    assert.equal(signedOut?.error, null);
    assert.equal(signedOut?.limits, null);
    assert.equal(disabled?.enabled, false);
    assert.equal(disabled?.isPrimary, false);
  } finally {
    await closeServer(server);
  }
});

test('accounts without auth.json never start an app-server, and removed accounts are closed', async () => {
  const fixtures: AccountFixture[] = [
    { id: 'default', codexHome: '/h/default' },
    { id: 'gone', codexHome: '/h/gone' },
    { id: 'new', codexHome: '/h/new', signedIn: false },
  ];
  const { server, created, closed, setAccounts } = multiAccountServer(fixtures);
  const baseUrl = await listen(server);
  try {
    await fetch(`${baseUrl}/accounts`);
    assert.deepEqual(created.sort(), ['default', 'gone']);
    setAccounts([fixtures[0]!]);
    await fetch(`${baseUrl}/accounts`);
    assert.deepEqual(closed, ['gone']);
  } finally {
    await closeServer(server);
  }
});

test('GET /activity selects an account, defaults to "default" and rejects unknown ones', async () => {
  const { server } = multiAccountServer([
    { id: 'work', codexHome: '/h/work', tokens: 5 },
    { id: 'default', codexHome: '/h/default', tokens: 100 },
    { id: 'new', codexHome: '/h/new', signedIn: false },
  ]);
  const baseUrl = await listen(server);
  try {
    const plain = await fetch(`${baseUrl}/activity?days=7`);
    assert.equal(plain.status, 200);
    assert.equal((await plain.json() as { totalTokens: number }).totalTokens, 100);
    const work = await fetch(`${baseUrl}/activity?account=work`);
    assert.equal((await work.json() as { totalTokens: number; days: number }).totalTokens, 5);
    const legacyLimits = await fetch(`${baseUrl}/rate-limits`);
    assert.equal(legacyLimits.status, 200);
    const unknown = await fetch(`${baseUrl}/activity?account=nope`);
    assert.equal(unknown.status, 404);
    const signedOut = await fetch(`${baseUrl}/activity?account=new`);
    assert.equal(signedOut.status, 409);
  } finally {
    await closeServer(server);
  }
});

test('GET /activity?account=all sums signed-in accounts and lists the ones left out', async () => {
  const { server } = multiAccountServer([
    { id: 'default', codexHome: '/h/default', tokens: 100 },
    { id: 'work', codexHome: '/h/work', tokens: 23 },
    { id: 'broken', codexHome: '/h/broken', failUsage: 'usage unavailable' },
    { id: 'new', codexHome: '/h/new', signedIn: false, tokens: 999 },
  ]);
  const baseUrl = await listen(server);
  try {
    const response = await fetch(`${baseUrl}/activity?account=all&days=30`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      days: number;
      totalTokens: number;
      accounts: string[];
      errors: { id: string; error: string }[];
      summary: { lifetimeTokens: number | null };
    };
    assert.equal(body.days, 30);
    assert.equal(body.totalTokens, 123);
    assert.equal(body.summary.lifetimeTokens, 123);
    assert.deepEqual(body.accounts, ['default', 'work']);
    assert.deepEqual(body.errors, [{ id: 'broken', error: 'usage unavailable' }]);
  } finally {
    await closeServer(server);
  }
});
