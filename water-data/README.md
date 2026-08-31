# water-data — локальная инфраструктура водных данных (AquaRoute E3.1)

## Зачем это

Каталог `water-data/` — **изолированный фундамент** для будущей локальной базы водных данных AquaRoute (PostgreSQL + PostGIS).

Сейчас это **только инфраструктура**: контейнер БД, минимальная схема и проверка, что PostGIS поднимается.  
Маршрутизация, WaterGraph, BRouter, Hybrid Router, Safety Validator, frontend и OSM/Overpass **не подключены** и не меняются.

## Что есть сейчас

- Docker Compose с официальным образом `postgis/postgis`
- БД `aquaroute_water`, пользователь `aquaroute`
- Порт хоста **5433** → 5432 в контейнере (чтобы реже конфликтовать с обычным PostgreSQL на 5432)
- Схема `water` и таблица метаданных `water.data_sources`
- Пароль только через `.env` (см. `.env.example`), не в коде

Полноценных таблиц графа (`water_objects`, `water_edges` и т.п.) **пока нет**.

## Запуск БД

Из каталога `water-data/`:

```bash
cp .env.example .env
# при необходимости отредактируйте POSTGRES_PASSWORD в .env

docker compose config   # проверка конфигурации
docker compose up -d
```

Первый старт выполняет SQL из `db/init/` (расширения и схема).

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
```

Ожидается: версия PostGIS, схема `water`, таблица `water.data_sources` с полями  
`id`, `source_name`, `source_version`, `imported_at`, `notes`.

## Что дальше (следующие этапы, не E3.1)

Предположительно:

- **E3.2** — таблицы хранения водных объектов/геометрии и правила импорта (без подключения к роутеру)
- позже — загрузка OSM/других источников, диагностика покрытия
- ещё позже — опциональная связь с WaterGraph / маршрутизацией (отдельные этапы, feature flags)

Production AquaRoute до тех пор остаётся прежним.

## Важно

- Не коммитьте файл `.env` с реальным паролем.
- Не подключайте эту БД к frontend/API/ORM без отдельного согласованного этапа.
- Повторный `docker compose up` на уже инициализированном volume **не** перезапускает скрипты из `db/init/`. Для чистой переинициализации: `docker compose down -v` и снова `up -d`.
