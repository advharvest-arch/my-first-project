# water-data — локальная инфраструктура водных данных (AquaRoute E3.1–E6)

## Зачем это

Каталог `water-data/` — **изолированный фундамент** для будущей локальной базы водных данных AquaRoute (PostgreSQL + PostGIS).

Сейчас: контейнер БД + схема + **offline import** (Беломор relation и extract Карелии) + SQL coverage diagnostics.  
Маршрутизация, WaterGraph, BRouter, Hybrid Router, Safety Validator, frontend и Overpass **не подключены**.

## Что есть сейчас

- Docker Compose (`postgis/postgis`), БД `aquaroute_water`, порт хоста **5433**
- Схема `water`: `data_sources`, `objects`, `object_members`
- `water-data/ingest/` — download scripts + pyosmium importer (E3.3–E3.4)
- `db/smoke/e34_coverage_diag.sql` — диагностика покрытия
- Пароль через `.env` (см. `.env.example`)

Таблиц графа (`water_edges`), synthetic connections и подключения к роутеру **нет**.

## Таблица `water.objects` (E3.2)

Хранит **исходный OSM water object** (node/way/relation): `osm_type`+`osm_id`, `tags` (JSONB), `geometry` (EPSG:4326), `water_type` (нормализация, не замена tags), `source` / `source_version`.

Уникальность: `UNIQUE (osm_type, osm_id)`.

## Таблица `water.object_members` (E3.3)

Зачем: сохранить **исходный состав** OSM relation отдельно от tags, чтобы SQL умел:

- какие members входят в relation;
- в какие relations входит конкретный way;
- порядок members (`seq`);
- role (`main_stream`, …).

| Поле | Смысл |
|------|--------|
| `parent_osm_type` / `parent_osm_id` | Родитель (сейчас всегда `relation` + его OSM id) |
| `seq` | Порядок member в списке relation (0-based), как в OSM |
| `member_osm_type` / `member_osm_id` | Сам member |
| `member_role` | Роль OSM (например `main_stream`) |

**Отличие от `tags`:** `tags` на `water.objects` — только исходные OSM key/value объекта. Состав relation туда не кладётся.

**FK нет:** обычный SQL `FOREIGN KEY` на `water.objects` ненадёжен при частичном OSM extract и порядке импорта (member может быть упомянут без отдельной строки объекта). Связь логическая по парам `(osm_type, osm_id)`.

**Provenance / geometry:** relation в `water.objects` может иметь `MultiLineString`, собранный из **реальных** геометрий member ways (без `LineMerge` и без дорисованных стыков). Разрывы между ways **не** сшиваются. Это не synthetic seam. Состав при этом остаётся в `object_members`.

Индексы: `(parent_osm_type, parent_osm_id)` и `(member_osm_type, member_osm_id)`.  
Уникальность позиции: `UNIQUE (parent_osm_type, parent_osm_id, seq)`.

## Запуск БД

```bash
cd water-data
cp .env.example .env
docker compose config
docker compose up -d
```

Первый старт выполняет `db/init/` (`001`…`004`). На старом volume без `004`:

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/init/004_object_members.sql
```

Полный сброс: `docker compose down -v && docker compose up -d`.

## Offline import (E3.3–E3.4)

См. [`ingest/README.md`](ingest/README.md).

```bash
# E3.4 — Республика Карелия (~102MB PBF, включает Беломор + окрестную водную сеть)
./ingest/download_karelia.sh
export POSTGRES_PASSWORD=...   # из .env
python3 -m pip install -r ingest/requirements.txt
python3 ingest/import_osm.py data/karelia_republic-latest.osm.pbf
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e34_coverage_diag.sql

# E3.3 — только relation 9909116 (~105KB)
./ingest/download_belomor.sh
python3 ingest/import_osm.py data/belomor-relation-9909116-full.osm
```

Повторный import — upsert по `(osm_type, osm_id)`; members relation перезаписываются без дублей.  
Неполные relations на границе extract **не** «чинятся» автоматически — см. `e34_coverage_diag.sql`.

## Incomplete relation QA (E3.5)

Read-only. Использует уже импортированную Карелию + локальный PBF (без новых download / без OSM API mass queries).

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e35_relation_qa.sql

python3 ingest/qa_incomplete_relations.py \
  --json-out data/e35_relation_qa_report.json   # gitignored under data/
```

Классификация missing members:
- **extract_boundary** — id отсутствует в локальном PBF
- **internal_missing** — id есть в PBF, но нет в `water.objects`
- **mixed** — часть missing in-PBF, часть нет

## Multi-extract architecture (E3.6) + staging merge (E3.7)

Документ: [`docs/E3_6_MULTI_EXTRACT_ARCHITECTURE.md`](docs/E3_6_MULTI_EXTRACT_ARCHITECTURE.md).

Схема E3.7: `import_batches`, `staging_objects`, `staging_members`, `object_conflicts`, `object_batch_links` (`db/init/005`–`008`).

```bash
# Apply 005–008 on an existing volume if needed, then:
python3 ingest/poc_e37_merge.py          # Belomor ordered-union + tags conflict PoC
python3 ingest/merge_staging.py --batch-id N
```

## Multi-extract: Leningrad + Karelia (E3.8)

```bash
./ingest/download_leningrad.sh           # ~189MB, gitignored
python3 ingest/e38_overlap_report.py --backfill-karelia
python3 ingest/import_osm.py data/leningrad_oblast-latest.osm.pbf \
  --to-staging --batch-key e38-leningrad-oblast \
  --source-version osm-leningrad-oblast-e38
python3 ingest/merge_staging.py --batch-id <id>
python3 ingest/e38_overlap_report.py --report
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e38_multi_extract_audit.sql
```

**Rollback note:** deleting an `import_batches` row cascades staging/conflicts/links for that batch, but does **not** remove canonical objects/members already merged. Full batch rollback is not implemented.

## Merge anomaly QA (E3.9)

Read-only. Does **not** mutate canonical objects/members or auto-resolve conflicts.

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e39_merge_anomaly_qa.sql

python3 ingest/e39_conflict_review.py --summary --top 10
python3 ingest/e39_conflict_review.py --open-geometry --sort size
python3 ingest/e39_conflict_review.py --dup-membership 14000871 \
  --json-out data/e39_conflict_qa.json
```

Conflicts remain `status=open` with recorded `resolution` (audit of what merge did). Manual review later — do not bulk-resolve for DB cleanliness.

**Schema limit:** extract-level `source_version` only; no per-object OSM `version`/`timestamp` → not enough for deterministic freshness ordering.

## Manual conflict review + occurrence policy (E3.10)

See [`docs/E3_10_CONFLICT_REVIEW.md`](docs/E3_10_CONFLICT_REVIEW.md).

```bash
# Apply 009 on existing volume if needed:
docker compose exec -T db psql -U aquaroute -d aquaroute_water < db/init/009_conflict_review.sql

python3 ingest/e310_conflict_review.py probe-demo
python3 ingest/e310_conflict_review.py list --status open
python3 ingest/poc_e310_occurrence_merge.py   # TEMP PoC; no canonical writes
```

`resolution` = merge recommendation; `status` = human review (`open|accepted|rejected|deferred`). Review never applies geometry.

## Water-data composition analysis (E3.11)

Read-only inventory of the current DB for a future Russia-wide water store. **No** new PBF, **no** canonical changes, **no** WaterGraph.

See [`docs/E3_11_WATER_DATA_COMPOSITION.md`](docs/E3_11_WATER_DATA_COMPOSITION.md).

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e311_water_data_inventory.sql
python3 ingest/e311_inventory.py --json-out data/e311_inventory.json
```

## Volga–Baltic coverage forensics (E3.12)

Read-only. Uses existing Karelia/Leningrad PBFs only — **does not download** the next extract.

See [`docs/E3_12_VOLGA_BALTIC_COVERAGE.md`](docs/E3_12_VOLGA_BALTIC_COVERAGE.md).

```bash
python3 ingest/e312_volga_baltic_coverage.py --json-out data/e312_volga_baltic_coverage.json
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e312_volga_baltic_coverage.sql
```

## Vologda coverage merge (E3.13)

Targeted staging→merge for Volga–Baltic completeness. See [`docs/E3_13_VOLOGDA_VOLGA_BALTIC.md`](docs/E3_13_VOLOGDA_VOLGA_BALTIC.md).

```bash
./ingest/download_vologda.sh
python3 ingest/import_osm.py data/vologda_oblast-latest.osm.pbf \
  --to-staging --batch-key e313-vologda-oblast \
  --source-version osm-vologda-oblast-e313
python3 ingest/merge_staging.py --batch-id <id>
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e313_vologda_volga_baltic.sql
```

**Result:** relation `16738852` **106/106**. PBF not committed.

## Geometry reconstruction audit (E3.14)

Read-only. See [`docs/E3_14_VB_GEOMETRY_RECON_AUDIT.md`](docs/E3_14_VB_GEOMETRY_RECON_AUDIT.md).

```bash
python3 ingest/e314_vb_geometry_recon_audit.py --omit-members-stdout \
  --json-out data/e314_vb_geometry_recon_audit.json
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e314_vb_geometry_recon_audit.sql
```

## Topology audit (E3.15)

Read-only member-chain continuity. See [`docs/E3_15_TOPOLOGY_AUDIT.md`](docs/E3_15_TOPOLOGY_AUDIT.md).

```bash
python3 ingest/e315_topology_audit.py --relation 16738852
python3 ingest/e315_topology_audit.py --relation 9909116
python3 ingest/e315_topology_audit.py --relation 21149039
```

Members = source of truth; `relation.geometry` is cached/derived.

## Routing relevance layer (E4.1)

READ-ONLY SQL VIEW `water.routing_relevance` classifies existing `water.objects` as HIGH / MEDIUM / LOW / IGNORE for future WaterGraph planning. **Does not** mutate canonical data, **does not** imply navigability, **does not** create graph tables.

See [`docs/E4_1_ROUTING_RELEVANCE.md`](docs/E4_1_ROUTING_RELEVANCE.md).

```bash
# Apply on existing volume if needed:
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/init/010_routing_relevance.sql

docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e41_routing_relevance.sql
```

## Routing candidate extract (E4.2)

READ-ONLY VIEW `water.routing_candidates` selects HIGH + stream/river_area MEDIUM + way members of HIGH waterway/lake relations as WaterGraph **candidates**. Identity = `(osm_type, osm_id)`. No graph tables. No navigability claims.

See [`docs/E4_2_ROUTING_CANDIDATES.md`](docs/E4_2_ROUTING_CANDIDATES.md).

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/init/011_routing_candidates.sql

docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e42_routing_candidates.sql
```

## Routing segments / endpoints (E4.3)

READ-ONLY VIEWs `water.routing_segments` + `water.routing_geometry_class`: linear way geometries from candidates with endpoints (`start_point`/`end_point`, `length_m`). No LineMerge, no graph nodes/edges, no proximity stitching. Relation cached geometry is **not** used as segment SoT.

See [`docs/E4_3_ROUTING_SEGMENTS.md`](docs/E4_3_ROUTING_SEGMENTS.md).

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/init/012_routing_segments.sql

docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e43_routing_segments.sql
```

## Topology inference audit (E4.4)

READ-ONLY diagnostics: endpoint connectivity (exact / 1 / 5 / 10 m) and crossing classification on `water.routing_segments`. **No** graph nodes/edges, **no** stitching, crossing ≠ junction.

See [`docs/E4_4_TOPOLOGY_INFERENCE.md`](docs/E4_4_TOPOLOGY_INFERENCE.md).

```bash
python3 ingest/e44_topology_inference_audit.py \
  --json-out data/e44_topology_inference.json

docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e44_topology_inference.sql
```

## Topology rules specification (E4.5)

READ-ONLY specification + measured PoC for how `routing_segments` could become a future topology. **No** graph nodes/edges. Primary proposal: exact endpoint match (E1); 1/5/10 m = diagnostic only.

See [`docs/E4_5_TOPOLOGY_RULES.md`](docs/E4_5_TOPOLOGY_RULES.md).

```bash
python3 ingest/e45_topology_rules_audit.py \
  --json-out data/e45_topology_rules.json

docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e45_topology_rules.sql
```

## E1 component PoC (E4.6)

READ-ONLY in-memory connected components from `routing_segments` using **only** E4.5 rule E1 (exact endpoint match). No graph tables, no tolerance stitching, no crossing-as-edge.

See [`docs/E4_6_E1_COMPONENT_POC.md`](docs/E4_6_E1_COMPONENT_POC.md).

```bash
python3 ingest/e46_e1_component_poc.py --json-out data/e46_e1_components.json

docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e46_e1_component_poc.sql
```

## Isolated WaterGraph PoC (E5)

First graph tables (`water.wg_build` / `wg_nodes` / `wg_edges`) built from `routing_segments` with **E1 only**. Isolated — **not** wired to AquaRoute / sea-map / BRouter. No navigability / directionality.

See [`docs/E5_WATERGRAPH_POC.md`](docs/E5_WATERGRAPH_POC.md).

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/init/013_watergraph_poc.sql

python3 ingest/e5_watergraph_poc_build.py --json-out data/e5_watergraph_poc.json

docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e5_watergraph_poc.sql
```

## WaterGraph safety validation (E6)

Read-only safety gate on `wg_nodes`/`wg_edges`: integrity, E1-only connections, Belomor/VB/N06/N08/structures/Ladoga. Writes `wg_safety_run` / `wg_edge_safety`. **ALLOWED_TOPOLOGY ≠ navigable.**

See [`docs/E6_WATERGRAPH_SAFETY.md`](docs/E6_WATERGRAPH_SAFETY.md).

```bash
python3 ingest/e6_watergraph_safety.py --json-out data/e6_watergraph_safety.json

docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e6_watergraph_safety.sql
```

## Остановка БД

```bash
docker compose down
# с удалением volume: docker compose down -v
```

## Проверка PostGIS / E3.2 smoke

```bash
docker compose exec db psql -U aquaroute -d aquaroute_water -c "SELECT PostGIS_Version();"
docker compose exec -T db psql -U aquaroute -d aquaroute_water < db/smoke/e32_objects_smoke.sql
```

## Что дальше (не выполняется здесь)

- **E7** isolated routing pilot — only after E6 gate; N06/N08 remain FALLBACK without Kuibyshev coverage
- AquaRoute / BRouter / production flag — not enabled here
- Navigability classification — still UNKNOWN for structures / lake rings

## Важно

- Не коммитьте `.env`, `data/*.osm`, PBF и database volumes.
- Не подключайте БД к frontend/API/ORM без отдельного этапа.
- Повторный `docker compose up` на уже инициализированном volume не перезапускает `db/init/`.
