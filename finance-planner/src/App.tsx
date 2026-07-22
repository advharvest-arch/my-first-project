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

const STORAGE_KEY = 'esli-finance-mvp-v3';

type StoredState = {
  mode: HousingMode;
  profile: BaselineProfile;
  settings: ProjectionSettings;
  scenariosByMode: Record<HousingMode, Scenario[]>;
};

function defaultStore(): StoredState {
  return {
    mode: 'no_home',
    profile: DEFAULT_PROFILE,
    settings: DEFAULT_SETTINGS,
    scenariosByMode: {
      no_home: buildScenariosForMode('no_home'),
      has_home: buildScenariosForMode('has_home'),
    },
  };
}

function loadState(): StoredState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultStore();
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    const base = defaultStore();
    return {
      mode: parsed.mode === 'has_home' ? 'has_home' : 'no_home',
      profile: { ...base.profile, ...parsed.profile },
      settings: { ...base.settings, ...parsed.settings },
      scenariosByMode: {
        no_home: parsed.scenariosByMode?.no_home?.length
          ? parsed.scenariosByMode.no_home
          : base.scenariosByMode.no_home,
        has_home: parsed.scenariosByMode?.has_home?.length
          ? parsed.scenariosByMode.has_home
          : base.scenariosByMode.has_home,
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

function numberFromInput(value: string): number {
  const cleaned = value.replace(/\s/g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

const COLORS = ['#e8c47a', '#7dcea0', '#7eb6e8', '#d4a5e8'];

export default function App() {
  const initial = useMemo(() => loadState(), []);
  const [mode, setMode] = useState<HousingMode>(initial.mode);
  const [profile, setProfile] = useState<BaselineProfile>(initial.profile);
  const [settings, setSettings] = useState<ProjectionSettings>(initial.settings);
  const [scenariosByMode, setScenariosByMode] = useState(initial.scenariosByMode);
  const [started, setStarted] = useState(false);

  const scenarios = scenariosByMode[mode];

  const results: ScenarioResult[] = useMemo(
    () => scenarios.map((s) => projectScenario(profile, s, settings)),
    [profile, scenarios, settings],
  );

  const verdict = useMemo(() => compareScenarios(results), [results]);

  function persist(
    nextMode = mode,
    nextProfile = profile,
    nextSettings = settings,
    nextMap = scenariosByMode,
  ) {
    const payload: StoredState = {
      mode: nextMode,
      profile: nextProfile,
      settings: nextSettings,
      scenariosByMode: nextMap,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  function updateProfile<K extends keyof BaselineProfile>(
    key: K,
    value: BaselineProfile[K],
  ) {
    const next = { ...profile, [key]: value };
    setProfile(next);
    persist(mode, next, settings, scenariosByMode);
  }

  function updateSettings<K extends keyof ProjectionSettings>(
    key: K,
    value: ProjectionSettings[K],
  ) {
    const next = { ...settings, [key]: value };
    setSettings(next);
    persist(mode, profile, next, scenariosByMode);
  }

  function switchMode(nextMode: HousingMode) {
    setMode(nextMode);
    persist(nextMode, profile, settings, scenariosByMode);
  }

  function patchScenarioEvent(
    scenarioId: string,
    patch: Partial<ScenarioEvent> & { type: ScenarioEvent['type'] },
  ) {
    const nextMap = {
      ...scenariosByMode,
      [mode]: scenariosByMode[mode].map((s) => {
        if (s.id !== scenarioId) return s;
        const current = s.events[0];
        if (!current || current.type !== patch.type) return s;
        return { ...s, events: [{ ...current, ...patch } as ScenarioEvent] };
      }),
    };
    setScenariosByMode(nextMap);
    persist(mode, profile, settings, nextMap);
  }

  function onMoney(
    setter: (n: number) => void,
  ): (e: ChangeEvent<HTMLInputElement>) => void {
    return (e) => setter(numberFromInput(e.target.value));
  }

  function resetExample() {
    const next = defaultStore();
    setMode(next.mode);
    setProfile(next.profile);
    setSettings(next.settings);
    setScenariosByMode(next.scenariosByMode);
    persist(next.mode, next.profile, next.settings, next.scenariosByMode);
    setStarted(true);
  }

  const offplan = scenarios
    .find((s) => s.id === 'offplan')
    ?.events[0] as OffplanMortgageEvent | undefined;
  const rentSave = scenarios
    .find((s) => s.id === 'rent_save')
    ?.events[0] as RentAndSaveEvent | undefined;
  const buyToLet = scenarios
    .find((s) => s.id === 'buy_to_let')
    ?.events[0] as BuyToLetMortgageEvent | undefined;
  const saveThenBuy = scenarios
    .find((s) => s.id === 'save_then_buy')
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
        {!started && (
          <div className="cta-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setStarted(true)}
            >
              Смоделировать
            </button>
            <button type="button" className="btn btn-ghost" onClick={resetExample}>
              Пример с цифрами
            </button>
          </div>
        )}
      </header>

      {started && (
        <div className="layout">
          <div className="stack">
            <section className="panel">
              <h2>Ваша ситуация</h2>
              <p className="hint">Сначала выберите, есть ли уже своё жильё.</p>
              <div className="cta-row">
                <button
                  type="button"
                  className={`btn ${mode === 'no_home' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => switchMode('no_home')}
                >
                  Своего жилья ещё нет
                </button>
                <button
                  type="button"
                  className={`btn ${mode === 'has_home' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => switchMode('has_home')}
                >
                  Своё жильё уже есть
                </button>
              </div>
            </section>

            <section className="panel">
              <h2>Профиль</h2>
              <p className="hint">
                Расходы — без аренды и ипотеки. Доход уже чистый после налогов.
              </p>
              <div className="fields two">
                <label>
                  Возраст
                  <input
                    type="number"
                    value={profile.currentAge}
                    onChange={onMoney((n) => updateProfile('currentAge', n))}
                  />
                </label>
                <label>
                  Чистый доход / мес
                  <input
                    type="number"
                    value={profile.monthlyNetIncome}
                    onChange={onMoney((n) =>
                      updateProfile('monthlyNetIncome', n),
                    )}
                  />
                </label>
                <label>
                  Расходы без жилья / мес
                  <input
                    type="number"
                    value={profile.monthlyExpenses}
                    onChange={onMoney((n) =>
                      updateProfile('monthlyExpenses', n),
                    )}
                  />
                </label>
                <label>
                  Кэш + накопления
                  <input
                    type="number"
                    value={profile.liquidAssets}
                    onChange={onMoney((n) => updateProfile('liquidAssets', n))}
                  />
                </label>
                <label>
                  Горизонт (лет)
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={settings.horizonYears}
                    onChange={onMoney((n) =>
                      updateSettings(
                        'horizonYears',
                        Math.min(30, Math.max(1, Math.round(n))),
                      ),
                    )}
                  />
                </label>
                <label>
                  Доходность капитала % / год
                  <input
                    type="number"
                    step="0.1"
                    value={settings.annualInvestmentReturnPercent}
                    onChange={onMoney((n) =>
                      updateSettings('annualInvestmentReturnPercent', n),
                    )}
                  />
                </label>
                <label>
                  Инфляция % / год
                  <input
                    type="number"
                    step="0.1"
                    value={settings.annualInflationPercent}
                    onChange={onMoney((n) =>
                      updateSettings('annualInflationPercent', n),
                    )}
                  />
                </label>
              </div>
            </section>

            <section className="panel">
              <h2>Сценарии</h2>
              <p className="hint">
                {mode === 'no_home'
                  ? 'Два пути без собственного жилья сейчас.'
                  : 'Два пути, когда жить уже есть где — решаете про инвестицию.'}
              </p>
              <div className="scenario-list">
                {mode === 'no_home' && offplan && (
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
                          onChange={onMoney((n) =>
                            patchScenarioEvent('offplan', {
                              type: 'offplan_mortgage',
                              propertyPrice: n,
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Первый взнос
                        <input
                          type="number"
                          value={offplan.downPayment}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('offplan', {
                              type: 'offplan_mortgage',
                              downPayment: n,
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Ставка ипотеки % / год
                        <input
                          type="number"
                          step="0.1"
                          value={offplan.annualRatePercent}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('offplan', {
                              type: 'offplan_mortgage',
                              annualRatePercent: n,
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Срок (лет)
                        <input
                          type="number"
                          value={offplan.termYears}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('offplan', {
                              type: 'offplan_mortgage',
                              termYears: Math.max(1, Math.round(n)),
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Месяцев до сдачи дома
                        <input
                          type="number"
                          value={offplan.monthsUntilHandover}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('offplan', {
                              type: 'offplan_mortgage',
                              monthsUntilHandover: Math.max(0, Math.round(n)),
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Аренда до переезда / мес
                        <input
                          type="number"
                          value={offplan.monthlyRentUntilMoveIn}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('offplan', {
                              type: 'offplan_mortgage',
                              monthlyRentUntilMoveIn: n,
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Рост цены жилья % / год
                        <input
                          type="number"
                          step="0.1"
                          value={offplan.annualAppreciationPercent}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('offplan', {
                              type: 'offplan_mortgage',
                              annualAppreciationPercent: n,
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Разовый заезд в аренду
                        <input
                          type="number"
                          value={offplan.moveInCost}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('offplan', {
                              type: 'offplan_mortgage',
                              moveInCost: n,
                            }),
                          )}
                        />
                      </label>
                    </div>
                  </article>
                )}

                {mode === 'no_home' && rentSave && (
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
                          onChange={onMoney((n) =>
                            patchScenarioEvent('rent_save', {
                              type: 'rent_and_save',
                              monthlyRent: n,
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Ставка вклада % / год
                        <input
                          type="number"
                          step="0.1"
                          value={rentSave.bankDepositAnnualRatePercent}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('rent_save', {
                              type: 'rent_and_save',
                              bankDepositAnnualRatePercent: n,
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Разовый заезд
                        <input
                          type="number"
                          value={rentSave.moveInCost}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('rent_save', {
                              type: 'rent_and_save',
                              moveInCost: n,
                            }),
                          )}
                        />
                      </label>
                    </div>
                  </article>
                )}

                {mode === 'has_home' && buyToLet && (
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
                          onChange={onMoney((n) =>
                            patchScenarioEvent('buy_to_let', {
                              type: 'buy_to_let_mortgage',
                              propertyPrice: n,
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Первый взнос
                        <input
                          type="number"
                          value={buyToLet.downPayment}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('buy_to_let', {
                              type: 'buy_to_let_mortgage',
                              downPayment: n,
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Ставка ипотеки % / год
                        <input
                          type="number"
                          step="0.1"
                          value={buyToLet.annualRatePercent}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('buy_to_let', {
                              type: 'buy_to_let_mortgage',
                              annualRatePercent: n,
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Срок (лет)
                        <input
                          type="number"
                          value={buyToLet.termYears}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('buy_to_let', {
                              type: 'buy_to_let_mortgage',
                              termYears: Math.max(1, Math.round(n)),
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Аренда от сдачи / мес
                        <input
                          type="number"
                          value={buyToLet.monthlyRentIncome}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('buy_to_let', {
                              type: 'buy_to_let_mortgage',
                              monthlyRentIncome: n,
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Рост цены жилья % / год
                        <input
                          type="number"
                          step="0.1"
                          value={buyToLet.annualAppreciationPercent}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('buy_to_let', {
                              type: 'buy_to_let_mortgage',
                              annualAppreciationPercent: n,
                            }),
                          )}
                        />
                      </label>
                    </div>
                  </article>
                )}

                {mode === 'has_home' && saveThenBuy && (
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
                          onChange={onMoney((n) =>
                            patchScenarioEvent('save_then_buy', {
                              type: 'save_then_buy',
                              targetPropertyPrice: n,
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Ставка вклада % / год
                        <input
                          type="number"
                          step="0.1"
                          value={saveThenBuy.bankDepositAnnualRatePercent}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('save_then_buy', {
                              type: 'save_then_buy',
                              bankDepositAnnualRatePercent: n,
                            }),
                          )}
                        />
                      </label>
                      <label>
                        Рост цены жилья % / год
                        <input
                          type="number"
                          step="0.1"
                          value={saveThenBuy.annualPriceGrowthPercent}
                          onChange={onMoney((n) =>
                            patchScenarioEvent('save_then_buy', {
                              type: 'save_then_buy',
                              annualPriceGrowthPercent: n,
                            }),
                          )}
                        />
                      </label>
                    </div>
                  </article>
                )}
              </div>
            </section>
          </div>

          <section className="panel">
            <h2>Сравнение</h2>
            <p className="hint">
              Net worth = накопления + капитал в жилье − долги.
            </p>
            <div className="verdict">{verdict.message}</div>
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
                const best = Math.max(...results.map((x) => x.finalNetWorth));
                const delta = r.finalNetWorth - best;
                const cls =
                  delta === 0 ? 'delta-pos' : delta < 0 ? 'delta-neg' : '';
                return (
                  <div className="delta-row" key={r.scenarioId}>
                    <span>{r.scenarioName}</span>
                    <span className={cls}>
                      {formatRub(r.finalNetWorth)}
                      {delta < 0 && <> (−{formatRub(Math.abs(delta))})</>}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="assumptions">
              Допущения: доход чистый; новостройка — ипотека с первого месяца и
              аренда до сдачи; вторичка под сдачу даёт арендный поток; накопление
              покупает квартиру, когда вклад догоняет цену (цена тоже растёт). Не
              финансовый совет.
            </p>
          </section>
        </div>
      )}

      <p className="footer-note">
        MVP · см. <code>finance-planner/docs/MVP.md</code>
      </p>
    </div>
  );
}
