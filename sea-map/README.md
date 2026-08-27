# AquaRoute

Онлайн-карта мира с прокладкой морских маршрутов по воде.

## Возможности

- Интерактивная карта мира (Leaflet + OpenStreetMap / Esri; опционально CARTO)
- Клик по карте: отправление → прибытие
- Быстрый выбор популярных портов
- Расчёт маршрута по судоходной сети Eurostat (`searoute-ts`)
- Дистанция в морских милях и ETA по скорости в узлах
- Ограничения: без Суэца / без Панамы, арктические проходы

## Запуск

```bash
cd sea-map
npm install
npm run dev
```

Сборка:

```bash
npm run build
npm run preview
```

### Базовая карта

По умолчанию тайлы без API-ключа: OpenStreetMap → Esri (failover).

CARTO Voyager опционален: задайте публичный ключ на этапе сборки
(не коммитьте значение в git):

```bash
export VITE_CARTO_API_KEY=your_public_carto_key
npm run build
```

Ключ можно получить бесплатно на [carto.com/basemaps/apikey](https://carto.com/basemaps/apikey/).
