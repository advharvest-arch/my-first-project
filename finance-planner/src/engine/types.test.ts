import { describe, expect, it } from 'vitest';
import {
  annuityPayment,
  buildDefaultScenarios,
  compareScenarios,
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  projectScenario,
  type BaselineProfile,
  type Scenario,
} from './types';

describe('annuityPayment', () => {
  it('returns 0 for zero principal', () => {
    expect(annuityPayment(0, 18, 20)).toBe(0);
  });

  it('matches zero-rate amortization', () => {
    expect(annuityPayment(1_200_000, 0, 10)).toBeCloseTo(10_000, 5);
  });

  it('computes a positive payment for a typical RF mortgage', () => {
    const payment = annuityPayment(9_600_000, 18, 20);
    expect(payment).toBeGreaterThan(140_000);
    expect(payment).toBeLessThan(160_000);
  });
});

describe('projectScenario', () => {
  it('grows liquid assets when surplus is positive (baseline)', () => {
    const [baseline] = buildDefaultScenarios();
    const result = projectScenario(DEFAULT_PROFILE, baseline, DEFAULT_SETTINGS);
    expect(result.years).toHaveLength(6); // 0..5
    expect(result.finalNetWorth).toBeGreaterThan(DEFAULT_PROFILE.liquidAssets);
  });

  it('applies rent and grows savings at bank deposit rate', () => {
    const profile: BaselineProfile = {
      ...DEFAULT_PROFILE,
      monthlyNetIncome: 200_000,
      monthlyExpenses: 50_000,
      liquidAssets: 1_000_000,
    };
    const scenario: Scenario = {
      id: 'rent_save',
      name: 'Снимать и копить',
      events: [
        {
          type: 'rent_and_save',
          startMonth: 0,
          monthlyRent: 40_000,
          bankDepositAnnualRatePercent: 12,
          moveInCost: 80_000,
        },
      ],
    };

    const result = projectScenario(profile, scenario, {
      ...DEFAULT_SETTINGS,
      horizonYears: 1,
      annualInvestmentReturnPercent: 0,
      annualInflationPercent: 0,
    });

    // After move-in: 1_000_000 - 80_000 = 920_000
    // Monthly surplus: 200_000 - 50_000 - 40_000 = 110_000
    // Grow at 12%/yr monthly for 12 months
    expect(result.years[1].homeEquity).toBe(0);
    expect(result.finalNetWorth).toBeGreaterThan(920_000 + 110_000 * 12);
    expect(result.finalNetWorth).toBeLessThan(2_500_000);
  });

  it('reduces liquid by down payment and builds home equity', () => {
    const profile: BaselineProfile = {
      ...DEFAULT_PROFILE,
      liquidAssets: 3_000_000,
      monthlyNetIncome: 300_000,
      monthlyExpenses: 100_000,
    };
    const scenario: Scenario = {
      id: 'm',
      name: 'Ипотека',
      events: [
        {
          type: 'mortgage',
          startMonth: 0,
          propertyPrice: 10_000_000,
          downPayment: 2_000_000,
          annualRatePercent: 12,
          termYears: 15,
          annualAppreciationPercent: 0,
        },
      ],
    };

    const result = projectScenario(profile, scenario, {
      ...DEFAULT_SETTINGS,
      horizonYears: 1,
      annualInvestmentReturnPercent: 0,
      annualInflationPercent: 0,
    });

    const y1 = result.years[1];
    expect(y1.homeEquity).toBeGreaterThan(2_000_000);
    expect(y1.liquidAssets).toBeLessThan(profile.liquidAssets);
  });
});

describe('compareScenarios', () => {
  it('picks the higher net-worth scenario and formats a verdict', () => {
    const scenarios = buildDefaultScenarios();
    const results = scenarios.map((s) =>
      projectScenario(DEFAULT_PROFILE, s, DEFAULT_SETTINGS),
    );
    const verdict = compareScenarios(results, 'baseline');
    expect(verdict.winnerId).toBeTruthy();
    expect(verdict.message.length).toBeGreaterThan(10);
  });
});
