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
};

export type MortgageDetailResult = {
  label: string;
  points: MortgagePoint[];
  payoffMonth: number | null;
  totalInterestPaid: Money;
  totalPaid: Money;
  finalRealNetWorth: Money;
  scheduledPayment: Money;
};

const MONTHS = 12;

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

export function simulateMortgageDetail(
  profile: BaselineProfile,
  settings: ProjectionSettings,
  params: MortgageDetailParams,
  label = 'Ипотека',
): MortgageDetailResult {
  const horizonMonths = Math.max(1, Math.round(settings.horizonYears)) * MONTHS;
  const depositRate = monthRate(settings.bankDepositAnnualRatePercent);
  const inflationMonth = monthRate(settings.annualInflationPercent);
  const loanRate = monthRate(params.annualRatePercent);
  const homeGrowth = monthRate(params.annualAppreciationPercent);

  const loan = Math.max(0, params.propertyPrice - params.downPayment);
  let principal = loan;
  let remainingTermMonths = Math.max(1, Math.round(params.termYears) * MONTHS);
  let payment = annuityPayment(loan, params.annualRatePercent, params.termYears);
  const scheduledPayment = payment;

  let liquid =
    profile.liquidAssets - params.downPayment - Math.max(0, params.moveInCost);
  let livingExpenses = profile.monthlyExpenses;
  let rentExpense = Math.max(0, params.monthlyRent);
  let rentIncome = Math.max(0, params.monthlyRentIncome);
  let homeValue = Math.max(0, params.propertyPrice);

  let totalInterest = 0;
  let totalPrincipalPaid = 0;
  let payoffMonth: number | null = null;

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
    },
  ];

  for (let month = 0; month < horizonMonths; month += 1) {
    if (params.rentMonths > 0 && month >= params.rentMonths) {
      rentExpense = 0;
    }

    let interest = 0;
    let principalPart = 0;

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

      const extra = Math.min(principal, extrasThisMonth);
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

      if (principal < 0.01) {
        principal = 0;
        payment = 0;
        if (payoffMonth === null) payoffMonth = month;
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
      });
    }
  }

  const final = points[points.length - 1];
  return {
    label,
    points,
    payoffMonth,
    totalInterestPaid: totalInterest,
    totalPaid: totalInterest + totalPrincipalPaid,
    finalRealNetWorth: final.realNetWorth,
    scheduledPayment,
  };
}

export function compareMortgageStrategies(
  profile: BaselineProfile,
  settings: ProjectionSettings,
  base: MortgageDetailParams,
): MortgageDetailResult[] {
  const currentTerm = Math.round(base.termYears);
  const results: MortgageDetailResult[] = [
    simulateMortgageDetail(
      profile,
      settings,
      { ...base, early: { ...DEFAULT_EARLY_PLAN } },
      'Без досрочки',
    ),
    simulateMortgageDetail(profile, settings, base, 'С досрочкой'),
  ];

  for (const termYears of [10, 15, 20, 25, 30]) {
    if (termYears === currentTerm) continue;
    results.push(
      simulateMortgageDetail(
        profile,
        settings,
        { ...base, termYears, early: { ...DEFAULT_EARLY_PLAN } },
        `Срок ${termYears} лет`,
      ),
    );
    if (results.length >= 4) break;
  }

  return results;
}
