import { useMemo, useState, type ChangeEvent } from 'react';
import {
  buildDefaultScenarios,
  compareScenarios,
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  projectScenario,
  type BaselineProfile,
  type MortgageEvent,
  type ProjectionSettings,
  type RentAndSaveEvent,
  type Scenario,
  type ScenarioResult,
} from './engine/types';
import { NetWorthChart } from './components/NetWorthChart';

const STORAGE_KEY = 'esli-finance-mvp-v2';

type StoredState = {
  profile: BaselineProfile;
  settings: ProjectionSettings;
  scenarios: Scenario[];
};

function loadState(): StoredState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        profile: DEFAULT_PROFILE,
        settings: DEFAULT_SETTINGS,
        scenarios: buildDefaultScenarios(),
      };
    }
    const parsed = JSON.parse(raw) as StoredState;
    const scenarios = parsed.scenarios?.length
      ? parsed.scenarios
      : buildDefaultScenarios();
    const hasRent = scenarios.some((s) =>
      s.events.some((e) => e.type === 'rent_and_save'),
    );
    return {
      profile: { ...DEFAULT_PROFILE, ...parsed.profile },
      settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
      scenarios: hasRent ? scenarios : buildDefaultScenarios(),
    };
  } catch {
    return {
      profile: DEFAULT_PROFILE,
      settings: DEFAULT_SETTINGS,
      scenarios: buildDefaultScenarios(),
    };
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

const COLORS = ['#e8c47a', '#7dcea0', '#7eb6e8'];

export default function App() {
  const initial = useMemo(() => loadState(), []);
  const [profile, setProfile] = useState<BaselineProfile>(initial.profile);
  const [settings, setSettings] = useState<ProjectionSettings>(initial.settings);
  const [scenarios, setScenarios] = useState<Scenario[]>(initial.scenarios);
  const [started, setStarted] = useState(false);

  const results: ScenarioResult[] = useMemo(
    () => scenarios.map((s) => projectScenario(profile, s, settings)),
    [profile, scenarios, settings],
  );

  const verdict = useMemo(
    () => compareScenarios(results, 'baseline'),
    [results],
  );

  const baselineFinal =
    results.find((r) => r.scenarioId === 'baseline')?.finalNetWorth ?? 0;

  function persist(
    nextProfile = profile,
    nextSettings = settings,
    nextScenarios = scenarios,
  ) {
    const payload: StoredState = {
      profile: nextProfile,
      settings: nextSettings,
      scenarios: nextScenarios,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  function updateProfile<K extends keyof BaselineProfile>(
    key: K,
    value: BaselineProfile[K],
  ) {
    const next = { ...profile, [key]: value };
    setProfile(next);
    persist(next, settings, scenarios);
  }

  function updateSettings<K extends keyof ProjectionSettings>(
    key: K,
    value: ProjectionSettings[K],
  ) {
    const next = { ...settings, [key]: value };
    setSettings(next);
    persist(profile, next, scenarios);
  }

  function updateRentAndSave(patch: Partial<RentAndSaveEvent>) {
    const next = scenarios.map((s) => {
      if (s.id !== 'rent_save') return s;
      const current = s.events.find((e) => e.type === 'rent_and_save') as
        | RentAndSaveEvent
        | undefined;
      const event: RentAndSaveEvent = {
        type: 'rent_and_save',
        startMonth: 0,
        monthlyRent: 55_000,
        bankDepositAnnualRatePercent: 16,
        moveInCost: 0,
        ...current,
        ...patch,
      };
      return { ...s, events: [event] };
    });
    setScenarios(next);
    persist(profile, settings, next);
  }

  function updateMortgage(patch: Partial<MortgageEvent>) {
    const next = scenarios.map((s) => {
      if (s.id !== 'mortgage') return s;
      const current = s.events.find((e) => e.type === 'mortgage') as
        | MortgageEvent
        | undefined;
      const event: MortgageEvent = {
        type: 'mortgage',
        startMonth: 0,
        propertyPrice: 12_000_000,
        downPayment: 2_400_000,
        annualRatePercent: 18,
        termYears: 20,
        annualAppreciationPercent: 5,
        ...current,
        ...patch,
      };
      return { ...s, events: [event] };
    });
    setScenarios(next);
    persist(profile, settings, next);
  }

  function onMoney(
    setter: (n: number) => void,
  ): (e: ChangeEvent<HTMLInputElement>) => void {
    return (e) => setter(numberFromInput(e.target.value));
  }

  const rentSave = scenarios
    .find((s) => s.id === 'rent_save')
    ?.events.find((e) => e.type === 'rent_and_save') as
    | RentAndSaveEvent
    | undefined;
  const mortgage = scenarios
    .find((s) => s.id === 'mortgage')
    ?.events.find((e) => e.type === 'mortgage') as MortgageEvent | undefined;

  return (
    <div className="app">
      <header className="hero">
        <h1 className="brand">
          Если<span>.</span>
        </h1>
        <p className="lede">
          Снимать жильё и копить во вкладе — или взять ипотеку? Считаем капитал
          на 5–10 лет рядом.
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
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setProfile(DEFAULT_PROFILE);
                setSettings(DEFAULT_SETTINGS);
                setScenarios(buildDefaultScenarios());
                persist(
                  DEFAULT_PROFILE,
                  DEFAULT_SETTINGS,
                  buildDefaultScenarios(),
                );
                setStarted(true);
              }}
            >
              Пример с цифрами
            </button>
          </div>
        )}
      </header>

      {started && (
        <div className="layout">
          <div className="stack">
            <section className="panel">
              <h2>Профиль</h2>
              <p className="hint">
                Расходы — без аренды и ипотеки. Жильё задаётся в сценариях.
                Доход — уже чистый после налогов.
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
                Три пути рядом. В сценарии вклада ставка банка перекрывает
                общую доходность капитала.
              </p>
              <div className="scenario-list">
                <article className="scenario">
                  <header>
                    <h3>Ничего не менять</h3>
                    <span className="tag">база</span>
                  </header>
                  <p className="hint" style={{ margin: 0 }}>
                    Без аренды и ипотеки в модели — только текущие расходы и рост
                    капитала.
                  </p>
                </article>

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
                        value={rentSave?.monthlyRent ?? 0}
                        onChange={onMoney((n) =>
                          updateRentAndSave({ monthlyRent: n }),
                        )}
                      />
                    </label>
                    <label>
                      Ставка вклада % / год
                      <input
                        type="number"
                        step="0.1"
                        value={rentSave?.bankDepositAnnualRatePercent ?? 0}
                        onChange={onMoney((n) =>
                          updateRentAndSave({
                            bankDepositAnnualRatePercent: n,
                          }),
                        )}
                      />
                    </label>
                    <label>
                      Разовый заезд (залог и т.п.)
                      <input
                        type="number"
                        value={rentSave?.moveInCost ?? 0}
                        onChange={onMoney((n) =>
                          updateRentAndSave({ moveInCost: n }),
                        )}
                      />
                    </label>
                  </div>
                </article>

                <article className="scenario">
                  <header>
                    <h3>Взять ипотеку</h3>
                    <span className="tag">покупка</span>
                  </header>
                  <div className="fields two">
                    <label>
                      Цена жилья
                      <input
                        type="number"
                        value={mortgage?.propertyPrice ?? 0}
                        onChange={onMoney((n) =>
                          updateMortgage({ propertyPrice: n }),
                        )}
                      />
                    </label>
                    <label>
                      Первый взнос
                      <input
                        type="number"
                        value={mortgage?.downPayment ?? 0}
                        onChange={onMoney((n) =>
                          updateMortgage({ downPayment: n }),
                        )}
                      />
                    </label>
                    <label>
                      Ставка ипотеки % / год
                      <input
                        type="number"
                        step="0.1"
                        value={mortgage?.annualRatePercent ?? 0}
                        onChange={onMoney((n) =>
                          updateMortgage({ annualRatePercent: n }),
                        )}
                      />
                    </label>
                    <label>
                      Срок (лет)
                      <input
                        type="number"
                        value={mortgage?.termYears ?? 0}
                        onChange={onMoney((n) =>
                          updateMortgage({
                            termYears: Math.max(1, Math.round(n)),
                          }),
                        )}
                      />
                    </label>
                    <label>
                      Рост цены жилья % / год
                      <input
                        type="number"
                        step="0.1"
                        value={mortgage?.annualAppreciationPercent ?? 0}
                        onChange={onMoney((n) =>
                          updateMortgage({ annualAppreciationPercent: n }),
                        )}
                      />
                    </label>
                  </div>
                </article>
              </div>
            </section>
          </div>

          <section className="panel">
            <h2>Сравнение</h2>
            <p className="hint">
              Net worth = накопления + капитал в жилье − долги.
            </p>
            <div className="verdict">{verdict.message}</div>
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
                const delta = r.finalNetWorth - baselineFinal;
                const cls =
                  r.scenarioId === 'baseline'
                    ? ''
                    : delta >= 0
                      ? 'delta-pos'
                      : 'delta-neg';
                return (
                  <div className="delta-row" key={r.scenarioId}>
                    <span>{r.scenarioName}</span>
                    <span className={cls}>
                      {formatRub(r.finalNetWorth)}
                      {r.scenarioId !== 'baseline' && (
                        <>
                          {' '}
                          (
                          {delta >= 0 ? '+' : '−'}
                          {formatRub(Math.abs(delta))})
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="assumptions">
              Допущения: доход чистый; в сценарии аренды деньги растут по ставке
              вклада; ипотека — аннуитет; расходы профиля без жилья. Не
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
