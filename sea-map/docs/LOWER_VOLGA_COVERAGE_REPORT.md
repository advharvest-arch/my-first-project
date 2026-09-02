# E1.6 — Нижняя Волга (Волгоград → Астрахань)

**Constraint:** no artificial fairway without proven geometry; do not raise span limits for the test.

## Corridor split (diagnostic)

| Segment | Approx A → B | Intent |
| --- | --- | --- |
| VG-A | Volgograd → ~50–100 km downstream | Local snap / BRouter quality |
| VG-B | Mid lower Volga | Island / branch ambiguity |
| VG-C | ~50–100 km before Astrakhan | Delta approach |
| VG-D | Volgograd → Astrakhan full | Long-span policy |

Coordinates used in probes (water-oriented):

- Volgograd water: ~44.52, 48.70
- Mid: ~45.2–46.1, 47.1–47.8
- Astrakhan water: ~48.02, 46.36

## OSM

Lower Volga `waterway=river` geometry exists along the corridor (OSM). Not a total absence of waterway data. Branching (Akhtuba / delta) increases snap ambiguity near Astrakhan.

## BRouter (`profile=river`)

| Case | Typical result |
| --- | --- |
| VG-A | Endpoint-sensitive; shore/city clicks → short/bogus tracks or weak geometry |
| VG-B | Can return HTTP 400 `target island detected` on poor snaps |
| VG-C | Often OK (~30 km, ratio ~1.25) |
| VG-D | **OK with good water clicks** (~456–460 km, ratio ~1.23–1.25) |

## AquaRoute stages

| Stage | Role on VG-D |
| --- | --- |
| Snap / candidates | Critical — city centers fail; river clicks succeed |
| Phase A | Usually no shared open-lake mask for this river span |
| Phase B | Primary success path when BRouter returns valid track |
| Phase C | Recovery budget if B fails; costly if many trials |
| Overpass | **Skipped** when span > 120 and BRouter path fails (`span_gt_120`) |
| Validator / hydro | Enforce residuals, barriers, STEM-class rejects |
| Fairway | No dedicated Lower Volga curated fairway required when BRouter OK |
| Knowledge | E1.6 `lower_volga` corridor + informational fact (advisory) |

## Root cause summary

**Long-span BRouter dependency + endpoint snap sensitivity**, not “Volga missing from OSM”.

Failure chain when manual A/B land off fairway:

`request → weak snap → BRouter fail/short → span>120 → Overpass skip → span_gt_120 → route_not_found`

## Open Russian data usefulness

| Source | Use |
| --- | --- |
| OSM waterway | Geometry for future WaterGraph centerline |
| KIM / basin PDFs | Depth / seasonal advisories (knowledge only) |
| GVR | Naming / inventory hints |
| ENC / S-57 | **Out of scope** this stage |

## Recommendation

1. Prefer water snaps / candidate binding (already Phase C) — do not raise 120 km.
2. Implement segmented routing design (`LONG_SPAN_DESIGN.md`) behind a flag.
3. Expand advisory knowledge (locks, seasonal) without ranking impact.
4. Hybrid WaterGraph should model main Volga stem vs Akhtuba branches explicitly.
