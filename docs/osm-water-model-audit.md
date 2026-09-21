# OSM water model audit

Исследовательский отчёт: как OSM **на самом деле** кодирует воду на эталонных объектах Европейской России.

**Не топология.** Нет соединений полигон↔осевая линия, нет KNN, ST_DWithin, «одна река», принадлежности по имени или bbox.

Классификация тегов/ролей согласована с OSM Water Inspector (`sea-map/src/osm-water-inspect.ts`), но реализована отдельно в `water-data/research/osm_water_model_audit/`. Inspector не менялся.

Сгенерировано: `2026-09-21T08:41:28Z`

## Метод

- Источник: OSM API 0.6 (`relation/id`, пакетный `ways.json`, `way/id/relations`); координаты узлов не сохраняются, только списки node id. Overpass — запасной путь.
- Для relation скачиваются сам объект и **объявленные** члены `members[]`.
- Членство в relation — только из `members[]` скачанных relation (для way-seed: `rel(bw)`).
- Имена (`name=*`) использованы **только** на этапе поиска seed id; классификатор их не читает.
- `start_node_id` / `end_node_id` — идентификаторы OSM node, не координаты.

## Эталонные объекты

| key | поиск (не классификация) | OSM | скачан | class | geometry | члены |
|---|---|---|---|---|---|---:|
| `seliger` | Селигер | relation/399081 | yes | `polygon-lake` | `MultiPolygon` | 293 |
| `selizharovka` | Селижаровка | relation/379295 | yes | `waterway-relation` | `GeometryCollection` | 3 |
| `river_area_mouth` | river area (устьевой участок) | relation/2406778 | yes | `polygon-river-area` | `MultiPolygon` | 7 |
| `river_area_large` | river area (крупный участок) | relation/2580469 | yes | `polygon-river-area` | `MultiPolygon` | 133 |
| `ladoga` | Ладожское озеро | relation/21149039 | yes | `polygon-lake` | `MultiPolygon` | 11477 |
| `onega` | Онежское озеро | relation/1308279 | yes | `polygon-lake` | `MultiPolygon` | 8904 |
| `beloe` | Белое озеро | relation/1603199 | yes | `polygon-lake` | `MultiPolygon` | 60 |
| `rybinsk` | Рыбинское водохранилище | relation/1521563 | yes | `polygon-reservoir` | `MultiPolygon` | 639 |
| `volga` | Волга (крупный waterway) | relation/1730417 | yes | `waterway-relation` | `GeometryCollection` | 213 |
| `neva` | Нева | relation/2811903 | yes | `waterway-relation` | `GeometryCollection` | 46 |
| `river_way` | обычный waterway=river way | way/28237778 | yes | `centerline-river` | `LineString` | — |
| `lake_way` | natural=water озеро без relation | way/20542587 | yes | `polygon-lake` | `Polygon` | — |

## Сводная статистика

Счётчики **seed-объектов** (площадные классы) и **seed + объявленные члены** (осевые линии и mp-outer/inner). Дубликаты между разными relation не схлопываются: это не граф, а описание выборки.

| показатель | значение |
|---|---:|
| seed всего / скачано / нет | 12 / 12 / 0 |
| polygon-lake (seeds) | 5 |
| polygon-reservoir (seeds) | 1 |
| polygon-river-area (seeds) | 2 |
| centerline-river (seeds+members) | 249 |
| centerline-canal (seeds+members) | 12 |
| centerline-stream (seeds+members) | 2 |
| mp-outer (seeds+members) | 7023 |
| mp-inner (seeds+members) | 14490 |
| waterway-relation (seeds) | 3 |
| relation с outer | 7 |
| relation с inner | 7 |
| relation с main_stream | 3 |
| relation с side_stream | 2 |
| way без тегов в role=outer | 4136 |
| inner (члены role=inner / class mp-inner) | 14490 |

Классификация seed-объектов:

```json
{
  "polygon-lake": 5,
  "waterway-relation": 3,
  "polygon-river-area": 2,
  "polygon-reservoir": 1,
  "centerline-river": 1
}
```

Классификация объявленных членов:

```json
{
  "mp-inner": 14490,
  "mp-outer": 7023,
  "centerline-river": 248,
  "centerline-stream": 2,
  "centerline-canal": 12
}
```

## Неоднозначные случаи

- relation/399081 inner way/81741637 имеет `place=islet`: остров как дыра MP, не осевая линия.
- relation/2406778 inner way/273432251 имеет `place=islet`: остров как дыра MP, не осевая линия.
- way/180396592 объявлен членом нескольких MP (relation/2402229) — это OSM membership, не proximity.
- relation/21149039 inner way/722755371 имеет `place=islet`: остров как дыра MP, не осевая линия.
- relation/1308279 inner way/832910155 имеет `place=islet`: остров как дыра MP, не осевая линия.
- relation/1521563 inner way/345840445 имеет `place=islet`: остров как дыра MP, не осевая линия.
- relation/1730417: роли вне outer/inner/main_stream/side_stream: `spring`
- way/20542587: `natural=water` без `water=lake|reservoir|...`; класс polygon-lake по правилу Inspector (`natural=water`).
- way/20542587: way-озеро без parent relation в `rel(bw)` (не «дыра» в MP).

## Проверка way/180396592 в relation/2406778

**PASS.** `way/180396592` — `mp-outer`, `LineString`, 3 вершины, без тегов, не `centerline-other` / `other`.

- classification: `mp-outer`
- geometry_type: `LineString`
- vertex_count: `3`
- closed: `False`
- tags: _(нет тегов)_
- start_node_id: `1116557328`, end_node_id: `1116556802`
- другие **объявленные** parent relation (OSM membership, не proximity):
  - relation/2402229 role=`outer`

## Разница: осевая линия vs площадь реки

В OSM это **два разных типа объектов**, даже если человек читает оба как «река».

| | осевая линия | площадь реки |
|---|---|---|
| типичные теги | `waterway=river` (way) или `type=waterway` + `waterway=river` (relation) | `type=multipolygon` + `natural=water` + `water=river` |
| класс аудита | `centerline-river` / `waterway-relation` | `polygon-river-area` |
| геометрия | LineString / GeometryCollection из осевых way | MultiPolygon (кольца outer/inner) |
| Inspector | линия, не площадь | площадь, члены — граница MP |

Примеры в этой выборке:

- `way/28237778` — обычный `waterway=river` way → `centerline-river`, LineString.
- `relation/379295` — `type=waterway` Селижаровка → `waterway-relation`; члены с role `main_stream` классифицируются как осевые линии.
- `relation/2406778` и `relation/2580469` — `water=river` multipolygon → `polygon-river-area`. Их outer — **не** осевая линия.

## outer/inner — граница, не осевая линия

У `type=multipolygon` роли `outer` и `inner` описывают **кольца полигона** (береговая линия / остров). Way часто **без тегов** и **не замкнут**: кольцо собирается из нескольких way. Это граница площади, а не `waterway=*`.

Классификатор ставит `mp-outer` / `mp-inner` по **роли в MP**, даже если way открытый, из трёх вершин и без тегов. Иначе Inspector ошибочно показал бы `centerline-other`.

Контрольный пример: `way/180396592` (см. проверку выше).

## Сосуществование полигона и осевой линии (не связь)

OSM часто хранит **и** площадь, **и** осевую линию рядом. Это два объекта. Общая география / имя / близость **не** являются членством. Inspector и этот аудит связывают объекты только через `relation.members[]`.

В этой выборке (объявленное членство vs соседство):

- `relation/2406778` (polygon-river-area) **не** содержит `way/28237778` (`waterway=river`) в `members[]`. Осевая линия Селижаровки живёт в `relation/379295`. Аудит **не** соединяет их.
- `relation/379295` — waterway; `relation/2406778` — речная площадь. Разные `type=*`. Нет ребра «это одна река».
- Крупные озёра (Селигер, Ладога, Онега, Белое) — MP `water=lake`. Отдельные `waterway=river` way в OSM могут впадать в озеро; пока way не listed в `members[]` озера, это **не** член озера.
- Волга `relation/1730417` (`type=waterway`) — осевой relation, не площадь. Площади Волги в OSM — другие relation с `water=river` / `water=reservoir` (например Рыбинское `1521563`). Аудит не склеивает их по имени «Волга».

## Relation `type=waterway` и `main_stream`

- `relation/379295` (Селижаровка) class=`waterway-relation` main_stream=3 side_stream=0 outer=0 inner=0 other=0
  - примеры main_stream: way/28838371, way/28237780, way/28237778
  - первый член: class=`centerline-river` geom=`LineString` tags: `boat=no`, `canoe=yes`, `name=Селижаровка`, `waterway=river`
- `relation/1730417` (Волга (крупный waterway)) class=`waterway-relation` main_stream=199 side_stream=13 outer=0 inner=0 other=1
  - примеры main_stream: way/48311065, way/381692957, way/48311069, way/28217744, way/28217742, way/104307554, way/104307634, way/28215857, way/107423527, way/104307524, way/104307611, way/105444502 … +187
  - первый член: class=`centerline-stream` geom=`LineString` tags: `gvr:code=08010100112110000000017`, `name=Волга`, `name:af=Wolga`, `name:am=ቮልጋ ወንዝ`, `name:an=Río Volga`, `name:ar=نهر الفولغا`, `name:as=ভল্গা নদী`, `name:ay=Volga`, `name:az=Volqa`, `name:be=Рака Волга`, `name:bh=वोल्गा`, `name:bn=ভোলগা নদী`, `name:bo=ཧྥོར་ཅཱ་གཙང་པོ།`, `name:br=Volga`, `name:bs=Volga`, `name:ca=Riu Volga`, `name:cs=Volha`, `name:cu=Вльга`, `name:cv=Атăл`, `name:cy=Afon Volga`, `name:da=Volga`, `name:de=Wolga`, `name:el=Βόλγας`, `name:en=Volga`, `name:eo=Volgo`, `name:es=Volga`, `name:et=Volga`, `name:eu=Volga`, `name:fa=رود ولگا`, `name:fi=Volga`, `name:fo=Volga`, `name:fr=La Volga`, `name:fy=Wolga`, `name:ga=An Volga`, `name:gl=Río Volga`, `name:gn=Volga`, `name:he=וולגה`, `name:hi=वोल्गा नदी`, `name:hr=Volga`, `name:hu=Volga`, `name:hy=Վոլգա`, `name:ia=Fluvio Volga`, `name:id=Sungai Volga`, `name:io=Volga`, `name:is=Volga`, `name:it=Volga`, `name:ja=ヴォルガ川`, `name:jv=Kali Volga`, `name:ka=ვოლგა`, `name:kk=Еділ`, `name:kn=ವೋಲ್ಗಾ ನದಿ`, `name:ko=볼가강`, `name:ku=Volga`, `name:ky=Волга дарыясы`, `name:la=Rha`, `name:lb=Wolga`, `name:li=Volga`, `name:lt=Volga`, `name:lv=Volga`, `name:ml=വോൾഗ നദി`, `name:mn=Ижил`, `name:mr=वोल्गा नदी`, `name:ms=Sungai Volga`, `name:my=ဗော်လ်ဂါမြစ်`, `name:na=Volga`, `name:nl=Wolga`, `name:nn=Volga`, `name:no=Volga`, `name:ny=Mtsinje wa Volga`, `name:oc=Vòlga`, `name:os=Волгæ`, `name:pa=ਵੋਲਗਾ ਦਰਿਆ`, `name:pl=Wołga`, `name:pt=Rio Volga`, `name:rm=Volga`, `name:ro=Volga`, `name:ru=Волга`, `name:sk=Volga`, `name:sl=Volga`, `name:sq=Vollga`, `name:sv=Volga`, `name:sw=Volga`, `name:ta=வோல்கா ஆறு`, `name:te=వోల్గా నది`, `name:tg=Волга`, `name:th=แม่น้ำวอลกา`, `name:tk=Wolga`, `name:tl=Ilog Volga`, `name:tr=İdil Nehri`, `name:tt=Идел`, `name:ug=ۋولگا دەرياسى`, `name:uk=Волга`, `name:ur=دریائے وولگا`, `name:uz=Volga`, `name:vi=Sông Volga`, `name:vo=Volga`, `name:yi=וואלגא`, `name:zh=伏尔加河`, `waterway=stream`
- `relation/2811903` (Нева) class=`waterway-relation` main_stream=36 side_stream=10 outer=0 inner=0 other=0
  - примеры main_stream: way/23567397, way/128486700, way/125178901, way/121660132, way/121660130, way/125192458, way/128486702, way/24219658, way/121803178, way/128486698, way/508157668, way/508157667 … +24
  - первый член: class=`centerline-river` geom=`LineString` tags: `CEMT=Vb`, `admin_level=6`, `boat=yes`, `boundary=administrative`, `have_riverbank=yes`, `name=Нева`, `name:bg=Нева`, `name:ca=Riu Neva`, `name:de=Newa`, `name:en=Neva`, `name:es=Río Neva`, `name:fi=Neva`, `name:fr=Neva`, `name:hr=Neva`, `name:ja=ネヴァ川`, `name:nl=Neva`, `name:ru=Нева`, `name:sv=Neva`, `name:zh=涅瓦河`, `waterway=river`, `wikidata=Q645`, `wikipedia=ru:Нева`

Роль `main_stream` не превращает way в полигон и не доказывает связь с соседним `water=river` multipolygon.

## Объекты

### Селигер — relation/399081

- classification: `polygon-lake`
- geometry_type: `MultiPolygon`
- fetch: `osm-api`
- tags: `ele=205`, `name=Селигер`, `name:ca=Llac Seliguer`, `name:de=Seligersee`, `name:en=Seliger`, `name:et=Seliger`, `name:ru=озеро Селигер`, `name:zh=谢利格尔湖`, `natural=water`, `type=multipolygon`, `water=lake`, `wikidata=Q746304`, `wikipedia=ru:Селигер`
- членство в relation:
нет (элемент не входит в скачанные parent relation)

- члены: 293 (outer=115, inner=178, main_stream=0, side_stream=0, other=0)

| role | type | id | classification | geometry | vertices | closed | start node | end node | tags |
|---|---|---:|---|---|---:|---|---:|---:|---|
| inner | way | 449889204 | mp-inner | Polygon | 12 | yes | 4468061726 | 4468061726 | — |
| outer | way | 141771495 | mp-outer | LineString | 744 | no | 779787160 | 1551827337 | — |
| outer | way | 49215824 | mp-outer | LineString | 67 | no | 220248055 | 779787160 | — |
| outer | way | 22998753 | mp-outer | LineString | 246 | no | 624633937 | 220248055 | — |
| outer | way | 191300204 | mp-outer | LineString | 12 | no | 1871260812 | 624633937 | — |
| outer | way | 191300215 | mp-outer | LineString | 232 | no | 2018880590 | 1871260812 | — |
| outer | way | 191300221 | mp-outer | LineString | 3 | no | 2018880568 | 2018880590 | — |
| outer | way | 191468194 | mp-outer | LineString | 56 | no | 2020423096 | 2018880568 | — |
| outer | way | 191468170 | mp-outer | LineString | 159 | no | 624633921 | 2020423096 | — |
| outer | way | 191468190 | mp-outer | LineString | 37 | no | 1871260846 | 624633921 | — |
| outer | way | 22998746 | mp-outer | LineString | 5 | no | 247941857 | 1871260846 | — |
| outer | way | 1501165081 | mp-outer | LineString | 7 | no | 1866515956 | 247941857 | — |
| outer | way | 1501165082 | mp-outer | LineString | 6 | no | 13743356918 | 1866515956 | — |
| outer | way | 1501165080 | mp-outer | LineString | 14 | no | 13743356914 | 13743356918 | — |
| outer | way | 1501165076 | mp-outer | LineString | 5 | no | 4336670296 | 13743356914 | — |
| outer | way | 1501165073 | mp-outer | LineString | 4 | no | 13743356871 | 4336670296 | — |
| outer | way | 1501165074 | mp-outer | LineString | 3 | no | 13743356878 | 13743356871 | — |
| outer | way | 1501165077 | mp-outer | LineString | 4 | no | 4336659191 | 13743356878 | — |
| outer | way | 1501165064 | mp-outer | LineString | 23 | no | 13743356789 | 4336659191 | — |
| outer | way | 1501165063 | mp-outer | LineString | 3 | no | 13743356790 | 13743356789 | — |
| outer | way | 1501165062 | mp-outer | LineString | 14 | no | 1866515998 | 13743356790 | — |
| outer | way | 1501165060 | mp-outer | LineString | 17 | no | 13743356818 | 1866515998 | — |
| outer | way | 1501165059 | mp-outer | LineString | 3 | no | 13743356764 | 13743356818 | — |
| outer | way | 1501165057 | mp-outer | LineString | 3 | no | 13743356821 | 13743356764 | — |
| outer | way | 1501165065 | mp-outer | LineString | 16 | no | 13743356836 | 13743356821 | — |
| … | | | | | | | | | ещё 268 членов — полный список в JSON |

### Селижаровка — relation/379295

- classification: `waterway-relation`
- geometry_type: `GeometryCollection`
- fetch: `osm-api`
- tags: `destination=Volga`, `name=Селижаровка`, `type=waterway`, `waterway=river`, `wikidata=Q289638`, `wikipedia=ru:Селижаровка`
- членство в relation:
нет (элемент не входит в скачанные parent relation)

- члены: 3 (outer=0, inner=0, main_stream=3, side_stream=0, other=0)

| role | type | id | classification | geometry | vertices | closed | start node | end node | tags |
|---|---|---:|---|---|---:|---|---:|---:|---|
| main_stream | way | 28838371 | centerline-river | LineString | 455 | no | 247941768 | 310147304 | boat=no, canoe=yes, name=Селижаровка, waterway=river |
| main_stream | way | 28237780 | centerline-river | LineString | 172 | no | 310147304 | 310147238 | boat=no, canoe=yes, name=Селижаровка, source=landsat, waterway=river |
| main_stream | way | 28237778 | centerline-river | LineString | 184 | no | 310147238 | 309927304 | boat=no, canoe=yes, name=Селижаровка, source=landsat, waterway=river |

### river area (устьевой участок) — relation/2406778

- classification: `polygon-river-area`
- geometry_type: `MultiPolygon`
- fetch: `osm-api`
- tags: `natural=water`, `type=multipolygon`, `water=river`
- членство в relation:
нет (элемент не входит в скачанные parent relation)

- члены: 7 (outer=5, inner=2, main_stream=0, side_stream=0, other=0)

| role | type | id | classification | geometry | vertices | closed | start node | end node | tags |
|---|---|---:|---|---|---:|---|---:|---:|---|
| inner | way | 273432251 | mp-inner | Polygon | 32 | yes | 4774069232 | 4774069232 | place=islet |
| inner | way | 858881074 | mp-inner | Polygon | 31 | yes | 8006436113 | 8006436113 | — |
| outer | way | 180396592 | mp-outer | LineString | 3 | no | 1116557328 | 1116556802 | — |
| outer | way | 180396594 | mp-outer | LineString | 194 | no | 1116557328 | 1116556674 | — |
| outer | way | 191714173 | mp-outer | LineString | 3 | no | 1116556674 | 1116556867 | — |
| outer | way | 191714151 | mp-outer | LineString | 176 | no | 1116556867 | 1835527318 | — |
| outer | way | 180396620 | mp-outer | LineString | 9 | no | 1835527318 | 1116556802 | — |

### river area (крупный участок) — relation/2580469

- classification: `polygon-river-area`
- geometry_type: `MultiPolygon`
- fetch: `osm-api`
- tags: `natural=water`, `type=multipolygon`, `water=river`
- членство в relation:
нет (элемент не входит в скачанные parent relation)

- члены: 133 (outer=128, inner=5, main_stream=0, side_stream=0, other=0)

| role | type | id | classification | geometry | vertices | closed | start node | end node | tags |
|---|---|---:|---|---|---:|---|---:|---:|---|
| inner | way | 191573386 | mp-inner | Polygon | 31 | yes | 2021566340 | 2021566340 | — |
| inner | way | 191573388 | mp-inner | Polygon | 38 | yes | 2021564712 | 2021564712 | — |
| outer | way | 191573385 | mp-outer | LineString | 2 | no | 1874386134 | 1874386149 | source=Bing |
| inner | way | 191300210 | mp-inner | Polygon | 18 | yes | 2018878046 | 2018878046 | — |
| inner | way | 191300207 | mp-inner | Polygon | 16 | yes | 2018878821 | 2018878821 | — |
| inner | way | 191300211 | mp-inner | Polygon | 19 | yes | 2018879074 | 2018879074 | source=Bing |
| outer | way | 191300221 | mp-outer | LineString | 3 | no | 2018880568 | 2018880590 | — |
| outer | way | 191300255 | mp-outer | LineString | 60 | no | 2018880590 | 2018879410 | source=Bing |
| outer | way | 191300217 | mp-outer | LineString | 3 | no | 2018879410 | 2018879326 | source=Bing |
| outer | way | 191300227 | mp-outer | LineString | 95 | no | 2018879326 | 2018878212 | source=Bing |
| outer | way | 191304303 | mp-outer | LineString | 7 | no | 2018878212 | 2018878114 | source=Bing |
| outer | way | 191304296 | mp-outer | LineString | 13 | no | 2018878114 | 2018877990 | source=Bing |
| outer | way | 191304300 | mp-outer | LineString | 4 | no | 2018877990 | 1162228236 | source=Bing |
| outer | way | 191304298 | mp-outer | LineString | 34 | no | 1162228236 | 1162227481 | source=Bing |
| outer | way | 191405410 | mp-outer | LineString | 5 | no | 1162227481 | 1162228376 | source=Bing |
| outer | way | 191405387 | mp-outer | LineString | 13 | no | 1162228376 | 2020422595 | source=Bing |
| outer | way | 191468196 | mp-outer | LineString | 6 | no | 2020422595 | 2018877512 | source=Bing |
| outer | way | 191468172 | mp-outer | LineString | 18 | no | 2018877512 | 1162229520 | source=Bing |
| outer | way | 191468193 | mp-outer | LineString | 5 | no | 1162229520 | 1162227314 | source=Bing |
| outer | way | 191468171 | mp-outer | LineString | 17 | no | 1162227314 | 1162228675 | source=Bing |
| outer | way | 191468166 | mp-outer | LineString | 10 | no | 1162228675 | 1162229862 | source=Bing |
| outer | way | 191468168 | mp-outer | LineString | 19 | no | 1162229862 | 1162229606 | source=Bing |
| outer | way | 191615992 | mp-outer | LineString | 8 | no | 1162229606 | 2021567321 | source=Bing |
| outer | way | 191615886 | mp-outer | LineString | 17 | no | 2021567321 | 1162228653 | source=Bing |
| outer | way | 191615840 | mp-outer | LineString | 11 | no | 1162228653 | 2021567281 | source=Bing |
| … | | | | | | | | | ещё 108 членов — полный список в JSON |

### Ладожское озеро — relation/21149039

- classification: `polygon-lake`
- geometry_type: `MultiPolygon`
- fetch: `osm-api`
- tags: `alt_name=Ладога`, `alt_name:hr=Ladoško jezero`, `alt_name:ru=Ладога`, `ele=4.84`, `gvr:code=01040300411102000010114`, `image=https://upload.wikimedia.org/wikipedia/commons/d/db/Sortavalan_saaristoa.jpg`, `int_name=Ladoga lake`, `lake=major`, `name=Ладожское озеро`, `name:ca=Llac Làdoga`, `name:cs=Ladožské jezero`, `name:de=Ladogasee`, `name:en=Lake Ladoga`, `name:et=Laadoga järv`, `name:fi=Laatokka`, `name:fr=Lac Ladoga`, `name:hr=Ladoga`, `name:hu=Ladoga-tó`, `name:is=Ladogavatn`, `name:it=Lago Ladoga`, `name:krl=Luadogu`, `name:nl=Ladogameer`, `name:pl=Jezioro Ładoga`, `name:ru=Ладожское озеро`, `name:sk=Ladožské jazero`, `name:sv=Ladoga`, `name:uk=Ладозьке озеро`, `name:vep=Ladoganjärv`, `name:zh=拉多加湖`, `natural=water`, `old_name=Нево`, `old_name:is=Aldeigjuvatn`, `salt=no`, `sqkm=17870`, `tidal=yes`, `type=multipolygon`, `water=lake`, `wikidata=Q15288`, `wikimedia_commons=Category:Lake Ladoga`, `wikipedia=ru:Ладожское озеро`
- членство в relation:
нет (элемент не входит в скачанные parent relation)

- члены: 11477 (outer=2767, inner=8710, main_stream=0, side_stream=0, other=0)

| role | type | id | classification | geometry | vertices | closed | start node | end node | tags |
|---|---|---:|---|---|---:|---|---:|---:|---|
| inner | way | 305943608 | mp-inner | Polygon | 9 | yes | 3106430980 | 3106430980 | natural=bare_rock |
| inner | way | 305943604 | mp-inner | Polygon | 4 | yes | 3106430956 | 3106430956 | natural=bare_rock |
| inner | way | 305837947 | mp-inner | Polygon | 8 | yes | 3105239160 | 3105239160 | natural=bare_rock |
| inner | way | 305837948 | mp-inner | Polygon | 11 | yes | 3105239175 | 3105239175 | natural=bare_rock |
| inner | way | 1552390610 | mp-inner | LineString | 8 | no | 14123686399 | 14123686282 | — |
| inner | way | 1552390609 | mp-inner | LineString | 4 | no | 14123686282 | 14123686281 | — |
| inner | way | 1552390608 | mp-inner | LineString | 3 | no | 14123686281 | 14123686262 | — |
| inner | way | 280833344 | mp-inner | LineString | 41 | no | 14123686262 | 14123686676 | — |
| inner | way | 1552390643 | mp-inner | LineString | 20 | no | 14123686695 | 14123686676 | — |
| inner | way | 1552390560 | mp-inner | LineString | 53 | no | 14123686747 | 14123686695 | — |
| inner | way | 1552390559 | mp-inner | LineString | 56 | no | 14123686802 | 14123686747 | — |
| inner | way | 1552390556 | mp-inner | LineString | 33 | no | 14123686834 | 14123686802 | — |
| inner | way | 1553007587 | mp-inner | LineString | 6 | no | 14123686839 | 14123686834 | — |
| inner | way | 1553007602 | mp-inner | LineString | 17 | no | 14123686855 | 14123686839 | — |
| inner | way | 1553007590 | mp-inner | LineString | 2 | no | 14123686856 | 14123686855 | — |
| inner | way | 1553007593 | mp-inner | LineString | 3 | no | 14123686858 | 14123686856 | — |
| inner | way | 1553007603 | mp-inner | LineString | 19 | no | 14129556816 | 14123686858 | — |
| inner | way | 1553007599 | mp-inner | LineString | 5 | no | 14123686879 | 14129556816 | — |
| inner | way | 1553007600 | mp-inner | LineString | 12 | no | 14123686890 | 14123686879 | — |
| inner | way | 1553007596 | mp-inner | LineString | 3 | no | 14123686892 | 14123686890 | — |
| inner | way | 1552390648 | mp-inner | LineString | 17 | no | 14123686908 | 14123686892 | — |
| inner | way | 1552390589 | mp-inner | LineString | 19 | no | 14123686926 | 14123686908 | — |
| inner | way | 1552390590 | mp-inner | LineString | 5 | no | 14123686930 | 14123686926 | — |
| inner | way | 1552390639 | mp-inner | LineString | 64 | no | 14123686993 | 14123686930 | — |
| inner | way | 1552390646 | mp-inner | LineString | 3 | no | 14123686993 | 14123686605 | — |
| … | | | | | | | | | ещё 11452 членов — полный список в JSON |

### Онежское озеро — relation/1308279

- classification: `polygon-lake`
- geometry_type: `MultiPolygon`
- fetch: `osm-api`
- tags: `alt_name=Онего`, `alt_name:hr=Onega`, `ele=33`, `gvr:code=01040100611102000016332`, `image=https://upload.wikimedia.org/wikipedia/commons/7/79/2_июля_2011._Отдых_на_Янигубе._-_panoramio_(2).jpg`, `name=Онежское озеро`, `name:ar=بحيرة أونيغا`, `name:az=Oneqa gölü`, `name:be=Анежскае возера`, `name:bg=Онежко езеро`, `name:bo=ཨའོ་ཉེ་ཅ་མཚེའུ།`, `name:ca=Onega`, `name:cs=Oněžské jezero`, `name:cv=Онега кӳлли`, `name:cy=Llyn Onega`, `name:da=Onega`, `name:de=Onegasee`, `name:el=Λίμνη Ονέγκα`, `name:en=Lake Onega`, `name:eo=Onega`, `name:es=Lago Onega`, `name:et=Äänisjärv`, `name:eu=Onega`, `name:fa=دریاچه اونگا`, `name:fi=Ääninen`, `name:fr=Lac Onega`, `name:fy=Onegamar`, `name:gl=Lago Onega`, `name:he=ימת אונגה`, `name:hi=ओनेगा झील`, `name:hr=Onjega`, `name:hu=Onyega-tó`, `name:hy=Օնեգա լիճ`, `name:id=Danau Onega`, `name:is=Onegavatn`, `name:it=Lago Onega`, `name:ja=オネガ湖`, `name:ka=ონეგის ტბა`, `name:ko=오네가 호`, `name:krl=Ääninen`, `name:ky=Онега көлү`, `name:la=Lacus Onega`, `name:lt=Onega`, `name:lv=Oņegas ezers`, `name:mk=Онега`, `name:nl=Onegameer`, `name:nn=Onegasjøen`, `name:no=Onega`, `name:pl=Onega`, `name:pt=Lago Onega`, `name:qu=Onega qucha`, `name:ro=Lacul Onega`, `name:ru=Онежское озеро`, `name:sk=Onežské jazero`, `name:sl=Oneško jezero`, `name:sr=Оњега`, `name:sv=Onega`, `name:sw=Ziwa Onega`, `name:th=ทะเลสาบโอเนกา`, `name:tr=Onega Gölü`, `name:uk=Онезьке озеро`, `name:uz=Onega`, `name:vi=Hồ Onega`, `name:zh=奥涅加湖`, `natural=water`, `salt=no`, `sqkm=9720`, `type=multipolygon`, `water=lake`, `wikidata=Q166162`, `wikimedia_commons=Category:Lake Onega`, `wikipedia=ru:Онежское озеро`
- членство в relation:
нет (элемент не входит в скачанные parent relation)

- члены: 8904 (outer=3720, inner=5184, main_stream=0, side_stream=0, other=0)

| role | type | id | classification | geometry | vertices | closed | start node | end node | tags |
|---|---|---:|---|---|---:|---|---:|---:|---|
| outer | way | 1517823715 | mp-outer | LineString | 67 | no | 8024150078 | 4654344067 | — |
| outer | way | 1541084254 | mp-outer | LineString | 31 | no | 4654344067 | 4654344048 | — |
| outer | way | 1542796759 | mp-outer | LineString | 6 | no | 4654344048 | 4654344069 | — |
| outer | way | 1542796755 | mp-outer | LineString | 10 | no | 4654344069 | 4654344036 | — |
| outer | way | 1542796750 | mp-outer | LineString | 6 | no | 4654344036 | 4654344022 | — |
| outer | way | 471266881 | mp-outer | LineString | 75 | no | 4654344022 | 4654342976 | — |
| outer | way | 1541084181 | mp-outer | LineString | 4 | no | 4654342976 | 4654343173 | — |
| outer | way | 1541084187 | mp-outer | LineString | 2 | no | 4654343173 | 4654343121 | — |
| outer | way | 1541084186 | mp-outer | LineString | 2 | no | 4654343121 | 4654342912 | — |
| outer | way | 1541084185 | mp-outer | LineString | 2 | no | 4654342912 | 4654342659 | — |
| outer | way | 1541084184 | mp-outer | LineString | 55 | no | 4654342659 | 8024345817 | — |
| outer | way | 1541084191 | mp-outer | LineString | 7 | no | 8024345817 | 4654342684 | — |
| outer | way | 1541084190 | mp-outer | LineString | 128 | no | 4654342684 | 8026929567 | — |
| outer | way | 1541084196 | mp-outer | LineString | 9 | no | 8026929567 | 8026929573 | — |
| outer | way | 1541084199 | mp-outer | LineString | 22 | no | 8026929573 | 8026910166 | — |
| outer | way | 1541084198 | mp-outer | LineString | 53 | no | 8026910166 | 8026935601 | — |
| outer | way | 1541084194 | mp-outer | LineString | 4 | no | 8026935601 | 8026935604 | — |
| outer | way | 1541084193 | mp-outer | LineString | 16 | no | 8026935604 | 8026935615 | — |
| outer | way | 1541084210 | mp-outer | LineString | 34 | no | 8026935615 | 8026935637 | — |
| outer | way | 1541084251 | mp-outer | LineString | 30 | no | 8026935637 | 4654343137 | source=ESRI, source:position=ESRI (0;0) |
| outer | way | 1541084253 | mp-outer | LineString | 14 | no | 4654343137 | 4651123467 | — |
| outer | way | 1540977121 | mp-outer | LineString | 115 | no | 4651123467 | 8034528907 | — |
| outer | way | 1541013012 | mp-outer | LineString | 10 | no | 8034528907 | 8034528930 | — |
| outer | way | 1540977120 | mp-outer | LineString | 3 | no | 8034528930 | 8034528932 | source=ESRI, source:position=ESRI (0;0) |
| outer | way | 1540950904 | mp-outer | LineString | 204 | no | 8034528932 | 289919880 | source=ESRI, source:position=ESRI (0;0) |
| … | | | | | | | | | ещё 8879 членов — полный список в JSON |

### Белое озеро — relation/1603199

- classification: `polygon-lake`
- geometry_type: `MultiPolygon`
- fetch: `osm-api`
- tags: `gvr:code=08010200311110000003908`, `lake=major`, `name=Белое озеро`, `name:cs=Bílé jezero`, `name:cv=Шурă кӳлĕ`, `name:de=Weißer See`, `name:en=Lake Beloye`, `name:es=Lago Béloye`, `name:et=Valgjärv`, `name:eu=Beloie aintzira`, `name:fi=Valkeajärvi`, `name:fr=Lac Beloïe`, `name:it=Lago Bianco`, `name:ja=ベロエ湖`, `name:lt=Belojės ežeras`, `name:lv=Beloje`, `name:nl=Belojemeer`, `name:nn=Belojesjøen`, `name:no=Belojesjøen`, `name:pl=Jezioro Białe`, `name:ru=Белое озеро`, `name:sk=Biele jazero`, `name:sr=Бело језеро`, `name:sv=Beloje ozero`, `name:uk=Біле озеро`, `name:uz=Beloye koʻli`, `name:zh=白湖`, `natural=water`, `type=multipolygon`, `water=lake`, `wikidata=Q953140`, `wikipedia=ru:Белое озеро (Вологодская область)`
- членство в relation:
нет (элемент не входит в скачанные parent relation)

- члены: 60 (outer=32, inner=28, main_stream=0, side_stream=0, other=0)

| role | type | id | classification | geometry | vertices | closed | start node | end node | tags |
|---|---|---:|---|---|---:|---|---:|---:|---|
| inner | way | 876135773 | mp-inner | Polygon | 22 | yes | 8154498612 | 8154498612 | — |
| inner | way | 856708994 | mp-inner | Polygon | 22 | yes | 7987642610 | 7987642610 | — |
| inner | way | 856601632 | mp-inner | Polygon | 12 | yes | 7986678463 | 7986678463 | — |
| inner | way | 856601633 | mp-inner | Polygon | 15 | yes | 7986678477 | 7986678477 | — |
| inner | way | 856601083 | mp-inner | Polygon | 18 | yes | 7986678608 | 7986678608 | — |
| inner | way | 856601086 | mp-inner | Polygon | 24 | yes | 7986678656 | 7986678656 | — |
| inner | way | 856601084 | mp-inner | Polygon | 14 | yes | 7986678621 | 7986678621 | — |
| inner | way | 856601085 | mp-inner | Polygon | 13 | yes | 7986678633 | 7986678633 | — |
| inner | way | 856325439 | mp-inner | Polygon | 15 | yes | 7984550134 | 7984550134 | — |
| inner | way | 856324239 | mp-inner | Polygon | 15 | yes | 7984555760 | 7984555760 | — |
| inner | way | 856324240 | mp-inner | Polygon | 13 | yes | 7984555772 | 7984555772 | — |
| inner | way | 856324241 | mp-inner | Polygon | 14 | yes | 7984563885 | 7984563885 | — |
| inner | way | 856324245 | mp-inner | Polygon | 35 | yes | 7984563960 | 7984563960 | — |
| inner | way | 856324244 | mp-inner | Polygon | 18 | yes | 7984563926 | 7984563926 | — |
| inner | way | 856324243 | mp-inner | Polygon | 13 | yes | 7984563909 | 7984563909 | — |
| inner | way | 856324242 | mp-inner | Polygon | 13 | yes | 7984563897 | 7984563897 | — |
| inner | way | 856322923 | mp-inner | Polygon | 18 | yes | 7984551734 | 7984551734 | — |
| inner | way | 856322921 | mp-inner | Polygon | 28 | yes | 7984551697 | 7984551697 | — |
| inner | way | 856322922 | mp-inner | Polygon | 21 | yes | 7984551717 | 7984551717 | — |
| inner | way | 856321858 | mp-inner | Polygon | 70 | yes | 7984544800 | 7984544800 | — |
| inner | way | 856321857 | mp-inner | Polygon | 18 | yes | 7984544731 | 7984544731 | — |
| inner | way | 856321856 | mp-inner | Polygon | 19 | yes | 7984544714 | 7984544714 | — |
| inner | way | 856321859 | mp-inner | Polygon | 184 | yes | 7984544974 | 7984544974 | — |
| inner | way | 856321860 | mp-inner | Polygon | 25 | yes | 7984544998 | 7984544998 | — |
| inner | way | 856274569 | mp-inner | Polygon | 22 | yes | 7984119806 | 7984119806 | — |
| inner | way | 856274568 | mp-inner | Polygon | 23 | yes | 7984119799 | 7984119799 | — |
| outer | way | 23131446 | mp-outer | LineString | 162 | no | 249756938 | 249761165 | — |
| outer | way | 115606459 | mp-outer | LineString | 788 | no | 703844728 | 249756938 | — |
| outer | way | 115606498 | mp-outer | LineString | 790 | no | 251830789 | 703844728 | — |
| outer | way | 115614890 | mp-outer | LineString | 151 | no | 249629732 | 251830789 | — |
| outer | way | 285000731 | mp-outer | LineString | 55 | no | 2886991531 | 249629732 | — |
| outer | way | 285000733 | mp-outer | LineString | 62 | no | 2886991501 | 2886991531 | — |
| outer | way | 115614864 | mp-outer | LineString | 163 | no | 1305727905 | 2886991501 | — |
| outer | way | 115528407 | mp-outer | LineString | 177 | no | 249629865 | 1305727905 | — |
| outer | way | 23131137 | mp-outer | LineString | 8 | no | 811394362 | 249629865 | admin_level=6, boundary=administrative |
| outer | way | 515166039 | mp-outer | LineString | 43 | no | 5031804318 | 811394362 | — |
| outer | way | 515166038 | mp-outer | LineString | 27 | no | 249629850 | 5031804318 | — |
| outer | way | 515166040 | mp-outer | LineString | 12 | no | 703414859 | 249629850 | — |
| outer | way | 515166041 | mp-outer | LineString | 7 | no | 703414804 | 703414859 | — |
| outer | way | 515166044 | mp-outer | LineString | 35 | no | 703414872 | 703414804 | — |
| outer | way | 515166045 | mp-outer | LineString | 2 | no | 5031804661 | 703414872 | — |
| outer | way | 515176453 | mp-outer | LineString | 2 | no | 11472835351 | 5031804661 | — |
| outer | way | 1235815951 | mp-outer | LineString | 2 | no | 11472872143 | 11472835351 | — |
| outer | way | 1235815796 | mp-outer | LineString | 3 | no | 11472883471 | 11472872143 | — |
| outer | way | 1235815795 | mp-outer | LineString | 6 | no | 1644722271 | 11472883471 | — |
| outer | way | 515176456 | mp-outer | LineString | 139 | no | 249757131 | 1644722271 | — |
| outer | way | 1303840144 | mp-outer | LineString | 35 | no | 12074836124 | 249757131 | — |
| outer | way | 1303840145 | mp-outer | LineString | 6 | no | 12074836122 | 12074836124 | — |
| outer | way | 115191048 | mp-outer | LineString | 320 | no | 1302390030 | 12074836122 | — |
| outer | way | 115173061 | mp-outer | LineString | 77 | no | 249757089 | 1302390030 | — |
| outer | way | 115172936 | mp-outer | LineString | 636 | no | 7979894127 | 249757089 | — |
| outer | way | 895044812 | mp-outer | LineString | 631 | no | 7984504067 | 7979894127 | — |
| outer | way | 895044813 | mp-outer | LineString | 24 | no | 249756983 | 7984504067 | — |
| outer | way | 115173034 | mp-outer | LineString | 3 | no | 1045663120 | 249756983 | — |
| outer | way | 116021677 | mp-outer | LineString | 2 | no | 249756963 | 1045663120 | — |
| outer | way | 115606467 | mp-outer | LineString | 349 | no | 249761145 | 249756963 | — |
| outer | way | 118892429 | mp-outer | LineString | 455 | no | 249760999 | 249761145 | — |
| outer | way | 118892428 | mp-outer | LineString | 3 | no | 249761165 | 249760999 | — |
| inner | way | 856347706 | mp-inner | Polygon | 45 | yes | 7984755037 | 7984755037 | — |
| inner | way | 856347707 | mp-inner | Polygon | 38 | yes | 7984755074 | 7984755074 | — |

### Рыбинское водохранилище — relation/1521563

- classification: `polygon-reservoir`
- geometry_type: `MultiPolygon`
- fetch: `osm-api`
- tags: `alt_name:cs=Rybinská přehrada`, `ele=102`, `is_in:country_code=RU`, `loc_name=Рыбинское море`, `name=Рыбинское водохранилище`, `name:be=Рыбінскае вадасховішча`, `name:ca=Embassament de Ríbinsk`, `name:cs=Rybinská vodní nádrž`, `name:da=Rybinskreservoiret`, `name:de=Rybinsker Stausee`, `name:en=Rybinsk Reservoir`, `name:eo=Ribinska Rezervujo`, `name:es=Embalse de Rybinsk`, `name:eu=Rybinsk-eko urtegia`, `name:fi=Rybinskin tekojärvi`, `name:fr=Réservoir de Rybinsk`, `name:hr=Rybinsko umjetno jezero`, `name:it=Bacino di Rybinsk`, `name:ka=რიბინსკის წყალსაცავი`, `name:la=Receptaculum aquae Piscarianum`, `name:lt=Rybinsko tvenkinys`, `name:lv=Ribinskas ūdenskrātuve`, `name:mk=Рибинско Езеро`, `name:nl=Stuwmeer van Rybinsk`, `name:no=Rybinsk-reservoaret`, `name:os=Рыбинсчы донуат`, `name:pl=Zbiornik Rybiński`, `name:ru=Рыбинское водохранилище`, `name:sk=Rybinská vodná nádrž`, `name:sr=Рибинско језеро`, `name:sv=Rybinskreservoaren`, `name:uk=Рибинське водосховище`, `name:uz=Ribinsk suv ombori`, `name:zh=雷宾斯克水库`, `natural=water`, `sqkm=4580`, `start_date=1941`, `type=multipolygon`, `water=reservoir`, `wikidata=Q375029`, `wikimedia_commons=Category:Rybinsk Reservoir`, `wikipedia=ru:Рыбинское водохранилище`
- членство в relation:
нет (элемент не входит в скачанные parent relation)

- члены: 639 (outer=256, inner=383, main_stream=0, side_stream=0, other=0)

| role | type | id | classification | geometry | vertices | closed | start node | end node | tags |
|---|---|---:|---|---|---:|---|---:|---:|---|
| inner | way | 298655956 | mp-inner | Polygon | 67 | yes | 8254314957 | 8254314957 | natural=sand |
| inner | way | 887805469 | mp-inner | Polygon | 52 | yes | 8254343851 | 8254343851 | — |
| inner | way | 173123263 | mp-inner | Polygon | 26 | yes | 1839548886 | 1839548886 | — |
| inner | way | 173123262 | mp-inner | Polygon | 21 | yes | 1839548795 | 1839548795 | — |
| inner | way | 875044758 | mp-inner | Polygon | 17 | yes | 8145297579 | 8145297579 | — |
| inner | way | 352680260 | mp-inner | LineString | 47 | no | 3584361000 | 8064525975 | — |
| inner | way | 352680259 | mp-inner | LineString | 15 | no | 8064525975 | 3584361000 | — |
| outer | way | 249842570 | mp-outer | LineString | 187 | no | 173534631 | 173534619 | — |
| outer | way | 354662373 | mp-outer | LineString | 8 | no | 173534619 | 1223997262 | — |
| outer | way | 249842568 | mp-outer | LineString | 92 | no | 1223997262 | 2558095617 | — |
| outer | way | 249145433 | mp-outer | LineString | 2 | no | 2558095617 | 3603426146 | — |
| outer | way | 354662372 | mp-outer | LineString | 237 | no | 3603426146 | 366482720 | — |
| outer | way | 240602161 | mp-outer | LineString | 46 | no | 366482720 | 173534565 | — |
| outer | way | 240602157 | mp-outer | LineString | 141 | no | 173534565 | 2483252606 | — |
| outer | way | 240602162 | mp-outer | LineString | 3 | no | 2483252606 | 2483252616 | — |
| outer | way | 240602164 | mp-outer | LineString | 145 | no | 2483252616 | 2483252830 | — |
| outer | way | 501622154 | mp-outer | LineString | 7 | no | 2483252830 | 173534548 | — |
| outer | way | 590856926 | mp-outer | LineString | 2 | no | 173534548 | 1180289490 | — |
| outer | way | 590856927 | mp-outer | LineString | 2 | no | 1180289490 | 410666828 | — |
| outer | way | 240602158 | mp-outer | LineString | 192 | no | 410666828 | 1421197998 | — |
| outer | way | 249145430 | mp-outer | LineString | 801 | no | 1421197998 | 173534531 | — |
| outer | way | 200259602 | mp-outer | LineString | 197 | no | 173534531 | 1421198073 | — |
| outer | way | 200259578 | mp-outer | LineString | 109 | no | 1421198073 | 251714749 | — |
| outer | way | 200259604 | mp-outer | LineString | 39 | no | 251714749 | 2102595072 | — |
| outer | way | 315889865 | mp-outer | LineString | 43 | no | 2102595072 | 1930084747 | — |
| … | | | | | | | | | ещё 614 членов — полный список в JSON |

### Волга (крупный waterway) — relation/1730417

- classification: `waterway-relation`
- geometry_type: `GeometryCollection`
- fetch: `osm-api`
- tags: `alt_name:ko=볼가 강`, `destination=Caspian Sea`, `destination:wikidata=Q5484`, `distance=3645`, `gvr:code=08010100112110000000017`, `int_name=Volga`, `name=Волга`, `name:af=Wolga`, `name:am=ቮልጋ ወንዝ`, `name:an=Río Volga`, `name:ar=نهر الفولغا`, `name:as=ভল্গা নদী`, `name:ay=Volga`, `name:az=Volqa`, `name:be=Рака Волга`, `name:bh=वोल्गा`, `name:bn=ভোলগা নদী`, `name:bo=ཧྥོར་ཅཱ་གཙང་པོ།`, `name:br=Volga`, `name:bs=Volga`, `name:ca=Riu Volga`, `name:cs=Volha`, `name:cu=Вльга`, `name:cv=Атăл`, `name:cy=Afon Volga`, `name:da=Volga`, `name:de=Wolga`, `name:el=Βόλγας`, `name:en=Volga`, `name:eo=Volgo`, `name:es=Volga`, `name:et=Volga`, `name:eu=Volga`, `name:fa=رود ولگا`, `name:fi=Volga`, `name:fo=Volga`, `name:fr=La Volga`, `name:fy=Wolga`, `name:ga=An Volga`, `name:gl=Río Volga`, `name:gn=Volga`, `name:he=וולגה`, `name:hi=वोल्गा नदी`, `name:hr=Volga`, `name:hu=Volga`, `name:hy=Վոլգա`, `name:ia=Fluvio Volga`, `name:id=Sungai Volga`, `name:io=Volga`, `name:is=Volga`, `name:it=Volga`, `name:ja=ヴォルガ川`, `name:jv=Kali Volga`, `name:ka=ვოლგა`, `name:kk=Еділ`, `name:kn=ವೋಲ್ಗಾ ನದಿ`, `name:ko=볼가강`, `name:ku=Volga`, `name:ky=Волга дарыясы`, `name:la=Rha`, `name:lb=Wolga`, `name:li=Volga`, `name:lt=Volga`, `name:lv=Volga`, `name:ml=വോൾഗ നദി`, `name:mn=Ижил`, `name:mr=वोल्गा नदी`, `name:ms=Sungai Volga`, `name:my=ဗော်လ်ဂါမြစ်`, `name:na=Volga`, `name:nl=Wolga`, `name:nn=Volga`, `name:no=Volga`, `name:ny=Mtsinje wa Volga`, `name:oc=Vòlga`, `name:os=Волгæ`, `name:pa=ਵੋਲਗਾ ਦਰਿਆ`, `name:pl=Wołga`, `name:pt=Rio Volga`, `name:rm=Volga`, `name:ro=Volga`, `name:ru=Волга`, `name:sk=Volga`, `name:sl=Volga`, `name:sq=Vollga`, `name:sv=Volga`, `name:sw=Volga`, `name:ta=வோல்கா ஆறு`, `name:te=వోల్గా నది`, `name:tg=Волга`, `name:th=แม่น้ำวอลกา`, `name:tk=Wolga`, `name:tl=Ilog Volga`, `name:tr=İdil Nehri`, `name:tt=Идел`, `name:ug=ۋولگا دەرياسى`, `name:uk=Волга`, `name:ur=دریائے وولگا`, `name:uz=Volga`, `name:vi=Sông Volga`, `name:vo=Volga`, `name:yi=וואלגא`, `name:zh=伏尔加河`, `order:classic=1`, `short_name:ar=فولغا`, `source:name:oc=ieo-bdtopoc`, `type=waterway`, `waterway=river`, `wikidata=Q626`, `wikipedia=ru:Волга`
- членство в relation:
нет (элемент не входит в скачанные parent relation)

- члены: 213 (outer=0, inner=0, main_stream=199, side_stream=13, other=1)
- прочие роли: `spring`

| role | type | id | classification | geometry | vertices | closed | start node | end node | tags |
|---|---|---:|---|---|---:|---|---:|---:|---|
| spring | node | 94110681 | centerline-river | Point | — | — | — | — | — |
| main_stream | way | 48311065 | centerline-stream | LineString | 631 | no | 94110681 | 3848570313 | gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী, name:ay=Volga … |
| main_stream | way | 381692957 | centerline-stream | LineString | 749 | no | 3848570313 | 3848569368 | gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী, name:ay=Volga … |
| main_stream | way | 48311069 | centerline-river | LineString | 265 | no | 3848569368 | 309927486 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 28217744 | centerline-river | LineString | 534 | no | 309927486 | 309927131 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 28217742 | centerline-river | LineString | 418 | no | 309927131 | 1203582341 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 104307554 | centerline-river | LineString | 36 | no | 1203582341 | 635190690 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 104307634 | centerline-river | LineString | 58 | no | 635190690 | 309907550 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 28215857 | centerline-river | LineString | 28 | no | 309907550 | 940421291 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 107423527 | centerline-river | LineString | 52 | no | 940421291 | 309907581 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 104307524 | centerline-river | LineString | 101 | no | 309907581 | 1148140738 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 104307611 | centerline-river | LineString | 94 | no | 1148140738 | 309907683 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 105444502 | centerline-river | LineString | 155 | no | 309907683 | 166926650 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 16307200 | centerline-river | LineString | 65 | no | 166926650 | 4234639753 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 106220037 | centerline-river | LineString | 173 | no | 4234639753 | 166874191 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 104565547 | centerline-river | LineString | 20 | no | 166874191 | 901034397 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 104565565 | centerline-river | LineString | 109 | no | 901034397 | 166874313 | boat=yes, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 27309369 | centerline-river | LineString | 63 | no | 166874313 | 166885984 | boat=yes, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 16307510 | centerline-river | LineString | 209 | no | 166885984 | 166889849 | boat=yes, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 137780740 | centerline-river | LineString | 194 | no | 166889849 | 1324848134 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 137780739 | centerline-river | LineString | 4 | no | 1324848134 | 166889689 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 137780738 | centerline-river | LineString | 44 | no | 166889689 | 166889702 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 430739591 | centerline-river | LineString | 2 | no | 166889702 | 4300065695 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 137776728 | centerline-river | LineString | 50 | no | 4300065695 | 166896005 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| main_stream | way | 137776727 | centerline-river | LineString | 22 | no | 166896005 | 166896036 | boat=no, gvr:code=08010100112110000000017, name=Волга, name:af=Wolga, name:am=ቮልጋ ወንዝ, name:an=Río Volga, name:ar=نهر الفولغا, name:as=ভল্গা নদী … |
| … | | | | | | | | | ещё 188 членов — полный список в JSON |

### Нева — relation/2811903

- classification: `waterway-relation`
- geometry_type: `GeometryCollection`
- fetch: `osm-api`
- tags: `gvr:code=01040300312102000008487`, `name=Нева`, `name:ca=Riu Nevà`, `name:de=Newa`, `name:en=Neva River`, `name:fa=رودخانه نوا`, `name:hr=Neva`, `name:ru=Нева`, `name:zh=涅瓦河`, `type=waterway`, `waterway=river`, `wikidata=Q645`, `wikipedia=ru:Нева`
- членство в relation:
нет (элемент не входит в скачанные parent relation)

- члены: 46 (outer=0, inner=0, main_stream=36, side_stream=10, other=0)

| role | type | id | classification | geometry | vertices | closed | start node | end node | tags |
|---|---|---:|---|---|---:|---|---:|---:|---|
| main_stream | way | 23567397 | centerline-river | LineString | 20 | no | 255233655 | 255233646 | CEMT=Vb, admin_level=6, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 128486700 | centerline-river | LineString | 3 | no | 255233646 | 1390922519 | CEMT=Vb, admin_level=6, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 125178901 | centerline-river | LineString | 2 | no | 1390922519 | 1361213928 | CEMT=Vb, admin_level=6, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 121660132 | centerline-river | LineString | 10 | no | 1361213928 | 255233642 | CEMT=Vb, admin_level=6, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 121660130 | centerline-river | LineString | 8 | no | 255233642 | 1390922517 | CEMT=Vb, admin_level=6, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 125192458 | centerline-river | LineString | 9 | no | 1390922517 | 255233632 | CEMT=Vb, admin_level=6, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 128486702 | centerline-river | LineString | 3 | no | 255233632 | 255233631 | CEMT=Vb, admin_level=6, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 24219658 | centerline-river | LineString | 14 | no | 255233631 | 255233619 | CEMT=Vb, admin_level=6, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 121803178 | centerline-river | LineString | 9 | no | 255233619 | 1419849678 | CEMT=Vb, admin_level=6, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 128486698 | centerline-river | LineString | 27 | no | 1419849678 | 598516833 | CEMT=Vb, admin_level=6, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 508157668 | centerline-river | LineString | 12 | no | 598516833 | 598516834 | CEMT=Vb, admin_level=4, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 508157667 | centerline-river | LineString | 10 | no | 598516834 | 598516835 | CEMT=Vb, admin_level=4, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 46876345 | centerline-river | LineString | 10 | no | 598516835 | 598516831 | CEMT=Vb, admin_level=4, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 155715677 | centerline-river | LineString | 34 | no | 598516831 | 598516832 | CEMT=Vb, admin_level=4, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 46876344 | centerline-river | LineString | 9 | no | 598516832 | 598701761 | CEMT=Vb, admin_level=8, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 46896182 | centerline-river | LineString | 4 | no | 598701761 | 2908723972 | CEMT=Vb, admin_level=8, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 791651475 | centerline-river | LineString | 3 | no | 2908723972 | 598701762 | CEMT=Vb, admin_level=8, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 46896193 | centerline-river | LineString | 5 | no | 598701762 | 598202960 | CEMT=Vb, admin_level=8, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 24219655 | centerline-river | LineString | 3 | no | 598202960 | 598701716 | CEMT=Vb, admin_level=8, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 46896166 | centerline-river | LineString | 6 | no | 598701716 | 598202999 | CEMT=Vb, admin_level=8, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 46835378 | centerline-river | LineString | 3 | no | 598202999 | 101425908 | CEMT=Vb, admin_level=5, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 46835377 | centerline-river | LineString | 3 | no | 101425908 | 1574337093 | CEMT=Vb, admin_level=5, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 79570059 | centerline-river | LineString | 6 | no | 1574337093 | 255233520 | CEMT=Vb, admin_level=5, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 78334117 | centerline-river | LineString | 8 | no | 255233520 | 849321054 | CEMT=Vb, admin_level=5, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 71376485 | centerline-river | LineString | 14 | no | 849321054 | 928556304 | CEMT=Vb, admin_level=5, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 79570065 | centerline-river | LineString | 2 | no | 928556304 | 849085716 | CEMT=Vb, admin_level=5, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 71360186 | centerline-river | LineString | 2 | no | 849085716 | 255233512 | CEMT=Vb, admin_level=5, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 71360173 | centerline-river | LineString | 2 | no | 255233512 | 355211812 | CEMT=Vb, admin_level=5, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 79570071 | centerline-river | LineString | 4 | no | 355211812 | 1559928752 | CEMT=Vb, admin_level=5, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 78518216 | centerline-river | LineString | 3 | no | 1559928752 | 255233510 | CEMT=Vb, admin_level=5, boat=yes, boundary=administrative, have_riverbank=yes, name=Нева, name:bg=Нева, name:ca=Riu Neva … |
| main_stream | way | 34348577 | centerline-river | LineString | 2 | no | 255233510 | 921375412 | admin_level=5, boat=yes, boundary=administrative, gvr:code=01040300312002000008602, have_riverbank=yes, name=Малая Нева, name:ar=نيفا الصغيرة, name:de=Kleine Newa … |
| main_stream | way | 78518193 | centerline-river | LineString | 4 | no | 921375412 | 859223650 | admin_level=5, boat=yes, boundary=administrative, description:en=The Neva River splits into two arms, this is the smaller northern one., gvr:code=01040300312002000008602, have_riverbank=yes, name=Малая Нева, name:ar=نيفا الصغيرة … |
| main_stream | way | 72322204 | centerline-river | LineString | 2 | no | 859223650 | 921375406 | admin_level=5, boat=yes, boundary=administrative, gvr:code=01040300312002000008602, have_riverbank=yes, name=Малая Нева, name:ar=نيفا الصغيرة, name:de=Kleine Newa … |
| main_stream | way | 78518205 | centerline-river | LineString | 3 | no | 921375406 | 859223613 | admin_level=5, boat=yes, boundary=administrative, gvr:code=01040300312002000008602, have_riverbank=yes, name=Малая Нева, name:ar=نيفا الصغيرة, name:de=Kleine Newa … |
| main_stream | way | 72322196 | centerline-river | LineString | 6 | no | 859223613 | 411566391 | admin_level=5, boat=yes, boundary=administrative, gvr:code=01040300312002000008602, have_riverbank=yes, name=Малая Нева, name:ar=نيفا الصغيرة, name:de=Kleine Newa … |
| main_stream | way | 219158978 | centerline-river | LineString | 2 | no | 411566391 | 393975659 | boat=yes, gvr:code=01040300312002000008602, have_riverbank=yes, name=Малая Нева, name:de=Kleine Newa, name:en=Little Neva, name:es=Canal Pequeño Neva, name:fr=Petite Neva … |
| side_stream | way | 71959351 | centerline-river | LineString | 8 | no | 540201137 | 393745710 | CEMT=Vb, admin_level=5, boat=yes, boundary=administrative, have_riverbank=yes, name=Большая Нева, name:ar=نيفا العظيم, name:ca=Riu Gran Nevà … |
| side_stream | way | 816346775 | centerline-river | LineString | 3 | no | 393745710 | 827186317 | CEMT=Vb, admin_level=5, boat=yes, boundary=administrative, have_riverbank=yes, name=Большая Нева, name:de=Große Newa, name:en=Great Neva … |
| side_stream | way | 362796529 | centerline-river | LineString | 4 | no | 3670492419 | 540201137 | CEMT=Vb, admin_level=5, alt_name=Нева, boat=yes, boundary=administrative, have_riverbank=yes, name=Большая Нева, name:ar=نيفا العظيم … |
| side_stream | way | 34348576 | centerline-river | LineString | 3 | no | 255233510 | 3670492419 | CEMT=Vb, admin_level=5, alt_name=Нева, boat=yes, boundary=administrative, have_riverbank=yes, name=Большая Нева, name:ar=نيفا العظيم … |
| side_stream | way | 30746764 | centerline-river | LineString | 8 | no | 255233512 | 921375404 | admin_level=5, boat=yes, boundary=administrative, gvr:code=01040300312002000008497, have_riverbank=yes, name=Большая Невка, name:de=Große Newka, name:en=Great Nevka … |
| side_stream | way | 78518196 | centerline-river | LineString | 8 | no | 921375404 | 849085727 | admin_level=5, boat=yes, boundary=administrative, gvr:code=01040300312002000008497, have_riverbank=yes, name=Большая Невка, name:de=Große Newka, name:en=Great Nevka … |
| side_stream | way | 71360167 | centerline-river | LineString | 4 | no | 849085727 | 616423601 | admin_level=5, boat=yes, boundary=administrative, gvr:code=01040300312002000008497, have_riverbank=yes, name=Большая Невка, name:de=Große Newka, name:en=Great Nevka … |
| side_stream | way | 78518204 | centerline-river | LineString | 13 | no | 616423601 | 929207060 | admin_level=5, boat=yes, boundary=administrative, gvr:code=01040300312002000008497, have_riverbank=yes, name=Большая Невка, name:de=Große Newka, name:en=Great Nevka … |
| side_stream | way | 79629133 | centerline-river | LineString | 5 | no | 929207060 | 340041490 | admin_level=5, boat=yes, boundary=administrative, gvr:code=01040300312002000008497, have_riverbank=yes, name=Большая Невка, name:de=Große Newka, name:en=Great Nevka … |
| side_stream | way | 219155917 | centerline-river | LineString | 2 | no | 340041490 | 849451695 | boat=yes, gvr:code=01040300312002000008497, have_riverbank=yes, name=Большая Невка, name:de=Große Newka, name:en=Great Nevka, name:fr=Grande Nevka, name:hr=Velika Nevka … |

### обычный waterway=river way — way/28237778

- classification: `centerline-river`
- geometry_type: `LineString`
- fetch: `osm-api`
- tags: `boat=no`, `canoe=yes`, `name=Селижаровка`, `source=landsat`, `waterway=river`
- vertices: `184`, closed: `False`, start_node_id: `310147238`, end_node_id: `309927304`
- членство в relation:
- relation/379295 role=`main_stream` type=`waterway` tags: `destination=Volga`, `name=Селижаровка`, `type=waterway`, `waterway=river`, `wikidata=Q289638`, `wikipedia=ru:Селижаровка`

### natural=water озеро без relation — way/20542587

- classification: `polygon-lake`
- geometry_type: `Polygon`
- fetch: `osm-api`
- tags: `name=Боярское`, `natural=water`
- vertices: `39`, closed: `True`, start_node_id: `220278070`, end_node_id: `220278070`
- членство в relation:
нет (элемент не входит в скачанные parent relation)

## Ограничения

- Снимок OSM на момент запроса; теги и члены могут измениться.
- Для крупных relation (Ладога, Волга) Overpass может отдать только `out tags` у вложенных relation; у way-членов теги и node id есть.
- Дополнительные parent relation членов запрашиваются только если у seed не слишком много way-членов (см. `MEMBER_PARENT_FETCH_MAX_WAYS`); иначе членство = родитель-seed.
- Геометрия relation как MultiPolygon **не собирается** из outer-колец: для relation указан тип по тегам, для членов — собственный тип way.
- Координаты не сохраняются; замкнутость = совпадение первого и последнего **node id** (≥4 узлов).
- Выборка — эталонный список, не вся Европейская Россия.
- Production (WRG, БД, маршрутизация, Inspector) этим скриптом не меняется.

