# E2.0 — Lower Volga WaterGraph report

**Mode:** shadow diagnostics. Corridor: Volgograd → Astrakhan (+ mid splits).

## Fairway / centerline availability

| Layer | In corridor? |
| --- | --- |
| `REGIONAL_FAIRWAYS` / VOLGA_NAV | **No** (~700 km away — upper cascade) |
| Lock defs (Dubna/Rybinsk) | **No** |
| OSM river | Yes (external); not auto-ingested in E2.0 builder |
| Legacy BRouter geometry | Often yes on VG-D with good snaps — used as `cl:legacy` when shadow runs after success |

## Shadow without injected OSM

| Stage | Typical |
| --- | --- |
| centerline | missing (no fairway, no legacy yet) |
| terminal bind | unbound / weak |
| `failureStage` | `centerline_missing` or `terminal_unbound` |

## Shadow after successful legacy VG-D

When `USE_WATER_GRAPH=true` and legacy returns a track, shadow injects legacy geometry as brouter centerline:

| Expectation | |
| --- | --- |
| `layers.centerline` | true |
| bind A/B | usually ok near track |
| search | may succeed along densified legacy polyline |
| components | often 1 along the track + global lock islands |

This proves the **pipeline**, not Lower Volga coverage completeness.

## Split diagnostics (targets)

| Segment | What to watch in RouteTrace |
| --- | --- |
| Volgograd → Volzhsky | `centerline_missing` vs bind |
| Mid Lower Volga | island/branch → future multi-component |
| Approach Astrakhan | delta / Akhtuba ambiguity |
| Full VG-D | legacyCompare agree% once OSM centerline ingested |

## Conclusion

Lower Volga problem is **not** “OSM empty”; it is **AquaRoute graph empty** until OpenStreetMap/BRouter polylines are loaded as centerline layers. E2.0 foundation can consume them; E2.1 should ingest them systematically.

## Recommendation

E2.1: corridor Overpass/water-core → `CenterlineSource` for Lower Volga; keep production on legacy until shadow agree% is high on VG-D + mid segments.
