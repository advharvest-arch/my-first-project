import { useMemo, useState, type ChangeEvent } from 'react';
import {
  annuityPayment,
  type BaselineProfile,
  type BuyToLetMortgageEvent,
  type HousingMode,
  type OffplanMortgageEvent,
  type ProjectionSettings,
  type RentAndSaveEvent,
  type SaveThenBuyEvent,
  type Scenario,
  type ScenarioEvent,
  type ScenarioResult,
} from '../engine/types';
import {
  buildSharedMortgageBase,
  compareMortgageVariants,
  loanAmount,
  suggestedExtraToMatchPayment,
  type EarlyPayMode,
  type EarlyPaymentPlan,
  type MortgageVariantSpec,
} from '../engine/mortgageDetail';
import { NetWorthChart } from './NetWorthChart';
import { MortgageDetailChart } from './MortgageDetailChart';

const DETAIL_COLORS = ['#e8c47a', '#7dcea0', '#7eb6e8', '#d4a5e8'];

const TIPS: Record<string, string[]> = {
  offplan: [
    'Пока идёт аренда, запас на досрочку меньше — учитывайте оба платежа.',
    'Сокращение срока обычно сильнее режет переплату, чем снижение платежа.',
    'Сравнивайте итог в сегодняшних рублях: инфляция делает далёкие проценты «дешевле».',
  ],
  rent_save: [
    'Если ставка вклада ниже инфляции, реальная покупательная способность падает.',
    'Рост аренды со временем съедает запас на накопления.',
    'Сценарий полезен как база сравнения с ипотечными вариантами.',
  ],
  buy_to_let: [
    'Аренда с объекта может частично закрывать платёж по ипотеке.',
    'Досрочка из свободных денег ускоряет выход в чистый поток.',
    'Считайте не только переплату, но и реальный капитал на горизонте.',
  ],
  save_then_buy: [
    'Чем выше ставка вклада, тем раньше накопите на покупку без кредита.',
    'Инфляция жилья может сделать «покупку потом» дороже.',
    'Сравнивайте с ипотечным сценарием: кредит vs ожидание.',
  ],
};

function formatRub(value: number): string {
  const rounded = Math.round(value);
  const abs = Math.abs(rounded);
  const formatted = new Intl.NumberFormat('ru-RU').format(abs);
  return rounded < 0 ? `−${formatted} ₽` : `${formatted} ₽`;
}

function readNumber(e: ChangeEvent<HTMLInputElement>): number | null {
  const v = e.target.valueAsNumber;
  return Number.isFinite(v) ? v : null;
}

type Props = {
  scenario: Scenario;
  result: ScenarioResult;
  profile: BaselineProfile;
  settings: ProjectionSettings;
  onBack: () => void;
  onPatchEvent: (
    mode: HousingMode,
    scenarioId: string,
    patch: Partial<ScenarioEvent> & { type: ScenarioEvent['type'] },
  ) => void;
};

export function ScenarioDetail({
  scenario,
  result,
  profile,
  settings,
  onBack,
  onPatchEvent,
}: Props) {
  const event = scenario.events[0];
  const isMortgage =
    event?.type === 'offplan_mortgage' || event?.type === 'buy_to_let_mortgage';
  const tips = TIPS[scenario.id] ?? [];

  return (
    <section className="detail-page">
      <button type="button" className="detail-back" onClick={onBack}>
        ← Все сценарии
      </button>

      <header className="detail-hero">
        <p className="eyebrow">Разбор сценария</p>
        <h2>{scenario.name}</h2>
        <p className="detail-verdict">
          На горизонте {settings.horizonYears} лет: капитал{' '}
          {formatRub(result.finalRealNetWorth)} (в сегодняшних рублях).
        </p>
      </header>

      <div className="detail-layout">
        <div className="panel detail-chart-panel">
          <h3>График этого сценария</h3>
          <p className="hint">
            Реальный капитал по годам — только выбранный путь, без остальных линий.
          </p>
          <div className="chart-wrap">
            <NetWorthChart results={[result]} colors={DETAIL_COLORS} />
          </div>
        </div>

        <aside className="panel detail-side">
          <h3>Параметры</h3>
          {event?.type === 'offplan_mortgage' && (
            <OffplanFields
              event={event}
              onPatch={(patch) =>
                onPatchEvent(scenario.mode, scenario.id, {
                  type: 'offplan_mortgage',
                  ...patch,
                })
              }
            />
          )}
          {event?.type === 'rent_and_save' && (
            <RentSaveFields
              event={event}
              onPatch={(patch) =>
                onPatchEvent(scenario.mode, scenario.id, {
                  type: 'rent_and_save',
                  ...patch,
                })
              }
            />
          )}
          {event?.type === 'buy_to_let_mortgage' && (
            <BuyToLetFields
              event={event}
              onPatch={(patch) =>
                onPatchEvent(scenario.mode, scenario.id, {
                  type: 'buy_to_let_mortgage',
                  ...patch,
                })
              }
            />
          )}
          {event?.type === 'save_then_buy' && (
            <SaveThenBuyFields
              event={event}
              onPatch={(patch) =>
                onPatchEvent(scenario.mode, scenario.id, {
                  type: 'save_then_buy',
                  ...patch,
                })
              }
            />
          )}

          {tips.length > 0 && (
            <ul className="detail-tips">
              {tips.map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      {isMortgage && event && (
        <MortgageLab
          profile={profile}
          settings={settings}
          event={event as OffplanMortgageEvent | BuyToLetMortgageEvent}
        />
      )}
    </section>
  );
}

function OffplanFields({
  event,
  onPatch,
}: {
  event: OffplanMortgageEvent;
  onPatch: (patch: Partial<OffplanMortgageEvent>) => void;
}) {
  return (
    <div className="fields two">
      <Num
        label="Цена лота"
        value={event.propertyPrice}
        onChange={(n) => onPatch({ propertyPrice: n })}
      />
      <Num
        label="Первый взнос"
        value={event.downPayment}
        onChange={(n) => onPatch({ downPayment: n })}
      />
      <Num
        label="Ставка ипотеки % / год"
        value={event.annualRatePercent}
        step={0.1}
        onChange={(n) => onPatch({ annualRatePercent: n })}
      />
      <Num
        label="Срок (лет)"
        value={event.termYears}
        onChange={(n) => onPatch({ termYears: Math.max(1, Math.round(n)) })}
      />
      <Num
        label="Срок аренды (месяцев)"
        value={event.rentMonths}
        onChange={(n) => onPatch({ rentMonths: Math.max(0, Math.round(n)) })}
      />
      <Num
        label="Аренда / мес"
        value={event.monthlyRentUntilMoveIn}
        onChange={(n) => onPatch({ monthlyRentUntilMoveIn: n })}
      />
      <Num
        label="Рост цены жилья % / год"
        value={event.annualAppreciationPercent}
        step={0.1}
        onChange={(n) => onPatch({ annualAppreciationPercent: n })}
      />
      <Num
        label="Разовый заезд в аренду"
        value={event.moveInCost}
        onChange={(n) => onPatch({ moveInCost: n })}
      />
    </div>
  );
}

function RentSaveFields({
  event,
  onPatch,
}: {
  event: RentAndSaveEvent;
  onPatch: (patch: Partial<RentAndSaveEvent>) => void;
}) {
  return (
    <div className="fields two">
      <Num
        label="Аренда / мес"
        value={event.monthlyRent}
        onChange={(n) => onPatch({ monthlyRent: n })}
      />
      <Num
        label="Разовый заезд"
        value={event.moveInCost}
        onChange={(n) => onPatch({ moveInCost: n })}
      />
    </div>
  );
}

function BuyToLetFields({
  event,
  onPatch,
}: {
  event: BuyToLetMortgageEvent;
  onPatch: (patch: Partial<BuyToLetMortgageEvent>) => void;
}) {
  return (
    <div className="fields two">
      <Num
        label="Цена квартиры"
        value={event.propertyPrice}
        onChange={(n) => onPatch({ propertyPrice: n })}
      />
      <Num
        label="Первый взнос"
        value={event.downPayment}
        onChange={(n) => onPatch({ downPayment: n })}
      />
      <Num
        label="Ставка ипотеки % / год"
        value={event.annualRatePercent}
        step={0.1}
        onChange={(n) => onPatch({ annualRatePercent: n })}
      />
      <Num
        label="Срок (лет)"
        value={event.termYears}
        onChange={(n) => onPatch({ termYears: Math.max(1, Math.round(n)) })}
      />
      <Num
        label="Аренда от сдачи / мес"
        value={event.monthlyRentIncome}
        onChange={(n) => onPatch({ monthlyRentIncome: n })}
      />
      <Num
        label="Рост цены жилья % / год"
        value={event.annualAppreciationPercent}
        step={0.1}
        onChange={(n) => onPatch({ annualAppreciationPercent: n })}
      />
    </div>
  );
}

function SaveThenBuyFields({
  event,
  onPatch,
}: {
  event: SaveThenBuyEvent;
  onPatch: (patch: Partial<SaveThenBuyEvent>) => void;
}) {
  return (
    <div className="fields two">
      <Num
        label="Целевая цена квартиры"
        value={event.targetPropertyPrice}
        onChange={(n) => onPatch({ targetPropertyPrice: n })}
      />
      <Num
        label="Рост цены жилья % / год"
        value={event.annualPriceGrowthPercent}
        step={0.1}
        onChange={(n) => onPatch({ annualPriceGrowthPercent: n })}
      />
    </div>
  );
}

function Num({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (n: number) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => {
          const n = readNumber(e);
          if (n !== null) onChange(n);
        }}
      />
    </label>
  );
}

function MortgageLab({
  profile,
  settings,
  event,
}: {
  profile: BaselineProfile;
  settings: ProjectionSettings;
  event: OffplanMortgageEvent | BuyToLetMortgageEvent;
}) {
  const shared = useMemo(() => buildSharedMortgageBase(event), [event]);
  const loan = loanAmount(shared);

  const [longTermYears, setLongTermYears] = useState(30);
  const [shortTermYears, setShortTermYears] = useState(15);
  const [extraMonthly, setExtraMonthly] = useState(() =>
    suggestedExtraToMatchPayment(
      Math.max(0, event.propertyPrice - event.downPayment),
      event.annualRatePercent,
      30,
      15,
    ),
  );
  const [mode, setMode] = useState<EarlyPayMode>('reduce_term');
  const [lumpSumAmount, setLumpSumAmount] = useState(0);
  const [lumpSumMonth, setLumpSumMonth] = useState(12);
  const [showThird, setShowThird] = useState(true);
  const [chartMetric, setChartMetric] = useState<
    'realNetWorth' | 'principalRemaining'
  >('principalRemaining');

  const longPay = annuityPayment(loan, event.annualRatePercent, longTermYears);
  const shortPay = annuityPayment(loan, event.annualRatePercent, shortTermYears);
  const matchExtra = suggestedExtraToMatchPayment(
    loan,
    event.annualRatePercent,
    longTermYears,
    shortTermYears,
  );

  const earlyA: EarlyPaymentPlan = {
    monthlyExtra: extraMonthly,
    monthlyExtraStartMonth: 0,
    lumpSumAmount,
    lumpSumMonth,
    mode,
  };

  const variants: MortgageVariantSpec[] = useMemo(() => {
    const modeLabel =
      mode === 'reduce_term'
        ? 'досрочка на сокращение срока'
        : 'досрочка на уменьшение платежа';
    const list: MortgageVariantSpec[] = [
      {
        id: 'long-extra',
        label: `Вариант 1: ${longTermYears} лет + досрочка`,
        note: `Аннуитет ${formatRub(longPay)} + ${formatRub(extraMonthly)}/мес (${modeLabel})`,
        termYears: longTermYears,
        early: earlyA,
      },
      {
        id: 'short-plain',
        label: `Вариант 2: ${shortTermYears} лет по графику`,
        note: `Только аннуитет ${formatRub(shortPay)}, без досрочных`,
        termYears: shortTermYears,
        early: {
          monthlyExtra: 0,
          monthlyExtraStartMonth: 0,
          lumpSumAmount: 0,
          lumpSumMonth: 12,
          mode: 'reduce_term',
        },
      },
    ];
    if (showThird) {
      list.push({
        id: 'long-plain',
        label: `Контроль: ${longTermYears} лет без досрочки`,
        note: `Только аннуитет ${formatRub(longPay)} — чтобы видеть эффект досрочки`,
        termYears: longTermYears,
        early: {
          monthlyExtra: 0,
          monthlyExtraStartMonth: 0,
          lumpSumAmount: 0,
          lumpSumMonth: 12,
          mode: 'reduce_term',
        },
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    longTermYears,
    shortTermYears,
    extraMonthly,
    mode,
    lumpSumAmount,
    lumpSumMonth,
    showThird,
    longPay,
    shortPay,
  ]);

  const comparison = useMemo(
    () => compareMortgageVariants(profile, settings, shared, variants),
    [profile, settings, shared, variants],
  );

  const variantA = comparison.find((c) => c.id === 'long-extra') ?? comparison[0];
  const variantB =
    comparison.find((c) => c.id === 'short-plain') ?? comparison[1];
  const winnerByInterest =
    variantA.totalInterestPaid <= variantB.totalInterestPaid ? variantA : variantB;
  const interestDelta = Math.abs(
    variantA.totalInterestPaid - variantB.totalInterestPaid,
  );
  const cashDelta = variantA.firstMonthCash - variantB.firstMonthCash;

  return (
    <section className="panel mortgage-lab">
      <h3>Ипотечный калькулятор: сравнение вариантов</h3>
      <p className="hint">
        Классический выбор: длинный срок с ежемесячной досрочкой против короткого
        срока строго по графику. Досрочка всегда уменьшает основной долг; дальше
        банк либо сокращает срок, либо пересчитывает платёж.
      </p>

      <div className="calc-loan-bar">
        <div>
          <span>Сумма кредита</span>
          <strong>{formatRub(loan)}</strong>
        </div>
        <div>
          <span>Ставка</span>
          <strong>{event.annualRatePercent}% / год</strong>
        </div>
        <div>
          <span>Тип платежей</span>
          <strong>Аннуитет</strong>
        </div>
      </div>

      <div className="variant-grid">
        <article className="variant-card">
          <header>
            <span className="variant-badge">Вариант 1</span>
            <h4>Длинный срок + досрочка</h4>
          </header>
          <div className="fields two">
            <label>
              Срок ипотеки, лет
              <input
                type="number"
                min={1}
                max={40}
                value={longTermYears}
                onChange={(e) => {
                  const n = readNumber(e);
                  if (n !== null) setLongTermYears(Math.max(1, Math.round(n)));
                }}
              />
            </label>
            <label>
              Платёж по графику
              <input type="text" readOnly value={formatRub(longPay)} />
            </label>
            <label>
              Дополнительно каждый месяц, ₽
              <input
                type="number"
                min={0}
                step={1000}
                value={extraMonthly}
                onChange={(e) => {
                  const n = readNumber(e);
                  if (n !== null) setExtraMonthly(Math.max(0, n));
                }}
              />
            </label>
            <label>
              Куда идёт досрочка
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as EarlyPayMode)}
              >
                <option value="reduce_term">
                  На сокращение срока (платёж тот же)
                </option>
                <option value="reduce_payment">
                  На уменьшение платежа (срок тот же)
                </option>
              </select>
            </label>
            <label>
              Разовый доп. платёж, ₽
              <input
                type="number"
                min={0}
                step={10000}
                value={lumpSumAmount}
                onChange={(e) => {
                  const n = readNumber(e);
                  if (n !== null) setLumpSumAmount(Math.max(0, n));
                }}
              />
            </label>
            <label>
              Месяц разового платежа
              <input
                type="number"
                min={0}
                value={lumpSumMonth}
                onChange={(e) => {
                  const n = readNumber(e);
                  if (n !== null) setLumpSumMonth(Math.max(0, Math.round(n)));
                }}
              />
            </label>
          </div>
          <p className="hint">
            Итого в первый месяц в банк:{' '}
            <strong>{formatRub(variantA.firstMonthCash)}</strong>
          </p>
          <button
            type="button"
            className="btn btn-ghost calc-preset"
            onClick={() => setExtraMonthly(matchExtra)}
          >
            Подобрать досрочку ≈ платежу варианта 2 ({formatRub(matchExtra)}/мес)
          </button>
        </article>

        <article className="variant-card">
          <header>
            <span className="variant-badge alt">Вариант 2</span>
            <h4>Короткий срок, только график</h4>
          </header>
          <div className="fields two">
            <label>
              Срок ипотеки, лет
              <input
                type="number"
                min={1}
                max={40}
                value={shortTermYears}
                onChange={(e) => {
                  const n = readNumber(e);
                  if (n !== null) setShortTermYears(Math.max(1, Math.round(n)));
                }}
              />
            </label>
            <label>
              Платёж по графику
              <input type="text" readOnly value={formatRub(shortPay)} />
            </label>
            <label>
              Досрочные платежи
              <input type="text" readOnly value="Нет — строго по графику" />
            </label>
            <label>
              Итого в месяц в банк
              <input type="text" readOnly value={formatRub(variantB.firstMonthCash)} />
            </label>
          </div>
          <p className="hint">
            Подходит, если готовы сразу платить высокий аннуитет и не хотите
            зависеть от дисциплины досрочки.
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={showThird}
              onChange={(e) => setShowThird(e.target.checked)}
            />
            Показать контроль: {longTermYears} лет без досрочки
          </label>
        </article>
      </div>

      <div className="calc-verdict">
        <strong>Итог сравнения:</strong> по переплате выгоднее «{winnerByInterest.label}»
        — экономия {formatRub(interestDelta)} процентов.
        {cashDelta > 0
          ? ` В начале вариант 1 тяжелее по кассе на ${formatRub(cashDelta)}/мес.`
          : cashDelta < 0
            ? ` В начале вариант 1 легче по кассе на ${formatRub(Math.abs(cashDelta))}/мес.`
            : ' Стартовый платёж почти одинаковый.'}{' '}
        Закрытие: вариант 1 —{' '}
        {variantA.payoffMonth != null
          ? `${(variantA.payoffMonth / 12).toFixed(1)} лет`
          : '—'}
        , вариант 2 —{' '}
        {variantB.payoffMonth != null
          ? `${(variantB.payoffMonth / 12).toFixed(1)} лет`
          : '—'}
        .
      </div>

      <div className="lab-kpis">
        <div>
          <span>Вариант 1 · платёж + досрочка</span>
          <strong>{formatRub(variantA.firstMonthCash)}</strong>
        </div>
        <div>
          <span>Вариант 1 · переплата</span>
          <strong>{formatRub(variantA.totalInterestPaid)}</strong>
        </div>
        <div>
          <span>Вариант 2 · платёж</span>
          <strong>{formatRub(variantB.firstMonthCash)}</strong>
        </div>
        <div>
          <span>Вариант 2 · переплата</span>
          <strong>{formatRub(variantB.totalInterestPaid)}</strong>
        </div>
      </div>

      <div className="metric-toggle">
        <button
          type="button"
          className={chartMetric === 'principalRemaining' ? 'is-active' : ''}
          onClick={() => setChartMetric('principalRemaining')}
        >
          Остаток долга
        </button>
        <button
          type="button"
          className={chartMetric === 'realNetWorth' ? 'is-active' : ''}
          onClick={() => setChartMetric('realNetWorth')}
        >
          Реальный капитал
        </button>
      </div>

      <div className="chart-wrap">
        <MortgageDetailChart
          series={comparison}
          colors={DETAIL_COLORS}
          metric={chartMetric}
        />
      </div>

      <div className="strategy-table-wrap">
        <h4>Таблица сравнения</h4>
        <table className="strategy-table">
          <thead>
            <tr>
              <th>Вариант</th>
              <th>Аннуитет</th>
              <th>В банк / мес*</th>
              <th>Переплата %</th>
              <th>Всего банку</th>
              <th>Закрытие</th>
            </tr>
          </thead>
          <tbody>
            {comparison.map((row) => (
              <tr
                key={row.id}
                className={
                  row.id === winnerByInterest.id ? 'is-active' : undefined
                }
              >
                <td>
                  <strong>{row.label}</strong>
                  <div className="strategy-note">{row.note}</div>
                </td>
                <td>{formatRub(row.scheduledPayment)}</td>
                <td>{formatRub(row.firstMonthCash)}</td>
                <td>{formatRub(row.totalInterestPaid)}</td>
                <td>{formatRub(row.totalCashToBank)}</td>
                <td>
                  {row.payoffMonth != null
                    ? `${(row.payoffMonth / 12).toFixed(1)} лет (${row.payoffMonth + 1} мес.)`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">
          * «В банк / мес» — первый месяц (аннуитет + ежемесячная досрочка; разовый
          платёж учитывается в своём месяце). Досрочка всегда гасит основной долг;
          режим задаёт, что банк меняет после этого — срок или размер платежа.
        </p>
        <p className="assumptions">
          Свободно после расходов профиля:{' '}
          {formatRub(
            profile.monthlyNetIncome - profile.monthlyExpenses - variantA.firstMonthCash,
          )}{' '}
          при варианте 1 и{' '}
          {formatRub(
            profile.monthlyNetIncome - profile.monthlyExpenses - variantB.firstMonthCash,
          )}{' '}
          при варианте 2 (без учёта аренды сценария). Не финансовый совет.
        </p>
      </div>
    </section>
  );
}
