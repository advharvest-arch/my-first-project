# Offline OSM ingest (AquaRoute E3.3–E3.5)

No Overpass. No AquaRoute/WaterGraph/BRouter wiring. No graph construction.

## Datasets

| Dataset | Script | Typical size | Notes |
|---------|--------|--------------|--------|
| Belomor relation `9909116` full | `./download_belomor.sh` | ~105 KB | E3.3 smoke |
| **Karelia republic PBF (E3.4)** | `./download_karelia.sh` | ~102 MB | Belomor + surrounding water network |

PBF/OSM files land in `water-data/data/` and are **gitignored**.

### Why Karelia for E3.4

- Source: [download.openstreetmap.fr](https://download.openstreetmap.fr/extracts/russia/northwestern_federal_district/) `karelia_republic-latest.osm.pbf`
- Real OSM extract (not hand-drawn)
- Covers Republic of Karelia → includes Belomor corridor and nearby lakes/rivers/canals
- ~100MB class: much larger than relation-only, far smaller than Geofabrik Northwestern (~620MB) or all-Russia

## Setup

```bash
cd water-data
python3 -m pip install -r ingest/requirements.txt
cp -n .env.example .env
docker compose up -d
```

## Download + import (E3.4)

```bash
./ingest/download_karelia.sh          # or --force
export POSTGRES_PASSWORD="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
python3 ingest/import_osm.py data/karelia_republic-latest.osm.pbf \
  --source-version "osm-karelia-republic-manual"
```

Importer is **two-pass** (index water features → materialize geometries) so regional PBFs stay memory-safe.

**Upsert:** `ON CONFLICT (osm_type, osm_id) DO UPDATE`.  
**Members:** deleted+reinserted per imported relation (no duplicates).

## Diagnostics

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e34_coverage_diag.sql
```

## Incomplete relation QA (E3.5)

Uses the **existing** Karelia import + local PBF. No new downloads. No mass OSM API. No auto-fixes.

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e35_relation_qa.sql

python3 ingest/qa_incomplete_relations.py \
  --json-out data/e35_relation_qa_report.json
```

Missing-member classification (PBF presence evidence):
- `extract_boundary` — id not in local PBF
- `internal_missing` — id in PBF but not in `water.objects`
- `mixed` — both

## Multi-extract architecture (E3.6) + merge (E3.7)

See [`../docs/E3_6_MULTI_EXTRACT_ARCHITECTURE.md`](../docs/E3_6_MULTI_EXTRACT_ARCHITECTURE.md).

```bash
python3 ingest/poc_multi_extract_merge.py   # E3.6 TEMP-table sketch
python3 ingest/poc_e37_merge.py             # E3.7 real staging→canonical PoC
python3 ingest/merge_staging.py --batch-id N
```

## Merge anomaly QA (E3.9)

Read-only. See [`../docs/E3_9_MERGE_ANOMALY_QA.md`](../docs/E3_9_MERGE_ANOMALY_QA.md).

```bash
python3 ingest/e39_conflict_review.py --summary --top 10
python3 ingest/e39_conflict_review.py --open-geometry --sort water_type
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e39_merge_anomaly_qa.sql
```

## Conflict review + occurrence policy (E3.10)

See [`../docs/E3_10_CONFLICT_REVIEW.md`](../docs/E3_10_CONFLICT_REVIEW.md).

```bash
python3 ingest/e310_conflict_review.py probe-demo
python3 ingest/e310_conflict_review.py list --status open
python3 ingest/poc_e310_occurrence_merge.py
```

## Water-data composition (E3.11)

Read-only. See [`../docs/E3_11_WATER_DATA_COMPOSITION.md`](../docs/E3_11_WATER_DATA_COMPOSITION.md).

```bash
python3 ingest/e311_inventory.py --json-out data/e311_inventory.json
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e311_water_data_inventory.sql
```

## Idempotency

Run `import_osm.py` twice on the same file; `water.objects` / `water.object_members` counts must not grow via duplicates. `water.data_sources` may gain one audit row per run.
