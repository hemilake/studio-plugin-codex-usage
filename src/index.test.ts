import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hexToHslTriplet,
  planWeight,
  remainingPercent,
  requiredHeadroomFor,
  selectNextAccount,
  summaryText,
  weightedHeadroom,
  type SelectionInput,
} from './index.js';
import type { AccountsResponse } from './server-app.js';
import type { RateLimitsData } from './usage.js';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const LATER = new Date(NOW + 3_600_000).toISOString();
const EARLIER = new Date(NOW - 3_600_000).toISOString();

function limits(percents: number[], reachedType: string | null = null, resetsAt: string | null = LATER): RateLimitsData {
  return {
    resetCreditsAvailable: 0,
    limits: [{
      id: 'codex',
      name: null,
      planType: null,
      reachedType,
      credits: null,
      windows: percents.map((usedPercent, index) => ({
        kind: index === 0 ? 'primary' : 'secondary',
        usedPercent,
        windowDurationMins: 300,
        resetsAt,
      })),
    }],
  };
}

type AccountInput = SelectionInput['accounts'][number];

function account(id: string, used: number[] | null, extra: Partial<AccountInput> = {}): AccountInput {
  return { id, enabled: true, signedIn: true, planType: 'plus', limits: used ? limits(used) : null, ...extra };
}

function registry(accounts: AccountInput[], extra: Partial<SelectionInput> = {}): SelectionInput {
  return {
    mode: 'round_robin',
    primaryAccountId: accounts[0]!.id,
    minHeadroomPercent: 5,
    planWeights: {},
    roundRobinCursor: null,
    accounts,
    ...extra,
  };
}

test('planWeight uses the table, overrides and compound plan names', () => {
  assert.equal(planWeight('pro'), 6);
  assert.equal(planWeight('PLUS'), 1);
  assert.equal(planWeight(null), 1);
  assert.equal(planWeight('mystery'), 1);
  assert.equal(planWeight('self_serve_business_prolite'), 1);
  assert.equal(planWeight('chatgpt_pro_monthly'), 6);
  assert.equal(planWeight('pro', { pro: 8 }), 8);
  assert.equal(planWeight('self_serve_business_prolite', { business: 2 }), 2);
});

test('remainingPercent takes the tightest live window', () => {
  assert.equal(remainingPercent(limits([10, 62]), NOW), 38);
  assert.equal(remainingPercent(null, NOW), null);
  assert.equal(remainingPercent(limits([1], 'rate_limit_reached'), NOW), 0);
  assert.equal(remainingPercent(limits([100], null, EARLIER), NOW), 100);
  assert.equal(remainingPercent(limits([100], 'rate_limit_reached', EARLIER), NOW), 100);
});

test('required headroom scales with effort', () => {
  assert.equal(requiredHeadroomFor('medium', 5), 5);
  assert.equal(requiredHeadroomFor(null, 5), 5);
  assert.equal(requiredHeadroomFor('high', 5), 10);
  assert.equal(requiredHeadroomFor('xhigh', 5), 15);
});

test('weightedHeadroom is remaining times plan weight', () => {
  assert.equal(weightedHeadroom({ planType: 'pro', limits: limits([90]) }, {}, NOW), 60);
  assert.equal(weightedHeadroom({ planType: 'plus', limits: null }, {}, NOW), null);
});

test('a single account is always the pick', () => {
  assert.deepEqual(selectNextAccount(registry([account('a', [100], { enabled: false })]), NOW), { accountId: 'a', reason: 'single' });
});

test('backup mode keeps the primary while it is eligible', () => {
  const data = registry([account('b', [0]), account('p', [50])], { mode: 'backup', primaryAccountId: 'p' });
  assert.deepEqual(selectNextAccount(data, NOW), { accountId: 'p', reason: 'primary' });
});

test('backup mode falls to the first eligible account in order', () => {
  const data = registry([
    account('p', [97]),
    account('off', [0], { enabled: false }),
    account('out', [0], { signedIn: false }),
    account('full', [10], { limits: limits([10], 'rate_limit_reached') }),
    account('b1', [40]),
    account('b2', [0]),
  ], { mode: 'backup', primaryAccountId: 'p' });
  assert.deepEqual(selectNextAccount(data, NOW), { accountId: 'b1', reason: 'backup' });
});

test('plan weight lets a nearly full Pro account through', () => {
  const data = registry([account('p', [99], { planType: 'pro' }), account('b', [0])], { mode: 'backup', primaryAccountId: 'p' });
  assert.deepEqual(selectNextAccount(data, NOW), { accountId: 'p', reason: 'primary' });
  const strict = { ...data, planWeights: { pro: 1 } };
  assert.deepEqual(selectNextAccount(strict, NOW), { accountId: 'b', reason: 'backup' });
});

test('round robin takes the first eligible account after the cursor, wrapping', () => {
  const accounts = [account('a', [10]), account('b', [99]), account('c', [10])];
  assert.equal(selectNextAccount(registry(accounts, { roundRobinCursor: null }), NOW)?.accountId, 'a');
  assert.equal(selectNextAccount(registry(accounts, { roundRobinCursor: 'a' }), NOW)?.accountId, 'c');
  assert.equal(selectNextAccount(registry(accounts, { roundRobinCursor: 'c' }), NOW)?.accountId, 'a');
  assert.equal(selectNextAccount(registry(accounts, { roundRobinCursor: 'gone' }), NOW)?.accountId, 'a');
});

test('accounts with unread limits are eligible, as in Studio', () => {
  const data = registry([account('a', [99]), account('fresh', null)], { roundRobinCursor: 'a' });
  assert.deepEqual(selectNextAccount(data, NOW), { accountId: 'fresh', reason: 'round_robin' });
});

test('with nobody eligible the most weighted headroom is the fallback', () => {
  const data = registry([
    account('a', [98]),
    account('b', [97], { planType: 'free' }),
    account('c', [99], { planType: 'pro' }),
    account('off', [0], { enabled: false }),
  ], { minHeadroomPercent: 50 });
  assert.deepEqual(selectNextAccount(data, NOW), { accountId: 'c', reason: 'fallback' });
});

test('summaryText names the pick and labels the fallback', () => {
  const base: AccountsResponse = {
    mode: 'round_robin',
    primaryAccountId: 'a',
    minHeadroomPercent: 50,
    planWeights: {},
    roundRobinCursor: null,
    accounts: [
      { id: 'a', label: 'Main', enabled: true, isPrimary: true, signedIn: true, email: null, planType: 'plus', limits: limits([90]), error: null },
      { id: 'b', label: 'Work', enabled: true, isPrimary: false, signedIn: true, email: null, planType: 'pro', limits: limits([95]), error: null },
    ],
  };
  const text = summaryText(base, selectNextAccount(base, NOW), NOW);
  assert.match(text, /^No account has the 50% headroom a turn needs\. Fallback: <strong>Work<\/strong> \(≈ 30% of a Plus window\)\.$/);
  const easy = { ...base, minHeadroomPercent: 5, roundRobinCursor: 'b' };
  assert.equal(summaryText(easy, selectNextAccount(easy, NOW), NOW), 'Next turn: <strong>Main</strong> (≈ 10% of a Plus window), after Work.');
});

test('hexToHslTriplet produces the theme variable format', () => {
  assert.equal(hexToHslTriplet('#ffffff'), '0 0% 100%');
  assert.equal(hexToHslTriplet('#000000'), '0 0% 0%');
  assert.equal(hexToHslTriplet('#ff0000'), '0 100% 50%');
  assert.equal(hexToHslTriplet('#10a37f'), '165.3 82.1% 35.1%');
});
