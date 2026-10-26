import { describe, expect, it } from 'vitest';
import { isBudgetError } from '../worker/lib/cache';
import { PRUNE_EVERY_MINUTES, shouldPruneNow } from '../worker/lib/scheduler';

/**
 * Regression tests for the D1 read-budget incident.
 *
 * Production context: 10.2M of 10.2M daily row reads were attributed to the
 * retention pruner, which ran on every cron tick and full-scanned `checks`.
 * These tests pin the two behavioural fixes so it cannot silently come back.
 */

describe('pruning cadence', () => {
  it('runs only on the configured minute boundary', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 26, 12, minute, 0)).getTime();
    expect(shouldPruneNow(at(0))).toBe(true);
    expect(shouldPruneNow(at(15))).toBe(true);
    expect(shouldPruneNow(at(30))).toBe(true);
    expect(shouldPruneNow(at(45))).toBe(true);
    for (const minute of [1, 7, 14, 16, 29, 44, 46, 59]) {
      expect(shouldPruneNow(at(minute)), `minute ${minute}`).toBe(false);
    }
  });

  it('runs 4 times per hour, not 60', () => {
    let ticks = 0;
    for (let minute = 0; minute < 60; minute += 1) {
      if (shouldPruneNow(new Date(Date.UTC(2026, 9, 26, 12, minute, 0)).getTime())) ticks += 1;
    }
    expect(ticks).toBe(60 / PRUNE_EVERY_MINUTES);
    expect(ticks).toBeLessThanOrEqual(4);
  });
});

describe('isBudgetError', () => {
  it('recognises the D1 free-tier message', () => {
    expect(
      isBudgetError(
        new Error(
          "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow"
        )
      )
    ).toBe(true);
  });

  it('recognises the error code form', () => {
    expect(isBudgetError(new Error('D1_ERROR: code 7500'))).toBe(true);
  });

  it('recognises throttling wording', () => {
    expect(isBudgetError(new Error('Too many requests, slow down'))).toBe(true);
    expect(isBudgetError(new Error('rate limit exceeded'))).toBe(true);
  });

  it('does not swallow ordinary bugs', () => {
    expect(isBudgetError(new Error('no such table: checks'))).toBe(false);
    expect(isBudgetError(new Error('syntax error near "SELEC"'))).toBe(false);
    expect(isBudgetError(new Error('TypeError: x is not a function'))).toBe(false);
    expect(isBudgetError('random string')).toBe(false);
  });

  it('handles non-Error values without throwing', () => {
    expect(isBudgetError(null)).toBe(false);
    expect(isBudgetError(undefined)).toBe(false);
    expect(isBudgetError({ message: 'daily row read limit' })).toBe(false);
  });
});
