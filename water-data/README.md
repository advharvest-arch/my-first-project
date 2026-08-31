# water-data — локальная инфраструктура водных данных (AquaRoute E3.1–E3.6)

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

## Multi-extract architecture (E3.6)

Документ: [`docs/E3_6_MULTI_EXTRACT_ARCHITECTURE.md`](docs/E3_6_MULTI_EXTRACT_ARCHITECTURE.md).

Выбрана стратегия **staging → merge → canonical**. Текущий replace-all members **небезопасен** для второго региона.

Локальный PoC (TEMP tables, реальные members Беломора, без новых PBF / без записи в permanent tables):

```bash
python3 ingest/poc_multi_extract_merge.py
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

- **E3.7** (предложение): staging DDL + merge job по политике E3.6 (без нового большого региона / без графа)
- позже — опциональная сборка WaterGraph из БД (отдельные этапы)

## Важно

- Не коммитьте `.env`, `data/*.osm`, PBF и database volumes.
- Не подключайте БД к frontend/API/ORM без отдельного этапа.
- Повторный `docker compose up` на уже инициализированном volume не перезапускает `db/init/`.
