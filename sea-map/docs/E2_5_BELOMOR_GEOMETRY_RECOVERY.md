# E2.5 — Belomor Geometry Recovery Research

**Status:** RESEARCH / DIAGNOSTIC ONLY. `USE_WATER_GRAPH=false`.  
**No seams. No synthetic / interpolated geometry. No production import.**

## Gap (fixture)

| Field | Value |
| --- | --- |
| Start | 34.82E, 63.95N |
| End | 34.79E, 64.12N |
| Length | ≈ **18.96 km** |
| waterId | `ww:беломорско-балтийский канал` |
| Tags | `waterway=canal`, name Беломорско-Балтийский канал |

Deterministic spec: `src/__fixtures__/belomor-recovery/gap-spec.json`.

## Sources checked

| Source | Geometry? | Coverage | Confidence | Notes |
| --- | --- | --- | --- | --- |
| Fixture `belomor.geojson` | No (in gap) | 0 | NONE | Intentional mid tear |
| `water-core.json` | No | 0 | NONE | No Belomor entries |
| `gvr-index.json` | No | 0 | NONE | No local geometry |
| `hydro-index.json` | No | 0 | NONE | — |
| Knowledge Layer | Metadata only | 0 | LOW | Corridor note / lock stair text ≠ geometry |
| **OSM relation 9909116** | **Yes** | ways through gap **latitudes** | **HIGH** | Real canal west of fixture chord |
| Default ingest bbox (pad 0.35°) | N/A | — | MEDIUM | Cuts off lon ≲ 34.42 — misses western swing |

## OSM relation continuity

- **Found:** relation `9909116` (`type=waterway`, `waterway=canal`, `name=Беломорканал`)
- **Members:** 29 `main_stream` ways
- **Covering gap latitudes 63.95–64.12:** ways `1020271530`, `1002946116`, `1020271532`
- Continuity exists on the **real** canal axis (~34.20–34.31E), not on the fixture’s simplified N–S chord at ~34.8E

Snapshot (offline tests): `src/__fixtures__/belomor-recovery/osm-relation-9909116-snapshot.json`.

## Classification

**`FULL_GEOMETRY_FOUND`** · `geometryConfidence: HIGH`

The fixture DATA_GAP is **not** “OSM has a 19 km hole”. It is:

1. Simplified fixture geometry omitting the western lake/canal swing; and  
2. Default corridor ingest bbox too narrow to pull those OSM members.

## Key question

> Можем ли мы получить реальную геометрию Беломорканала из легальных открытых данных без synthetic seam?

**Да.** OSM relation 9909116 already contains the missing stretch. Next stage (if any) should be **relation-aware / wider-bbox centerline ingest** as a diagnostic import candidate — **not** a distance seam and **not** a straight-line fill of the fixture chord.

## Explicitly not done

- No production import of candidate ways  
- No WaterGraph edges / seams  
- No ENC / S-57  
- No routing decision on unverified geometry  

Script: `npx tsx scripts/e25-belomor-geometry-recovery.ts`
