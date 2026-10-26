import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { accountsRoot, parseRegistry, readRegistry } from './accounts.js';

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-accounts-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('accountsRoot honours CLOUDCLI_CODEX_ACCOUNTS_DIR', () => {
  assert.equal(accountsRoot({ CLOUDCLI_CODEX_ACCOUNTS_DIR: '/tmp/x' }), '/tmp/x');
  assert.equal(accountsRoot({}), path.join(os.homedir(), '.cloudcli', 'codex-accounts'));
});

test('missing accounts.json falls back to the default account', async () => {
  await withRoot(async (root) => {
    const registry = await readRegistry(root, { CODEX_HOME: '/srv/codex' });
    assert.deepEqual(registry, {
      mode: 'round_robin',
      primaryAccountId: 'default',
      minHeadroomPercent: 5,
      accounts: [{ id: 'default', label: 'Default', codexHome: '/srv/codex', enabled: true }],
    });
  });
});

test('without CODEX_HOME the default account uses ~/.codex', async () => {
  await withRoot(async (root) => {
    const registry = await readRegistry(root, {});
    assert.equal(registry.accounts[0]?.codexHome, path.join(os.homedir(), '.codex'));
  });
});

test('bad JSON falls back to the default account', async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, 'accounts.json'), '{"version":1,"accounts":[');
    const registry = await readRegistry(root, { CODEX_HOME: '/srv/codex' });
    assert.equal(registry.accounts.length, 1);
    assert.equal(registry.accounts[0]?.id, 'default');
  });
});

test('a registry with no usable account falls back to the default account', async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, 'accounts.json'), JSON.stringify({ version: 1, accounts: [{ id: 'x' }] }));
    const registry = await readRegistry(root, { CODEX_HOME: '/srv/codex' });
    assert.equal(registry.accounts[0]?.codexHome, '/srv/codex');
  });
});

test('reads the registry keeping array order as priority order', async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, 'accounts.json'), JSON.stringify({
      version: 1,
      mode: 'backup',
      primaryAccountId: 'acct-2',
      minHeadroomPercent: 10,
      accounts: [
        { id: 'acct-3', label: 'Third', codexHome: '/h/3', enabled: true, createdAt: '2026-10-26T09:00:00Z' },
        { id: 'default', label: 'Principal', codexHome: '/h/default', enabled: true },
        { id: 'acct-2', label: 'Trabajo', codexHome: '/h/2', enabled: false },
      ],
    }));
    const registry = await readRegistry(root, {});
    assert.equal(registry.mode, 'backup');
    assert.equal(registry.primaryAccountId, 'acct-2');
    assert.equal(registry.minHeadroomPercent, 10);
    assert.deepEqual(registry.accounts.map((account) => account.id), ['acct-3', 'default', 'acct-2']);
    assert.equal(registry.accounts[2]?.enabled, false);
  });
});

test('parseRegistry skips invalid and repeated entries and fixes an unknown primary', () => {
  const registry = parseRegistry({
    mode: 'something-else',
    primaryAccountId: 'gone',
    minHeadroomPercent: 500,
    accounts: [
      null,
      { id: 'a', codexHome: '/h/a' },
      { id: 'a', codexHome: '/h/dup' },
      { id: '', codexHome: '/h/empty' },
      { id: 'b', label: 'B', codexHome: '/h/b' },
    ],
  });
  assert(registry);
  assert.equal(registry.mode, 'round_robin');
  assert.equal(registry.primaryAccountId, 'a');
  assert.equal(registry.minHeadroomPercent, 100);
  assert.deepEqual(registry.accounts, [
    { id: 'a', label: 'a', codexHome: '/h/a', enabled: true },
    { id: 'b', label: 'B', codexHome: '/h/b', enabled: true },
  ]);
});
