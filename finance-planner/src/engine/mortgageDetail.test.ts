import { describe, expect, it } from 'vitest';
import {
  compareMortgageStrategies,
  DEFAULT_EARLY_PLAN,
  simulateMortgageDetail,
} from './mortgageDetail';
import { DEFAULT_PROFILE, DEFAULT_SETTINGS } from './types';

const baseParams = {
  propertyPrice: 10_000_000,
  downPayment: 2_000_000,
  annualRatePercent: 18,
  termYears: 20,
  annualAppreciationPercent: 4,
  rentMonths: 0,
  monthlyRent: 0,
  moveInCost: 0,
  monthlyRentIncome: 70_000,
  early: { ...DEFAULT_EARLY_PLAN },
};

describe('simulateMortgageDetail', () => {
  it('pays less interest with monthly early payments that shorten the term', () => {
    const plain = simulateMortgageDetail(
      DEFAULT_PROFILE,
      DEFAULT_SETTINGS,
      baseParams,
      'plain',
    );
    const early = simulateMortgageDetail(
      DEFAULT_PROFILE,
      DEFAULT_SETTINGS,
      {
        ...baseParams,
        early: {
          ...DEFAULT_EARLY_PLAN,
          monthlyExtra: 30_000,
          mode: 'reduce_term',
        },
      },
      'early',
    );

    expect(early.totalInterestPaid).toBeLessThan(plain.totalInterestPaid);
    expect(early.payoffMonth).not.toBeNull();
    if (plain.payoffMonth != null && early.payoffMonth != null) {
      expect(early.payoffMonth).toBeLessThan(plain.payoffMonth);
    }
  });

  it('reduce_payment keeps a longer schedule than reduce_term for the same extras', () => {
    const term = simulateMortgageDetail(
      DEFAULT_PROFILE,
      { ...DEFAULT_SETTINGS, horizonYears: 25 },
      {
        ...baseParams,
        early: {
          ...DEFAULT_EARLY_PLAN,
          monthlyExtra: 25_000,
          mode: 'reduce_term',
        },
      },
    );
    const payment = simulateMortgageDetail(
      DEFAULT_PROFILE,
      { ...DEFAULT_SETTINGS, horizonYears: 25 },
      {
        ...baseParams,
        early: {
          ...DEFAULT_EARLY_PLAN,
          monthlyExtra: 25_000,
          mode: 'reduce_payment',
        },
      },
    );

    expect(term.payoffMonth).not.toBeNull();
    expect(payment.payoffMonth).not.toBeNull();
    expect(term.payoffMonth!).toBeLessThan(payment.payoffMonth!);
    expect(term.totalInterestPaid).toBeLessThan(payment.totalInterestPaid);
  });

  it('lump-sum early payment reduces interest vs baseline', () => {
    const plain = simulateMortgageDetail(
      DEFAULT_PROFILE,
      DEFAULT_SETTINGS,
      baseParams,
    );
    const lump = simulateMortgageDetail(DEFAULT_PROFILE, DEFAULT_SETTINGS, {
      ...baseParams,
      early: {
        ...DEFAULT_EARLY_PLAN,
        lumpSumAmount: 500_000,
        lumpSumMonth: 6,
        mode: 'reduce_term',
      },
    });

    expect(lump.totalInterestPaid).toBeLessThan(plain.totalInterestPaid);
  });
});

describe('compareMortgageStrategies', () => {
  it('returns baseline, early plan, and alternate terms', () => {
    const rows = compareMortgageStrategies(DEFAULT_PROFILE, DEFAULT_SETTINGS, {
      ...baseParams,
      early: {
        ...DEFAULT_EARLY_PLAN,
        monthlyExtra: 20_000,
        mode: 'reduce_term',
      },
    });

    expect(rows.some((r) => r.label === 'Без досрочки')).toBe(true);
    expect(rows.some((r) => r.label === 'С досрочкой')).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});
