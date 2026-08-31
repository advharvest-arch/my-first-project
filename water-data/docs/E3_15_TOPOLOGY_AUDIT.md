# E3.15 — Read-only water topology audit

Members = **source of truth**. `relation.geometry` = derived/cached (not used for ordering or continuity).

Tool: `ingest/e315_topology_audit.py`

```bash
python3 ingest/e315_topology_audit.py --relation 16738852
python3 ingest/e315_topology_audit.py --relation 9909116 --json-out data/e315_topology_9909116.json
```

No canonical writes. No seams. Threshold (default **10 m**) is QA classification only.

## Classification

| Status | Rule |
|--------|------|
| `GEOMETRY_INCOMPLETE` | missing member object or missing/invalid geometry |
| `GEOMETRICALLY_CONTINUOUS` | all members valid; every best neighbor gap ≤ 10 m |
| `GEOMETRICALLY_FRAGMENTED` | members complete; some best neighbor gap > 10 m |

**Not implied:** navigability, locks/portage, legal passage, vessel class.

## Volga–Baltic `16738852`

| | |
|--|--|
| Completeness | **106/106** valid LINESTRING |
| Classification | **GEOMETRICALLY_FRAGMENTED** |
| Orientation | keep_B **34** / reverse_B **71** (logical only) |
| Best-gap median / p95 / max | **0** / **0** / **~8765 m** |
| Buckets (best gap) | ≤10 m: **104**; >1 km: **1** |
| Critical gap | **seq 53→54** ways `28433211`→`824398188` ≈ **8.76 km** |
| Components (≤10 m) | **2**: seq 0–53 (54 ways, ~456.6 km); seq 54–105 (52 ways, ~396.0 km) |
| Canonical geometry | MULTILINESTRING 54 parts, **456.6 km**, xmax **35.84E** |
| Member-derived collect | 106 parts, **852.6 km**, xmax **38.56E** |
| Diagnostic LineMerge | **2** parts, 852.6 km |

## Belomor `9909116`

| | |
|--|--|
| Completeness | **29/29** |
| Classification | **GEOMETRICALLY_CONTINUOUS** |
| Components | **1** (seq 0–28) |
| Best-gap max | **0 m** |
| Canonical length = collect length | **216963.1 m** |

## Ladoga `21149039`

| | |
|--|--|
| Completeness | **10364/10364** |
| Classification | **GEOMETRICALLY_FRAGMENTED** |
| Components (≤10 m chain) | **2106** |
| Best-gap max | ~190 km |
| Note | Multipolygon / multi-ring lake: ordered `seq` chain continuity is a weak model; fragmentation is expected and does **not** mean members are missing |

## Invariants

objects **455001**, members **199570**, conflicts **92** unchanged.  
identity / orphan / invalid = **0**.

## Conclusion

1. Topology audit confirms VB is **member-complete but geometrically fragmented** at the known 53→54 extract-boundary gap.  
2. Belomor is a continuous waterway chain.  
3. Ladoga completeness ≠ single sequential centerline.  
4. Rebuild of `relation.geometry` remains a separate explicit policy (not done here).

## Suggested E3.16

Optional explicit **waterway-only** relation geometry rebuild job (members → collect/orient/report gaps) **or** keep members as SoT for a future WaterGraph builder — still no new regions / no graph tables in that step unless requested.
