# E2 DATA_PILOT (research only)

Prove: Russian ENC S-57 objects can map into AquaRoute WaterGraph types.

**Does not** change Phase A–D, E0 RouteTrace, E1 masks, safety thresholds, or production routing.

## Quick start

```bash
cd sea-map
npx tsx research/data-pilot/run-pilot.ts
npm test -- src/__tests__/data-pilot.test.ts
```

## Layout

| Path | Role |
| --- | --- |
| `types.ts` | S-57 + WaterGraph research types + mapping table |
| `parse-s57-json.ts` | JSON stand-in for S-57 parse |
| `water-graph-adapter.ts` | normalize → WaterGraph layers |
| `fixtures/synthetic-volga-pilot.json` | fake Rybinsk→NN ENC |
| `docs/` | report, contacts, mapping, AI signals |

Real licensed S-57 cells are **not** in this repo.
