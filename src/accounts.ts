import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type AccountMode = 'round_robin' | 'backup';

export type RegistryAccount = {
  id: string;
  label: string;
  codexHome: string;
  enabled: boolean;
};

export type Registry = {
  mode: AccountMode;
  primaryAccountId: string;
  minHeadroomPercent: number;
  /** Plan weight overrides, lower-case plan name → capacity relative to Plus. */
  planWeights: Record<string, number>;
  /** Last account round robin handed out, or null. */
  roundRobinCursor: string | null;
  accounts: RegistryAccount[];
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Directory that holds accounts.json, written by Studio core. */
export function accountsRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return nonEmptyString(environment.CLOUDCLI_CODEX_ACCOUNTS_DIR)
    ?? path.join(os.homedir(), '.cloudcli', 'codex-accounts');
}

/** The Codex home used when there is no registry: $CODEX_HOME or ~/.codex. */
export function defaultCodexHome(environment: NodeJS.ProcessEnv = process.env): string {
  return nonEmptyString(environment.CODEX_HOME) ?? path.join(os.homedir(), '.codex');
}

export function fallbackRegistry(environment: NodeJS.ProcessEnv = process.env): Registry {
  return {
    mode: 'round_robin',
    primaryAccountId: 'default',
    minHeadroomPercent: 5,
    planWeights: {},
    roundRobinCursor: null,
    accounts: [{ id: 'default', label: 'Default', codexHome: defaultCodexHome(environment), enabled: true }],
  };
}

/**
 * Parse the registry document. Array order is priority order and is kept.
 * Entries without an id or codexHome are skipped, as are repeated ids.
 * Returns null when the document has no usable account.
 */
export function parseRegistry(value: unknown): Registry | null {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.accounts)) return null;
  const seen = new Set<string>();
  const accounts: RegistryAccount[] = [];
  for (const entry of raw.accounts) {
    const account = record(entry);
    const id = nonEmptyString(account?.id);
    const codexHome = nonEmptyString(account?.codexHome);
    if (!account || !id || !codexHome || seen.has(id)) continue;
    seen.add(id);
    accounts.push({
      id,
      label: nonEmptyString(account.label) ?? id,
      codexHome,
      enabled: account.enabled !== false,
    });
  }
  if (accounts.length === 0) return null;
  const minHeadroom = typeof raw.minHeadroomPercent === 'number' && Number.isFinite(raw.minHeadroomPercent)
    ? Math.min(Math.max(raw.minHeadroomPercent, 0), 100)
    : 5;
  const primary = nonEmptyString(raw.primaryAccountId);
  const planWeights: Record<string, number> = {};
  for (const [plan, weight] of Object.entries(record(raw.planWeights) ?? {})) {
    const number = Number(weight);
    if (Number.isFinite(number) && number > 0) planWeights[plan.toLowerCase()] = number;
  }
  const cursor = nonEmptyString(raw.roundRobinCursor);
  return {
    mode: raw.mode === 'backup' ? 'backup' : 'round_robin',
    primaryAccountId: primary && seen.has(primary) ? primary : accounts[0]!.id,
    minHeadroomPercent: minHeadroom,
    planWeights,
    roundRobinCursor: cursor && seen.has(cursor) ? cursor : null,
    accounts,
  };
}

/** Read <root>/accounts.json; fall back to the single default account if it is missing or invalid. */
export async function readRegistry(
  root: string = accountsRoot(),
  environment: NodeJS.ProcessEnv = process.env,
  read: (filePath: string) => Promise<string> = (filePath) => readFile(filePath, 'utf8'),
): Promise<Registry> {
  try {
    const parsed = parseRegistry(JSON.parse(await read(path.join(root, 'accounts.json'))));
    if (parsed) return parsed;
  } catch {
    // Missing file or bad JSON: same as no registry.
  }
  return fallbackRegistry(environment);
}
