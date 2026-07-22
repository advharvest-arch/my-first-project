export type Money = number;

export interface BaselineProfile {
  currentAge: number;
  monthlyNetIncome: Money;
  monthlyExpenses: Money;
  liquidAssets: Money;
  existingDebtBalance: Money;
  existingDebtMonthlyPayment: Money;
}

export type JobOfferEvent = {
  type: 'job_offer';
  /** Month index when offer starts (0 = now) */
  startMonth: number;
  newMonthlyNetIncome: Money;
  relocationCost: Money;
  monthlyExpenseDelta: Money;
};

export type MortgageEvent = {
  type: 'mortgage';
  startMonth: number;
  propertyPrice: Money;
  downPayment: Money;
  annualRatePercent: number;
  termYears: number;
  annualAppreciationPercent: number;
};

export type ScenarioEvent = JobOfferEvent | MortgageEvent;

export interface Scenario {
  id: string;
  name: string;
  events: ScenarioEvent[];
}

export interface ProjectionSettings {
  horizonYears: number;
  annualInvestmentReturnPercent: number;
  annualInflationPercent: number;
}

export interface YearSnapshot {
  year: number;
  age: number;
  liquidAssets: Money;
  homeEquity: Money;
  otherDebt: Money;
  netWorth: Money;
  realNetWorth: Money;
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  years: YearSnapshot[];
  finalNetWorth: Money;
  finalRealNetWorth: Money;
}

export interface CompareVerdict {
  winnerId: string;
  winnerName: string;
  deltaVsBaseline: Money;
  message: string;
}

const MONTHS_IN_YEAR = 12;

export function annuityPayment(
  principal: Money,
  annualRatePercent: number,
  termYears: number,
): Money {
  if (principal <= 0) return 0;
  const n = termYears * MONTHS_IN_YEAR;
  const r = annualRatePercent / 100 / MONTHS_IN_YEAR;
  if (r === 0) return principal / n;
  return (principal * r * (1 + r) ** n) / ((1 + r) ** n - 1);
}

function formatRub(value: Money): string {
  const abs = Math.abs(Math.round(value));
  const formatted = new Intl.NumberFormat('ru-RU').format(abs);
  return value < 0 ? `−${formatted} ₽` : `${formatted} ₽`;
}

export function projectScenario(
  profile: BaselineProfile,
  scenario: Scenario,
  settings: ProjectionSettings,
): ScenarioResult {
  const totalMonths = Math.max(1, settings.horizonYears) * MONTHS_IN_YEAR;
  const rMonth = settings.annualInvestmentReturnPercent / 100 / MONTHS_IN_YEAR;
  const gInflationMonth = settings.annualInflationPercent / 100 / MONTHS_IN_YEAR;

  let income = profile.monthlyNetIncome;
  let expenses = profile.monthlyExpenses;
  let liquid = profile.liquidAssets;
  let otherDebt = Math.max(0, profile.existingDebtBalance);
  const otherDebtPayment = Math.max(0, profile.existingDebtMonthlyPayment);

  let mortgagePrincipal = 0;
  let mortgagePayment = 0;
  let mortgageRateMonth = 0;
  let homeValue = 0;
  let homeAppreciationMonth = 0;
  let mortgageActive = false;

  const years: YearSnapshot[] = [];

  // Year 0 snapshot (before simulation)
  years.push({
    year: 0,
    age: profile.currentAge,
    liquidAssets: liquid,
    homeEquity: 0,
    otherDebt,
    netWorth: liquid - otherDebt,
    realNetWorth: liquid - otherDebt,
  });

  for (let month = 0; month < totalMonths; month += 1) {
    for (const event of scenario.events) {
      if (event.startMonth !== month) continue;

      if (event.type === 'job_offer') {
        income = event.newMonthlyNetIncome;
        expenses = profile.monthlyExpenses + event.monthlyExpenseDelta;
        liquid -= event.relocationCost;
      }

      if (event.type === 'mortgage') {
        const loan = Math.max(0, event.propertyPrice - event.downPayment);
        liquid -= event.downPayment;
        mortgagePrincipal = loan;
        mortgagePayment = annuityPayment(
          loan,
          event.annualRatePercent,
          event.termYears,
        );
        mortgageRateMonth = event.annualRatePercent / 100 / MONTHS_IN_YEAR;
        homeValue = event.propertyPrice;
        homeAppreciationMonth =
          event.annualAppreciationPercent / 100 / MONTHS_IN_YEAR;
        mortgageActive = loan > 0 || event.downPayment > 0;
      }
    }

    let debtPay = 0;
    if (otherDebt > 0 && otherDebtPayment > 0) {
      debtPay = Math.min(otherDebt, otherDebtPayment);
      otherDebt -= debtPay;
    }

    let mPay = 0;
    if (mortgageActive && mortgagePrincipal > 0) {
      const interest = mortgagePrincipal * mortgageRateMonth;
      const principalPart = Math.min(
        mortgagePrincipal,
        Math.max(0, mortgagePayment - interest),
      );
      mPay = interest + principalPart;
      mortgagePrincipal -= principalPart;
      if (mortgagePrincipal < 0.01) mortgagePrincipal = 0;
    }

    if (mortgageActive && homeValue > 0) {
      homeValue *= 1 + homeAppreciationMonth;
    }

    const surplus = income - expenses - mPay - debtPay;
    liquid = (liquid + surplus) * (1 + rMonth);

    const homeEquity = mortgageActive
      ? Math.max(0, homeValue - mortgagePrincipal)
      : 0;
    const netWorth = liquid + homeEquity - otherDebt;
    const inflationFactor = (1 + gInflationMonth) ** (month + 1);
    const realNetWorth = netWorth / inflationFactor;

    if ((month + 1) % MONTHS_IN_YEAR === 0) {
      const year = (month + 1) / MONTHS_IN_YEAR;
      years.push({
        year,
        age: profile.currentAge + year,
        liquidAssets: liquid,
        homeEquity,
        otherDebt,
        netWorth,
        realNetWorth,
      });
    }
  }

  const last = years[years.length - 1];
  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    years,
    finalNetWorth: last.netWorth,
    finalRealNetWorth: last.realNetWorth,
  };
}

export function compareScenarios(
  results: ScenarioResult[],
  baselineId: string,
): CompareVerdict {
  if (results.length === 0) {
    return {
      winnerId: '',
      winnerName: '',
      deltaVsBaseline: 0,
      message: 'Нет сценариев для сравнения.',
    };
  }

  const baseline = results.find((r) => r.scenarioId === baselineId) ?? results[0];
  const winner = results.reduce((best, cur) =>
    cur.finalNetWorth > best.finalNetWorth ? cur : best,
  );
  const delta = winner.finalNetWorth - baseline.finalNetWorth;
  const horizon = winner.years[winner.years.length - 1]?.year ?? 0;

  let message: string;
  if (winner.scenarioId === baseline.scenarioId) {
    message = `Базовый сценарий лучший: через ${horizon} лет капитал ≈ ${formatRub(winner.finalNetWorth)}.`;
  } else if (delta >= 0) {
    message = `В сценарии «${winner.scenarioName}» через ${horizon} лет капитал больше базового на ${formatRub(delta)}.`;
  } else {
    message = `В сценарии «${winner.scenarioName}» через ${horizon} лет капитал меньше базового на ${formatRub(Math.abs(delta))}.`;
  }

  return {
    winnerId: winner.scenarioId,
    winnerName: winner.scenarioName,
    deltaVsBaseline: delta,
    message,
  };
}

export const DEFAULT_PROFILE: BaselineProfile = {
  currentAge: 32,
  monthlyNetIncome: 180_000,
  monthlyExpenses: 110_000,
  liquidAssets: 3_500_000,
  existingDebtBalance: 0,
  existingDebtMonthlyPayment: 0,
};

export const DEFAULT_SETTINGS: ProjectionSettings = {
  horizonYears: 5,
  annualInvestmentReturnPercent: 8,
  annualInflationPercent: 6,
};

export function buildDefaultScenarios(): Scenario[] {
  return [
    {
      id: 'baseline',
      name: 'Ничего не менять',
      events: [],
    },
    {
      id: 'offer',
      name: 'Принять оффер',
      events: [
        {
          type: 'job_offer',
          startMonth: 0,
          newMonthlyNetIncome: 250_000,
          relocationCost: 150_000,
          monthlyExpenseDelta: 20_000,
        },
      ],
    },
    {
      id: 'mortgage',
      name: 'Взять ипотеку',
      events: [
        {
          type: 'mortgage',
          startMonth: 0,
          propertyPrice: 12_000_000,
          downPayment: 2_400_000,
          annualRatePercent: 18,
          termYears: 20,
          annualAppreciationPercent: 5,
        },
      ],
    },
  ];
}
