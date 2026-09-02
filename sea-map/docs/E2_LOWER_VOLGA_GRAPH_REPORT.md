# E2.1 — Lower Volga WaterGraph (after centerline ingest)

**Mode:** shadow. Fixture: OSM-structured open centerlines (`lower-volga.geojson`). Live Overpass used at runtime when reachable.

## Corridor

| Segment | A | B |
| --- | --- | --- |
| VG-D | Volgograd ~44.52E 48.7N | Astrakhan ~48.02E 46.36N |
| Mid | ~45.9E 47.75N | ~46.95E 47.0N |
| Branch | Akhtuba LineString in fixture | — |

## Graph (fixture ingest, locks/mask off)

| Metric | VG-D | Mid |
| --- | --- | --- |
| `failureStage` | **not** `centerline_missing` | **not** `centerline_missing` |
| Centerline layer | yes (river) | yes |
| Nodes / edges | >> 0 (see unit test / bench) | >> 0 |
| Components | ≥1; Akhtuba may be separate | ≥1 |
| `largestComponentKm` | tens–hundreds km along stem | mid stretch |

## Interpretation

| Question | Answer |
| --- | --- |
| Still `centerline_missing`? | **No** (with ingest/fixture or live OSM) |
| End-to-end production route? | **Not required** for E2.1 |
| Where graph breaks? | Branch junctions (Akhtuba), long-span mid-only ingest, missing locks |
| Fairway? | Still none on Lower Volga (no hardcoded crutches) |

## Remaining issues (for later analysis)

1. Live Overpass may be unreachable in some CI/cloud egress → fixture proves pipeline; runtime needs Overpass allowlist.
2. Full VG-D shadow currently mid-segment ingest by default (no global graph).
3. No Lower Volga lock portals yet.
4. End-to-end Dijkstra+validator path may still fail → `graph_disconnected` / `validator_reject` are now **diagnosable**.

## Production

UNCHANGED.
