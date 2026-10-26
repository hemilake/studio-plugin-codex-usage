/**
 * Codex Usage tab: live plan limits and token activity for every Codex account Studio knows about.
 *
 * The host imports this file from a Blob URL, so it cannot import other modules at
 * runtime: keep every import here type-only.
 */

import type { AccountsResponse, AccountView } from './server-app.js';
import type { PluginAPI, PluginContext } from './types.js';
import type { ActivityData, RateLimitsData, RateWindow } from './usage.js';

type ThemeColors = {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  ok: string;
  warn: string;
  bad: string;
  font: string;
};

type State = {
  accounts: AccountsResponse | null;
  accountsError: string | null;
  activityAccount: string;
  activity: ActivityData | null;
  activityError: string | null;
  loading: boolean;
};

/** Highest usedPercent across every window of every limit, or null if there are none. */
export function maxUsedPercent(limits: RateLimitsData | null): number | null {
  const percents = limits?.limits.flatMap((limit) => limit.windows.map((window) => window.usedPercent)) ?? [];
  return percents.length > 0 ? Math.max(...percents) : null;
}

export type HeadroomCandidate = {
  id: string;
  enabled: boolean;
  signedIn: boolean;
  limits: RateLimitsData | null;
};

/**
 * The enabled, signed-in account with the most headroom: lowest max usedPercent,
 * skipping accounts where any limit reports a reached type. Ties go to the
 * earlier account (priority order).
 */
export function pickMostHeadroom(accounts: HeadroomCandidate[]): string | null {
  let best: { id: string; used: number } | null = null;
  for (const account of accounts) {
    if (!account.enabled || !account.signedIn || !account.limits) continue;
    if (account.limits.limits.some((limit) => limit.reachedType !== null)) continue;
    const used = maxUsedPercent(account.limits);
    if (used === null) continue;
    if (!best || used < best.used) best = { id: account.id, used };
  }
  return best?.id ?? null;
}

const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, monospace";

/** '#10a37f' → '165 82% 35%', the HSL triplet format Studio's theme variables use. */
export function hexToHslTriplet(hex: string): string {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;
  if (max !== min) {
    const delta = max - min;
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
  }
  const round = (number: number) => Math.round(number * 10) / 10;
  return `${round(hue)} ${round(saturation * 100)}% ${round(lightness * 100)}%`;
}

/** A Studio theme colour with the plugin's own colour as fallback outside Studio. */
function themeColor(variables: string[], fallbackHex: string): string {
  const fallback = hexToHslTriplet(fallbackHex);
  const nested = variables.reduceRight((inner, name) => `var(${name}, ${inner})`, fallback);
  return `hsl(${nested})`;
}

function colors(dark: boolean): ThemeColors {
  const own = dark
    ? { bg: '#080b0a', surface: '#0d1311', border: '#1c2924', text: '#e2eee9', muted: '#71857d', accent: '#10a37f', ok: '#34d399', warn: '#f59e0b', bad: '#fb7185' }
    : { bg: '#f8faf9', surface: '#ffffff', border: '#dfe8e4', text: '#10201a', muted: '#6f827a', accent: '#087f5f', ok: '#059669', warn: '#d97706', bad: '#e11d48' };
  return {
    bg: themeColor(['--background'], own.bg),
    surface: themeColor(['--card'], own.surface),
    border: themeColor(['--border'], own.border),
    text: themeColor(['--foreground'], own.text),
    muted: themeColor(['--muted-foreground'], own.muted),
    accent: themeColor(['--hemi-copper'], own.accent),
    accentText: themeColor(['--hemi-copper-text', '--hemi-copper'], own.accent),
    ok: themeColor(['--hemi-ok'], own.ok),
    warn: own.warn,
    bad: themeColor(['--destructive'], own.bad),
    font: `var(--font-mono, ${MONO})`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character] as string));
}

function formatTokens(value: number | null): string {
  if (value === null) return '—';
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${(value / 1_000_000_000).toFixed(2)}B`;
}

function formatDuration(minutes: number): string {
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatPercent(percent: number): string {
  return `${percent.toFixed(percent % 1 === 0 ? 0 : 1)}%`;
}

function resetCountdown(timestamp: string | null): string {
  if (!timestamp) return 'reset unknown';
  const remainingMs = Date.parse(timestamp) - Date.now();
  if (!Number.isFinite(remainingMs)) return 'reset unknown';
  if (remainingMs <= 0) return 'resetting…';
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

function severityColor(theme: ThemeColors, percent: number): string {
  if (percent >= 90) return theme.bad;
  if (percent >= 70) return theme.warn;
  return theme.ok;
}

function card(title: string, body: string, extraClass = ''): string {
  return `<section class="cx-card ${extraClass}"><div class="cx-eyebrow">${title}</div>${body}</section>`;
}

function errorNote(message: string): string {
  return `<div class="cx-error">⚠ ${escapeHtml(message)}</div>`;
}

function badge(text: string, kind = ''): string {
  return `<span class="cx-badge ${kind}">${escapeHtml(text)}</span>`;
}

function renderWindow(theme: ThemeColors, limitName: string, window: RateWindow): string {
  const percent = Math.max(0, Math.min(100, window.usedPercent));
  const color = severityColor(theme, percent);
  const label = `${limitName === 'codex' ? 'Codex' : limitName} · ${formatDuration(window.windowDurationMins)}`;
  return `
    <div class="cx-limit">
      <div class="cx-limit-row">
        <span>${escapeHtml(label)}</span>
        <span class="cx-muted">${formatPercent(percent)} · ${resetCountdown(window.resetsAt)}</span>
      </div>
      <div class="cx-track"><div class="cx-fill" style="width:${percent}%;background:${color}"></div></div>
    </div>`;
}

function renderLimits(theme: ThemeColors, data: RateLimitsData): string {
  if (data.limits.length === 0) {
    return '<div class="cx-muted">No ChatGPT-backed Codex limits were returned.</div>';
  }
  const reached = data.limits.filter((limit) => limit.reachedType !== null);
  const reachedNote = reached.length > 0
    ? `<div class="cx-reached">Limit reached${reached.map((limit) => ` · ${escapeHtml(limit.reachedType ?? '')}`).join('')}</div>`
    : '';
  const windows = data.limits.flatMap((limit) => limit.windows.map((window) => renderWindow(theme, limit.name ?? limit.id, window)));
  return `${reachedNote}${windows.join('')}`;
}

function renderAccount(theme: ThemeColors, data: AccountsResponse, account: AccountView): string {
  const badges = [
    account.planType ? badge(account.planType) : '',
    data.mode === 'backup' ? badge(account.isPrimary ? 'Primary' : 'Backup', account.isPrimary ? 'cx-badge-accent' : '') : '',
    account.enabled ? '' : badge('Disabled', 'cx-badge-off'),
    account.limits && account.limits.resetCreditsAvailable > 0
      ? badge(`${account.limits.resetCreditsAvailable} free reset${account.limits.resetCreditsAvailable === 1 ? '' : 's'}`, 'cx-badge-accent')
      : '',
  ].join('');
  const header = `
    <div class="cx-account-head">
      <div class="cx-account-label">${escapeHtml(account.label)}</div>
      <div class="cx-badges">${badges}</div>
    </div>
    ${account.email ? `<div class="cx-email">${escapeHtml(account.email)}</div>` : ''}`;
  let body: string;
  if (!account.signedIn) body = '<div class="cx-muted">Not signed in to Codex.</div>';
  else if (account.limits) body = renderLimits(theme, account.limits);
  else body = account.error ? '' : '<div class="cx-muted">No limits returned.</div>';
  const error = account.error ? errorNote(account.error) : '';
  return `<section class="cx-card cx-account${account.enabled ? '' : ' cx-account-off'}">${header}${body}${error}</section>`;
}

function renderSummary(data: AccountsResponse): string {
  const mode = data.mode === 'backup' ? 'Backup' : 'Round robin';
  const bestId = pickMostHeadroom(data.accounts);
  const best = data.accounts.find((account) => account.id === bestId);
  const primary = data.accounts.find((account) => account.isPrimary);
  const parts: string[] = [];
  if (data.mode === 'backup' && primary) parts.push(`Primary: ${escapeHtml(primary.label)}.`);
  if (best) {
    const used = maxUsedPercent(best.limits) ?? 0;
    const lead = data.mode === 'round_robin' ? 'Next pick' : 'Most headroom';
    parts.push(`${lead}: <strong>${escapeHtml(best.label)}</strong> (${formatPercent(used)} used at most).`);
  } else {
    parts.push('No enabled account has headroom right now.');
  }
  return `
    <div class="cx-summary">
      ${badge(mode, 'cx-badge-accent')}
      <span>${parts.join(' ')}</span>
    </div>`;
}

function renderAccounts(theme: ThemeColors, data: AccountsResponse | null, error: string | null): string {
  if (error) return card('accounts', errorNote(error));
  if (!data) return card('accounts', '<div class="cx-muted">Loading…</div>');
  return `${renderSummary(data)}<div class="cx-accounts">${data.accounts.map((account) => renderAccount(theme, data, account)).join('')}</div>`;
}

function renderChart(activity: ActivityData): string {
  const maximum = Math.max(1, ...activity.daily.map((day) => day.tokens));
  const bars = activity.daily.map((day, index) => {
    const height = Math.round((day.tokens / maximum) * 100);
    const opacity = 0.4 + (0.6 * index) / Math.max(activity.daily.length - 1, 1);
    const title = escapeHtml(`${day.date}: ${formatTokens(day.tokens)} tokens`);
    return `<div class="cx-bar-slot" title="${title}"><div class="cx-bar" style="height:${Math.max(height, day.tokens > 0 ? 3 : 0)}%;opacity:${opacity}"></div></div>`;
  }).join('');
  return `
    <div class="cx-chart">${bars}</div>
    <div class="cx-axis"><span>${activity.daily[0]?.date ?? ''}</span><span>${activity.daily.at(-1)?.date ?? ''}</span></div>`;
}

function renderSelector(state: State): string {
  const accounts = state.accounts?.accounts ?? [];
  const options = [
    ...accounts.map((account) => ({ value: account.id, label: account.label })),
    ...(accounts.length > 1 ? [{ value: 'all', label: 'All accounts' }] : []),
  ];
  if (options.length === 0) options.push({ value: state.activityAccount, label: state.activityAccount });
  const items = options.map((option) => (
    `<option value="${escapeHtml(option.value)}"${option.value === state.activityAccount ? ' selected' : ''}>${escapeHtml(option.label)}</option>`
  )).join('');
  return `<label class="cx-select-wrap"><span class="cx-eyebrow">account</span><select class="cx-select">${items}</select></label>`;
}

function renderActivity(state: State): string {
  const data = state.activity;
  const heading = `<div class="cx-section-head"><div class="cx-section-title">Token activity</div>${renderSelector(state)}</div>`;
  if (state.activityError) return `${heading}${card('token activity (30 days)', errorNote(state.activityError))}`;
  if (!data) return `${heading}${card('token activity (30 days)', '<div class="cx-muted">Loading…</div>')}`;
  const failed = (data as ActivityData & { errors?: { id: string; error: string }[] }).errors ?? [];
  const failedNote = failed.length > 0
    ? errorNote(`Left out: ${failed.map((entry) => `${entry.id} (${entry.error})`).join('; ')}`)
    : '';
  const stats: [string, string][] = [
    ['30-day tokens', formatTokens(data.totalTokens)],
    ['lifetime tokens', formatTokens(data.summary.lifetimeTokens)],
    ['peak day', formatTokens(data.summary.peakDailyTokens)],
    ['current streak', data.summary.currentStreakDays === null ? '—' : `${data.summary.currentStreakDays}d`],
  ];
  return `
    ${heading}
    ${failedNote}
    <div class="cx-stats">
      ${stats.map(([label, value]) => `<div class="cx-stat"><div class="cx-stat-value">${value}</div><div class="cx-eyebrow">${label}</div></div>`).join('')}
    </div>
    ${card('daily tokens (30 days)', renderChart(data))}`;
}

function stylesheet(theme: ThemeColors): string {
  return `<style>
    .cx-root{min-height:100%;box-sizing:border-box;padding:24px;background:${theme.bg};color:${theme.text};font-family:${theme.font}}
    .cx-root *{box-sizing:border-box}
    .cx-header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}
    .cx-title{font-size:1.3rem;font-weight:750;letter-spacing:-.03em}.cx-cursor{color:${theme.accent}}
    .cx-refresh{padding:6px 12px;background:transparent;border:1px solid ${theme.border};color:${theme.muted};font:inherit;font-size:.7rem;border-radius:5px;cursor:pointer;flex-shrink:0}.cx-refresh:hover{color:${theme.text};border-color:${theme.muted}}.cx-refresh:disabled{opacity:.55;cursor:wait}
    .cx-summary{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:.74rem;line-height:1.5;margin-bottom:14px}.cx-summary .cx-badge{margin-left:0}
    .cx-accounts{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:12px;margin-bottom:20px}.cx-accounts .cx-card{margin-bottom:0}
    .cx-card,.cx-stat{background:${theme.surface};border:1px solid ${theme.border};border-radius:6px;padding:18px;margin-bottom:12px;min-width:0}
    .cx-account-off{opacity:.65}
    .cx-account-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px;margin-bottom:4px}
    .cx-account-label{font-size:.9rem;font-weight:700;overflow-wrap:anywhere}
    .cx-badges{display:flex;flex-wrap:wrap;gap:4px}.cx-badges .cx-badge{margin-left:0}
    .cx-email{font-size:.68rem;color:${theme.muted};overflow-wrap:anywhere;margin-bottom:14px}
    .cx-account-head + .cx-limit,.cx-account-head + .cx-muted,.cx-account-head + .cx-reached{margin-top:12px}
    .cx-eyebrow{font-size:.62rem;color:${theme.muted};letter-spacing:.11em;text-transform:uppercase;margin-bottom:14px}
    .cx-badge{display:inline-block;border:1px solid ${theme.border};border-radius:4px;padding:2px 7px;margin-left:6px;font-size:.64rem;color:${theme.muted};letter-spacing:normal;text-transform:none}.cx-badge-accent{border-color:${theme.accent};color:${theme.accentText}}.cx-badge-off{border-color:${theme.muted};color:${theme.text}}
    .cx-reached{font-size:.72rem;font-weight:700;color:${theme.bad};margin-bottom:10px}
    .cx-limit{margin-bottom:15px}.cx-limit:last-child{margin-bottom:0}.cx-limit-row{display:flex;justify-content:space-between;gap:12px;font-size:.72rem;margin-bottom:6px}.cx-muted{font-size:.73rem;color:${theme.muted}}
    .cx-track{height:7px;background:${theme.border};border-radius:4px;overflow:hidden}.cx-fill{height:100%;border-radius:4px;transition:width .35s ease}
    .cx-error{font-size:.74rem;color:${theme.warn};line-height:1.6;margin-top:8px;overflow-wrap:anywhere}
    .cx-section-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px}.cx-section-title{font-size:.95rem;font-weight:700}
    .cx-select-wrap{display:flex;align-items:center;gap:8px}.cx-select-wrap .cx-eyebrow{margin:0}
    .cx-select{max-width:220px;padding:5px 8px;background:${theme.surface};color:${theme.text};border:1px solid ${theme.border};border-radius:5px;font:inherit;font-size:.72rem}
    .cx-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.cx-stat{margin-bottom:12px}.cx-stat-value{font-size:1.3rem;font-weight:750;letter-spacing:-.03em;margin-bottom:5px}.cx-stat .cx-eyebrow{margin:0}
    .cx-chart{height:110px;display:flex;align-items:flex-end;gap:3px}.cx-bar-slot{height:100%;flex:1;display:flex;align-items:flex-end}.cx-bar{width:100%;background:${theme.accent};border-radius:2px 2px 0 0;min-height:0}.cx-axis{display:flex;justify-content:space-between;color:${theme.muted};font-size:.62rem;margin-top:7px}
    .cx-footnote{color:${theme.muted};font-size:.64rem;line-height:1.6;margin-top:14px}
    @media(max-width:720px){.cx-root{padding:16px}.cx-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.cx-limit-row{align-items:flex-start;flex-direction:column;gap:3px}.cx-chart{gap:2px}}
    @media(max-width:420px){.cx-root{padding:10px}.cx-card,.cx-stat{padding:12px}.cx-stats{gap:8px}.cx-stat-value{font-size:1.05rem}.cx-chart{gap:1px}.cx-select{max-width:160px}}
  </style>`;
}

export function mount(container: HTMLElement, api: PluginAPI): void {
  const root = document.createElement('div');
  root.className = 'cx-root';
  container.appendChild(root);
  const state: State = {
    accounts: null,
    accountsError: null,
    activityAccount: 'default',
    activity: null,
    activityError: null,
    loading: false,
  };
  let disposed = false;
  let activityRequest = 0;

  function render(context: PluginContext): void {
    if (disposed) return;
    const theme = colors(context.theme === 'dark');
    root.innerHTML = `${stylesheet(theme)}
      <div class="cx-header">
        <div class="cx-title">Codex Usage<span class="cx-cursor">▌</span></div>
        <button class="cx-refresh" type="button" ${state.loading ? 'disabled' : ''}>${state.loading ? 'refreshing…' : '↻ refresh'}</button>
      </div>
      ${renderAccounts(theme, state.accounts, state.accountsError)}
      ${renderActivity(state)}
      <div class="cx-footnote">Usage is read through the official Codex app-server, one per account. This plugin never reads or stores your authentication tokens.</div>`;
    root.querySelector<HTMLButtonElement>('.cx-refresh')?.addEventListener('click', () => void load(true));
    root.querySelector<HTMLSelectElement>('.cx-select')?.addEventListener('change', (event) => {
      state.activityAccount = (event.target as HTMLSelectElement).value;
      state.activity = null;
      state.activityError = null;
      render(api.context);
      void loadActivity();
    });
  }

  async function loadAccounts(): Promise<void> {
    try {
      state.accounts = await api.rpc('GET', 'accounts') as AccountsResponse;
      state.accountsError = null;
      const ids = state.accounts.accounts.map((account) => account.id);
      if (state.activityAccount !== 'all' && !ids.includes(state.activityAccount) && ids[0]) {
        state.activityAccount = ids[0];
        state.activity = null;
        void loadActivity();
      }
    } catch (error) {
      state.accounts = null;
      state.accountsError = error instanceof Error ? error.message : 'Codex accounts are unavailable.';
    } finally {
      render(api.context);
    }
  }

  async function loadActivity(): Promise<void> {
    const requestId = ++activityRequest;
    const account = state.activityAccount;
    try {
      const data = await api.rpc('GET', `activity?account=${encodeURIComponent(account)}&days=30`) as ActivityData;
      if (requestId !== activityRequest) return;
      state.activity = data;
      state.activityError = null;
    } catch (error) {
      if (requestId !== activityRequest) return;
      state.activity = null;
      state.activityError = error instanceof Error ? error.message : 'Token activity is unavailable.';
    } finally {
      if (requestId === activityRequest) render(api.context);
    }
  }

  async function load(includeActivity: boolean): Promise<void> {
    if (state.loading || disposed) return;
    state.loading = true;
    render(api.context);
    await Promise.all([loadAccounts(), includeActivity || !state.activity ? loadActivity() : Promise.resolve()]);
    state.loading = false;
    render(api.context);
  }

  render(api.context);
  void load(true);
  const timer = window.setInterval(() => void load(false), 60_000);
  const unsubscribe = api.onContextChange(render);
  (container as HTMLElement & { _codexUsageCleanup?: () => void })._codexUsageCleanup = () => {
    disposed = true;
    window.clearInterval(timer);
    unsubscribe();
  };
}

export function unmount(container: HTMLElement): void {
  const target = container as HTMLElement & { _codexUsageCleanup?: () => void };
  target._codexUsageCleanup?.();
  delete target._codexUsageCleanup;
  container.innerHTML = '';
}
