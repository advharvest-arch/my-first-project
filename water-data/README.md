# water-data — локальная инфраструктура водных данных (AquaRoute E3.1–E3.2)

## Зачем это

Каталог `water-data/` — **изолированный фундамент** для будущей локальной базы водных данных AquaRoute (PostgreSQL + PostGIS).

Сейчас: контейнер БД + минимальная схема хранения исходных водных объектов.  
Маршрутизация, WaterGraph, BRouter, Hybrid Router, Safety Validator, frontend и OSM/Overpass **не подключены** и не меняются. Импорта данных пока нет.

## Что есть сейчас

- Docker Compose с официальным образом `postgis/postgis`
- БД `aquaroute_water`, пользователь `aquaroute`
- Порт хоста **5433** → 5432 в контейнере
- Схема `water`
- Таблица метаданных `water.data_sources` (E3.1)
- Таблица исходных объектов `water.objects` (E3.2)
- Пароль только через `.env` (см. `.env.example`)

Таблиц графа (`water_edges` и т.п.), synthetic connections и пайплайна импорта **пока нет**.

## Таблица `water.objects` (E3.2)

Хранит **исходный OSM water object** так, чтобы позже можно было проверить происхождение любой геометрии и не потерять полезные tags.

| Поле | Смысл |
|------|--------|
| `id` | Внутренний ключ БД |
| `osm_type` | Тип элемента OSM: `node` / `way` / `relation` |
| `osm_id` | Исходный OSM id (вместе с `osm_type` — уникальная личность объекта) |
| `name` | Название, если есть |
| `water_type` | **Наше** нормализованное представление (`river`, `canal`, `lake`, …) — **не** замена tags |
| `geometry` | Геометрия исходного объекта, **EPSG:4326** (WGS84) |
| `tags` | Полный набор исходных OSM tags (`JSONB`) — источник правды для аудита |
| `source` / `source_version` | Происхождение набора (например `osm` + дата/версия выгрузки) |
| `imported_at` | Когда строка попала в БД |

Уникальность: один OSM-объект = одна строка (`UNIQUE (osm_type, osm_id)`).

Индексы: GIST по `geometry`, btree по `water_type`, GIN по `tags` (удобно для `tags @> …`).

### Почему SRID 4326

OSM отдаёт координаты в WGS84 (lon/lat). Одна колонка `geometry(Geometry, 4326)` хранит Point / LineString / Polygon / Multi* без лишних преобразований при импорте. Для расстояний и «ближайших» объектов позже можно использовать `::geography` или проекцию в запросе — отдельная projected-колонка пока не нужна.

## Запуск БД

Из каталога `water-data/`:

```bash
cp .env.example .env
# при необходимости отредактируйте POSTGRES_PASSWORD в .env

docker compose config   # проверка конфигурации
docker compose up -d
```

Первый старт выполняет SQL из `db/init/` по порядку (`001` → `002` → `003`).

Если volume уже был создан на E3.1 **без** `003_objects.sql`, примените миграцию вручную:

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/init/003_objects.sql
```

Либо пересоздайте volume: `docker compose down -v && docker compose up -d`.

## Остановка БД

```bash
cd water-data
docker compose down
```

Данные в named volume `aquaroute_water_pgdata` сохраняются. Чтобы удалить и volume:

```bash
docker compose down -v
```

## Проверка подключения

```bash
cd water-data
docker compose exec db \
  psql -U aquaroute -d aquaroute_water -c '\conninfo'
```

С хоста (если установлен клиент `psql`):

```bash
psql "postgresql://aquaroute:<PASSWORD>@127.0.0.1:5433/aquaroute_water" -c 'SELECT 1;'
```

## Проверка PostGIS и схемы

```bash
docker compose exec db psql -U aquaroute -d aquaroute_water -c \
  "SELECT PostGIS_Version();"

docker compose exec db psql -U aquaroute -d aquaroute_water -c \
  "\dn water"

docker compose exec db psql -U aquaroute -d aquaroute_water -c \
  "\d water.data_sources"

docker compose exec db psql -U aquaroute -d aquaroute_water -c \
  "\d water.objects"
```

## Smoke test E3.2 (без реальных OSM-данных)

Проверяет наличие таблицы, SRID 4326, UNIQUE `(osm_type, osm_id)`, типы `geometry`/`jsonb` и индексы. Вставляет временную строку и удаляет её.

```bash
cd water-data
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e32_objects_smoke.sql
```

После успешного прогона в `water.objects` не должно остаться smoke-записей.

## E3.3 status (blocked on schema)

Offline import was **not** started: `water.objects` cannot store OSM relation **members** without either polluting `tags` or extending the schema.

See: [`docs/E3_3_RELATION_MEMBERS_SCHEMA_NEEDED.md`](docs/E3_3_RELATION_MEMBERS_SCHEMA_NEEDED.md)  
(tool comparison, Belomor probe `9909116`, proposed `water.object_members`).

Awaiting approval of that minimal extension before implementing `water-data/ingest/`.

## Что дальше (не выполняется здесь)

Предположительно:

- **E3.3 (resume)** — schema for members → offline import of a small Belomor extract → `water.objects` + `data_sources`
- **E3.4+** — larger extracts / coverage diagnostics (still without wiring the router)
- ещё позже — опциональная сборка WaterGraph из БД (отдельные этапы, feature flags)

Production AquaRoute до тех пор остаётся прежним.

## Важно

- Не коммитьте файл `.env` с реальным паролем.
- Не подключайте эту БД к frontend/API/ORM без отдельного согласованного этапа.
- Повторный `docker compose up` на уже инициализированном volume **не** перезапускает скрипты из `db/init/`. Для чистой переинициализации: `docker compose down -v` и снова `up -d`.
