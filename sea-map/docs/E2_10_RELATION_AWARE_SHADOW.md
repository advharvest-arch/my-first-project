# E2.10 — Safe relation-aware WaterGraph shadow (Belomor)

**Status:** SHADOW / DIAGNOSTIC ONLY.  
`USE_WATER_GRAPH` **defaults false** — production routing unchanged.  
No seams, no synthetic geometry, no Volga↔Akhtuba joins, no live production Overpass relation fetch.

Script: `npx tsx scripts/e210-relation-aware-shadow.ts` (`--legacy`, `--with-shadow-flag`)  
Modules: `relation-aware-osm-provider.ts`, `relation-aware-shadow.ts`  
Snapshot: `src/__fixtures__/belomor-recovery/osm-relation-9909116-full-ways.json` (explicit snapshot, not live)

---

## Why

E2.7–E2.9 showed Belomor’s WaterGraph tear is an **ingest/fixture artifact**, not missing OSM. Relation **9909116** restores real geometry. E2.10 is the first **controlled** step: wire that geometry into the **WaterGraph shadow** path only.

## What E2.7–E2.9 proved

| Stage | Result |
| --- | --- |
| E2.7 | Relation-aware → 1 connected Belomor path ~217 km; fixture tear ~18.96 km gone |
| E2.8 | Systemic INGEST_ARTIFACT pattern; Belomor confirmed |
| E2.9 | `35bb549` relation query drop; `65dfe1d` fixture/bbox; historical Belomor OK was BRouter |

## Shadow integration

```
legacy measureWaterChain  ──► returned WaterPath (UNCHANGED)
        │
        └── if USE_WATER_GRAPH (tests/bench only):
              Belomor corridor?
                yes → centerlines from relation-aware provider (snapshot)
                no  → existing Overpass/fixture ingest
              runWaterGraphShadow (same Dijkstra / validator / hydro)
              + runBelomorRelationAwareShadow → RouteTrace.relationAwareShadow
```

- Provider returns relationId, tags, member ways, roles, geometry copies, provenance (`sourceType=osm`, `way/<id>`, `diagnosticOnly`).
- CURRENT fixture graph is compared separately; geometries are **not mixed** without provenance.
- X3 / Volga / Akhtuba / N06–L2 **not** wired.

## Production unchanged

- Default `USE_WATER_GRAPH=false` → shadow block never runs in production.
- Accept/reject, BRouter, Phase A/B/C, validator, hydro, thresholds untouched.
- Graph path never replaces legacy result.

## Metrics (actual diagnostic run)

| | CURRENT | RELATION_AWARE |
| --- | ---: | ---: |
| nodeCount | 114 | 481 |
| edgeCount | 110 | 478 |
| componentCount | 4 | 3 |
| largestComponentKm | ~121.5 | ~219.7 |
| gapCount | 1 (~18.959 km) | 0 |
| Artificial ~19 km gap | **yes** | **no** |
| pathFound (validated) | false | **true ~217.031 km** |
| seamCount | 0 | 0 |
| graphBuildMs / searchMs | ~1 / ~0.3 | ~8 / ~10 |

Component counts include remote lock portals under default shadow options — E2.10 claims the Belomor **artificial tear** is eliminated (not “exactly one global component”).

### Legacy compare (same Belomor request, `USE_WATER_GRAPH=false` for legacy)

| Metric | Value |
| --- | --- |
| legacyOk | true (~215.9 km via BRouter) |
| graph path | ~217.0 km, safety accepted, diagnosticOnly |
| divergenceReason | both_ok_compare_lengths |
| legacyRoutingMs (wall) | ~391 ms (this run) |
| graphShadowMs (CURRENT+RA build/search) | ~20 ms |
| brouterCalls (legacy) | 1 |

Do **not** treat graphSearchMs as UI latency improvement — E2E wall is dominated by legacy routing while the flag stays off.

## Before production enablement

1. Live OSM/Overpass relation fetch policy  
2. Multi-corridor rollout (not Belomor-only)  
3. E2E UI latency with shadow on (not graphSearchMs alone)  
4. Explicit product decision to set `USE_WATER_GRAPH` / promote path  

## Key answers

1. **Safe shadow integration?** Yes — gated, diagnosticOnly, same safety stack.  
2. **Belomor graph DATA_GAP gone?** Yes (artificial fixture tear eliminated; validated path).  
3. **Safety unchanged?** Yes — existing validateWaterRoute + hydro.  
4. **Legacy vs graph?** Legacy remains production; graph is diagnostic compare on RouteTrace.  
5. **BRouter dependency potential?** Exists diagnostically if path validates — **not** a UI latency claim while flag is off.
