export type Money = number;

export type HousingMode = 'no_home' | 'has_home';

export interface BaselineProfile {
  monthlyNetIncome: Money;
  /** Everyday spending without rent / mortgage / investment property. */
  monthlyExpenses: Money;
  liquidAssets: Money;
  existingDebtBalance: Money;
  existingDebtMonthlyPayment: Money;
}

/** New-build mortgage: rent until handover, then move in. */
export type OffplanMortgageEvent = {
  type: 'offplan_mortgage';
  startMonth: number;
  propertyPrice: Money;
  downPayment: Money;
  annualRatePercent: number;
  termYears: number;
  annualAppreciationPercent: number;
  /** Months until the building is delivered. */
  monthsUntilHandover: number;
  /** Rent paid while waiting for handover. */
  monthlyRentUntilMoveIn: Money;
  moveInCost: Money;
};

/** Rent forever (horizon) and grow cash on the profile deposit rate. */
export type RentAndSaveEvent = {
  type: 'rent_and_save';
  startMonth: number;
  monthlyRent: Money;
  moveInCost: Money;
};

/** Buy secondary (ready) with mortgage and rent it out immediately. */
export type BuyToLetMortgageEvent = {
  type: 'buy_to_let_mortgage';
  startMonth: number;
  propertyPrice: Money;
  downPayment: Money;
  annualRatePercent: number;
  termYears: number;
  annualAppreciationPercent: number;
  /** Net monthly rent received from tenants. */
  monthlyRentIncome: Money;
};

/** Save on deposit (profile rate), then buy for cash when enough is accumulated. */
export type SaveThenBuyEvent = {
  type: 'save_then_buy';
  startMonth: number;
  targetPropertyPrice: Money;
  annualPriceGrowthPercent: number;
};

export type ScenarioEvent =
  | OffplanMortgageEvent
  | RentAndSaveEvent
  | BuyToLetMortgageEvent
  | SaveThenBuyEvent;

export interface Scenario {
  id: string;
  name: string;
  mode: HousingMode;
  events: ScenarioEvent[];
}

export interface ProjectionSettings {
  horizonYears: number;
  /** Bank deposit / savings rate for liquid cash in every scenario. */
  bankDepositAnnualRatePercent: number;
  annualInflationPercent: number;
}

export interface YearSnapshot {
  year: number;
  liquidAssets: Money;
  homeEquity: Money;
  otherDebt: Money;
  netWorth: Money;
  realNetWorth: Money;
  note?: string;
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  years: YearSnapshot[];
  finalNetWorth: Money;
  finalRealNetWorth: Money;
  meta?: {
    boughtAtMonth?: number;
    movedInAtMonth?: number;
  };
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
  const n = Math.max(1, Math.round(termYears)) * MONTHS_IN_YEAR;
  const r = annualRatePercent / 100 / MONTHS_IN_YEAR;
  if (Math.abs(r) < 1e-12) return principal / n;
  return (principal * r * (1 + r) ** n) / ((1 + r) ** n - 1);
}

function formatRub(value: Money): string {
  const abs = Math.abs(Math.round(value));
  const formatted = new Intl.NumberFormat('ru-RU').format(abs);
  return value < 0 ? `−${formatted} ₽` : `${formatted} ₽`;
}

function monthRate(annualPercent: number): number {
  return annualPercent / 100 / MONTHS_IN_YEAR;
}

export function projectScenario(
  profile: BaselineProfile,
  scenario: Scenario,
  settings: ProjectionSettings,
): ScenarioResult {
  const totalMonths = Math.max(1, Math.round(settings.horizonYears)) * MONTHS_IN_YEAR;
  const depositRate = monthRate(settings.bankDepositAnnualRatePercent);
  const inflationMonth = monthRate(settings.annualInflationPercent);

  const income = profile.monthlyNetIncome;
  let livingExpenses = profile.monthlyExpenses;
  let liquid = profile.liquidAssets;
  let otherDebt = Math.max(0, profile.existingDebtBalance);
  const otherDebtPayment = Math.max(0, profile.existingDebtMonthlyPayment);

  let rentExpense = 0;
  let rentIncome = 0;

  let mortgagePrincipal = 0;
  let mortgagePayment = 0;
  let mortgageRate = 0;
  let homeValue = 0;
  let homeAppreciation = 0;
  let mortgageActive = false;

  let handoverMonth: number | null = null;
  let movedInAtMonth: number | undefined;
  let boughtAtMonth: number | undefined;

  let saveThenBuyActive = false;
  let targetPrice = 0;
  let targetPriceGrowth = 0;
  let ownedCashHome = false;

  const years: YearSnapshot[] = [];
  years.push({
    year: 0,
    liquidAssets: liquid,
    homeEquity: 0,
    otherDebt,
    netWorth: liquid - otherDebt,
    realNetWorth: liquid - otherDebt,
  });

  for (let month = 0; month < totalMonths; month += 1) {
    for (const event of scenario.events) {
      if (event.startMonth !== month) continue;

      if (event.type === 'offplan_mortgage') {
        const down = Math.max(0, event.downPayment);
        const price = Math.max(0, event.propertyPrice);
        const loan = Math.max(0, price - down);
        liquid -= down + Math.max(0, event.moveInCost);
        mortgagePrincipal = loan;
        mortgagePayment = annuityPayment(
          loan,
          event.annualRatePercent,
          event.termYears,
        );
        mortgageRate = monthRate(event.annualRatePercent);
        homeValue = price;
        homeAppreciation = monthRate(event.annualAppreciationPercent);
        mortgageActive = true;
        rentExpense = Math.max(0, event.monthlyRentUntilMoveIn);
        handoverMonth = month + Math.max(0, Math.round(event.monthsUntilHandover));
      }

      if (event.type === 'rent_and_save') {
        rentExpense = Math.max(0, event.monthlyRent);
        liquid -= Math.max(0, event.moveInCost);
      }

      if (event.type === 'buy_to_let_mortgage') {
        const down = Math.max(0, event.downPayment);
        const price = Math.max(0, event.propertyPrice);
        const loan = Math.max(0, price - down);
        liquid -= down;
        mortgagePrincipal = loan;
        mortgagePayment = annuityPayment(
          loan,
          event.annualRatePercent,
          event.termYears,
        );
        mortgageRate = monthRate(event.annualRatePercent);
        homeValue = price;
        homeAppreciation = monthRate(event.annualAppreciationPercent);
        mortgageActive = true;
        rentIncome = Math.max(0, event.monthlyRentIncome);
        rentExpense = 0;
      }

      if (event.type === 'save_then_buy') {
        saveThenBuyActive = true;
        targetPrice = Math.max(0, event.targetPropertyPrice);
        targetPriceGrowth = monthRate(event.annualPriceGrowthPercent);
        rentExpense = 0;
        rentIncome = 0;
      }
    }

    if (handoverMonth !== null && month === handoverMonth) {
      rentExpense = 0;
      movedInAtMonth = month;
    }

    let debtPay = 0;
    if (otherDebt > 0 && otherDebtPayment > 0) {
      debtPay = Math.min(otherDebt, otherDebtPayment);
      otherDebt -= debtPay;
    }

    let mPay = 0;
    if (mortgageActive && mortgagePrincipal > 0) {
      const interest = mortgagePrincipal * mortgageRate;
      const principalPart = Math.min(
        mortgagePrincipal,
        Math.max(0, mortgagePayment - interest),
      );
      mPay = interest + principalPart;
      mortgagePrincipal -= principalPart;
      if (mortgagePrincipal < 0.01) mortgagePrincipal = 0;
    }

    // Mortgage payment stays nominal/fixed; living costs and rents rise with inflation.
    const surplus =
      income + rentIncome - livingExpenses - rentExpense - mPay - debtPay;

    liquid = (liquid + surplus) * (1 + depositRate);

    if (
      saveThenBuyActive &&
      !ownedCashHome &&
      targetPrice > 0 &&
      liquid >= targetPrice
    ) {
      liquid -= targetPrice;
      homeValue = targetPrice;
      homeAppreciation = targetPriceGrowth;
      ownedCashHome = true;
      boughtAtMonth = month;
      mortgageActive = false;
      mortgagePrincipal = 0;
      mortgagePayment = 0;
    }

    if ((mortgageActive || ownedCashHome) && homeValue > 0) {
      homeValue *= 1 + homeAppreciation;
    }

    if (saveThenBuyActive && !ownedCashHome && targetPrice > 0) {
      targetPrice *= 1 + targetPriceGrowth;
    }

    // Inflate cash-flow items for the next month.
    livingExpenses *= 1 + inflationMonth;
    if (rentExpense > 0) rentExpense *= 1 + inflationMonth;
    if (rentIncome > 0) rentIncome *= 1 + inflationMonth;

    const homeEquity =
      mortgageActive || ownedCashHome
        ? Math.max(0, homeValue - mortgagePrincipal)
        : 0;
    const netWorth = liquid + homeEquity - otherDebt;
    const inflationFactor = (1 + inflationMonth) ** (month + 1);
    const realNetWorth = netWorth / inflationFactor;

    if ((month + 1) % MONTHS_IN_YEAR === 0) {
      const year = (month + 1) / MONTHS_IN_YEAR;
      let note: string | undefined;
      if (
        boughtAtMonth !== undefined &&
        boughtAtMonth < month + 1 &&
        boughtAtMonth >= month + 1 - 12
      ) {
        note = `Купили за наличные на ${boughtAtMonth + 1}-м мес.`;
      }
      if (
        movedInAtMonth !== undefined &&
        movedInAtMonth < month + 1 &&
        movedInAtMonth >= month + 1 - 12
      ) {
        note = `Переезд после сдачи на ${movedInAtMonth + 1}-м мес.`;
      }
      years.push({
        year,
        liquidAssets: liquid,
        homeEquity,
        otherDebt,
        netWorth,
        realNetWorth,
        note,
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
    meta: { boughtAtMonth, movedInAtMonth },
  };
}

export function compareScenarios(results: ScenarioResult[]): CompareVerdict {
  if (results.length === 0) {
    return {
      winnerId: '',
      winnerName: '',
      deltaVsBaseline: 0,
      message: 'Нет сценариев для сравнения.',
    };
  }

  const sorted = [...results].sort(
    (a, b) => b.finalRealNetWorth - a.finalRealNetWorth,
  );
  const winner = sorted[0];
  const second = sorted[1] ?? sorted[0];
  const delta = winner.finalRealNetWorth - second.finalRealNetWorth;
  const horizon = winner.years[winner.years.length - 1]?.year ?? 0;

  const message =
    results.length === 1
      ? `Через ${horizon} лет капитал ≈ ${formatRub(winner.finalRealNetWorth)} в сегодняшних рублях.`
      : `Лучше «${winner.scenarioName}»: через ${horizon} лет реальный капитал больше, чем у «${second.scenarioName}», на ${formatRub(delta)}.`;

  return {
    winnerId: winner.scenarioId,
    winnerName: winner.scenarioName,
    deltaVsBaseline: delta,
    message,
  };
}

export const DEFAULT_PROFILE: BaselineProfile = {
  monthlyNetIncome: 180_000,
  monthlyExpenses: 70_000,
  liquidAssets: 3_500_000,
  existingDebtBalance: 0,
  existingDebtMonthlyPayment: 0,
};

export const DEFAULT_SETTINGS: ProjectionSettings = {
  horizonYears: 10,
  bankDepositAnnualRatePercent: 16,
  annualInflationPercent: 6,
};

export function buildScenariosForMode(mode: HousingMode): Scenario[] {
  if (mode === 'no_home') {
    return [
      {
        id: 'offplan',
        name: 'Ипотека на новостройку + аренда до сдачи',
        mode,
        events: [
          {
            type: 'offplan_mortgage',
            startMonth: 0,
            propertyPrice: 12_000_000,
            downPayment: 2_400_000,
            annualRatePercent: 18,
            termYears: 20,
            annualAppreciationPercent: 5,
            monthsUntilHandover: 24,
            monthlyRentUntilMoveIn: 55_000,
            moveInCost: 110_000,
          },
        ],
      },
      {
        id: 'rent_save',
        name: 'Снимать и копить во вкладе',
        mode,
        events: [
          {
            type: 'rent_and_save',
            startMonth: 0,
            monthlyRent: 55_000,
            moveInCost: 110_000,
          },
        ],
      },
    ];
  }

  return [
    {
      id: 'buy_to_let',
      name: 'Ипотека на вторичку и сразу сдавать',
      mode,
      events: [
        {
          type: 'buy_to_let_mortgage',
          startMonth: 0,
          propertyPrice: 10_000_000,
          downPayment: 2_000_000,
          annualRatePercent: 18,
          termYears: 20,
          annualAppreciationPercent: 4,
          monthlyRentIncome: 70_000,
        },
      ],
    },
    {
      id: 'save_then_buy',
      name: 'Копить во вкладе, потом купить за наличные',
      mode,
      events: [
        {
          type: 'save_then_buy',
          startMonth: 0,
          targetPropertyPrice: 10_000_000,
          annualPriceGrowthPercent: 4,
        },
      ],
    },
  ];
}
