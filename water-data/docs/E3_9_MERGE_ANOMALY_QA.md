# E3.9 — Merge anomaly QA (Karelia + Leningrad)

Read-only investigation of E3.8 leftovers. **No** third-region import, **no** canonical auto-fixes, **no** WaterGraph / sea-map / routing changes.

## A. Relation `14000871` (Oulankajoki / Оланга)

- Parent: `relation/14000871`, waterway river, Karelia-only provenance (`e34-karelia-republic`).
- Absent from Leningrad PBF.
- Duplicate membership rows (same type+id+role, different `seq`):

| member | role | seqs |
|--------|------|------|
| way/134221487 | main_stream | 30, 32 |
| way/1456380890 | main_stream | 31, 33 |

- Member ways are **not** present in `water.objects` (not imported as water features); membership rows still valid OSM relation members.
- **Verdict: A — legitimate OSM duplicate membership** (not DB corruption, not E3.7 merge bug).
- Evidence: Karelia PBF relation version 19 contains the identical duplicate member list. E3.4 importer preserved OSM order/duplicates. E3.7 `ordered_union` was not applied to this relation (no Leningrad staging members).

## B. Geometry conflicts (`e38-leningrad-oblast`)

- **49** geometry conflicts, all `status=open`.
- Resolutions already applied at merge time: **27** `take_incoming`, **22** `keep_canonical`. History not rewritten.
- Classification (evidence-based CLI): see `ingest/e39_conflict_review.py`.

## C. Tooling

- `db/smoke/e39_merge_anomaly_qa.sql`
- `ingest/e39_conflict_review.py` — open geometry conflicts sortable by importance / size / water_type; duplicate-membership dump; JSON report.

## D. Schema / freshness

`current OSM object version/timestamp недостаточен for deterministic freshness ordering.`

Minimal future extension (if needed): nullable `osm_version INT` + `osm_timestamp TIMESTAMPTZ` on `staging_objects` / `objects`, populated from pyosmium — not added in E3.9.
