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

// Selection policy copied from Studio core
// (server/modules/providers/list/codex/accounts/codex-accounts.selector.ts) so the
// summary names the account Studio would really hand the next turn to. Keep the two
// in step. The sticky-session rule is left out: the tab has no session.

/**
 * Codex capacity of each plan relative to Plus. Estimates from OpenAI's
 * published multipliers; unknown plans count as Plus. The registry's
 * `planWeights` overrides any entry.
 */
export const DEFAULT_PLAN_WEIGHTS: Record<string, number> = {
  free: 0.25,
  go: 0.5,
  plus: 1,
  team: 1,
  business: 1,
  enterprise: 1,
  edu: 1,
  pro: 6,
};

const EFFORT_HEADROOM_FACTOR: Record<string, number> = {
  minimal: 0.5,
  low: 1,
  medium: 1,
  high: 2,
  xhigh: 3,
};

export function planWeight(planType: string | null, overrides: Record<string, number> = {}): number {
  if (!planType) return 1;
  const key = planType.toLowerCase();
  const table = { ...DEFAULT_PLAN_WEIGHTS, ...overrides };
  if (typeof table[key] === 'number') return table[key]!;
  // Codex reports compound names such as `self_serve_business_prolite`; match
  // the most specific known plan inside them, longest name first.
  const match = Object.keys(table)
    .sort((a, b) => b.length - a.length)
    .find((name) => key.split(/[^a-z0-9]+/).includes(name));
  return match ? table[match]! : 1;
}

/**
 * Percent of the tightest window still free, or null when the limits were not
 * read. Windows whose reset time has passed count as empty; a reached limit is 0.
 */
export function remainingPercent(limits: RateLimitsData | null, now: number): number | null {
  if (!limits) return null;
  const windows = limits.limits.flatMap((limit) => limit.windows);
  const live = windows.filter((window) => window.resetsAt === null || Date.parse(window.resetsAt) > now);
  if (limits.limits.some((limit) => limit.reachedType !== null) && live.length > 0) return 0;
  if (live.length === 0) return windows.length > 0 ? 100 : null;
  return Math.max(0, 100 - Math.max(...live.map((window) => window.usedPercent)));
}

export function requiredHeadroomFor(effort: string | null | undefined, minHeadroomPercent: number): number {
  const factor = EFFORT_HEADROOM_FACTOR[(effort || 'medium').toLowerCase()] ?? 1;
  return minHeadroomPercent * factor;
}

/** Remaining percent times plan weight: "percent of a Plus window". Null when unknown. */
export function weightedHeadroom(
  account: Pick<AccountView, 'planType' | 'limits'>,
  planWeights: Record<string, number>,
  now: number,
): number | null {
  const remaining = remainingPercent(account.limits, now);
  return remaining === null ? null : remaining * planWeight(account.planType, planWeights);
}

export type SelectionInput = Pick<AccountsResponse, 'mode' | 'primaryAccountId' | 'minHeadroomPercent' | 'planWeights' | 'roundRobinCursor'> & {
  accounts: Pick<AccountView, 'id' | 'enabled' | 'signedIn' | 'planType' | 'limits'>[];
};

export type Selection = {
  accountId: string;
  reason: 'single' | 'primary' | 'backup' | 'round_robin' | 'fallback';
};

type Candidate = { id: string; enabled: boolean; signedIn: boolean; headroom: number | null; eligible: boolean };

/** The account Studio would pick for the next turn at medium effort. */
export function selectNextAccount(data: SelectionInput, now: number, effort: string | null = 'medium'): Selection | null {
  const accounts = data.accounts;
  if (accounts.length === 0) return null;
  if (accounts.length === 1) return { accountId: accounts[0]!.id, reason: 'single' };

  const required = requiredHeadroomFor(effort, data.minHeadroomPercent);
  const candidates: Candidate[] = accounts.map((account) => {
    const base = { id: account.id, enabled: account.enabled, signedIn: account.signedIn };
    if (!account.enabled || !account.signedIn) return { ...base, headroom: null, eligible: false };
    const remaining = remainingPercent(account.limits, now);
    // Never read (or the read failed): Studio tries it rather than skipping it.
    if (remaining === null) return { ...base, headroom: null, eligible: true };
    const headroom = remaining * planWeight(account.planType, data.planWeights);
    return { ...base, headroom, eligible: remaining > 0 && headroom >= required };
  });
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  if (data.mode === 'backup') {
    const primary = byId.get(data.primaryAccountId);
    if (primary?.eligible) return { accountId: primary.id, reason: 'primary' };
    const backup = candidates.find((candidate) => candidate.eligible);
    if (backup) return { accountId: backup.id, reason: 'backup' };
  } else {
    const cursorIndex = data.roundRobinCursor
      ? candidates.findIndex((candidate) => candidate.id === data.roundRobinCursor)
      : -1;
    for (let step = 1; step <= candidates.length; step += 1) {
      const candidate = candidates[(cursorIndex + step + candidates.length) % candidates.length]!;
      if (candidate.eligible) return { accountId: candidate.id, reason: 'round_robin' };
    }
  }

  const usable = candidates.filter((candidate) => candidate.enabled && candidate.signedIn);
  const best = usable
    .filter((candidate) => candidate.headroom !== null)
    .sort((a, b) => (b.headroom ?? 0) - (a.headroom ?? 0))[0]
    ?? usable[0]
    ?? candidates.find((candidate) => candidate.enabled)
    ?? byId.get(data.primaryAccountId)
    ?? candidates[0]!;
  return { accountId: best.id, reason: 'fallback' };
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

function formatHeadroom(headroom: number): string {
  return `≈ ${Math.round(headroom)}% of a Plus window`;
}

function renderAccount(theme: ThemeColors, data: AccountsResponse, account: AccountView, next: Selection | null): string {
  const headroom = account.signedIn ? weightedHeadroom(account, data.planWeights ?? {}, Date.now()) : null;
  const badges = [
    next?.accountId === account.id ? badge('Next', 'cx-badge-accent') : '',
    account.planType ? badge(account.planType) : '',
    headroom !== null ? badge(formatHeadroom(headroom), 'cx-badge-plain') : '',
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

/** Sentence for the header; exported for tests. */
export function summaryText(data: AccountsResponse, next: Selection | null, now: number): string {
  const label = (id: string) => escapeHtml(data.accounts.find((account) => account.id === id)?.label ?? id);
  if (!next) return 'No accounts.';
  const picked = data.accounts.find((account) => account.id === next.accountId);
  const headroom = picked ? weightedHeadroom(picked, data.planWeights ?? {}, now) : null;
  const detail = headroom === null ? '' : ` (${formatHeadroom(headroom)})`;
  const name = `<strong>${label(next.accountId)}</strong>${detail}`;
  switch (next.reason) {
    case 'single':
      return `Only account: ${name}.`;
    case 'primary':
      return `Next turn: ${name}, the primary.`;
    case 'backup':
      return `Next turn: ${name}, a backup; the primary ${label(data.primaryAccountId)} lacks headroom.`;
    case 'round_robin':
      return `Next turn: ${name}${data.roundRobinCursor ? `, after ${label(data.roundRobinCursor)}` : ''}.`;
    case 'fallback': {
      const required = requiredHeadroomFor('medium', data.minHeadroomPercent);
      return `No account has the ${Math.round(required)}% headroom a turn needs. Fallback: ${name}.`;
    }
  }
}

function renderSummary(data: AccountsResponse, next: Selection | null): string {
  const mode = data.mode === 'backup' ? 'Backup' : 'Round robin';
  return `
    <div class="cx-summary">
      ${badge(mode, 'cx-badge-accent')}
      <span>${summaryText(data, next, Date.now())}</span>
    </div>`;
}

function renderAccounts(theme: ThemeColors, data: AccountsResponse | null, error: string | null): string {
  if (error) return card('accounts', errorNote(error));
  if (!data) return card('accounts', '<div class="cx-muted">Loading…</div>');
  const next = selectNextAccount({ ...data, planWeights: data.planWeights ?? {}, roundRobinCursor: data.roundRobinCursor ?? null }, Date.now());
  return `${renderSummary(data, next)}<div class="cx-accounts">${data.accounts.map((account) => renderAccount(theme, data, account, next)).join('')}</div>`;
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

/** The <option> list; the <select> itself is created once and kept. */
function renderSelectorOptions(state: State): string {
  const accounts = state.accounts?.accounts ?? [];
  const options = [
    ...accounts.map((account) => ({ value: account.id, label: account.label })),
    ...(accounts.length > 1 ? [{ value: 'all', label: 'All accounts' }] : []),
  ];
  if (options.length === 0) options.push({ value: state.activityAccount, label: state.activityAccount });
  const items = options.map((option) => (
    `<option value="${escapeHtml(option.value)}"${option.value === state.activityAccount ? ' selected' : ''}>${escapeHtml(option.label)}</option>`
  )).join('');
  return items;
}

function renderActivity(state: State): string {
  const data = state.activity;
  if (state.activityError) return card('token activity (30 days)', errorNote(state.activityError));
  if (!data) return card('token activity (30 days)', '<div class="cx-muted">Loading…</div>');
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
    .cx-badge{display:inline-block;border:1px solid ${theme.border};border-radius:4px;padding:2px 7px;margin-left:6px;font-size:.64rem;color:${theme.muted};letter-spacing:normal;text-transform:none}.cx-badge-accent{border-color:${theme.accent};color:${theme.accentText}}.cx-badge-off{border-color:${theme.muted};color:${theme.text}}.cx-badge-plain{border-color:transparent;padding-left:2px;padding-right:2px}
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

  // The frame is built once. Refreshes replace only the data regions, so the
  // account <select> keeps its DOM node and an open dropdown stays open.
  root.innerHTML = `
    <div class="cx-style"></div>
    <div class="cx-header">
      <div class="cx-title">Codex Usage<span class="cx-cursor">▌</span></div>
      <button class="cx-refresh" type="button"></button>
    </div>
    <div class="cx-accounts-region"></div>
    <div class="cx-section-head">
      <div class="cx-section-title">Token activity</div>
      <label class="cx-select-wrap"><span class="cx-eyebrow">account</span><select class="cx-select"></select></label>
    </div>
    <div class="cx-activity-region"></div>
    <div class="cx-footnote">Usage is read through the official Codex app-server, one per account. This plugin never reads or stores your authentication tokens.</div>`;
  const styleRegion = root.querySelector<HTMLElement>('.cx-style')!;
  const refreshButton = root.querySelector<HTMLButtonElement>('.cx-refresh')!;
  const accountsRegion = root.querySelector<HTMLElement>('.cx-accounts-region')!;
  const select = root.querySelector<HTMLSelectElement>('.cx-select')!;
  const activityRegion = root.querySelector<HTMLElement>('.cx-activity-region')!;
  let renderedTheme: string | null = null;
  let renderedOptions: string | null = null;

  refreshButton.addEventListener('click', () => void load(true));
  select.addEventListener('change', () => {
    state.activityAccount = select.value;
    state.activity = null;
    state.activityError = null;
    render(api.context);
    void loadActivity();
  });
  // Option changes that arrived while the dropdown had focus are applied on blur.
  select.addEventListener('blur', () => render(api.context));

  function render(context: PluginContext): void {
    if (disposed) return;
    const theme = colors(context.theme === 'dark');
    if (renderedTheme !== context.theme) {
      styleRegion.innerHTML = stylesheet(theme);
      renderedTheme = context.theme;
    }
    refreshButton.disabled = state.loading;
    refreshButton.textContent = state.loading ? 'refreshing…' : '↻ refresh';
    accountsRegion.innerHTML = renderAccounts(theme, state.accounts, state.accountsError);
    const options = renderSelectorOptions(state);
    if (options !== renderedOptions && document.activeElement !== select) {
      select.innerHTML = options;
      select.value = state.activityAccount;
      renderedOptions = options;
    }
    activityRegion.innerHTML = renderActivity(state);
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
