import { describe, expect, it } from 'vitest';
import {
  amortizeLoan,
  compareMortgageVariants,
  DEFAULT_EARLY_PLAN,
  simulateMortgageDetail,
  suggestedExtraToMatchPayment,
} from './mortgageDetail';
import {
  annuityPayment,
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
} from './types';

const shared = {
  propertyPrice: 10_000_000,
  downPayment: 2_000_000,
  annualRatePercent: 18,
  annualAppreciationPercent: 4,
  rentMonths: 0,
  monthlyRent: 0,
  moveInCost: 0,
  monthlyRentIncome: 70_000,
};

const baseParams = {
  ...shared,
  termYears: 20,
  early: { ...DEFAULT_EARLY_PLAN },
};

describe('amortizeLoan', () => {
  it('pays off a plain annuity near the contractual term', () => {
    const plain = amortizeLoan({
      principal: 8_000_000,
      annualRatePercent: 18,
      termYears: 15,
      early: { ...DEFAULT_EARLY_PLAN },
    });
    expect(plain.payoffMonth).not.toBeNull();
    expect(plain.payoffMonth!).toBeGreaterThanOrEqual(14 * 12);
    expect(plain.payoffMonth!).toBeLessThan(15 * 12);
    expect(plain.scheduledPayment).toBeCloseTo(
      annuityPayment(8_000_000, 18, 15),
      0,
    );
  });

  it('reduce_term early payments cut interest and shorten payoff vs reduce_payment', () => {
    const term = amortizeLoan({
      principal: 8_000_000,
      annualRatePercent: 18,
      termYears: 30,
      early: {
        ...DEFAULT_EARLY_PLAN,
        monthlyExtra: 40_000,
        mode: 'reduce_term',
      },
    });
    const payment = amortizeLoan({
      principal: 8_000_000,
      annualRatePercent: 18,
      termYears: 30,
      early: {
        ...DEFAULT_EARLY_PLAN,
        monthlyExtra: 40_000,
        mode: 'reduce_payment',
      },
    });

    expect(term.payoffMonth!).toBeLessThan(payment.payoffMonth!);
    expect(term.totalInterestPaid).toBeLessThan(payment.totalInterestPaid);
  });
});

describe('compareMortgageVariants', () => {
  it('compares 30y+extra vs 15y schedule like a mortgage calculator', () => {
    const loan = 8_000_000;
    const extra = suggestedExtraToMatchPayment(loan, 18, 30, 15);
    expect(extra).toBeGreaterThan(0);

    const [longExtra, shortPlain] = compareMortgageVariants(
      DEFAULT_PROFILE,
      { ...DEFAULT_SETTINGS, horizonYears: 30 },
      shared,
      [
        {
          id: 'long-extra',
          label: '30 + досрочка',
          note: 'test',
          termYears: 30,
          early: {
            ...DEFAULT_EARLY_PLAN,
            monthlyExtra: extra,
            mode: 'reduce_term',
          },
        },
        {
          id: 'short-plain',
          label: '15 по графику',
          note: 'test',
          termYears: 15,
          early: { ...DEFAULT_EARLY_PLAN },
        },
      ],
    );

    expect(longExtra.firstMonthCash).toBeCloseTo(shortPlain.firstMonthCash, -2);
    expect(longExtra.totalInterestPaid).toBeLessThan(
      simulateMortgageDetail(DEFAULT_PROFILE, DEFAULT_SETTINGS, {
        ...baseParams,
        termYears: 30,
        early: { ...DEFAULT_EARLY_PLAN },
      }).totalInterestPaid,
    );
    expect(shortPlain.payoffMonth).not.toBeNull();
    expect(longExtra.payoffMonth).not.toBeNull();
  });
});

describe('simulateMortgageDetail', () => {
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
