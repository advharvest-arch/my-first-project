# E2.8 — Ingest coverage audit

**Status:** DIAGNOSTIC ONLY.  
`USE_WATER_GRAPH=false`. No production relation-aware enablement. No seams. No synthetic geometry.

Script: `npx tsx scripts/e28-ingest-coverage-audit.ts`  
Module: `src/ingest-coverage-audit.ts`  
Evidence: `src/__fixtures__/ingest-audit/e28-osm-evidence.json`

---

## 1. What we checked

For seven control corridors, measure **CURRENT** WaterGraph ingest (fixture and/or fairway shadow), then compare against open OSM evidence (relations/ways/probes, plus E2.7 Belomor full-ways snapshot). Classify each primary discontinuity; estimate **recoverableGeometryKm** of real OSM geometry CURRENT does not use.

## 2. Routes

Belomor · N06 · N08 · L2 · X3 · VG-D · VG-mid (VG-D and VG-mid analyzed separately; Volga↔Akhtuba never treated as proven navigable join).

## 3–5. Where CURRENT loses geometry / OSM missing / objects separate

| route | CURRENT comps | gaps | largestKm | OSM geom? | relation? | ways? | wider helps? | rel-aware helps? | **class** | conf | recoverableKm |
| --- | ---: | ---: | ---: | --- | --- | --- | --- | --- | --- | --- | ---: |
| Belomor | 2 | 1 (~18.96) | 121.5 | Y | Y 9909116 | Y | Y | Y | **INGEST_ARTIFACT** | HIGH | ~94.9 |
| VG-mid | 2 | 1 (~14.5) | 175.9 | Y | Y (separate) | Y | N | N | **SEPARATE_WATER_OBJECT** | HIGH | **0** |
| VG-D | 2 | 1 | 516.5 | Y | Y (Volga+Akhtuba) | Y | — | — | **SEPARATE_WATER_OBJECT** | HIGH | **0** |
| N06 | 1 (fairway) | 0 | 105.9 | Y | Y | Y (~96) | Y | — | **INGEST_ARTIFACT** | HIGH | ~144* |
| N08 | 1 (fairway) | 0 | 84.1 | Y | Y | Y | Y | — | **INGEST_ARTIFACT** | MEDIUM | ~120* |
| L2 | 1 (fairway) | 0 | 90.7 | Y | Y | Y | Y | — | **INGEST_ARTIFACT** | MEDIUM | ~105* |
| X3 | 1 (fairway) | 0 | 96.1 | Y | Y 382593 | Y (35) | Y | Y | **INGEST_ARTIFACT** | HIGH | ~87.5* |

\*Kuibyshev/X3 recoverable km are **diagnostic estimates** (way counts × coarse km/member), not imported geometry.

### Counts

| class | n |
| --- | ---: |
| INGEST_ARTIFACT | **5** |
| OSM_DATA_GAP | **0** |
| SEPARATE_WATER_OBJECT | **2** |
| UNKNOWN | **0** |

## 6. Recoverable geometry

**totalRecoverableGeometryKm ≈ 551** (diagnostic sum).  
Only Belomor’s figure is tightly grounded (E2.7 largest-component delta / artificial tear). Others are order-of-magnitude unused OSM centerline estimates.

## 7. Relation-aware candidates

- **Belomor** — proven (E2.7): relation 9909116 removes artificial gap.
- **X3** — Vetluga relation **382593** (33 main_stream + 2 side_stream) absent from CURRENT/water-core.

## 8. Wider-bbox candidates

- **Belomor** — default pad cuts western swing.
- **N06/N08/L2/X3** — CURRENT centerline fixture empty; wider/OSM centerline ingest would surface ways already in OSM (lake mask may still own Phase A).

## 9. Must NOT fix with seams

- **VG-mid / VG-D Volga↔Akhtuba** — SEPARATE_WATER_OBJECT; no navigable join evidence; recoverable join km = **0**.
- Fairway↔mask on Kuibyshev — layer evidence (E2.4), not a seam.

## 10. UNKNOWN

No corridor left UNKNOWN in this pass. VG-D wider/relation-aware *fidelity* benefit remains unquantified (null helps flags) but the 2-component split is classified SEPARATE, not UNKNOWN.

---

## Per-route notes

### Belomor — INGEST_ARTIFACT (confirms E2.7)
Fixture chord ~34.8E + narrow bbox vs OSM relation ~34.2E. Artificial ~18.96 km tear; relation-aware → 1 component, diagnostic path ~217 km.

### N06 / N08 / L2
OSM waterway ways exist; CURRENT shadow often fairway-only (1 component, 0 topology gaps). Production Phase A frequently OK via Kuibyshev **mask**. Ingest loss is **centerline under-coverage**, not a Belomor-style canal tear. fairway↔mask ≠ OSM_DATA_GAP.

### X3 — INGEST_ARTIFACT
Ветлуга relation **382593** + ways exist; CURRENT has no Vetluga centerlines (water-core 0). Cheboksary mask incompleteness remains a separate E1 issue.

### VG-D / VG-mid — SEPARATE_WATER_OBJECT
Volga (rel 1730417) and Akhtuba (rel 1230074) are distinct OSM waterways. Mid gap ~14.5 km is **not** recoverable join geometry.

---

## Main answers

1. **Is OSM geometry loss at ingest a systemic AquaRoute problem?**  
   **Yes, as a recurring pattern** — Belomor tear, X3 Vetluga absence, Kuibyshev OSM ways unused as WaterGraph centerlines — **but not every gap is an artifact** (VG-mid/VG-D are separate objects).

2. **Where can relation-aware / wider ingest return real existing geometry (no new geometry)?**  
   **Belomor, X3,** and (centerline-wise) **N06/N08/L2** via wider/OSM way ingest. **Not** VG-mid/VG-D Volga↔Akhtuba joins.

## Production safety

Flag false; no routing/validator/hydro/threshold/fallback/Overpass-timeout changes; no seams; no synthetic geometry; audit does not mutate empty graphs.
