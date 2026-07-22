import { describe, expect, it } from 'vitest';
import {
  annuityPayment,
  buildScenariosForMode,
  compareScenarios,
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  projectScenario,
  type BaselineProfile,
  type Scenario,
} from './types';

describe('annuityPayment', () => {
  it('computes a positive payment for a typical RF mortgage', () => {
    const payment = annuityPayment(9_600_000, 18, 20);
    expect(payment).toBeGreaterThan(140_000);
    expect(payment).toBeLessThan(160_000);
  });
});

describe('no_home scenarios', () => {
  it('stops rent after off-plan handover and keeps mortgage equity', () => {
    const scenario = buildScenariosForMode('no_home').find((s) => s.id === 'offplan')!;
    const event = scenario.events[0];
    if (event.type !== 'offplan_mortgage') throw new Error('expected offplan');
    event.monthsUntilHandover = 12;
    event.monthlyRentUntilMoveIn = 50_000;

    const profile: BaselineProfile = {
      ...DEFAULT_PROFILE,
      monthlyNetIncome: 250_000,
      monthlyExpenses: 60_000,
      liquidAssets: 3_000_000,
    };

    const result = projectScenario(profile, scenario, {
      ...DEFAULT_SETTINGS,
      horizonYears: 2,
      bankDepositAnnualRatePercent: 0,
      annualInflationPercent: 0,
    });

    expect(result.meta?.movedInAtMonth).toBe(12);
    expect(result.years[2].homeEquity).toBeGreaterThan(2_000_000);
  });

  it('uses profile deposit rate while renting', () => {
    const scenario = buildScenariosForMode('no_home').find((s) => s.id === 'rent_save')!;
    const low = projectScenario(DEFAULT_PROFILE, scenario, {
      ...DEFAULT_SETTINGS,
      horizonYears: 1,
      bankDepositAnnualRatePercent: 0,
      annualInflationPercent: 0,
    });
    const high = projectScenario(DEFAULT_PROFILE, scenario, {
      ...DEFAULT_SETTINGS,
      horizonYears: 1,
      bankDepositAnnualRatePercent: 20,
      annualInflationPercent: 0,
    });
    expect(high.finalNetWorth).toBeGreaterThan(low.finalNetWorth);
  });
});

describe('has_home scenarios', () => {
  it('adds rental income on buy-to-let mortgage', () => {
    const scenario = buildScenariosForMode('has_home').find((s) => s.id === 'buy_to_let')!;
    const profile: BaselineProfile = {
      ...DEFAULT_PROFILE,
      monthlyNetIncome: 200_000,
      monthlyExpenses: 80_000,
      liquidAssets: 3_000_000,
    };
    const withRent = projectScenario(profile, scenario, {
      ...DEFAULT_SETTINGS,
      horizonYears: 1,
      bankDepositAnnualRatePercent: 0,
      annualInflationPercent: 0,
    });

    const noRentScenario: Scenario = {
      ...scenario,
      events: scenario.events.map((e) =>
        e.type === 'buy_to_let_mortgage' ? { ...e, monthlyRentIncome: 0 } : e,
      ),
    };
    const withoutRent = projectScenario(profile, noRentScenario, {
      ...DEFAULT_SETTINGS,
      horizonYears: 1,
      bankDepositAnnualRatePercent: 0,
      annualInflationPercent: 0,
    });

    expect(withRent.finalNetWorth).toBeGreaterThan(withoutRent.finalNetWorth);
  });

  it('buys for cash when deposit reaches target price', () => {
    const scenario: Scenario = {
      id: 'save_then_buy',
      name: 'Копить',
      mode: 'has_home',
      events: [
        {
          type: 'save_then_buy',
          startMonth: 0,
          targetPropertyPrice: 1_200_000,
          annualPriceGrowthPercent: 0,
        },
      ],
    };
    const profile: BaselineProfile = {
      ...DEFAULT_PROFILE,
      monthlyNetIncome: 200_000,
      monthlyExpenses: 50_000,
      liquidAssets: 500_000,
    };
    const result = projectScenario(profile, scenario, {
      ...DEFAULT_SETTINGS,
      horizonYears: 2,
      bankDepositAnnualRatePercent: 0,
      annualInflationPercent: 0,
    });

    expect(result.meta?.boughtAtMonth).toBeDefined();
    expect(result.years[2].homeEquity).toBeGreaterThan(0);
  });

  it('reacts to target price growth while saving', () => {
    const base = buildScenariosForMode('has_home').find((s) => s.id === 'save_then_buy')!;
    const flat: Scenario = {
      ...base,
      events: [
        {
          type: 'save_then_buy',
          startMonth: 0,
          targetPropertyPrice: 8_000_000,
          annualPriceGrowthPercent: 0,
        },
      ],
    };
    const rising: Scenario = {
      ...base,
      events: [
        {
          type: 'save_then_buy',
          startMonth: 0,
          targetPropertyPrice: 8_000_000,
          annualPriceGrowthPercent: 20,
        },
      ],
    };
    const profile: BaselineProfile = {
      ...DEFAULT_PROFILE,
      monthlyNetIncome: 300_000,
      monthlyExpenses: 50_000,
      liquidAssets: 2_000_000,
    };
    const a = projectScenario(profile, flat, {
      ...DEFAULT_SETTINGS,
      horizonYears: 5,
      bankDepositAnnualRatePercent: 10,
      annualInflationPercent: 0,
    });
    const b = projectScenario(profile, rising, {
      ...DEFAULT_SETTINGS,
      horizonYears: 5,
      bankDepositAnnualRatePercent: 10,
      annualInflationPercent: 0,
    });
    expect(a.meta?.boughtAtMonth ?? 999).toBeLessThan(b.meta?.boughtAtMonth ?? 999);
  });
});

describe('compareScenarios', () => {
  it('picks the richer path', () => {
    const scenarios = [
      ...buildScenariosForMode('no_home'),
      ...buildScenariosForMode('has_home'),
    ];
    const results = scenarios.map((s) =>
      projectScenario(DEFAULT_PROFILE, s, DEFAULT_SETTINGS),
    );
    const verdict = compareScenarios(results);
    expect(verdict.winnerId).toBeTruthy();
    expect(verdict.message).toContain('Лучше');
  });
});
