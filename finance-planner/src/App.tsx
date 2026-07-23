import { useMemo, useState, type ChangeEvent } from 'react';
import {
  buildScenariosForMode,
  compareScenarios,
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  projectScenario,
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
} from './engine/types';
import { NetWorthChart } from './components/NetWorthChart';

const STORAGE_KEY = 'esli-finance-mvp-v6';

type StoredState = {
  profile: BaselineProfile;
  settings: ProjectionSettings;
  scenariosByMode: Record<HousingMode, Scenario[]>;
};

function defaultStore(): StoredState {
  return {
    profile: DEFAULT_PROFILE,
    settings: DEFAULT_SETTINGS,
    scenariosByMode: {
      no_home: buildScenariosForMode('no_home'),
      has_home: buildScenariosForMode('has_home'),
    },
  };
}

function normalizeScenarios(
  stored: Scenario[] | undefined,
  mode: HousingMode,
): Scenario[] {
  const defaults = buildScenariosForMode(mode);
  if (!stored?.length) return defaults;
  return defaults.map((def) => {
    const found = stored.find((s) => s.id === def.id);
    const defEvent = def.events[0];
    const foundEvent = found?.events[0];
    if (!found || !foundEvent || foundEvent.type !== defEvent.type) return def;
    return {
      ...def,
      events: [{ ...defEvent, ...foundEvent, type: defEvent.type } as ScenarioEvent],
    };
  });
}

function loadState(): StoredState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultStore();
    const parsed = JSON.parse(raw) as Partial<StoredState> & {
      settings?: ProjectionSettings & { annualInvestmentReturnPercent?: number };
    };
    const base = defaultStore();
    return {
      profile: { ...base.profile, ...parsed.profile },
      settings: {
        ...base.settings,
        ...parsed.settings,
        bankDepositAnnualRatePercent:
          parsed.settings?.bankDepositAnnualRatePercent ??
          parsed.settings?.annualInvestmentReturnPercent ??
          base.settings.bankDepositAnnualRatePercent,
      },
      scenariosByMode: {
        no_home: normalizeScenarios(parsed.scenariosByMode?.no_home, 'no_home'),
        has_home: normalizeScenarios(parsed.scenariosByMode?.has_home, 'has_home'),
      },
    };
  } catch {
    return defaultStore();
  }
}

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

const COLORS = ['#e8c47a', '#7dcea0', '#7eb6e8', '#d4a5e8'];

export default function App() {
  const initial = useMemo(() => loadState(), []);
  const [profile, setProfile] = useState<BaselineProfile>(initial.profile);
  const [settings, setSettings] = useState<ProjectionSettings>(initial.settings);
  const [scenariosByMode, setScenariosByMode] = useState(initial.scenariosByMode);

  const allScenarios = useMemo(
    () => [...scenariosByMode.no_home, ...scenariosByMode.has_home],
    [scenariosByMode],
  );

  const results: ScenarioResult[] = useMemo(
    () => allScenarios.map((s) => projectScenario(profile, s, settings)),
    [profile, allScenarios, settings],
  );

  const zeroInflationResults: ScenarioResult[] = useMemo(
    () =>
      allScenarios.map((s) =>
        projectScenario(profile, s, {
          ...settings,
          annualInflationPercent: 0,
        }),
      ),
    [profile, allScenarios, settings],
  );

  const verdict = useMemo(() => compareScenarios(results), [results]);

  const inflationImpact = useMemo(() => {
    const withInf = Math.max(...results.map((r) => r.finalRealNetWorth));
    const noInf = Math.max(
      ...zeroInflationResults.map((r) => r.finalRealNetWorth),
    );
    const eaten = noInf - withInf;
    const pct = noInf !== 0 ? (eaten / Math.abs(noInf)) * 100 : 0;
    return { withInf, noInf, eaten, pct };
  }, [results, zeroInflationResults]);

  function persist(
    nextProfile = profile,
    nextSettings = settings,
    nextMap = scenariosByMode,
  ) {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        profile: nextProfile,
        settings: nextSettings,
        scenariosByMode: nextMap,
      } satisfies StoredState),
    );
  }

  function updateProfile<K extends keyof BaselineProfile>(
    key: K,
    value: BaselineProfile[K],
  ) {
    const next = { ...profile, [key]: value };
    setProfile(next);
    persist(next, settings, scenariosByMode);
  }

  function updateSettings<K extends keyof ProjectionSettings>(
    key: K,
    value: ProjectionSettings[K],
  ) {
    const next = { ...settings, [key]: value };
    setSettings(next);
    persist(profile, next, scenariosByMode);
  }

  function patchScenarioEvent(
    mode: HousingMode,
    scenarioId: string,
    patch: Partial<ScenarioEvent> & { type: ScenarioEvent['type'] },
  ) {
    setScenariosByMode((prev) => {
      const nextMap = {
        ...prev,
        [mode]: prev[mode].map((s) => {
          if (s.id !== scenarioId) return s;
          const current = s.events[0];
          if (!current || current.type !== patch.type) return s;
          return { ...s, events: [{ ...current, ...patch } as ScenarioEvent] };
        }),
      };
      persist(profile, settings, nextMap);
      return nextMap;
    });
  }

  const offplan = scenariosByMode.no_home.find((s) => s.id === 'offplan')
    ?.events[0] as OffplanMortgageEvent | undefined;
  const rentSave = scenariosByMode.no_home.find((s) => s.id === 'rent_save')
    ?.events[0] as RentAndSaveEvent | undefined;
  const buyToLet = scenariosByMode.has_home.find((s) => s.id === 'buy_to_let')
    ?.events[0] as BuyToLetMortgageEvent | undefined;
  const saveThenBuy = scenariosByMode.has_home.find((s) => s.id === 'save_then_buy')
    ?.events[0] as SaveThenBuyEvent | undefined;

  return (
    <div className="app">
      <header className="hero">
        <h1 className="brand">
          Если<span>.</span>
        </h1>
        <p className="lede">
          Сравните пути к жилью: новостройка с арендой до сдачи, вклад вместо
          покупки, ипотека под сдачу или накопить и купить за наличные.
        </p>
      </header>

      <div className="layout-wide">
          <section className="panel panel-chart">
            <h2>Сравнение всех 4 сценариев</h2>
            <p className="hint">
              График — в сегодняшних рублях (с учётом инфляции). Ставка вклада
              общая, из профиля.
            </p>
            <div className="verdict">{verdict.message}</div>
            <div className="inflation-box">
              <strong>Эффект инфляции {settings.annualInflationPercent}%:</strong>{' '}
              без инфляции лучший итог был бы {formatRub(inflationImpact.noInf)}, 
              сейчас {formatRub(inflationImpact.withInf)}
              {inflationImpact.eaten > 0
                ? ` — инфляция «съела» ${formatRub(inflationImpact.eaten)} (${inflationImpact.pct.toFixed(0)}%)`
                : inflationImpact.eaten < 0
                  ? ` — при нулевой инфляции было бы меньше`
                  : ' — при 0% инфляции итог тот же'}
              .
            </div>
            {results.some((r) => r.meta?.boughtAtMonth !== undefined) && (
              <p className="hint">
                {results
                  .filter((r) => r.meta?.boughtAtMonth !== undefined)
                  .map(
                    (r) =>
                      `«${r.scenarioName}»: покупка за наличные около ${(r.meta!.boughtAtMonth! / 12).toFixed(1)} года.`,
                  )
                  .join(' ')}
              </p>
            )}
            {results.some((r) => r.meta?.movedInAtMonth !== undefined) && (
              <p className="hint">
                {results
                  .filter((r) => r.meta?.movedInAtMonth !== undefined)
                  .map(
                    (r) =>
                      `«${r.scenarioName}»: переезд после сдачи на ${(r.meta!.movedInAtMonth! / 12).toFixed(1)} году.`,
                  )
                  .join(' ')}
              </p>
            )}
            <div className="chart-wrap">
              <NetWorthChart results={results} colors={COLORS} />
            </div>
            <div className="legend">
              {results.map((r, i) => (
                <span key={r.scenarioId}>
                  <i style={{ background: COLORS[i % COLORS.length] }} />
                  {r.scenarioName}
                </span>
              ))}
            </div>
            <div className="delta-grid">
              {results.map((r) => {
                const best = Math.max(
                  ...results.map((x) => x.finalRealNetWorth),
                );
                const delta = r.finalRealNetWorth - best;
                const cls =
                  delta === 0 ? 'delta-pos' : delta < 0 ? 'delta-neg' : '';
                return (
                  <div className="delta-row" key={r.scenarioId}>
                    <span>{r.scenarioName}</span>
                    <span className={cls}>
                      {formatRub(r.finalRealNetWorth)}
                      {delta < 0 && <> (−{formatRub(Math.abs(delta))})</>}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="assumptions">
              Инфляция поднимает расходы и аренду каждый месяц и переводит итог
              в сегодняшние рубли. Платёж по ипотеке фиксированный. Рост цены
              жилья задаётся отдельно в сценарии. Не финансовый совет.
            </p>
          </section>

          <div className="layout-top">
            <section className="panel">
              <h2>Профиль</h2>
              <p className="hint">
                Расходы — без аренды и ипотеки. Ставка вклада общая для всех
                сценариев.
              </p>
              <div className="fields two">
                <label>
                  Чистый доход / мес
                  <input
                    type="number"
                    value={profile.monthlyNetIncome}
                    onChange={(e) => {
                      const n = readNumber(e);
                      if (n !== null) updateProfile('monthlyNetIncome', n);
                    }}
                  />
                </label>
                <label>
                  Расходы без жилья / мес
                  <input
                    type="number"
                    value={profile.monthlyExpenses}
                    onChange={(e) => {
                      const n = readNumber(e);
                      if (n !== null) updateProfile('monthlyExpenses', n);
                    }}
                  />
                </label>
                <label>
                  Кэш + накопления
                  <input
                    type="number"
                    value={profile.liquidAssets}
                    onChange={(e) => {
                      const n = readNumber(e);
                      if (n !== null) updateProfile('liquidAssets', n);
                    }}
                  />
                </label>
                <label>
                  Ставка вклада % / год
                  <input
                    type="number"
                    step="0.1"
                    value={settings.bankDepositAnnualRatePercent}
                    onChange={(e) => {
                      const n = readNumber(e);
                      if (n !== null)
                        updateSettings('bankDepositAnnualRatePercent', n);
                    }}
                  />
                </label>
                <label>
                  Горизонт (лет)
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={settings.horizonYears}
                    onChange={(e) => {
                      const n = readNumber(e);
                      if (n !== null)
                        updateSettings(
                          'horizonYears',
                          Math.min(30, Math.max(1, Math.round(n))),
                        );
                    }}
                  />
                </label>
                <label>
                  Инфляция % / год
                  <input
                    type="number"
                    step="0.1"
                    value={settings.annualInflationPercent}
                    onChange={(e) => {
                      const n = readNumber(e);
                      if (n !== null) updateSettings('annualInflationPercent', n);
                    }}
                  />
                </label>
              </div>
            </section>

            <section className="panel">
              <h2>Параметры сценариев</h2>
              <p className="hint">
                Меняйте цифры — график сверху пересчитается. Ставка вклада только
                в профиле.
              </p>
              <div className="scenario-list">
                <p className="group-title">Своего жилья ещё нет</p>
                {offplan && (
                  <article className="scenario">
                    <header>
                      <h3>Ипотека на новостройку + аренда до сдачи</h3>
                      <span className="tag">новостройка</span>
                    </header>
                    <div className="fields two">
                      <label>
                        Цена лота
                        <input
                          type="number"
                          value={offplan.propertyPrice}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('no_home', 'offplan', {
                                type: 'offplan_mortgage',
                                propertyPrice: n,
                              });
                          }}
                        />
                      </label>
                      <label>
                        Первый взнос
                        <input
                          type="number"
                          value={offplan.downPayment}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('no_home', 'offplan', {
                                type: 'offplan_mortgage',
                                downPayment: n,
                              });
                          }}
                        />
                      </label>
                      <label>
                        Ставка ипотеки % / год
                        <input
                          type="number"
                          step="0.1"
                          value={offplan.annualRatePercent}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('no_home', 'offplan', {
                                type: 'offplan_mortgage',
                                annualRatePercent: n,
                              });
                          }}
                        />
                      </label>
                      <label>
                        Срок (лет)
                        <input
                          type="number"
                          value={offplan.termYears}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('no_home', 'offplan', {
                                type: 'offplan_mortgage',
                                termYears: Math.max(1, Math.round(n)),
                              });
                          }}
                        />
                      </label>
                      <label>
                        Месяцев до сдачи дома
                        <input
                          type="number"
                          value={offplan.monthsUntilHandover}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('no_home', 'offplan', {
                                type: 'offplan_mortgage',
                                monthsUntilHandover: Math.max(0, Math.round(n)),
                              });
                          }}
                        />
                      </label>
                      <label>
                        Срок аренды (месяцев)
                        <input
                          type="number"
                          value={offplan.rentMonths}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('no_home', 'offplan', {
                                type: 'offplan_mortgage',
                                rentMonths: Math.max(0, Math.round(n)),
                              });
                          }}
                        />
                      </label>
                      <label>
                        Аренда / мес
                        <input
                          type="number"
                          value={offplan.monthlyRentUntilMoveIn}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('no_home', 'offplan', {
                                type: 'offplan_mortgage',
                                monthlyRentUntilMoveIn: n,
                              });
                          }}
                        />
                      </label>
                      <label>
                        Рост цены жилья % / год
                        <input
                          type="number"
                          step="0.1"
                          value={offplan.annualAppreciationPercent}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('no_home', 'offplan', {
                                type: 'offplan_mortgage',
                                annualAppreciationPercent: n,
                              });
                          }}
                        />
                      </label>
                      <label>
                        Разовый заезд в аренду
                        <input
                          type="number"
                          value={offplan.moveInCost}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('no_home', 'offplan', {
                                type: 'offplan_mortgage',
                                moveInCost: n,
                              });
                          }}
                        />
                      </label>
                    </div>
                  </article>
                )}

                {rentSave && (
                  <article className="scenario">
                    <header>
                      <h3>Снимать и копить во вкладе</h3>
                      <span className="tag">аренда</span>
                    </header>
                    <div className="fields two">
                      <label>
                        Аренда / мес
                        <input
                          type="number"
                          value={rentSave.monthlyRent}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('no_home', 'rent_save', {
                                type: 'rent_and_save',
                                monthlyRent: n,
                              });
                          }}
                        />
                      </label>
                      <label>
                        Разовый заезд
                        <input
                          type="number"
                          value={rentSave.moveInCost}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('no_home', 'rent_save', {
                                type: 'rent_and_save',
                                moveInCost: n,
                              });
                          }}
                        />
                      </label>
                    </div>
                  </article>
                )}

                <p className="group-title">Своё жильё уже есть</p>
                {buyToLet && (
                  <article className="scenario">
                    <header>
                      <h3>Ипотека на вторичку и сразу сдавать</h3>
                      <span className="tag">сдача</span>
                    </header>
                    <div className="fields two">
                      <label>
                        Цена квартиры
                        <input
                          type="number"
                          value={buyToLet.propertyPrice}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('has_home', 'buy_to_let', {
                                type: 'buy_to_let_mortgage',
                                propertyPrice: n,
                              });
                          }}
                        />
                      </label>
                      <label>
                        Первый взнос
                        <input
                          type="number"
                          value={buyToLet.downPayment}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('has_home', 'buy_to_let', {
                                type: 'buy_to_let_mortgage',
                                downPayment: n,
                              });
                          }}
                        />
                      </label>
                      <label>
                        Ставка ипотеки % / год
                        <input
                          type="number"
                          step="0.1"
                          value={buyToLet.annualRatePercent}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('has_home', 'buy_to_let', {
                                type: 'buy_to_let_mortgage',
                                annualRatePercent: n,
                              });
                          }}
                        />
                      </label>
                      <label>
                        Срок (лет)
                        <input
                          type="number"
                          value={buyToLet.termYears}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('has_home', 'buy_to_let', {
                                type: 'buy_to_let_mortgage',
                                termYears: Math.max(1, Math.round(n)),
                              });
                          }}
                        />
                      </label>
                      <label>
                        Аренда от сдачи / мес
                        <input
                          type="number"
                          value={buyToLet.monthlyRentIncome}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('has_home', 'buy_to_let', {
                                type: 'buy_to_let_mortgage',
                                monthlyRentIncome: n,
                              });
                          }}
                        />
                      </label>
                      <label>
                        Рост цены жилья % / год
                        <input
                          type="number"
                          step="0.1"
                          value={buyToLet.annualAppreciationPercent}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('has_home', 'buy_to_let', {
                                type: 'buy_to_let_mortgage',
                                annualAppreciationPercent: n,
                              });
                          }}
                        />
                      </label>
                    </div>
                  </article>
                )}

                {saveThenBuy && (
                  <article className="scenario">
                    <header>
                      <h3>Копить во вкладе, потом купить за наличные</h3>
                      <span className="tag">накопление</span>
                    </header>
                    <div className="fields two">
                      <label>
                        Целевая цена квартиры
                        <input
                          type="number"
                          value={saveThenBuy.targetPropertyPrice}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('has_home', 'save_then_buy', {
                                type: 'save_then_buy',
                                targetPropertyPrice: n,
                              });
                          }}
                        />
                      </label>
                      <label>
                        Рост цены жилья % / год
                        <input
                          type="number"
                          step="0.1"
                          value={saveThenBuy.annualPriceGrowthPercent}
                          onChange={(e) => {
                            const n = readNumber(e);
                            if (n !== null)
                              patchScenarioEvent('has_home', 'save_then_buy', {
                                type: 'save_then_buy',
                                annualPriceGrowthPercent: n,
                              });
                          }}
                        />
                      </label>
                    </div>
                  </article>
                )}
              </div>
            </section>
          </div>
        </div>

      <p className="footer-note">
        MVP · см. <code>finance-planner/docs/MVP.md</code>
      </p>
    </div>
  );
}
