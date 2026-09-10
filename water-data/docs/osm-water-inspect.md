# OSM water inspect — Европейская часть России

Исследовательский debug `?russiaWaterTopologyDebug=1`. **Не WRG, не routing, не topology graph.**
`wg_edges` в репозитории нет и не создавался. `?seligerDebug=1` / `?seligerTopologyDebug=1` не менялись.

## Как открыть без туннеля

jsDelivr отдаёт HTML как `text/plain`, GitHub Pages этой ветки не деплоим (это production `main`). htmlpreview не исполняет Vite `type=module`, поэтому `open.html` грузит классический IIFE `inspect-iife.js` (fetch + eval).

Inspect включается флагом `window.__AQUAROUTE_OSM_INSPECT__` внутри `open.html`. Актуальная ссылка — в PR #88. Не production Pages.

## Как устроен Seliger debug (найденный прецедент)

| Режим | Данные | Backend |
|---|---|---|
| `?seligerDebug=1` | `seliger-399081-debug.geojson` | нет API, static fetch |
| `?seligerTopologyDebug=1` | `seliger-topology-debug.geojson` из PR #86 | нет API, static fetch, **без rediscovery** |

Оба режима short-circuit `bootFromQuery()` до WRG/BRouter.

Таблицы: Seliger overlay **не читает** `water.objects`. Topology graph — research JSON, не PostGIS.

## Что есть в БД (локальный extract, не вся Европейская Россия)

Postgres в этой среде не запущен (`:5433` нет). Цифры — fingerprint из E3.11 / E3.13, не runtime SQL.

После Карелия+ЛО (E3.11): **422327** `water.objects`, **186823** members.

После Вологды (E3.13): **455001** objects, **199570** members.

### E3.11 geometry / class (Карелия+ЛО)

| | count |
|---|---:|
| LINESTRING (centerlines) | 334620 |
| MULTIPOLYGON | 86397 |
| POLYGON | 51 |
| MULTILINESTRING | 416 |
| POINT | 843 |
| lake | 23845 |
| reservoir | 647 |
| river (centerline water_type) | 14527 |
| river_area | 3526 |
| canal | 733 |
| stream | 31778 |

**area + centerline как «связь»:** в БД такой join не хранится. Считать `ST_Contains` ради отчёта — это уже inference; в inspect это **не делается**. Совпадение видно глазами: polygon и line рисуются разными слоями.

**holes / MultiPolygon parts:** PostGIS MULTIPOLYGON сохраняет interiors, но агрегированной статистики holes в fingerprint нет. На карте inner rings рисуются отдельно (`mp-inner`), parts не сливаются.

## Покрытие extract vs Европейская Россия

Локальные PBF (пунктир на карте):

- Карелия ~29.3–37.97E, 60.73–66.75N
- Ленинградская обл. ~26.98–35.96E, 58.39–61.34N
- Вологодская обл. (после E3.13) — восточный хвост Волго-Балта

**Есть в extract:** Ладога, Онега, Нева, Финский залив (берег ЛО), Белое озеро, Волго-Балт (после Вологды).

**Нет в extract (inspect идёт в live OSM Overpass):** Селигер (Тверь), Волга / Рыбинск / Горьковское и прочие волжские водохранилища.

Европейская Россия целиком одним GeoJSON / одним SQL — слишком велика (оценка E3.11: 3–10M objects). Поэтому inspect — **ступенчатый viewport**:

| кадр | что видно |
|---|---|
| обзор Европейской России (span > 10° или z < 5) | справочные bbox из `water-bodies.json` (**не OSM-геометрия**) |
| z ≥ 5, span ≤ 10° | live OSM bbox named **lake/reservoir** (не полное кольцо, без нарезки river ways) |
| z ≥ 7, span ≤ 3° | все water polygons + river/canal centerlines |
| z ≥ 11, span ≤ 2.5° | плюс stream/ditch |

Раньше стоял жёсткий порог z≥8 и span≤2.4°, из‑за него начальный кадр и Ладога целиком были пустыми.

## Relation / multipolygon vs centerline

Классификация идёт по **тегам relation и role members**, не по длине геометрии.

- `type=multipolygon` + `natural=water` + `water=river` → **river-area** (заливка) + members как **MP outer/inner boundary**.
- Короткий незамкнутый outer (2–3 точки) **не** становится `centerline-other`.
- `waterway=river` way / `type=waterway` relation → настоящий **centerline**.
- Inspector не считает nearest polygon↔centerline. Поле «связи»: не вычисляются.

Пример: `relation/2406778` (Селижаровка → Волга). Жёлтая поперечная линия была `way/180396592`, untagged outer из 3 точек, не centerline. Настоящий centerline рядом: `way/28237778` (`waterway=river`, Селижаровка), плюс `way/28217744` (Волга).

## Что показывает режим

- water polygons (`natural=water`, lake / reservoir / river area)
- waterway centerlines (river / canal; stream с z≥11)
- на широком кадре — catalog bbox, не OSM
- MultiPolygon: каждый outer — отдельный polygon; inner — отдельный слой дыр
- polygon и centerline **рядом** = визуальный факт OSM, не ребро графа
- клик: OSM id, tags, geometry type, parts, holes, member roles relation. Без вычисленных связей. Catalog popup явно говорит, что это не OSM.

## Изменённые файлы

- `sea-map/src/osm-water-inspect.ts`
- `sea-map/src/osm-water-inspect-overlay.ts`
- `sea-map/src/__tests__/osm-water-inspect.test.ts`
- `sea-map/src/main.ts` (новый flag, Seliger ветки не тронуты)
- `sea-map/src/style.css`
- этот отчёт

Не изменены: WRG, BRouter, `wrg_route.py`, funnel, Area-Bridge, Seliger overlays, ingest, `water.objects` schema.
