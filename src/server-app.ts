import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import {
  fallbackRegistry,
  readRegistry as readRegistryFile,
  type AccountMode,
  type Registry,
  type RegistryAccount,
} from './accounts.js';
import { CodexAppServerClient } from './codex-client.js';
import {
  normalizeAccount,
  normalizeActivity,
  normalizeRateLimits,
  sumActivity,
  type ActivityData,
  type RateLimitsData,
} from './usage.js';

export type UsageClient = {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
};

export type UsageServerOptions = {
  /** Re-read on every request so accounts added by Studio show up without a restart. */
  readRegistry?: () => Promise<Registry>;
  createClient?: (account: RegistryAccount) => UsageClient;
  /** Whether <codexHome>/auth.json exists. Only stats the file, never reads it. */
  authExists?: (codexHome: string) => Promise<boolean>;
  now?: () => number;
};

export type AccountView = {
  id: string;
  label: string;
  enabled: boolean;
  isPrimary: boolean;
  signedIn: boolean;
  email: string | null;
  planType: string | null;
  limits: RateLimitsData | null;
  error: string | null;
};

export type AccountsResponse = {
  mode: AccountMode;
  primaryAccountId: string;
  minHeadroomPercent: number;
  accounts: AccountView[];
};

export type AllActivity = ActivityData & {
  accounts: string[];
  errors: { id: string; error: string }[];
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function authFileExists(codexHome: string): Promise<boolean> {
  try {
    return (await stat(path.join(codexHome, 'auth.json'))).isFile();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isUsageClient(value: unknown): value is UsageClient {
  return typeof (value as UsageClient | null)?.request === 'function';
}

/** One app-server client per account, keyed by id and Codex home. */
export class ClientPool {
  private clients = new Map<string, UsageClient>();

  constructor(private readonly create: (account: RegistryAccount) => UsageClient) {}

  private static key(account: RegistryAccount): string {
    return `${account.id}\u0000${account.codexHome}`;
  }

  get(account: RegistryAccount): UsageClient {
    const key = ClientPool.key(account);
    let client = this.clients.get(key);
    if (!client) {
      client = this.create(account);
      this.clients.set(key, client);
    }
    return client;
  }

  /** Close clients whose account left the registry or moved to another Codex home. */
  sync(accounts: RegistryAccount[]): void {
    const keep = new Set(accounts.map((account) => ClientPool.key(account)));
    for (const [key, client] of this.clients) {
      if (keep.has(key)) continue;
      client.close();
      this.clients.delete(key);
    }
  }

  size(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}

/** Account used by the routes without an `account` parameter. */
function defaultAccount(registry: Registry): RegistryAccount {
  return registry.accounts.find((account) => account.id === 'default')
    ?? registry.accounts.find((account) => account.id === registry.primaryAccountId)
    ?? registry.accounts[0]!;
}

/**
 * Create the plugin HTTP server; exported so routing can be tested independently.
 * Passing a single client keeps the old one-account behaviour.
 */
export function createUsageServer(options: UsageServerOptions | UsageClient = {}): http.Server {
  const settings: UsageServerOptions = isUsageClient(options)
    ? {
      readRegistry: async () => fallbackRegistry(),
      createClient: () => options,
      authExists: async () => true,
    }
    : options;
  const readRegistry = settings.readRegistry ?? (() => readRegistryFile());
  const authExists = settings.authExists ?? authFileExists;
  const now = settings.now ?? Date.now;
  const pool = new ClientPool(settings.createClient
    ?? ((account) => new CodexAppServerClient({ codexHome: account.codexHome })));

  async function loadRegistry(): Promise<Registry> {
    const registry = await readRegistry();
    pool.sync(registry.accounts);
    return registry;
  }

  async function describe(registry: Registry, account: RegistryAccount): Promise<AccountView> {
    const view: AccountView = {
      id: account.id,
      label: account.label,
      enabled: account.enabled,
      isPrimary: account.id === registry.primaryAccountId,
      signedIn: false,
      email: null,
      planType: null,
      limits: null,
      error: null,
    };
    if (!await authExists(account.codexHome)) return view;

    const client = pool.get(account);
    const [identity, limits] = await Promise.allSettled([
      client.request('account/read'),
      client.request('account/rateLimits/read'),
    ]);
    if (identity.status === 'fulfilled') {
      const parsed = normalizeAccount(identity.value);
      if (!parsed) return view;
      view.email = parsed.email;
      view.planType = parsed.planType;
    }
    view.signedIn = true;
    if (limits.status === 'fulfilled') {
      view.limits = normalizeRateLimits(limits.value);
      view.planType ??= view.limits.limits.find((limit) => limit.planType)?.planType ?? null;
    }
    const failure = [identity, limits].find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') view.error = errorMessage(failure.reason, 'Codex usage is unavailable.');
    return view;
  }

  async function accountActivity(account: RegistryAccount, days: number): Promise<ActivityData> {
    if (!await authExists(account.codexHome)) {
      throw new HttpError(409, `Account "${account.label}" is not signed in to Codex.`);
    }
    const result = await pool.get(account).request('account/usage/read');
    return normalizeActivity(result, days, now());
  }

  async function allActivity(registry: Registry, days: number): Promise<AllActivity> {
    const signedIn = (await Promise.all(registry.accounts.map(async (account) => (
      await authExists(account.codexHome) ? account : null
    )))).filter((account): account is RegistryAccount => account !== null);
    const results = await Promise.allSettled(signedIn.map((account) => accountActivity(account, days)));
    const series: ActivityData[] = [];
    const included: string[] = [];
    const errors: AllActivity['errors'] = [];
    results.forEach((result, index) => {
      const id = signedIn[index]!.id;
      if (result.status === 'fulfilled') {
        series.push(result.value);
        included.push(id);
      } else {
        errors.push({ id, error: errorMessage(result.reason, 'Token activity is unavailable.') });
      }
    });
    return { ...sumActivity(series, days, now()), accounts: included, errors };
  }

  return http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/accounts') {
        const registry = await loadRegistry();
        const accounts = await Promise.all(registry.accounts.map((account) => describe(registry, account)));
        const body: AccountsResponse = {
          mode: registry.mode,
          primaryAccountId: registry.primaryAccountId,
          minHeadroomPercent: registry.minHeadroomPercent,
          accounts,
        };
        response.end(JSON.stringify(body));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/rate-limits') {
        const registry = await loadRegistry();
        const result = await pool.get(defaultAccount(registry)).request('account/rateLimits/read');
        response.end(JSON.stringify(normalizeRateLimits(result)));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/activity') {
        const requestedDays = Number(url.searchParams.get('days')) || 30;
        const days = Math.min(Math.max(Math.trunc(requestedDays), 1), 365);
        const registry = await loadRegistry();
        const accountId = url.searchParams.get('account');
        if (accountId === 'all') {
          response.end(JSON.stringify(await allActivity(registry, days)));
          return;
        }
        const account = accountId
          ? registry.accounts.find((candidate) => candidate.id === accountId)
          : defaultAccount(registry);
        if (!account) throw new HttpError(404, `Unknown account "${accountId}".`);
        response.end(JSON.stringify(await accountActivity(account, days)));
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: 'Not found' }));
    } catch (error) {
      response.writeHead(error instanceof HttpError ? error.status : 502);
      response.end(JSON.stringify({ error: errorMessage(error, 'Codex usage is unavailable.') }));
    }
  }).on('close', () => pool.closeAll());
}
