# OPEN_RUSSIAN_KNOWLEDGE_REPORT

E2 advisory knowledge pack diagnostics (**not** routing cost).

## Counts

| Metric | Value |
| --- | --- |
| WaterFacts imported | 49 |
| NavigationEvents imported | 3 |
| Total corpus | 52 |
| With Point geometry | 0 |
| Without geometry | 52 |
| With sourceDate / validFrom | 52 |
| Without date | 0 |

## Sources

kama-dimensions, kim-bulletins

## Basin coverage

{"moscow": 39, "kama": 12, "volga": 1}

## Signal class

{"advisory": 40, "informational": 12}

## Confidence

min=0.7 max=0.85 avg=0.753

## Corridor match preview (primary bbox)

| Corridor sample | Matched facts |
| --- | --- |
| Kim / Moscow canal | 25 |
| Rybinsk / upper Volga | 15 |
| Kama | 12 |
| Oka | 4 |
| Don | 0 |

## Product fitness

- **Useful now:** Kim closures/restrictions + depth advisories; Kama named segments; Rybinsk km restriction event.
- **Weak:** Don — E1.5 catalogued sources, but **0** normalized facts in this pack.
- **Weak:** Volgo-Balt classifiers — metadata only, not route-matched.
- **Geometry gap:** matching via corridor id + primary bbox + river metadata (MVP).

## RouteTrace

`knowledge` attached in `measureWaterChain` `emitDone` — advisory only; no accept/reject / threshold / Phase D ranking change.
