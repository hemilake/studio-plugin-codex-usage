import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

type RpcResponse = {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

const REQUEST_TIMEOUT_MS = 15_000;

/** Small JSON-RPC client for the official `codex app-server` stdio transport. */
export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private initialized = false;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stderrTail = '';

  async request(method: string, params: JsonRecord = {}): Promise<unknown> {
    await this.ensureStarted();
    return this.sendRequest(method, params);
  }

  close(): void {
    const process = this.process;
    this.process = null;
    this.initialized = false;
    if (process && !process.killed) process.kill('SIGTERM');
    this.rejectPending(new Error('Codex app-server stopped.'));
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && this.initialized && !this.process.killed) return;
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
  }

  private async start(): Promise<void> {
    const child = spawn('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.process = child;
    this.initialized = false;
    this.stderrTail = '';

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-8_000);
    });
    child.once('error', (error) => {
      this.handleExit(new Error(`Unable to start Codex CLI: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      const detail = this.stderrTail.trim();
      const suffix = detail ? ` ${detail}` : '';
      this.handleExit(new Error(`Codex app-server exited (${signal ?? code ?? 'unknown'}).${suffix}`));
    });

    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'cloudcli_codex_usage',
        title: 'CloudCLI Codex Usage',
        version: '1.0.0',
      },
      capabilities: {
        optOutNotificationMethods: ['account/rateLimits/updated'],
      },
    });
    this.sendNotification('initialized', {});
    this.initialized = true;
  }

  private sendRequest(method: string, params: JsonRecord): Promise<unknown> {
    const child = this.process;
    if (!child || child.killed || !child.stdin.writable) {
      return Promise.reject(new Error('Codex app-server is not running.'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private sendNotification(method: string, params: JsonRecord): void {
    const child = this.process;
    if (child && !child.killed && child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  private handleLine(line: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? `Codex app-server error ${message.error.code ?? ''}`.trim()));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleExit(error: Error): void {
    this.process = null;
    this.initialized = false;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

type JsonRecord = Record<string, unknown>;
