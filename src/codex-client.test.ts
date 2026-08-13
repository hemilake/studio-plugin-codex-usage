import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { CodexAppServerClient } from './codex-client.js';

type FakeProcess = {
  process: ChildProcessWithoutNullStreams;
  killedSignals: NodeJS.Signals[];
};

function fakeAppServer(): FakeProcess {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killedSignals: NodeJS.Signals[] = [];
  let killed = false;
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    get killed() { return killed; },
  }) as unknown as ChildProcessWithoutNullStreams;
  child.kill = ((signal: NodeJS.Signals = 'SIGTERM') => {
    killed = true;
    killedSignals.push(signal);
    queueMicrotask(() => emitter.emit('exit', 0, signal));
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  stdin.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').trim().split('\n')) {
      if (!line) continue;
      const request = JSON.parse(line) as { id?: number; method: string };
      if (typeof request.id !== 'number') continue;
      const result = request.method === 'initialize'
        ? {}
        : { method: request.method };
      queueMicrotask(() => stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
    }
  });
  return { process: child, killedSignals };
}

test('restarts app-server before the next request when auth.json changes', async () => {
  let authMtime = 1;
  const children: FakeProcess[] = [];
  const client = new CodexAppServerClient({
    readStat: async () => ({ dev: 1, ino: 2, size: 100, mtimeMs: authMtime }),
    spawnAppServer: () => {
      const child = fakeAppServer();
      children.push(child);
      return child.process;
    },
  });

  try {
    await client.request('account/rateLimits/read');
    assert.equal(children.length, 1);

    authMtime = 2;
    await client.request('account/rateLimits/read');
    assert.equal(children.length, 2);
    assert.deepEqual(children[0]?.killedSignals, ['SIGTERM']);
  } finally {
    client.close();
  }
});

test('restarts an unchanged app-server after its maximum age', async () => {
  let now = 1_000;
  const children: FakeProcess[] = [];
  const client = new CodexAppServerClient({
    maxServerAgeMs: 600_000,
    now: () => now,
    readStat: async () => ({ dev: 1, ino: 2, size: 100, mtimeMs: 1 }),
    spawnAppServer: () => {
      const child = fakeAppServer();
      children.push(child);
      return child.process;
    },
  });

  try {
    await client.request('account/rateLimits/read');
    now += 599_999;
    await client.request('account/rateLimits/read');
    assert.equal(children.length, 1);

    now += 1;
    await client.request('account/rateLimits/read');
    assert.equal(children.length, 2);
  } finally {
    client.close();
  }
});
