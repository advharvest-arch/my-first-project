# E2.9 — Historical ingest regression forensics

**Status:** FORENSIC / DIAGNOSTIC ONLY.  
`USE_WATER_GRAPH=false`. No production enablement, seams, synthetic geometry, or routing fixes.

Script: `npx tsx scripts/e29-historical-ingest-forensics.ts`  
Module: `src/e29-historical-ingest-forensics.ts`

---

## 1. What was investigated

Git history of Overpass queries, bbox/corridor pad, relation handling, WaterGraph centerline ingest, Belomor/Lower Volga fixtures, water-core, and related routing-only changes (soft accept, span_gt_120, snap). Evidence from `git show` / `git log -S` / E2.6–E2.8 reports — not commit messages alone.

## 2. Historical timeline (code-backed)

| commit | date | type | finding |
| --- | --- | --- | --- |
| `246a212` | 2026-07-27 | QUERY+RELATION | Early `buildWaterwayQuery` included `relation["waterway"=canal\|river]` + `type=waterway` |
| `612dadde` | 2026-07-27 | QUERY | **LAST_GOOD** around-query still had waterway relations |
| **`35bb549`** | 2026-07-27 | QUERY+RELATION | **FIRST_BAD** legacy: `aroundWaterQuery` / `cellBboxQuery` **ways-only** |
| `54eb6e5` | 2026-07-27 | ROUTING | Skip Overpass when span>120 (latency; not Belomor fixture tear) |
| `4f60ab8` | 2026-07-28 | ROUTING | Soft accept — **unsafe** to restore as “fix” |
| `1e5bcfc` | 2026-07-28 | BBOX | Moscow spur lonMax bug (fixed) — pattern of bbox coverage loss |
| `afc2623` | 2026-08-25 | ROUTING | BRouter-first architecture |
| `edd2603` / `f181ecb` | 2026-08-25 | ROUTING | Safety hardenings — **must not** roll back |
| `21b571c` | 2026-08-27 | DATA | E1 Kuibyshev masks — N06/N08/L2 OK without WaterGraph OSM centerlines |
| **`65dfe1d`** | 2026-08-27 | FIXTURE+BBOX+QUERY | **FIRST_BAD** Belomor WaterGraph fixture chord ~34.8E; pad 0.35°; WaterGraph Overpass **ways-only from birth** |

### Code diffs (short)

**BEFORE `35bb549` (`612dadde` around):**
```
way(around:...)["waterway"~"^(river|canal|...)$"];
relation(around:...)["waterway"~"^(river|canal)$"];
relation(around:...)["type"="waterway"];
```

**AFTER `35bb549`:**
```
way(around:...)["waterway"~"^(river|canal|fairway|ship_canal|link)$"];
// no waterway relation(around) clauses
```

**`65dfe1d` Belomor fixture:** fake `osmId` 5020001–4, lon≈34.82–34.90, intentional mid discontinuity ~63.95–64.12.  
**`65dfe1d` WaterGraph `bboxQuery`:** ways-only (parser can read relations if present, but query never requests them).  
**`WG_INGEST_CORRIDOR_PAD_DEG = 0.35`** from birth — west cut ≈34.42 vs real canal ≈34.20.

## 3–4. Last known good / first bad

| route | lastGood | firstBad | notes |
| --- | --- | --- | --- |
| Belomor (legacy Overpass relations) | `612dadde` | `35bb549` | Relation fetch dropped |
| Belomor (WaterGraph fixture tear) | **none in git** | `65dfe1d` | Fixture introduced already broken; no prior good Belomor fixture |
| X3 / N06 / N08 / L2 (WaterGraph centerlines) | **—** | **—** | NO EVIDENCE of last-good→first-bad centerline flip |
| VG-D / VG-mid | **—** | **—** | Separate objects from fixture birth; not a split bug |

## 5. Per-corridor root causes

### E. Belomor (HIGH)
- **FIXTURE** `65dfe1d`: simplified chord creates ~18.96 km artificial DATA_GAP.
- **BBOX** pad 0.35° amplifies western miss.
- **RELATION_HANDLING/QUERY** `35bb549`: legacy relation fetch removed (ways still exist in OSM; wrong chord sampling still misses ~34.2E within 4.5 km around-radius).
- Historical **CONFIRMED_WORKING** = production **BRouter** full corridor — **PARTIAL** evidence it used real canal geometry; **NO EVIDENCE** WaterGraph fixture ever held relation 9909116 members.

### F. X3 (MEDIUM)
- Vetluga OSM relation **382593** exists (E2.8).
- `git log -S 'Ветлуг' -- water-core.json` → **empty** (never in water-core).
- No Vetluga centerline fixture ever added.
- **NO EVIDENCE** of a commit that *removed* Vetluga from CURRENT ingest — under-ingest from WaterGraph path birth, not proven regression.

### G. N06 / N08 / L2 (MEDIUM)
- E1 masks (`21b571c`) explain PROBABLY_WORKING / ok_expected.
- E2.8 INGEST_ARTIFACT = unused OSM centerlines vs fairway/mask layers.
- **Do not** treat mask success as proof those OSM centerline km were historically in WaterGraph then lost.
- **NO EVIDENCE** last-good/first-bad for centerline loss.

### H. VG-D / VG-mid (HIGH)
- Fixtures ship Volga + Akhtuba as distinct waterIds from `65dfe1d`.
- OSM: relations **1730417** / **1230074** separate.
- **NO EVIDENCE** they were one navigable object then broken by ingest.
- recoverable join km = **0** — must not sew.

## 6. Pipeline diagram

```
OLD (≈246a212–612dadde)
OSM (ways + waterway relations)
  → Overpass bbox/around (relations included)
  → local snap graph / BRouter
  → route

CURRENT
OSM
  → legacy around/cell ways-only (35bb549)
  → OR skip Overpass if span>120 (54eb6e5)
  → BRouter-first (afc2623) + lake masks (21b571c)
  → WaterGraph shadow fixtures (65dfe1d): Belomor chord + pad 0.35°; ways-only ingest query
  → E2.7 relation-aware diagnostic NOT enabled
```

**Divergence:** `35bb549` (query), `54eb6e5` (long-span skip), `65dfe1d` (fixture/bbox/WaterGraph query). Historical Belomor OK ≠ WaterGraph fixture path.

## 7. Confidence

| claim | conf |
| --- | --- |
| Belomor fixture/bbox introduced tear at 65dfe1d | HIGH |
| Legacy relation Overpass removed at 35bb549 | HIGH |
| X3/Kuibyshev centerline last-good/first-bad | LOW / NO EVIDENCE |
| VG separate objects not an ingest bug | HIGH |

## 8. Safe historical behavior to recover (ingest only)

- Re-add waterway **relation** Overpass clauses (undo `35bb549` query narrowing) behind diagnostics.
- **Relation-aware / wider-bbox** Belomor ingest (E2.7) — real OSM members only.
- Gated OSM centerline ingest for Vetluga / Kuibyshev corridors (future).

## 9. Must NOT recover

- Soft accept / excess 3.5× (`4f60ab8`)
- Drop `span_gt_120` without safe alternative (`54eb6e5`)
- Weaken snap / validator / hydro / barriers (`edd2603`, `f181ecb`)
- Sew Volga↔Akhtuba
- Synthetic chords / seams

## 10. Remaining unknowns

- Whether user clicks on the *real* Belomor axis ever got western ways via ways-only around before WaterGraph fixtures.
- Exact Vetluga/Kuibyshev recoverable km (E2.8 estimates).
- Any out-of-repo experiments with better Belomor fixtures.

---

## Key answers (strict)

1. **Proof that current OSM geometry loss came from a project change?**  
   **YES** for Belomor WaterGraph fixture/bbox (`65dfe1d`) and legacy Overpass relation drop (`35bb549`).  
   **NO EVIDENCE** for X3/N06/N08/L2 centerline removal commits.  
   **NO EVIDENCE** VG-mid/VG-D were merged then split.

2. **Proof historical good routes used this recoverable geometry?**  
   **PARTIAL** Belomor (BRouter used real canal; fixture never did).  
   **NO EVIDENCE** for X3 Vetluga relation in CURRENT ingest historically.  
   **NO EVIDENCE** N06/N08/L2 OK required the unused OSM centerline km (mask path).  
   **NO EVIDENCE** for VG-mid join geometry.

## Production / safety

Flag false; production unchanged; no seams; no synthetic geometry; no routing fix in this stage.
