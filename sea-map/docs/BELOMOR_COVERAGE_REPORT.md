# E1.6 — Беломорско-Балтийский канал coverage

**Constraint:** no production fairway hardcode; advisory knowledge only.

## 1. OSM geometry

**Present.** Corridor Overpass sample `(62.7–64.7N, 34.2–35.6E)`:

| Tag | Approx count |
| --- | --- |
| `waterway=river` | ~744 |
| `waterway=canal` | ~82 |
| Named `Беломорканал` | ≥30 ways |

Locks appear as canal stairs / lock-tagged nodes in OSM (multi-lock staircase Povenets↔Belomorsk). Exact lock portal graph for AquaRoute is **not** yet modeled (future WaterGraph / lock portals).

## 2. Overpass / AquaRoute query

Current water queries already include `canal`. **Not a type-filter miss.**

## 3. Connectivity / graph

- OSM ways are segment-wise present; a continuous navigable centerline for routing is **provider-dependent**.
- AquaRoute legacy Overpass cell graph is not the primary path for >120 km spans (`span_gt_120`).
- Curated NW vias (`nearNorthwestWaterway`) cap ~**63.0°N** — northern Belomor (~64.5°N) is **outside** the Volga-Baltic NW via box.

## 4. Where routing breaks

| Stage | Observation |
| --- | --- |
| Data fetch | Canal features returned |
| Candidate snap | Works near southern Onega / Povenets; northern end outside NW helpers |
| BRouter full | Often OK (~216 km, ratio ~1.17) |
| BRouter mid | Can return **bogus short** tracks (ratio ≪ 1) → validator reject |
| Phase C | May burn up to 9 trials on bad mid geometry |
| Validator / hydro | Rejects short/bogus / barrier issues when present |
| UI | Shows not-found; not a map “hide canal” bug |

## 5. Data gaps vs routing gaps

| Kind | Detail |
| --- | --- |
| DATA_GAP | No curated Belomor vias / lock portals; NW box incomplete north of 63° |
| ROUTING | BRouter mid-segment quality inconsistent |
| NOT | Missing `waterway=canal` in OSM/Overpass filter |

## 6. Open Russian knowledge (advisory)

E1.6 adds corridor `belomor` + informational fact `info-belomor-corridor-e16` in `open-russian-knowledge.json`.

**Does not** hard-reject or change ranking.

Useful future open sources (no letters/ENC):

- OSM lock/`waterway=canal` densification
- Volgo-Balt / Belomor public basin PDFs (dimensions, seasonal) → knowledge pack only
- GVR names where available

## 7. Recommendation for later stages

1. Extend NW via / WaterGraph coverage north of 63° with **proven** geometry (not test-only stubs).
2. Segmented BRouter along canal centerline (see `LONG_SPAN_DESIGN.md`).
3. Lock portals as first-class graph nodes in Hybrid WaterGraph.
4. Keep knowledge advisory until ENC/official centerline is licensed separately.
