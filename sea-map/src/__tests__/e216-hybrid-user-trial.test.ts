/**
 * E2.16 — Hybrid router user-facing labels (no algorithm changes).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  hybridEnabledFromSearchParams,
  isHybridWaterGraphEnabled,
  statusWithRouterSource,
  userRouterSourceFromHybrid,
  userRouterSourceLabelEn,
  userRouterSourceLabelRu,
} from '../hybrid-router-ui';
import {
  getRouteFeatureFlags,
  resetRouteFeatureFlags,
  setRouteFeatureFlagsForTests,
} from '../route-feature-flags';
import type { RouteTraceHybridRouter } from '../route-trace';
import { legacyHybridDiag } from '../watergraph-hybrid-router';

afterEach(() => {
  resetRouteFeatureFlags();
});

function hybridDiag(
  partial: Partial<RouteTraceHybridRouter>,
): RouteTraceHybridRouter {
  return {
    ...legacyHybridDiag(),
    routerMode: 'hybrid_pilot',
    waterGraphAttempted: true,
    ...partial,
  };
}

describe('E2.16 Hybrid router user trial UI', () => {
  it('USE_WATER_GRAPH defaults to false (production)', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
    expect(isHybridWaterGraphEnabled()).toBe(false);
  });

  it('?wg=1 and ?useWaterGraph=1 enable hybrid from query', () => {
    expect(hybridEnabledFromSearchParams('?wg=1')).toBe(true);
    expect(hybridEnabledFromSearchParams('?useWaterGraph=1')).toBe(true);
    expect(hybridEnabledFromSearchParams('?wg=0')).toBe(false);
    expect(hybridEnabledFromSearchParams('')).toBe(false);
  });

  it('maps hybridRouter to WaterGraph / BRouter fallback / not built', () => {
    expect(
      userRouterSourceFromHybrid(
        hybridDiag({ selectedRouter: 'watergraph', fallbackUsed: false }),
        true,
      ),
    ).toBe('watergraph');
    expect(
      userRouterSourceFromHybrid(
        hybridDiag({
          selectedRouter: 'brouter',
          fallbackUsed: true,
          fallbackReason: 'watergraph_terminal_unbound:x',
        }),
        true,
      ),
    ).toBe('brouter_fallback');
    expect(
      userRouterSourceFromHybrid(
        hybridDiag({ selectedRouter: 'none', fallbackUsed: true }),
        false,
      ),
    ).toBe('not_built');
    expect(userRouterSourceFromHybrid(legacyHybridDiag(), true)).toBe('legacy');
  });

  it('user labels stay coarse (no diagnostic fields)', () => {
    expect(userRouterSourceLabelRu('watergraph')).toBe('WaterGraph');
    expect(userRouterSourceLabelRu('brouter_fallback')).toBe(
      'BRouter (запасной)',
    );
    expect(userRouterSourceLabelRu('not_built')).toBe('маршрут не построен');
    expect(userRouterSourceLabelEn('brouter_fallback')).toBe(
      'BRouter fallback',
    );
    expect(userRouterSourceLabelEn('watergraph')).not.toMatch(
      /graphBuildMs|snap_empty|component/i,
    );
  });

  it('status appends router only when hybrid flag is on', () => {
    resetRouteFeatureFlags();
    expect(
      statusWithRouterSource(
        'Готово: 2 точ.',
        hybridDiag({ selectedRouter: 'watergraph' }),
        true,
      ),
    ).toBe('Готово: 2 точ.');

    setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
    expect(
      statusWithRouterSource(
        'Готово: 2 точ.',
        hybridDiag({ selectedRouter: 'watergraph', fallbackUsed: false }),
        true,
      ),
    ).toBe('Готово: 2 точ. · маршрутизатор: WaterGraph');
    expect(
      statusWithRouterSource(
        'Водный маршрут не найден',
        hybridDiag({ selectedRouter: 'none', fallbackUsed: true }),
        false,
      ),
    ).toBe(
      'Водный маршрут не найден · маршрутизатор: маршрут не построен',
    );
    expect(
      statusWithRouterSource(
        'Готово: 2 точ.',
        hybridDiag({
          selectedRouter: 'brouter',
          fallbackUsed: true,
        }),
        true,
      ),
    ).toBe('Готово: 2 точ. · маршрутизатор: BRouter (запасной)');
  });
});
