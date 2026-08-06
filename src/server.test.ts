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
