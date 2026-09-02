# E2.1 — Belomor WaterGraph (after centerline ingest)

**Mode:** shadow. Fixture: OSM-structured canal centerlines (`belomor.geojson`). No manual fairway.

## Corridor

| Segment | Approx |
| --- | --- |
| South | ~62.7–63.2N @ 34.8E |
| Mid | ~63.2–63.9N |
| North | ~64.0–64.6N (weak BRouter zone) |

## Graph (fixture ingest)

| Metric | Result |
| --- | --- |
| `failureStage` | **not** `centerline_missing` |
| Edge kinds | `canal` edges present |
| Components | ≥1; north gap in fixture can show **disconnected** north tip |
| Lock portals | Still **missing** Belomor staircase (Dubna/Rybinsk only) |

## Interpretation

| Question | Answer |
| --- | --- |
| OSM canal in graph? | **Yes** (after ingest) |
| Connected end-to-end? | Not guaranteed — gaps / missing locks visible via components |
| DATA_GAP vs DISCONNECTED | Distinguishes `centerline_missing` from `graph_disconnected` |

## Remaining issues

1. Belomor lock chambers not modeled as `lock` portals.
2. North segment historically weak in BRouter — graph can still be torn.
3. Live Overpass required for production-shadow diagnostics outside fixtures.

## Production

UNCHANGED. No Belomor routing crutches.
