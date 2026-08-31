# E3.14 — Read-only geometry reconstruction audit (Volga–Baltic 16738852)

Diagnostic only. **No** canonical writes. **No** conflict apply. **No** LineMerge into `water.objects`.

## A. Completeness

| | |
|--|--|
| listed / present | **106 / 106** |
| with geometry | **106** |
| Policy | complete = every member exists in `water.objects` **with geometry** |
| Continuity | **not** implied by completeness |

## B–C. Member geometry availability

| Check | Result |
|-------|--------|
| missing objects | **0** |
| missing geometry | **0** |
| invalid geometry | **0** |
| unexpected types | **0** (all LINESTRING, SRID 4326) |

## D. Endpoint gaps (geography meters)

105 consecutive pairs (seq N → N+1).

| Metric | forward end→start | best endpoint pair (allows reverse) |
|--------|------------------:|------------------------------------:|
| max | 64276.9 m | **8783.8 m** |
| median | 4806.6 m | **0.0 m** |
| p95 | 36185.8 m | **0.0 m** |
| pairs gap > 10 m | 75 | **1** |

Forward gaps are large mainly because many ways are oriented opposite to relation order — not because members are missing.

Top forward gaps are QA-only (e.g. seq 25→26 forward ~64 km, best_m = 0).

## E. Orientation (diagnostic greedy chain)

Starting as stored:

- neighbors keep: **34**
- neighbors need reverse: **71**

No geometry reversed in DB. Reversals are hypothetical for chaining QA only.

## F–G. Diagnostic reconstruction (SELECT only)

| Build | type | parts | points | length_m | bbox xmax |
|-------|------|------:|-------:|---------:|----------:|
| `ST_Collect(members ORDER BY seq)` | MULTILINESTRING | **106** | 1612 | **852597.2** | **38.55666** |
| `ST_LineMerge(ST_Collect(...))` | MULTILINESTRING | **2** | 1508 | **852597.2** | **38.55666** |
| Canonical `objects.geometry` | MULTILINESTRING | **54** | 902 | **456575.1** | **35.83529** |

LineMerge is diagnostic only — not written, not for routing. It collapses to **2** components because one residual abutment gap remains: **seq 53→54** (ways `28433211`→`824398188`), best endpoint pair ≈ **8783.8 m** (extract-boundary / fairway stub region). Forward-only gaps are dominated by way orientation, not missing members.

## H. Canonical vs reconstructed

- Canonical length ≈ **456.6 km** (≈ first 54 member ways’ assembly).
- Collect/LineMerge length ≈ **852.6 km** (+396.0 km).
- Canonical xmax **35.84E**; member collect xmax **38.56E**.
- **52** member ways lie east of canonical xmax (seq 54–105) — present as objects, absent from stored relation geometry.

**Why:** E3.13 merge recorded geometry conflict on the relation (Vologda staging 730 pts vs canonical 902) → `keep_canonical`. Member objects were added; relation `geometry` column was not rebuilt.

## I. Conflicts (not resolved)

- Relation `16738852` geometry conflicts: E3.8 `take_incoming`, E3.13 `keep_canonical` (still open).
- VB member ways with open geometry conflict: **1**.
- Open geometry conflicts globally remain open (not touched).

## J. Controls

| relation | present/listed | missing/invalid member geom |
|----------|----------------|-----------------------------|
| Belomor 9909116 | 29/29 | 0 / 0 |
| Ladoga 21149039 | 10364/10364 | 0 / 0 |
| Volga–Baltic 16738852 | 106/106 | 0 / 0 |

## K–L. Invariants

objects **455001**, members **199570** (unchanged).  
identity / orphan / invalid = **0**.

## N. Conclusion

1. **Yes** — a relation geometry can be built from the **106 real member way geometries** already in the DB (`ST_Collect` / diagnostic `ST_LineMerge`).
2. Completeness is satisfied; **geometric continuity is not** (1 residual ~8.8 km best-pair gap; LineMerge → 2 parts; many ways need reverse for a sequential chain).
3. Canonical relation geometry is a **stale partial assembly** (54 parts / 35.84E), not the full member set — by E3.7 keep_canonical, not by missing members.

## O. Limits

- No automatic reverse/write.
- No conflict apply.
- Residual gap not explained by inventing seams; coords come only from stored member geometries.
- LineMerge result must not be treated as routing graph input.

## P. Suggested E3.15

Policy decision only: optional **explicit** relation-geometry rebuild job from complete members (with reverse rules + gap report), still without WaterGraph / new regions — **or** leave geometry stale and treat members as source of truth for a later graph builder.
