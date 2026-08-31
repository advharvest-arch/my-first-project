# water-data — локальная инфраструктура водных данных (AquaRoute E3.1–E3.3)

## Зачем это

Каталог `water-data/` — **изолированный фундамент** для будущей локальной базы водных данных AquaRoute (PostgreSQL + PostGIS).

Сейчас: контейнер БД + схема хранения исходных OSM water-объектов + **offline import** тестового набора Беломорканала.  
Маршрутизация, WaterGraph, BRouter, Hybrid Router, Safety Validator, frontend и Overpass **не подключены**.

## Что есть сейчас

- Docker Compose (`postgis/postgis`), БД `aquaroute_water`, порт хоста **5433**
- Схема `water`
- `water.data_sources` — метаданные загрузок (E3.1)
- `water.objects` — исходные OSM объекты (E3.2)
- `water.object_members` — состав OSM relations (E3.3)
- `water-data/ingest/` — download + pyosmium importer (E3.3)
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

## Offline import Беломорканала (E3.3)

См. подробности в [`ingest/README.md`](ingest/README.md).

```bash
./ingest/download_belomor.sh          # OSM API relation/9909116/full → data/*.osm (gitignored)
export POSTGRES_PASSWORD=...          # из .env
python3 -m pip install -r ingest/requirements.txt
python3 ingest/import_osm.py
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e33_belomor_validate.sql
```

Повторный import — upsert по `(osm_type, osm_id)`; members relation перезаписываются без дублей.

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

- **E3.4** (предложение): расширить offline extract / coverage diagnostics по коридору, всё ещё без графа и без роутера
- позже — опциональная сборка WaterGraph из БД (отдельные этапы)

## Важно

- Не коммитьте `.env`, `data/*.osm`, PBF и database volumes.
- Не подключайте БД к frontend/API/ORM без отдельного этапа.
- Повторный `docker compose up` на уже инициализированном volume не перезапускает `db/init/`.
