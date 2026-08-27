# E2.0 — Belomor WaterGraph report

**Mode:** shadow diagnostics only. No manual fairway added.

## Setup

Corridor seeds: Povenets-ish → Belomorsk-ish (~62.86N–64.52N, ~34.8E).

Regional fairways: **none** in this bbox (NW vias stop ~63°N; `REGIONAL_FAIRWAYS` are Volga/Topo).

## Graph build (no OSM polylines injected)

| Metric | Result |
| --- | --- |
| Centerline layer | absent unless caller supplies OSM/BRouter samples |
| Fairway layer | absent |
| Lock layer | global Dubna/Rybinsk portals may appear if bbox pad includes them — **not Belomor locks** |
| Components | typically **0 useful Belomor edges** without centerline input |
| `failureStage` (shadow, empty inputs) | `centerline_missing` |

## Interpretation

| Question | Answer |
| --- | --- |
| OSM canal exists? | Yes (E1.6/E1.7 Overpass) |
| AquaRoute graph connected? | **No** until centerline polylines are ingested |
| Missing lock portals? | **Yes** — Belomor staircase not in KNOWN_BARRIERS / lock defs |
| BRouter gaps? | Mid-segment quality flaky (E1.7) |
| DATA_GAP vs DISCONNECTED | Data exists in OSM; **graph disconnected / missing** in AquaRoute |

## Next (E2.1)

1. Feed OSM `waterway=canal` Belomor ways as `CenterlineSource[]` into `buildWaterGraph`.  
2. Model lock chambers as `lock` portals (confirmed passage only).  
3. Re-run component analysis: `connectedComponents`, `largestComponentKm`, dead ends.

## AI signal

`failureStage=centerline_missing` vs future `graph_disconnected` after partial ingest — distinguishes “no geometry loaded” from “geometry loaded but torn”.
