# E9 — AquaRoute WaterGraph integration pilot

Connect the **PostGIS WaterGraph** (E5–E8) to AquaRoute **only** behind the existing explicit pilot flag.

**Production default unchanged:** `USE_WATER_GRAPH=false`.

---

## How to enable the pilot

| Method | How |
|--------|-----|
| Query | `?wg=1` or `?useWaterGraph=1` |
| DEV panel | checkbox “Hybrid WaterGraph (пилот)” |
| Tests | `setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true })` |

Example Belomor trial URL (local Vite):

```
/?wg=1&mode=water&route=34.82,62.86;34.77,64.52
```

With flag **off**, AquaRoute is identical to pre-E9 (legacy Phase A/B/C / BRouter).

---

## Flow

```
USE_WATER_GRAPH=false  →  legacy BRouter/Overpass only

USE_WATER_GRAPH=true
  → PostGIS WG provider (NAVIGABLE-only snapshot; Belomor corridor)
  → validateWaterRoute (+ hydro / barrier checks)
  → if OK: use WaterGraph path (centerlineSource=postgis_watergraph)
  → else: other WG candidates (relation/mask/Overpass) then BRouter fallback
```

- **UNKNOWN / BLOCKED edges are never routed**
- Exact E1 node ids from export — no proximity/name seams, no crossing links
- VB gap not crossed; Volga↔Akhtuba not sewn; Ladoga rings not used as centerline

---

## Provider

| Piece | Path |
|-------|------|
| Adapter | `sea-map/src/postgis-watergraph-provider.ts` |
| Snapshot | `sea-map/src/__fixtures__/postgis-watergraph/belomor-navigable.json` |
| Wire | early step in `attemptWaterGraphRoute` (`watergraph-hybrid-router.ts`) |
| Flag | `USE_WATER_GRAPH` in `route-feature-flags.ts` (default **false**) |
| Export | `water-data/ingest/e9_export_postgis_wg_pilot.py` |

Snapshot = Belomor subgraph from PostGIS after E8 classification (29× NAVIGABLE). Does **not** duplicate graph build — reuses E5–E8 edges/nodes.

Refresh fixture (local PostGIS):

```bash
cd water-data
python3 ingest/e8_navigation_semantics.py --json-out data/e8_navigation_semantics.json
python3 ingest/e9_export_postgis_wg_pilot.py \
  --out ../sea-map/src/__fixtures__/postgis-watergraph/belomor-navigable.json
```

---

## Belomor result (pilot)

| Field | Value |
|-------|------:|
| edges | **29** NAVIGABLE |
| length | ~**217 km** |
| selectedRouter | `watergraph` |
| centerlineSource | `postgis_watergraph` |
| fallbackUsed | false |

---

## Fallback

If PostGIS WG has no safe NAVIGABLE path (or terminals unbound), hybrid falls through to other WG candidates then **legacy BRouter** (`fallbackUsed=true`). Production path with flag off never enters this branch.

---

## Regressions (tests)

| Case | Expect |
|------|--------|
| flag=false | `routerMode=legacy`, no WG attempt |
| Belomor + flag=true | PostGIS WG route |
| WG forced miss | `selectedRouter=brouter`, fallback |
| UNKNOWN injected | route refused |
| VB gap | not crossed |
| Volga/Akhtuba | no shared NAVIGABLE nodes |

`src/__tests__/e9-postgis-wg-pilot.test.ts`

---

## Explicit non-goals

- Production enable (`USE_WATER_GRAPH` stays false)
- Frontend redesign / new routing API
- Russia-wide graph / coverage optimization
- Canonical DB mutation / PBF download
