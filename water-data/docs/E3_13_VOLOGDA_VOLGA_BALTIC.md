# E3.13 — Vologda Oblast staging merge (Volga–Baltic coverage)

Targeted coverage experiment. **No** Yaroslavl / Russia-wide / WaterGraph / sea-map changes.

## A. PBF

| Field | Value |
|-------|-------|
| URL | `https://download.openstreetmap.fr/extracts/russia/northwestern_federal_district/vologda_oblast-latest.osm.pbf` |
| bytes | **51980210** (~49.6 MiB / ~52 MB) |
| sha256 | `07265588eb73f5e13143af7f60b4662e7667a59621c10d63d87931a2dc80c773` |
| downloaded | 2026-08-31T11:22:09Z → 11:22:11Z |
| script | `ingest/download_vologda.sh` (PBF gitignored; meta beside file) |

## B. Staging

| Field | Value |
|-------|-------|
| batch_key | `e313-vologda-oblast` |
| batch_id | 11 |
| source_version | `osm-vologda-oblast-e313` |
| staged_objects | **33728** |
| staged_relations | 2103 |
| staged_members | 23059 |

## C–D. Relation 16738852 before merge

| | |
|--|--|
| Before | **54 / 106** |
| Missing seq | 54–105 (52 ways) |
| Found as Vologda staging objects | **52 / 52** |
| Still missing from staging | **0** |

## E–F. Merge result (E3.7 engine, unchanged)

| Metric | Before | After |
|--------|-------:|------:|
| objects | 422327 | **455001** (+32674) |
| members | 186823 | **199570** (+12747) |
| **16738852 present/listed** | 54/106 | **106/106** |

Member provenance after merge:

- prior-only: 53  
- overlap Vologda+prior: 1  
- Vologda-only (new objects for the tail): **52**

## G. Geometry

| Aspect | Result |
|--------|--------|
| Completeness | **106/106** — every member exists in `water.objects` |
| Relation `geometry` column | Still MULTILINESTRING SRID 4326, **902** pts, length **456575.1** m, bbox …–**35.84E** |
| Why not extended | Geometry conflict recorded: canonical 902 pts vs Vologda staging 730 pts → **keep_canonical** (E3.7 richer-points policy). No manual rebuild / LineMerge / seam. |
| Member ways extent (read-only) | All 106 members span ~30.36–**38.56E**, 59.06–61.27N; sum of member lengths ≈ 852.6 km |

Complete ≠ “relation.geometry rebuilt from all members”. Completeness is member existence only.

## H. Conflicts (Vologda batch, left open)

| type | resolution | n |
|------|------------|--:|
| geometry | keep_canonical | 21 |
| geometry | take_incoming | 20 |
| tags / order | — | 0 |

No auto-resolve.

## I. Idempotency (re-merge batch 11)

- objects: `unchanged` 33707 + `conflict_keep_canonical` 21 (no new inserts)
- members: all `added: 0`
- counts **+0**; conflicts stay **41** for batch

## J–O. Invariants / audits

| Check | Result |
|-------|--------|
| Belomor 9909116 | **29/29**, length 216963.1 m |
| Ladoga 21149039 | **10364/10364** |
| Volga–Baltic 16738852 | **106/106** |
| 14000871 duplicate occurrences | preserved (ways @ seq 30/32 and 31/33) |
| identity dups | 0 |
| orphan parents | 0 |
| invalid geometry | 0 |

## Q. Way 824398188 (former “filter miss”)

- Tags: `waterway=fairway`, `CEMT=VIb` — **within** current importer `WATERWAY_TYPES` (maps to `other`).
- Present in Karelia PBF and Vologda PBF; absent from Leningrad PBF.
- Absent from canonical after Karelia import; **now in canonical** via Vologda (`source_version=osm-vologda-oblast-e313`).
- Conclusion: **not a tag-filter exclusion**. Likely E3.4 materialization skip at extract boundary (incomplete/degenerate way geometry in Karelia context). **Not auto-fixed beyond successful Vologda import.**

## S. Proven

Vologda oblast extract **closes the Volga–Baltic member gap** left by Karelia+Leningrad: **54/106 → 106/106** without Russia-wide import, placeholders, or geometry invention.

## T. Suggested E3.14

Optional: explicit **relation geometry rebuild from complete members** (policy decision; separate from completeness) **or** conflict-review pass on the 41 Vologda geometry conflicts — still no WaterGraph / no Yaroslavl unless needed for another corridor.
