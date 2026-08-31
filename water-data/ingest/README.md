# water-data/ingest — offline OSM import (AquaRoute E3.3)

Offline only. No Overpass, no AquaRoute/WaterGraph/BRouter wiring.

## Setup

```bash
cd water-data
python3 -m pip install -r ingest/requirements.txt
cp .env.example .env   # if needed
docker compose up -d
```

Load schema (fresh volume runs `db/init/*` automatically). On an existing E3.2 volume:

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/init/004_object_members.sql
```

## Download Belomor test extract

Official OSM API (not Overpass):

```bash
./ingest/download_belomor.sh
# overwrite: ./ingest/download_belomor.sh --force
```

Writes (gitignored):

`water-data/data/belomor-relation-9909116-full.osm`

## Import

```bash
export POSTGRES_PASSWORD="$(grep POSTGRES_PASSWORD .env | cut -d= -f2-)"
python3 ingest/import_osm.py
# or: python3 ingest/import_osm.py data/belomor-relation-9909116-full.osm
```

**Upsert strategy:** `ON CONFLICT (osm_type, osm_id) DO UPDATE` on `water.objects`.  
For each imported relation, members are **replaced** (`DELETE` by parent + `INSERT`) so `seq`/`role` stay exact without duplicates.

## Validate

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e33_belomor_validate.sql
```

## Idempotency check

```bash
python3 ingest/import_osm.py   # first
python3 ingest/import_osm.py   # second — object/member counts must not grow via duplicates
```
