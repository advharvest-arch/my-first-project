import { useMemo, useState, type ChangeEvent } from 'react';
import {
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
  compareMortgageStrategies,
  DEFAULT_EARLY_PLAN,
  type EarlyPayMode,
  type EarlyPaymentPlan,
  type MortgageDetailParams,
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
  const [termYears, setTermYears] = useState(event.termYears);
  const [extraMonthly, setExtraMonthly] = useState(20_000);
  const [extraStartMonth, setExtraStartMonth] = useState(0);
  const [lumpSumAmount, setLumpSumAmount] = useState(0);
  const [lumpSumMonth, setLumpSumMonth] = useState(12);
  const [mode, setMode] = useState<EarlyPayMode>('reduce_term');
  const [chartMetric, setChartMetric] = useState<
    'realNetWorth' | 'principalRemaining'
  >('principalRemaining');

  const early: EarlyPaymentPlan = {
    monthlyExtra: extraMonthly,
    monthlyExtraStartMonth: extraStartMonth,
    lumpSumAmount,
    lumpSumMonth,
    mode,
  };

  const baseParams: MortgageDetailParams = useMemo(() => {
    if (event.type === 'offplan_mortgage') {
      return {
        propertyPrice: event.propertyPrice,
        downPayment: event.downPayment,
        annualRatePercent: event.annualRatePercent,
        termYears,
        annualAppreciationPercent: event.annualAppreciationPercent,
        rentMonths: event.rentMonths,
        monthlyRent: event.monthlyRentUntilMoveIn,
        moveInCost: event.moveInCost,
        monthlyRentIncome: 0,
        early,
      };
    }
    return {
      propertyPrice: event.propertyPrice,
      downPayment: event.downPayment,
      annualRatePercent: event.annualRatePercent,
      termYears,
      annualAppreciationPercent: event.annualAppreciationPercent,
      rentMonths: 0,
      monthlyRent: 0,
      moveInCost: 0,
      monthlyRentIncome: event.monthlyRentIncome,
      early,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    event,
    termYears,
    extraMonthly,
    extraStartMonth,
    lumpSumAmount,
    lumpSumMonth,
    mode,
  ]);

  const comparison = useMemo(
    () => compareMortgageStrategies(profile, settings, baseParams),
    [profile, settings, baseParams],
  );

  const withEarly =
    comparison.find((c) => c.label === 'С досрочкой') ?? comparison[0];
  const baseline =
    comparison.find((c) => c.label === 'Без досрочки') ?? comparison[0];

  const spare =
    profile.monthlyNetIncome -
    profile.monthlyExpenses -
    withEarly.scheduledPayment;

  return (
    <section className="panel mortgage-lab">
      <h3>Лаборатория ипотеки</h3>
      <p className="hint">
        Подберите срок и досрочные платежи: когда вносить, сколько и что выгоднее —
        сократить срок или снизить ежемесячный платёж.
      </p>

      <div className="fields three lab-controls">
        <label>
          Срок кредита, лет
          <input
            type="number"
            min={1}
            max={40}
            value={termYears}
            onChange={(e) => {
              const n = readNumber(e);
              if (n !== null) setTermYears(Math.max(1, Math.round(n)));
            }}
          />
        </label>
        <label>
          Ежемесячная досрочка, ₽
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
          Досрочка с месяца №
          <input
            type="number"
            min={0}
            value={extraStartMonth}
            onChange={(e) => {
              const n = readNumber(e);
              if (n !== null) setExtraStartMonth(Math.max(0, Math.round(n)));
            }}
          />
        </label>
        <label>
          Разовый платёж, ₽
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
        <label>
          Куда направить досрочку
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as EarlyPayMode)}
          >
            <option value="reduce_term">Сократить срок</option>
            <option value="reduce_payment">Снизить платёж</option>
          </select>
        </label>
      </div>

      <p className="hint lab-spare">
        После обычного платежа (~{formatRub(withEarly.scheduledPayment)}) свободно
        около {formatRub(spare)} / мес (до аренды и инфляции расходов). Базовый
        план без досрочки:{' '}
        {baseline.payoffMonth != null
          ? `закрытие на ${(baseline.payoffMonth / 12).toFixed(1)} году`
          : 'не закрыта на горизонте'}
        , переплата {formatRub(baseline.totalInterestPaid)}.
      </p>

      <div className="lab-kpis">
        <div>
          <span>Платёж по графику</span>
          <strong>{formatRub(withEarly.scheduledPayment)}</strong>
        </div>
        <div>
          <span>Переплата с досрочкой</span>
          <strong>{formatRub(withEarly.totalInterestPaid)}</strong>
        </div>
        <div>
          <span>Закрытие</span>
          <strong>
            {withEarly.payoffMonth != null
              ? `${withEarly.payoffMonth} мес. (${(withEarly.payoffMonth / 12).toFixed(1)} лет)`
              : 'на горизонте не закрыта'}
          </strong>
        </div>
        <div>
          <span>Капитал в конце</span>
          <strong>{formatRub(withEarly.finalRealNetWorth)}</strong>
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
          series={comparison.slice(0, 3)}
          colors={DETAIL_COLORS}
          metric={chartMetric}
        />
      </div>

      <div className="strategy-table-wrap">
        <h4>Сравнение стратегий</h4>
        <table className="strategy-table">
          <thead>
            <tr>
              <th>Стратегия</th>
              <th>Платёж</th>
              <th>Переплата</th>
              <th>Закрытие</th>
              <th>Капитал</th>
            </tr>
          </thead>
          <tbody>
            {comparison.map((row) => (
              <tr
                key={row.label}
                className={row.label === 'С досрочкой' ? 'is-active' : undefined}
              >
                <td>
                  <strong>{row.label}</strong>
                </td>
                <td>{formatRub(row.scheduledPayment)}</td>
                <td>{formatRub(row.totalInterestPaid)}</td>
                <td>
                  {row.payoffMonth != null
                    ? `${(row.payoffMonth / 12).toFixed(1)} лет`
                    : '—'}
                </td>
                <td>{formatRub(row.finalRealNetWorth)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">
          «С досрочкой» использует ваши настройки выше
          {extraMonthly > 0 || lumpSumAmount > 0
            ? ` (${extraMonthly > 0 ? `+${formatRub(extraMonthly)}/мес` : ''}${
                lumpSumAmount > 0
                  ? `${extraMonthly > 0 ? ', ' : ''}разово ${formatRub(lumpSumAmount)}`
                  : ''
              }, режим «${mode === 'reduce_term' ? 'срок' : 'платёж'}»)`
            : ' (сейчас досрочка = 0 — совпадает с базой)'}
          . Остальные строки — без досрочки, для сравнения сроков.
        </p>
        <p className="assumptions">
          Модель упрощённая: досрочка списывается с ликвидности; при «снизить
          платёж» аннуитет пересчитывается на оставшийся срок. Дефолт досрочки —{' '}
          {formatRub(DEFAULT_EARLY_PLAN.monthlyExtra)}/мес.
        </p>
      </div>
    </section>
  );
}
