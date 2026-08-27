# E2.1 — Open Water Centerline Ingest

**Status:** E2.1_READY (shadow ingest). Production **UNCHANGED** (`USE_WATER_GRAPH=false`).

## What shipped

| Module | Role |
| --- | --- |
| `src/water-graph-ingest.ts` | Overpass/GeoJSON → `CenterlineSource[]`, corridor crop, provenance |
| Fixtures | `src/__fixtures__/centerlines/{lower-volga,lower-volga-mid,belomor}.geojson` |
| Shadow wire | `measureWaterChain` → async `emitDone` ingests OSM before graph build |

## Ingest rules

- Allowed: river, canal, ship_canal, fairway, link, tidal_channel, named stream
- Blocked as centerline: dam, weir, waterfall, riverbank (crest ≠ edge)
- Crop to corridor bbox (`padDeg=0.35`, ≠ user snap)
- Long-span: segment + **mid-segment ingest by default** (stitching later)
- Same-`waterId` dedupe only; no nearest-node cross-water connect
- BRouter/legacy geometry used only if OSM ingest empty (fallback provider)

## Failure codes

| Code | Meaning |
| --- | --- |
| `centerline_missing` | No OSM/features loaded |
| `centerline_empty_after_filter` | Features loaded but all rejected/cropped |
| `terminal_unbound` | A/B not bound |
| `graph_disconnected` | Multi-component, no path |
| `search_no_path` | Search failed |

## Provenance (RouteTrace.graph)

`centerlineSource`, `sourceFeatureCount`, `sourceWaterwayIds`, `osmFeatureCount`, accept/reject counts, `corridorBbox`, `dataTimestampMs`, `provenanceSources`.

## Production

`USE_WATER_GRAPH` remains **false**. Shadow never changes returned path.

## Recommendation

Do **not** jump to E2.2 until this report is reviewed. Next candidate: live Overpass agree% on VG-D mid + Belomor segments, then optional lock portals for Belomor staircase.
