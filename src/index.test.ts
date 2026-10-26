import assert from 'node:assert/strict';
import test from 'node:test';

import { hexToHslTriplet, maxUsedPercent, pickMostHeadroom } from './index.js';
import type { RateLimitsData } from './usage.js';

function limits(percents: number[], reachedType: string | null = null): RateLimitsData {
  return {
    resetCreditsAvailable: 0,
    limits: [{
      id: 'codex',
      name: null,
      planType: 'plus',
      reachedType,
      credits: null,
      windows: percents.map((usedPercent, index) => ({
        kind: index === 0 ? 'primary' : 'secondary',
        usedPercent,
        windowDurationMins: 300,
        resetsAt: null,
      })),
    }],
  };
}

test('maxUsedPercent takes the fullest window', () => {
  assert.equal(maxUsedPercent(limits([10, 62])), 62);
  assert.equal(maxUsedPercent(null), null);
});

test('pickMostHeadroom picks the enabled account with the lowest max usage', () => {
  const picked = pickMostHeadroom([
    { id: 'a', enabled: true, signedIn: true, limits: limits([40, 50]) },
    { id: 'b', enabled: true, signedIn: true, limits: limits([5, 30]) },
    { id: 'c', enabled: false, signedIn: true, limits: limits([0, 0]) },
    { id: 'd', enabled: true, signedIn: true, limits: limits([1, 1], 'rate_limit_reached') },
    { id: 'e', enabled: true, signedIn: false, limits: null },
  ]);
  assert.equal(picked, 'b');
});

test('pickMostHeadroom breaks ties by priority order and returns null when nothing fits', () => {
  assert.equal(pickMostHeadroom([
    { id: 'first', enabled: true, signedIn: true, limits: limits([20]) },
    { id: 'second', enabled: true, signedIn: true, limits: limits([20]) },
  ]), 'first');
  assert.equal(pickMostHeadroom([{ id: 'x', enabled: true, signedIn: true, limits: limits([99], 'workspace') }]), null);
});

test('hexToHslTriplet produces the theme variable format', () => {
  assert.equal(hexToHslTriplet('#ffffff'), '0 0% 100%');
  assert.equal(hexToHslTriplet('#000000'), '0 0% 0%');
  assert.equal(hexToHslTriplet('#ff0000'), '0 100% 50%');
  assert.equal(hexToHslTriplet('#10a37f'), '165.3 82.1% 35.1%');
});
