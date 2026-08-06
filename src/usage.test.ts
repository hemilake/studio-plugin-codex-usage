import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeActivity, normalizeRateLimits } from './usage.js';

test('normalizeRateLimits supports multiple buckets and both windows', () => {
  const result = normalizeRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        planType: 'plus',
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 71.5, windowDurationMins: 10_080, resetsAt: 1_800_100_000 },
        credits: { hasCredits: true, unlimited: false, balance: '12.50' },
      },
      other: {
        limitId: 'codex_other',
        limitName: 'Review',
        primary: { usedPercent: 105, windowDurationMins: 60, resetsAt: 1_800_200_000 },
      },
    },
    rateLimitResetCredits: { availableCount: 2 },
  });

  assert.equal(result.limits.length, 2);
  assert.equal(result.limits[0]?.windows.length, 2);
  assert.equal(result.limits[0]?.planType, 'plus');
  assert.equal(result.limits[0]?.credits?.balance, '12.50');
  assert.equal(result.limits[1]?.windows[0]?.usedPercent, 100);
  assert.equal(result.resetCreditsAvailable, 2);
});

test('normalizeRateLimits falls back to the legacy single bucket', () => {
  const result = normalizeRateLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
    },
  });
  assert.equal(result.limits[0]?.id, 'codex');
  assert.equal(result.limits[0]?.windows[0]?.windowDurationMins, 10_080);
});

test('normalizeActivity returns a bounded zero-filled UTC window', () => {
  const now = Date.parse('2026-08-06T15:00:00Z');
  const result = normalizeActivity({
    summary: {
      lifetimeTokens: 1_000_000,
      peakDailyTokens: 400,
      longestRunningTurnSec: 60,
      currentStreakDays: 2,
      longestStreakDays: 8,
    },
    dailyUsageBuckets: [
      { startDate: '2026-08-04', tokens: 100 },
      { startDate: '2026-08-06', tokens: 300 },
      { startDate: 'not-a-date', tokens: 999 },
    ],
  }, 3, now);

  assert.deepEqual(result.daily, [
    { date: '2026-08-04', tokens: 100 },
    { date: '2026-08-05', tokens: 0 },
    { date: '2026-08-06', tokens: 300 },
  ]);
  assert.equal(result.totalTokens, 400);
  assert.equal(result.summary.lifetimeTokens, 1_000_000);
});
