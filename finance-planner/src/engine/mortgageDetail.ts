import {
  annuityPayment,
  type BaselineProfile,
  type Money,
  type ProjectionSettings,
} from './types';

export type EarlyPayMode = 'reduce_term' | 'reduce_payment';

export type EarlyPaymentPlan = {
  monthlyExtra: Money;
  /** Month index when monthly extras start (0 = first loan month). */
  monthlyExtraStartMonth: number;
  lumpSumAmount: Money;
  lumpSumMonth: number;
  mode: EarlyPayMode;
};

export type MortgageDetailParams = {
  propertyPrice: Money;
  downPayment: Money;
  annualRatePercent: number;
  termYears: number;
  annualAppreciationPercent: number;
  rentMonths: number;
  monthlyRent: Money;
  moveInCost: Money;
  monthlyRentIncome: Money;
  early: EarlyPaymentPlan;
};

export type MortgagePoint = {
  month: number;
  year: number;
  principalRemaining: Money;
  homeEquity: Money;
  liquidAssets: Money;
  realNetWorth: Money;
  totalInterestPaid: Money;
  totalPrincipalPaid: Money;
  monthlyPayment: Money;
  /** Scheduled annuity + extras this month (cash to the bank). */
  cashToBank: Money;
};

export type MortgageDetailResult = {
  id: string;
  label: string;
  note: string;
  points: MortgagePoint[];
  /** Years with full wealth simulation; later points are debt-only tails. */
  wealthHorizonYears: number;
  payoffMonth: number | null;
  totalInterestPaid: Money;
  totalPaid: Money;
  /** Sum of all cash sent to the bank (annuity + extras) until payoff. */
  totalCashToBank: Money;
  finalRealNetWorth: Money;
  scheduledPayment: Money;
  /** First-month total outflow = scheduled + monthly extra (+ lump if month 0). */
  firstMonthCash: Money;
  termYears: number;
  earlyMode: EarlyPayMode;
  monthlyExtra: Money;
};

export type MortgageVariantSpec = {
  id: string;
  label: string;
  note: string;
  termYears: number;
  early: EarlyPaymentPlan;
};

const MONTHS = 12;
const MAX_SIM_MONTHS = 40 * MONTHS;

function monthRate(annualPercent: number): number {
  return annualPercent / 100 / MONTHS;
}

export const DEFAULT_EARLY_PLAN: EarlyPaymentPlan = {
  monthlyExtra: 0,
  monthlyExtraStartMonth: 0,
  lumpSumAmount: 0,
  lumpSumMonth: 12,
  mode: 'reduce_term',
};

export function loanAmount(params: Pick<MortgageDetailParams, 'propertyPrice' | 'downPayment'>): Money {
  return Math.max(0, params.propertyPrice - params.downPayment);
}

/**
 * Pure loan amortization until payoff (or safety cap).
 * Early payments always reduce principal; mode chooses schedule rewrite.
 */
export function amortizeLoan(params: {
  principal: Money;
  annualRatePercent: number;
  termYears: number;
  early: EarlyPaymentPlan;
}): {
  scheduledPayment: Money;
  payoffMonth: number | null;
  totalInterestPaid: Money;
  totalPrincipalPaid: Money;
  totalCashToBank: Money;
  firstMonthCash: Money;
  monthlyPrincipal: Money[];
} {
  const loan = Math.max(0, params.principal);
  const loanRate = monthRate(params.annualRatePercent);
  let principal = loan;
  let remainingTermMonths = Math.max(1, Math.round(params.termYears) * MONTHS);
  let payment = annuityPayment(loan, params.annualRatePercent, params.termYears);
  const scheduledPayment = payment;

  let totalInterest = 0;
  let totalPrincipalPaid = 0;
  let totalCashToBank = 0;
  let firstMonthCash = 0;
  let payoffMonth: number | null = null;
  const monthlyPrincipal: Money[] = [principal];

  for (let month = 0; month < MAX_SIM_MONTHS; month += 1) {
    if (principal <= 0.01) {
      payoffMonth = payoffMonth ?? Math.max(0, month - 1);
      break;
    }

    const interest = principal * loanRate;
    const principalPart = Math.min(principal, Math.max(0, payment - interest));
    principal -= principalPart;
    totalInterest += interest;
    totalPrincipalPaid += principalPart;

    const extrasThisMonth =
      (month >= params.early.monthlyExtraStartMonth
        ? Math.max(0, params.early.monthlyExtra)
        : 0) +
      (month === params.early.lumpSumMonth
        ? Math.max(0, params.early.lumpSumAmount)
        : 0);

    const extra = Math.min(principal, extrasThisMonth);
    if (extra > 0) {
      principal -= extra;
      totalPrincipalPaid += extra;

      if (params.early.mode === 'reduce_payment' && principal > 0.01) {
        const leftMonths = Math.max(1, remainingTermMonths - 1);
        payment = annuityPayment(
          principal,
          params.annualRatePercent,
          leftMonths / MONTHS,
        );
      }
    }

    const cash = principalPart + interest + extra;
    totalCashToBank += cash;
    if (month === 0) firstMonthCash = cash;

    if (principal < 0.01) {
      principal = 0;
      payment = 0;
      payoffMonth = month;
    }

    remainingTermMonths = Math.max(0, remainingTermMonths - 1);
    monthlyPrincipal.push(principal);

    if (payoffMonth !== null) break;
  }

  return {
    scheduledPayment,
    payoffMonth,
    totalInterestPaid: totalInterest,
    totalPrincipalPaid,
    totalCashToBank,
    firstMonthCash,
    monthlyPrincipal,
  };
}

export function simulateMortgageDetail(
  profile: BaselineProfile,
  settings: ProjectionSettings,
  params: MortgageDetailParams,
  meta: { id?: string; label?: string; note?: string } = {},
): MortgageDetailResult {
  const label = meta.label ?? 'Ипотека';
  const id = meta.id ?? label;
  const note = meta.note ?? '';

  const horizonMonths = Math.max(1, Math.round(settings.horizonYears)) * MONTHS;
  const depositRate = monthRate(settings.bankDepositAnnualRatePercent);
  const inflationMonth = monthRate(settings.annualInflationPercent);
  const loanRate = monthRate(params.annualRatePercent);
  const homeGrowth = monthRate(params.annualAppreciationPercent);

  const loan = loanAmount(params);
  const amort = amortizeLoan({
    principal: loan,
    annualRatePercent: params.annualRatePercent,
    termYears: params.termYears,
    early: params.early,
  });

  // Wealth path over the planner horizon (may end before full payoff).
  let principal = loan;
  let remainingTermMonths = Math.max(1, Math.round(params.termYears) * MONTHS);
  let payment = amort.scheduledPayment;

  let liquid =
    profile.liquidAssets - params.downPayment - Math.max(0, params.moveInCost);
  let livingExpenses = profile.monthlyExpenses;
  let rentExpense = Math.max(0, params.monthlyRent);
  let rentIncome = Math.max(0, params.monthlyRentIncome);
  let homeValue = Math.max(0, params.propertyPrice);

  let totalInterest = 0;
  let totalPrincipalPaid = 0;
  let horizonPayoff: number | null = null;

  const points: MortgagePoint[] = [
    {
      month: 0,
      year: 0,
      principalRemaining: principal,
      homeEquity: Math.max(0, homeValue - principal),
      liquidAssets: liquid,
      realNetWorth: liquid + Math.max(0, homeValue - principal),
      totalInterestPaid: 0,
      totalPrincipalPaid: 0,
      monthlyPayment: payment,
      cashToBank: 0,
    },
  ];

  for (let month = 0; month < horizonMonths; month += 1) {
    if (params.rentMonths > 0 && month >= params.rentMonths) {
      rentExpense = 0;
    }

    let interest = 0;
    let principalPart = 0;
    let extra = 0;
    let cashToBank = 0;

    if (principal > 0.01) {
      interest = principal * loanRate;
      principalPart = Math.min(principal, Math.max(0, payment - interest));
      principal -= principalPart;
      totalInterest += interest;
      totalPrincipalPaid += principalPart;

      const extrasThisMonth =
        (month >= params.early.monthlyExtraStartMonth
          ? Math.max(0, params.early.monthlyExtra)
          : 0) +
        (month === params.early.lumpSumMonth
          ? Math.max(0, params.early.lumpSumAmount)
          : 0);

      extra = Math.min(principal, extrasThisMonth);
      if (extra > 0) {
        principal -= extra;
        totalPrincipalPaid += extra;
        liquid -= extra;

        if (params.early.mode === 'reduce_payment' && principal > 0.01) {
          const leftMonths = Math.max(1, remainingTermMonths - 1);
          payment = annuityPayment(
            principal,
            params.annualRatePercent,
            leftMonths / MONTHS,
          );
        }
      }

      cashToBank = principalPart + interest + extra;

      if (principal < 0.01) {
        principal = 0;
        payment = 0;
        if (horizonPayoff === null) horizonPayoff = month;
      }

      remainingTermMonths = Math.max(0, remainingTermMonths - 1);
    }

    const mPay = interest + principalPart;
    const surplus =
      profile.monthlyNetIncome +
      rentIncome -
      livingExpenses -
      rentExpense -
      mPay;

    liquid = (liquid + surplus) * (1 + depositRate);
    if (homeValue > 0) homeValue *= 1 + homeGrowth;

    livingExpenses *= 1 + inflationMonth;
    if (rentExpense > 0) rentExpense *= 1 + inflationMonth;
    if (rentIncome > 0) rentIncome *= 1 + inflationMonth;

    if ((month + 1) % MONTHS === 0) {
      const year = (month + 1) / MONTHS;
      const homeEquity = Math.max(0, homeValue - principal);
      const realNetWorth =
        (liquid + homeEquity) / (1 + inflationMonth) ** (month + 1);
      points.push({
        month: month + 1,
        year,
        principalRemaining: principal,
        homeEquity,
        liquidAssets: liquid,
        realNetWorth,
        totalInterestPaid: totalInterest,
        totalPrincipalPaid,
        monthlyPayment: payment,
        cashToBank,
      });
    }
  }

  // Extend chart points with pure amortization principal after horizon,
  // so long mortgages still show payoff on the debt chart.
  const amortYears = Math.ceil(
    (amort.payoffMonth != null ? amort.payoffMonth + 1 : params.termYears * MONTHS) /
      MONTHS,
  );
  const chartEndYear = Math.max(settings.horizonYears, amortYears, params.termYears);
  for (let year = settings.horizonYears + 1; year <= chartEndYear; year += 1) {
    const monthIdx = year * MONTHS;
    const principalAt = amort.monthlyPrincipal[monthIdx] ?? 0;
    const last = points[points.length - 1];
    points.push({
      month: monthIdx,
      year,
      principalRemaining: principalAt,
      homeEquity: last.homeEquity,
      liquidAssets: last.liquidAssets,
      realNetWorth: last.realNetWorth,
      totalInterestPaid: amort.totalInterestPaid,
      totalPrincipalPaid: amort.totalPrincipalPaid,
      monthlyPayment: 0,
      cashToBank: 0,
    });
  }

  const final = points[Math.min(settings.horizonYears, points.length - 1)] ?? points.at(-1)!;

  return {
    id,
    label,
    note,
    points,
    wealthHorizonYears: settings.horizonYears,
    payoffMonth: amort.payoffMonth,
    totalInterestPaid: amort.totalInterestPaid,
    totalPaid: amort.totalInterestPaid + amort.totalPrincipalPaid,
    totalCashToBank: amort.totalCashToBank,
    finalRealNetWorth: final.realNetWorth,
    scheduledPayment: amort.scheduledPayment,
    firstMonthCash: amort.firstMonthCash,
    termYears: params.termYears,
    earlyMode: params.early.mode,
    monthlyExtra: params.early.monthlyExtra,
  };
}

export function buildSharedMortgageBase(
  event: {
    type: 'offplan_mortgage' | 'buy_to_let_mortgage';
    propertyPrice: Money;
    downPayment: Money;
    annualRatePercent: number;
    annualAppreciationPercent: number;
    rentMonths?: number;
    monthlyRentUntilMoveIn?: Money;
    moveInCost?: Money;
    monthlyRentIncome?: Money;
  },
): Omit<MortgageDetailParams, 'termYears' | 'early'> {
  if (event.type === 'offplan_mortgage') {
    return {
      propertyPrice: event.propertyPrice,
      downPayment: event.downPayment,
      annualRatePercent: event.annualRatePercent,
      annualAppreciationPercent: event.annualAppreciationPercent,
      rentMonths: event.rentMonths ?? 0,
      monthlyRent: event.monthlyRentUntilMoveIn ?? 0,
      moveInCost: event.moveInCost ?? 0,
      monthlyRentIncome: 0,
    };
  }
  return {
    propertyPrice: event.propertyPrice,
    downPayment: event.downPayment,
    annualRatePercent: event.annualRatePercent,
    annualAppreciationPercent: event.annualAppreciationPercent,
    rentMonths: 0,
    monthlyRent: 0,
    moveInCost: 0,
    monthlyRentIncome: event.monthlyRentIncome ?? 0,
  };
}

export function compareMortgageVariants(
  profile: BaselineProfile,
  settings: ProjectionSettings,
  shared: Omit<MortgageDetailParams, 'termYears' | 'early'>,
  variants: MortgageVariantSpec[],
): MortgageDetailResult[] {
  return variants.map((v) =>
    simulateMortgageDetail(
      profile,
      settings,
      { ...shared, termYears: v.termYears, early: v.early },
      { id: v.id, label: v.label, note: v.note },
    ),
  );
}

/** Suggest monthly extra so long-term + extra ≈ short-term scheduled payment. */
export function suggestedExtraToMatchPayment(
  loan: Money,
  annualRatePercent: number,
  longTermYears: number,
  shortTermYears: number,
): Money {
  const longPay = annuityPayment(loan, annualRatePercent, longTermYears);
  const shortPay = annuityPayment(loan, annualRatePercent, shortTermYears);
  return Math.max(0, Math.round(shortPay - longPay));
}

/** @deprecated prefer compareMortgageVariants */
export function compareMortgageStrategies(
  profile: BaselineProfile,
  settings: ProjectionSettings,
  base: MortgageDetailParams,
): MortgageDetailResult[] {
  const currentTerm = Math.round(base.termYears);
  const variants: MortgageVariantSpec[] = [
    {
      id: 'plain',
      label: 'Без досрочки',
      note: `${currentTerm} лет по графику`,
      termYears: currentTerm,
      early: { ...DEFAULT_EARLY_PLAN },
    },
    {
      id: 'early',
      label: 'С досрочкой',
      note: 'Ваши настройки досрочки',
      termYears: currentTerm,
      early: base.early,
    },
  ];

  for (const termYears of [15, 20, 30]) {
    if (termYears === currentTerm) continue;
    variants.push({
      id: `term-${termYears}`,
      label: `Срок ${termYears} лет`,
      note: 'Только график, без досрочки',
      termYears,
      early: { ...DEFAULT_EARLY_PLAN },
    });
    if (variants.length >= 4) break;
  }

  return compareMortgageVariants(profile, settings, base, variants);
}
