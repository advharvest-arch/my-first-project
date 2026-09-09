# Topology discovery: water graph from OSM seed

Исследовательский слой. **БД, WRG, seligerDebug и production WaterSystem не изменялись.**
Навигация не оценивалась. Названия не являются ключом обнаружения.

Алгоритм: `discoverWaterGraph(seed)` — BFS по общим OSM node id и open waterways
(`river|stream|canal`). Слои A `DIRECT_OSM` и B `WATERWAY_CONNECTOR` подтверждают
топологию. C `GEOMETRY_CONTACT` и D `NEARBY`/`PORTAGE` — только candidates.
Переиспользованы tag-предикаты ingest (`is_water_tagged` / `is_area_water_tags` /
`pick_name`) и сборка колец по endpoint node id из реконструкции 399081 (`assemble_rings`).

Артефакты: [seliger-topology-discovery.json](seliger-topology-discovery.json), [seliger-topology-discovery.geojson](seliger-topology-discovery.geojson).

## A. Seed

- OSM: `relation/399081` (`r399081`)
- name (display only): 'Селигер'
- tags: `{"ele": "205", "name": "Селигер", "name:ca": "Llac Seliguer", "name:de": "Seligersee", "name:en": "Seliger", "name:et": "Seliger", "name:ru": "озеро Селигер", "name:zh": "谢利格尔湖", "natural": "water", "type": "multipolygon", "water": "lake", "wikidata": "Q746304", "wikipedia": "ru:Селигер"}`
- outer parts (kept separate, not dissolved): **2**
- OSM nodes in seed geometry: 15772
- bbox: [32.7005201, 57.025131, 33.3184555, 57.5401079]
- ring assembly outer: `{'member_ways': 115, 'unique_member_ways': 115, 'present_ways': 115, 'closed_single_ways': 0, 'open_ways': 115, 'assembled_rings': 2, 'closed_rings': 2, 'used_ways': 115}`
- ring assembly inner: `{'member_ways': 178, 'unique_member_ways': 178, 'present_ways': 178, 'closed_single_ways': 123, 'open_ways': 55, 'assembled_rings': 137, 'closed_rings': 137, 'used_ways': 178}`

## B. WaterFeatures

- nodes in output graph: **154**
- area features: 54
- waterway features: 100
- confirmed BFS component size: **136**

## C. Confirmed connections

- confirmed edges: **210**
  - DIRECT_OSM: 189
  - WATERWAY_CONNECTOR: 21

## D. Candidate connections

- candidate edges: **18**
- nearby candidates: 18

## E. Full graph (confirmed component)

| key | OSM | name | role | hops | island |
|---|---|---|---|---:|---|
| `r399081` | relation/399081 | Селигер | seed | 0 |  |
| `r1203668` | relation/1203668 | Полоновка | area | 1 |  |
| `r17001378` | relation/17001378 |  | area | 1 |  |
| `r379295` | relation/379295 | Селижаровка | waterway | 1 |  |
| `w103320388` | way/103320388 | Крапивенка | waterway | 1 |  |
| `w1238091262` | way/1238091262 |  | waterway | 1 |  |
| `w1316976066` | way/1316976066 | Варварина протока | area | 1 |  |
| `w1347279844` | way/1347279844 |  | waterway | 1 |  |
| `w167683446` | way/167683446 | канал Копанка | waterway | 1 |  |
| `w167688573` | way/167688573 |  | waterway | 1 |  |
| `w175853322` | way/175853322 |  | waterway | 1 |  |
| `w191300070` | way/191300070 |  | waterway | 1 |  |
| `w191300072` | way/191300072 |  | waterway | 1 |  |
| `w191300074` | way/191300074 |  | waterway | 1 |  |
| `w192329795` | way/192329795 |  | waterway | 1 |  |
| `w195929170` | way/195929170 | Сиговка | waterway | 1 |  |
| `w199586062` | way/199586062 |  | area | 1 |  |
| `w212370774` | way/212370774 |  | waterway | 1 |  |
| `w217721565` | way/217721565 |  | area | 1 |  |
| `w229644709` | way/229644709 |  | waterway | 1 |  |
| `w229647293` | way/229647293 |  | waterway | 1 |  |
| `w231923190` | way/231923190 |  | waterway | 1 |  |
| `w234067887` | way/234067887 |  | waterway | 1 |  |
| `w237330209` | way/237330209 | Березовец | waterway | 1 |  |
| `w260065513` | way/260065513 |  | area | 1 |  |
| `w287616945` | way/287616945 |  | waterway | 1 |  |
| `w28838371` | way/28838371 | Селижаровка | waterway | 1 |  |
| `w288428252` | way/288428252 |  | waterway | 1 |  |
| `w299382153` | way/299382153 |  | area | 1 |  |
| `w299384445` | way/299384445 |  | area | 1 |  |
| `w30163681` | way/30163681 | Глушица | waterway | 1 |  |
| `w30196495` | way/30196495 |  | waterway | 1 |  |
| `w308143904` | way/308143904 |  | area | 1 |  |
| `w308145403` | way/308145403 |  | waterway | 1 |  |
| `w308146766` | way/308146766 |  | waterway | 1 |  |
| `w308178247` | way/308178247 |  | waterway | 1 |  |
| `w308319722` | way/308319722 |  | area | 1 |  |
| `w308319728` | way/308319728 |  | waterway | 1 |  |
| `w308336991` | way/308336991 |  | waterway | 1 |  |
| `w308676450` | way/308676450 |  | area | 1 |  |
| `w32487176` | way/32487176 | Княжа | waterway | 1 |  |
| `w32487402` | way/32487402 | Полоновка | waterway | 1 |  |
| `w329235115` | way/329235115 |  | area | 1 |  |
| `w430621784` | way/430621784 |  | waterway | 1 |  |
| `w431584384` | way/431584384 |  | waterway | 1 |  |
| `w443774155` | way/443774155 |  | waterway | 1 |  |
| `w449889206` | way/449889206 |  | waterway | 1 |  |
| `w451958337` | way/451958337 |  | waterway | 1 |  |
| `w451963962` | way/451963962 |  | waterway | 1 |  |
| `w48872395` | way/48872395 | Близна | waterway | 1 |  |
| `w62456617` | way/62456617 | Сорога | waterway | 1 |  |
| `w640414647` | way/640414647 | Глубочица | waterway | 1 |  |
| `w690737405` | way/690737405 |  | area | 1 |  |
| `w691693544` | way/691693544 |  | area | 1 |  |
| `w691693545` | way/691693545 |  | area | 1 |  |
| `w75616105` | way/75616105 | Ускройня | waterway | 1 |  |
| `w790979304` | way/790979304 |  | waterway | 1 |  |
| `w81323084` | way/81323084 | Зуёвка | waterway | 1 |  |
| `w81732492` | way/81732492 |  | waterway | 1 |  |
| `w81753515` | way/81753515 | Княжа | area | 1 |  |
| `w81759425` | way/81759425 |  | waterway | 1 |  |
| `w81781050` | way/81781050 | Замошенка | waterway | 1 |  |
| `w81781076` | way/81781076 | Чёрная | waterway | 1 |  |
| `w82331216` | way/82331216 |  | waterway | 1 |  |
| `w848485110` | way/848485110 |  | waterway | 1 |  |
| `w884128196` | way/884128196 |  | waterway | 1 |  |
| `w906802015` | way/906802015 |  | waterway | 1 |  |
| `w906802016` | way/906802016 |  | waterway | 1 |  |
| `w906802017` | way/906802017 |  | waterway | 1 |  |
| `w906802018` | way/906802018 |  | waterway | 1 |  |
| `w906802019` | way/906802019 |  | waterway | 1 |  |
| `w906802020` | way/906802020 |  | waterway | 1 |  |
| `w906802021` | way/906802021 |  | waterway | 1 |  |
| `w906802022` | way/906802022 |  | waterway | 1 |  |
| `w906802023` | way/906802023 |  | waterway | 1 |  |
| `w906802024` | way/906802024 |  | waterway | 1 |  |
| `w906802025` | way/906802025 |  | waterway | 1 |  |
| `w927079942` | way/927079942 |  | waterway | 1 |  |
| `w977864069` | way/977864069 |  | waterway | 1 |  |
| `w979432568` | way/979432568 |  | waterway | 1 |  |
| `r1159264` | relation/1159264 | Ласцо | area | 2 |  |
| `r18358803` | relation/18358803 | Святое | area | 2 |  |
| `r399614` | relation/399614 | озеро Сиг | area | 2 |  |
| `r9617478` | relation/9617478 | Серемо | area | 2 |  |
| `w1215522889` | way/1215522889 | Чёрная | waterway | 2 |  |
| `w1221659592` | way/1221659592 |  | waterway | 2 |  |
| `w1460105518` | way/1460105518 |  | waterway | 2 |  |
| `w1460105519` | way/1460105519 |  | waterway | 2 |  |
| `w1462368982` | way/1462368982 |  | waterway | 2 |  |
| `w1501164930` | way/1501164930 |  | waterway | 2 |  |
| `w1501165019` | way/1501165019 |  | waterway | 2 |  |
| `w1501165023` | way/1501165023 |  | waterway | 2 |  |
| `w191300071` | way/191300071 |  | waterway | 2 |  |
| `w191468052` | way/191468052 |  | waterway | 2 |  |
| `w191573376` | way/191573376 |  | waterway | 2 |  |
| `w191615745` | way/191615745 |  | waterway | 2 |  |
| `w191615746` | way/191615746 |  | waterway | 2 |  |
| `w191615747` | way/191615747 |  | waterway | 2 |  |
| `w191615748` | way/191615748 |  | waterway | 2 |  |
| `w192241823` | way/192241823 |  | waterway | 2 |  |
| `w193190823` | way/193190823 |  | waterway | 2 |  |
| `w195011307` | way/195011307 | Ёмша | waterway | 2 |  |
| `w20542134` | way/20542134 | Белое-южное | area | 2 | parent [30171650, 430623975, 430623978, 430623981, 430623977, 430623976, 430623979, 430623980] |
| `w207645000` | way/207645000 |  | waterway | 2 |  |
| `w207645001` | way/207645001 |  | waterway | 2 |  |
| `w212766612` | way/212766612 | Сиговка | waterway | 2 |  |
| `w217721693` | way/217721693 |  | waterway | 2 |  |
| `w261237885` | way/261237885 |  | area | 2 |  |
| `w28237778` | way/28237778 | Селижаровка | waterway | 2 |  |
| `w28237780` | way/28237780 | Селижаровка | waterway | 2 |  |
| `w287616948` | way/287616948 |  | waterway | 2 |  |
| `w30164445` | way/30164445 | Рясивое | area | 2 |  |
| `w30196364` | way/30196364 | Залецкое | area | 2 |  |
| `w30196538` | way/30196538 | Стройное | area | 2 |  |
| `w308145402` | way/308145402 |  | area | 2 | parent [30171650, 430623975, 430623978, 430623981, 430623977, 430623976, 430623979, 430623980] |
| `w308146279` | way/308146279 |  | waterway | 2 |  |
| `w308336995` | way/308336995 |  | waterway | 2 |  |
| `w32486887` | way/32486887 | Святица | area | 2 |  |
| `w372155332` | way/372155332 |  | waterway | 2 |  |
| `w451958339` | way/451958339 |  | waterway | 2 |  |
| `w451958342` | way/451958342 |  | waterway | 2 |  |
| `w49220132` | way/49220132 | озеро Гнильцы Малое | area | 2 | parent [30171650, 430623975, 430623978, 430623981, 430623977, 430623976, 430623979, 430623980] |
| `w49220133` | way/49220133 | Кобыльское | area | 2 | parent [30171650, 430623975, 430623978, 430623981, 430623977, 430623976, 430623979, 430623980] |
| `w60082952` | way/60082952 | Свапущенка | waterway | 2 |  |
| `w640414648` | way/640414648 | Глубочица | waterway | 2 |  |
| `w753214808` | way/753214808 |  | waterway | 2 |  |
| `w76207976` | way/76207976 |  | area | 2 |  |
| `w78343141` | way/78343141 |  | area | 2 |  |
| `w790979305` | way/790979305 |  | waterway | 2 |  |
| `w81303076` | way/81303076 | Гастовец | area | 2 |  |
| `w906802027` | way/906802027 |  | waterway | 2 |  |
| `w927079943` | way/927079943 |  | waterway | 2 |  |
| `w979432569` | way/979432569 |  | waterway | 2 |  |
| `r9617480` | relation/9617480 | Глубокое | area | 3 |  |
| `r9617479` | relation/9617479 | Мелкое | area | 4 |  |
| `r18072605` | relation/18072605 | Княжка | area | 5 |  |

## F. Branches (BFS tree from seed)

- hops=1: Селигер (`r399081`) → Полоновка (`r1203668`)
- hops=1: Селигер (`r399081`) → ? (`r17001378`)
- hops=1: Селигер (`r399081`) → ? (`w199586062`)
- hops=1: Селигер (`r399081`) → ? (`w217721565`)
- hops=1: Селигер (`r399081`) → ? (`w260065513`)
- hops=1: Селигер (`r399081`) → ? (`w299382153`)
- hops=1: Селигер (`r399081`) → ? (`w299384445`)
- hops=1: Селигер (`r399081`) → ? (`w308319722`)
- hops=1: Селигер (`r399081`) → ? (`w308676450`)
- hops=1: Селигер (`r399081`) → ? (`w329235115`)
- hops=1: Селигер (`r399081`) → ? (`w690737405`)
- hops=1: Селигер (`r399081`) → ? (`w691693544`)
- hops=1: Селигер (`r399081`) → ? (`w691693545`)
- hops=2: Селигер (`r399081`) → Зуёвка (`w81323084`) → Ласцо (`r1159264`)
- hops=2: Селигер (`r399081`) → Варварина протока (`w1316976066`) → Святое (`r18358803`)
- hops=2: Селигер (`r399081`) → Сиговка (`w195929170`) → озеро Сиг (`r399614`)
- hops=2: Селигер (`r399081`) → ? (`w167688573`) → Белое-южное (`w20542134`)
- hops=2: Селигер (`r399081`) → Крапивенка (`w103320388`) → ? (`w261237885`)
- hops=2: Селигер (`r399081`) → ? (`w82331216`) → Рясивое (`w30164445`)
- hops=2: Селигер (`r399081`) → ? (`w30196495`) → Залецкое (`w30196364`)
- hops=2: Селигер (`r399081`) → ? (`w308143904`) → Стройное (`w30196538`)
- hops=2: Селигер (`r399081`) → ? (`w308145403`) → ? (`w308145402`)
- hops=2: Селигер (`r399081`) → ? (`w1347279844`) → Святица (`w32486887`)
- hops=2: Селигер (`r399081`) → ? (`w848485110`) → озеро Гнильцы Малое (`w49220132`)
- hops=2: Селигер (`r399081`) → ? (`w288428252`) → Кобыльское (`w49220133`)
- hops=2: Селигер (`r399081`) → ? (`w229644709`) → ? (`w76207976`)
- hops=2: Селигер (`r399081`) → ? (`w81759425`) → ? (`w78343141`)
- hops=2: Селигер (`r399081`) → ? (`w81732492`) → Гастовец (`w81303076`)
- hops=5: Селигер (`r399081`) → Княжа (`w81753515`) → Серемо (`r9617478`) → Глубокое (`r9617480`) → Мелкое (`r9617479`) → Княжка (`r18072605`)

## G. Nearby candidates (not connected)

| key | OSM | name | d (m) | geometry | reason | type |
|---|---|---|---:|---|---|---|
| `w1135420114` | way/1135420114 |  | 3.2 | inside_island | inside island/inner geometry of a water feature; not a waterway connection | NEARBY_CANDIDATE |
| `w1305535843` | way/1305535843 |  | 12.0 | inside_island | inside island/inner geometry of a water feature; not a waterway connection | NEARBY_CANDIDATE |
| `w119343953` | way/119343953 | Садок | 16.4 | disjoint | proximity only; gap ≤ portage threshold; not a proven portage | PORTAGE_CANDIDATE |
| `w430378915` | way/430378915 |  | 29.8 | disjoint | proximity only; gap ≤ portage threshold; not a proven portage | PORTAGE_CANDIDATE |
| `r6407846` | relation/6407846 |  | 113.5 | inside_island | inside island/inner geometry of a water feature; not a waterway connection | NEARBY_CANDIDATE |
| `r16459681` | relation/16459681 |  | 172.6 | disjoint | proximity only; no confirmed OSM water path from seed | NEARBY_CANDIDATE |
| `r1729194` | relation/1729194 | Дивное | 183.1 | inside_island | inside island/inner geometry of a water feature; not a waterway connection | NEARBY_CANDIDATE |
| `w30196394` | way/30196394 | Глубокое | 1155.1 | disjoint | in seed scan radius; no confirmed OSM water path | NEARBY_CANDIDATE |
| `w49220130` | way/49220130 | Чёрное | 1189.3 | inside_island | inside island/inner geometry of a water feature; not a waterway connection | NEARBY_CANDIDATE |
| `w81323080` | way/81323080 | Большой Жетонег | 1420.7 | disjoint | in seed scan radius; no confirmed OSM water path | NEARBY_CANDIDATE |
| `w75616104` | way/75616104 | Чёрное | 1603.4 | disjoint | in seed scan radius; no confirmed OSM water path | NEARBY_CANDIDATE |
| `w20542587` | way/20542587 | Боярское | 1631.5 | disjoint | in seed scan radius; no confirmed OSM water path | NEARBY_CANDIDATE |
| `r1236637` | relation/1236637 | озеро Полонец | 2211.2 | disjoint | in seed scan radius; no confirmed OSM water path | NEARBY_CANDIDATE |
| `w78343143` | way/78343143 | Чёрное | 2271.8 | disjoint | in seed scan radius; no confirmed OSM water path | NEARBY_CANDIDATE |
| `r18358806` | relation/18358806 | Мелкош | 2931.1 | disjoint | in seed scan radius; no confirmed OSM water path | NEARBY_CANDIDATE |
| `w28834954` | way/28834954 | Долгое | 3117.5 | disjoint | in seed scan radius; no confirmed OSM water path | NEARBY_CANDIDATE |
| `w60916826` | way/60916826 | Долгое | 3574.2 | disjoint | in seed scan radius; no confirmed OSM water path | NEARBY_CANDIDATE |
| `r77684` | relation/77684 | Берёзовское озеро | 4486.7 | disjoint | in seed scan radius; no confirmed OSM water path | NEARBY_CANDIDATE |

## H. Island water features

| key | OSM | name | parent island ways | membership | direct | connector | separate | in BFS |
|---|---|---|---|---|---|---|---|---|
| `r1729194` | relation/1729194 | Дивное | [42769363, 1337346122, 428185999, 428186000, 428185990, 1337346125, 428185997, 428185998, 428185993, 428185989] | [] | False | False | True | False |
| `r6407846` | relation/6407846 |  | [30171650, 430623975, 430623978, 430623981, 430623977, 430623976, 430623979, 430623980] | [] | False | False | True | False |
| `w1135420114` | way/1135420114 |  | [1135420115] | [] | False | False | True | False |
| `w1305535843` | way/1305535843 |  | [31057309] | [] | False | False | True | False |
| `w20542134` | way/20542134 | Белое-южное | [30171650, 430623975, 430623978, 430623981, 430623977, 430623976, 430623979, 430623980] | [] | False | True | False | True |
| `w308145402` | way/308145402 |  | [30171650, 430623975, 430623978, 430623981, 430623977, 430623976, 430623979, 430623980] | [] | False | True | False | True |
| `w49220130` | way/49220130 | Чёрное | [30171650, 430623975, 430623978, 430623981, 430623977, 430623976, 430623979, 430623980] | [] | False | False | True | False |
| `w49220132` | way/49220132 | озеро Гнильцы Малое | [30171650, 430623975, 430623978, 430623981, 430623977, 430623976, 430623979, 430623980] | [] | False | True | False | True |
| `w49220133` | way/49220133 | Кобыльское | [30171650, 430623975, 430623978, 430623981, 430623977, 430623976, 430623979, 430623980] | [] | False | True | False | True |

## I. UNCERTAIN cases

- `NEARBY_CANDIDATE` r399081 → w1305535843: inside island/inner geometry of a water feature; not a waterway connection
- `NEARBY_CANDIDATE` r1729194 → r399081: inside island/inner geometry of a water feature; not a waterway connection
- `NEARBY_CANDIDATE` r399081 → r6407846: inside island/inner geometry of a water feature; not a waterway connection
- `NEARBY_CANDIDATE` r399081 → w60916826: in seed scan radius; no confirmed OSM water path
- `NEARBY_CANDIDATE` r399081 → w30196394: in seed scan radius; no confirmed OSM water path
- `NEARBY_CANDIDATE` r399081 → w1135420114: inside island/inner geometry of a water feature; not a waterway connection
- `NEARBY_CANDIDATE` r399081 → w75616104: in seed scan radius; no confirmed OSM water path
- `NEARBY_CANDIDATE` r18358806 → r399081: in seed scan radius; no confirmed OSM water path
- `NEARBY_CANDIDATE` r399081 → w28834954: in seed scan radius; no confirmed OSM water path
- `NEARBY_CANDIDATE` r399081 → w20542587: in seed scan radius; no confirmed OSM water path
- `NEARBY_CANDIDATE` r399081 → r77684: in seed scan radius; no confirmed OSM water path
- `PORTAGE_CANDIDATE` r399081 → w119343953: proximity only; gap ≤ portage threshold; not a proven portage
- `NEARBY_CANDIDATE` r399081 → w49220130: inside island/inner geometry of a water feature; not a waterway connection
- `PORTAGE_CANDIDATE` r399081 → w430378915: proximity only; gap ≤ portage threshold; not a proven portage
- `NEARBY_CANDIDATE` r399081 → w78343143: in seed scan radius; no confirmed OSM water path
- `NEARBY_CANDIDATE` r399081 → w81323080: in seed scan radius; no confirmed OSM water path
- `NEARBY_CANDIDATE` r16459681 → r399081: proximity only; no confirmed OSM water path from seed
- `NEARBY_CANDIDATE` r1236637 → r399081: in seed scan radius; no confirmed OSM water path
- `ISLAND_WATER_NO_CONNECTOR` r399081 → w1135420114: water feature sits inside an inner/island ring; no OSM node or waterway connector to the parent water body
- `ISLAND_WATER_NO_CONNECTOR` r399081 → w1305535843: water feature sits inside an inner/island ring; no OSM node or waterway connector to the parent water body
- `ISLAND_WATER_NO_CONNECTOR` r399081 → w49220130: water feature sits inside an inner/island ring; no OSM node or waterway connector to the parent water body
- `ISLAND_WATER_NO_CONNECTOR` r399081 → r1729194: water feature sits inside an inner/island ring; no OSM node or waterway connector to the parent water body
- `ISLAND_WATER_NO_CONNECTOR` r399081 → r6407846: water feature sits inside an inner/island ring; no OSM node or waterway connector to the parent water body

## J. Confirmed edges: OSM ids and evidence

| from | to | type | connectors | evidence |
|---|---|---|---|---|
| `r1159264` | `w81323084` | DIRECT_OSM | `[]` | sharedNodes=1; ids=526889446; r1159264 and w81323084 share OSM node 526889446 |
| `r1203668` | `r399081` | DIRECT_OSM | `[]` | sharedNodes=6; sharedEdges=4; ids=365264662,365264663,365264664,365264682,365270429; r1203668 and r399081 share OSM node 365264662, 365264663, 365264664 |
| `r1203668` | `w32487402` | DIRECT_OSM | `[]` | sharedNodes=2; ids=365264664,365264682; r1203668 and w32487402 share OSM node 365264664, 365264682 |
| `r1203668` | `w906802022` | DIRECT_OSM | `[]` | sharedNodes=1; ids=365264664; r1203668 and w906802022 share OSM node 365264664 |
| `r1203668` | `w906802023` | DIRECT_OSM | `[]` | sharedNodes=1; ids=365264682; r1203668 and w906802023 share OSM node 365264682 |
| `r17001378` | `r399081` | DIRECT_OSM | `[]` | sharedNodes=3; sharedEdges=2; ids=950124294,9235426556,11500497926; r17001378 and r399081 share OSM node 950124294, 9235426556, 11500497926 |
| `r17001378` | `w1238091262` | DIRECT_OSM | `[]` | sharedNodes=2; ids=9235426556,11500497949; r17001378 and w1238091262 share OSM node 9235426556, 11500497949 |
| `r18072605` | `r9617479` | DIRECT_OSM | `[]` | sharedNodes=2; ids=12188675901,12188675941; r18072605 and r9617479 share OSM node 12188675901, 12188675941 |
| `r18358803` | `w1316976066` | DIRECT_OSM | `[]` | sharedNodes=2; sharedEdges=1; ids=12188675942,12188675977; r18358803 and w1316976066 share OSM node 12188675942, 12188675977 |
| `r379295` | `r399081` | DIRECT_OSM | `[]` | sharedNodes=1; ids=247941768; r379295 and r399081 share OSM node 247941768 |
| `r379295` | `w191468052` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2020422602; r379295 and w191468052 share OSM node 2020422602 |
| `r379295` | `w191573376` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2021567277; r379295 and w191573376 share OSM node 2021567277 |
| `r379295` | `w191615745` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2021987828; r379295 and w191615745 share OSM node 2021987828 |
| `r379295` | `w191615746` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2021987628; r379295 and w191615746 share OSM node 2021987628 |
| `r379295` | `w191615747` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2021987491; r379295 and w191615747 share OSM node 2021987491 |
| `r379295` | `w191615748` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2021987299; r379295 and w191615748 share OSM node 2021987299 |
| `r379295` | `w28237778` | DIRECT_OSM | `[]` | sharedNodes=184; sharedEdges=183; ids=309927304,310147105,310147106,310147107,310147108; r379295 and w28237778 share OSM node 309927304, 310147105, 310147106 |
| `r379295` | `w28237780` | DIRECT_OSM | `[]` | sharedNodes=172; sharedEdges=171; ids=310147238,310147239,310147241,310147242,310147243; r379295 and w28237780 share OSM node 310147238, 310147239, 310147241 |
| `r379295` | `w28838371` | DIRECT_OSM | `[]` | sharedNodes=455; sharedEdges=454; ids=247941768,310147304,317040265,317040266,317040270; r379295 and w28838371 share OSM node 247941768, 310147304, 317040265 |
| `r379295` | `w884128196` | DIRECT_OSM | `[]` | sharedNodes=1; ids=247941768; r379295 and w884128196 share OSM node 247941768 |
| `r399081` | `w103320388` | DIRECT_OSM | `[]` | sharedNodes=1; ids=624633849; r399081 and w103320388 share OSM node 624633849 |
| `r399081` | `w1238091262` | DIRECT_OSM | `[]` | sharedNodes=1; ids=9235426556; r399081 and w1238091262 share OSM node 9235426556 |
| `r399081` | `w1316976066` | DIRECT_OSM | `[]` | sharedNodes=2; sharedEdges=1; ids=12188675959,12188675960; r399081 and w1316976066 share OSM node 12188675959, 12188675960 |
| `r399081` | `w1347279844` | DIRECT_OSM | `[]` | sharedNodes=1; ids=12462734553; r399081 and w1347279844 share OSM node 12462734553 |
| `r399081` | `w167683446` | DIRECT_OSM | `[]` | sharedNodes=1; ids=247941268; r399081 and w167683446 share OSM node 247941268 |
| `r399081` | `w167688573` | DIRECT_OSM | `[]` | sharedNodes=1; ids=14085575805; r399081 and w167688573 share OSM node 14085575805 |
| `r399081` | `w175853322` | DIRECT_OSM | `[]` | sharedNodes=1; ids=1864126149; r399081 and w175853322 share OSM node 1864126149 |
| `r399081` | `w191300070` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2018880922; r399081 and w191300070 share OSM node 2018880922 |
| `r399081` | `w191300072` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2018880729; r399081 and w191300072 share OSM node 2018880729 |
| `r399081` | `w191300074` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2018881142; r399081 and w191300074 share OSM node 2018881142 |
| `r399081` | `w192329795` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2028851909; r399081 and w192329795 share OSM node 2028851909 |
| `r399081` | `w195929170` | DIRECT_OSM | `[]` | sharedNodes=1; ids=247941917; r399081 and w195929170 share OSM node 247941917 |
| `r399081` | `w199586062` | DIRECT_OSM | `[]` | sharedNodes=2; sharedEdges=1; ids=2082335462,2082335465; r399081 and w199586062 share OSM node 2082335462, 2082335465 |
| `r399081` | `w212370774` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2222260321; r399081 and w212370774 share OSM node 2222260321 |
| `r399081` | `w217721565` | DIRECT_OSM | `[]` | sharedNodes=2; sharedEdges=1; ids=2270237715,2270237719; r399081 and w217721565 share OSM node 2270237715, 2270237719 |
| `r399081` | `w229644709` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2382126353; r399081 and w229644709 share OSM node 2382126353 |
| `r399081` | `w229647293` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2382148682; r399081 and w229647293 share OSM node 2382148682 |
| `r399081` | `w231923190` | DIRECT_OSM | `[]` | sharedNodes=1; ids=281702106; r399081 and w231923190 share OSM node 281702106 |
| `r399081` | `w234067887` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2423749273; r399081 and w234067887 share OSM node 2423749273 |
| `r399081` | `w237330209` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2452488495; r399081 and w237330209 share OSM node 2452488495 |
| `r399081` | `w260065513` | DIRECT_OSM | `[]` | sharedNodes=2; sharedEdges=1; ids=2055153259,2055153260; r399081 and w260065513 share OSM node 2055153259, 2055153260 |
| `r399081` | `w287616945` | DIRECT_OSM | `[]` | sharedNodes=1; ids=220247901; r399081 and w287616945 share OSM node 220247901 |
| `r399081` | `w28838371` | DIRECT_OSM | `[]` | sharedNodes=1; ids=247941768; r399081 and w28838371 share OSM node 247941768 |
| `r399081` | `w288428252` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2919877301; r399081 and w288428252 share OSM node 2919877301 |
| `r399081` | `w299382153` | DIRECT_OSM | `[]` | sharedNodes=2; sharedEdges=1; ids=2082334551,2082334554; r399081 and w299382153 share OSM node 2082334551, 2082334554 |
| `r399081` | `w299384445` | DIRECT_OSM | `[]` | sharedNodes=2; sharedEdges=1; ids=220266041,2270239130; r399081 and w299384445 share OSM node 220266041, 2270239130 |
| `r399081` | `w30163681` | DIRECT_OSM | `[]` | sharedNodes=1; ids=332392239; r399081 and w30163681 share OSM node 332392239 |
| `r399081` | `w30196495` | DIRECT_OSM | `[]` | sharedNodes=1; ids=220266130; r399081 and w30196495 share OSM node 220266130 |
| `r399081` | `w308143904` | DIRECT_OSM | `[]` | sharedNodes=2; sharedEdges=1; ids=3134275992,3134276019; r399081 and w308143904 share OSM node 3134275992, 3134276019 |
| `r399081` | `w308145403` | DIRECT_OSM | `[]` | sharedNodes=1; ids=3134289259; r399081 and w308145403 share OSM node 3134289259 |
| `r399081` | `w308146766` | DIRECT_OSM | `[]` | sharedNodes=1; ids=3134302846; r399081 and w308146766 share OSM node 3134302846 |
| `r399081` | `w308178247` | DIRECT_OSM | `[]` | sharedNodes=1; ids=3134686890; r399081 and w308178247 share OSM node 3134686890 |
| `r399081` | `w308319722` | DIRECT_OSM | `[]` | sharedNodes=4; sharedEdges=3; ids=332463340,3136100589,3136100610,4487732677; r399081 and w308319722 share OSM node 332463340, 3136100589, 3136100610 |
| `r399081` | `w308319728` | DIRECT_OSM | `[]` | sharedNodes=1; ids=4487732677; r399081 and w308319728 share OSM node 4487732677 |
| `r399081` | `w308336991` | DIRECT_OSM | `[]` | sharedNodes=1; ids=3136243093; r399081 and w308336991 share OSM node 3136243093 |
| `r399081` | `w308676450` | DIRECT_OSM | `[]` | sharedNodes=3; sharedEdges=2; ids=3139427972,3139427977,3139428013; r399081 and w308676450 share OSM node 3139427972, 3139427977, 3139428013 |
| `r399081` | `w32487176` | DIRECT_OSM | `[]` | sharedNodes=1; ids=220277673; r399081 and w32487176 share OSM node 220277673 |
| `r399081` | `w32487402` | DIRECT_OSM | `[]` | sharedNodes=2; ids=365264664,365264682; r399081 and w32487402 share OSM node 365264664, 365264682 |
| `r399081` | `w329235115` | DIRECT_OSM | `[]` | sharedNodes=2; sharedEdges=1; ids=2082334294,2082334301; r399081 and w329235115 share OSM node 2082334294, 2082334301 |
| `r399081` | `w430621784` | DIRECT_OSM | `[]` | sharedNodes=1; ids=4298862744; r399081 and w430621784 share OSM node 4298862744 |
| `r399081` | `w431584384` | DIRECT_OSM | `[]` | sharedNodes=1; ids=632244068; r399081 and w431584384 share OSM node 632244068 |
| `r399081` | `w443774155` | DIRECT_OSM | `[]` | sharedNodes=1; ids=4413121618; r399081 and w443774155 share OSM node 4413121618 |
| `r399081` | `w449889206` | DIRECT_OSM | `[]` | sharedNodes=1; ids=4468061741; r399081 and w449889206 share OSM node 4468061741 |
| `r399081` | `w451958337` | DIRECT_OSM | `[]` | sharedNodes=1; ids=4298862379; r399081 and w451958337 share OSM node 4298862379 |
| `r399081` | `w451963962` | DIRECT_OSM | `[]` | sharedNodes=1; ids=4487682248; r399081 and w451963962 share OSM node 4487682248 |
| `r399081` | `w48872395` | DIRECT_OSM | `[]` | sharedNodes=1; ids=620102064; r399081 and w48872395 share OSM node 620102064 |
| `r399081` | `w62456617` | DIRECT_OSM | `[]` | sharedNodes=1; ids=365255204; r399081 and w62456617 share OSM node 365255204 |
| `r399081` | `w640414647` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2655782667; r399081 and w640414647 share OSM node 2655782667 |
| `r399081` | `w690737405` | DIRECT_OSM | `[]` | sharedNodes=2; sharedEdges=1; ids=247941921,6480997849; r399081 and w690737405 share OSM node 247941921, 6480997849 |
| `r399081` | `w691693544` | DIRECT_OSM | `[]` | sharedNodes=3; sharedEdges=2; ids=2423749273,6491307758,6491307767; r399081 and w691693544 share OSM node 2423749273, 6491307758, 6491307767 |
| `r399081` | `w691693545` | DIRECT_OSM | `[]` | sharedNodes=4; sharedEdges=2; ids=6491307768,6491307772,6491307773,6491307779; r399081 and w691693545 share OSM node 6491307768, 6491307772, 6491307773 |
| `r399081` | `w75616105` | DIRECT_OSM | `[]` | sharedNodes=1; ids=892745703; r399081 and w75616105 share OSM node 892745703 |
| `r399081` | `w790979304` | DIRECT_OSM | `[]` | sharedNodes=1; ids=3139428013; r399081 and w790979304 share OSM node 3139428013 |
| `r399081` | `w81323084` | DIRECT_OSM | `[]` | sharedNodes=1; ids=947338538; r399081 and w81323084 share OSM node 947338538 |
| `r399081` | `w81732492` | DIRECT_OSM | `[]` | sharedNodes=1; ids=933815904; r399081 and w81732492 share OSM node 933815904 |
| `r399081` | `w81753515` | DIRECT_OSM | `[]` | sharedNodes=3; sharedEdges=2; ids=220277673,952396939,952397004; r399081 and w81753515 share OSM node 220277673, 952396939, 952397004 |
| `r399081` | `w81759425` | DIRECT_OSM | `[]` | sharedNodes=1; ids=952581538; r399081 and w81759425 share OSM node 952581538 |
| `r399081` | `w81781050` | DIRECT_OSM | `[]` | sharedNodes=1; ids=952755607; r399081 and w81781050 share OSM node 952755607 |
| `r399081` | `w81781076` | DIRECT_OSM | `[]` | sharedNodes=1; ids=952755942; r399081 and w81781076 share OSM node 952755942 |
| `r399081` | `w82331216` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2421493972; r399081 and w82331216 share OSM node 2421493972 |
| `r399081` | `w848485110` | DIRECT_OSM | `[]` | sharedNodes=1; ids=7917322355; r399081 and w848485110 share OSM node 7917322355 |
| `r399081` | `w884128196` | DIRECT_OSM | `[]` | sharedNodes=2; ids=247941768,624633849; r399081 and w884128196 share OSM node 247941768, 624633849 |
| `r399081` | `w906802015` | DIRECT_OSM | `[]` | sharedNodes=1; ids=620102064; r399081 and w906802015 share OSM node 620102064 |
| `r399081` | `w906802016` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2452488495; r399081 and w906802016 share OSM node 2452488495 |
| `r399081` | `w906802017` | DIRECT_OSM | `[]` | sharedNodes=1; ids=332392239; r399081 and w906802017 share OSM node 332392239 |
| `r399081` | `w906802018` | DIRECT_OSM | `[]` | sharedNodes=1; ids=365255204; r399081 and w906802018 share OSM node 365255204 |
| `r399081` | `w906802019` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2655782667; r399081 and w906802019 share OSM node 2655782667 |
| `r399081` | `w906802020` | DIRECT_OSM | `[]` | sharedNodes=1; ids=952755607; r399081 and w906802020 share OSM node 952755607 |
| `r399081` | `w906802021` | DIRECT_OSM | `[]` | sharedNodes=1; ids=947338538; r399081 and w906802021 share OSM node 947338538 |
| `r399081` | `w906802022` | DIRECT_OSM | `[]` | sharedNodes=2; ids=365264664,952755942; r399081 and w906802022 share OSM node 365264664, 952755942 |
| `r399081` | `w906802023` | DIRECT_OSM | `[]` | sharedNodes=1; ids=365264682; r399081 and w906802023 share OSM node 365264682 |
| `r399081` | `w906802024` | DIRECT_OSM | `[]` | sharedNodes=1; ids=247941917; r399081 and w906802024 share OSM node 247941917 |
| `r399081` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=220277673; r399081 and w906802025 share OSM node 220277673 |
| `r399081` | `w927079942` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2382148849; r399081 and w927079942 share OSM node 2382148849 |
| `r399081` | `w977864069` | DIRECT_OSM | `[]` | sharedNodes=1; ids=3033657801; r399081 and w977864069 share OSM node 3033657801 |
| `r399081` | `w979432568` | DIRECT_OSM | `[]` | sharedNodes=1; ids=9061270691; r399081 and w979432568 share OSM node 9061270691 |
| `r399614` | `w195929170` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2063164680; r399614 and w195929170 share OSM node 2063164680 |
| `r9617478` | `r9617480` | DIRECT_OSM | `[]` | sharedNodes=3; sharedEdges=2; ids=220279942,365262227,8420373444; r9617478 and r9617480 share OSM node 220279942, 365262227, 8420373444 |
| `r9617478` | `w32487176` | DIRECT_OSM | `[]` | sharedNodes=1; ids=952397092; r9617478 and w32487176 share OSM node 952397092 |
| `r9617478` | `w81753515` | DIRECT_OSM | `[]` | sharedNodes=3; sharedEdges=2; ids=220278932,749439906,952397092; r9617478 and w81753515 share OSM node 220278932, 749439906, 952397092 |
| `r9617478` | `w906802027` | DIRECT_OSM | `[]` | sharedNodes=2; ids=749478265,952397092; r9617478 and w906802027 share OSM node 749478265, 952397092 |
| `r9617479` | `r9617480` | DIRECT_OSM | `[]` | sharedNodes=3; sharedEdges=2; ids=365262214,365262221,8420373450; r9617479 and r9617480 share OSM node 365262214, 365262221, 8420373450 |
| `w103320388` | `w193190823` | DIRECT_OSM | `[]` | sharedNodes=1; ids=1866515850; w103320388 and w193190823 share OSM node 1866515850 |
| `w103320388` | `w207645000` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2178986782; w103320388 and w207645000 share OSM node 2178986782 |
| `w103320388` | `w207645001` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2178986782; w103320388 and w207645001 share OSM node 2178986782 |
| `w103320388` | `w261237885` | DIRECT_OSM | `[]` | sharedNodes=2; ids=2020424094,2668587287; w103320388 and w261237885 share OSM node 2020424094, 2668587287 |
| `w103320388` | `w884128196` | DIRECT_OSM | `[]` | sharedNodes=1; ids=624633849; w103320388 and w884128196 share OSM node 624633849 |
| `w1215522889` | `w81781076` | DIRECT_OSM | `[]` | sharedNodes=1; ids=11262096825; w1215522889 and w81781076 share OSM node 11262096825 |
| `w1221659592` | `w308319728` | DIRECT_OSM | `[]` | sharedNodes=1; ids=3136100601; w1221659592 and w308319728 share OSM node 3136100601 |
| `w1347279844` | `w32486887` | DIRECT_OSM | `[]` | sharedNodes=1; ids=12462734550; w1347279844 and w32486887 share OSM node 12462734550 |
| `w1460105518` | `w175853322` | DIRECT_OSM | `[]` | sharedNodes=1; ids=1864125834; w1460105518 and w175853322 share OSM node 1864125834 |
| `w1460105519` | `w175853322` | DIRECT_OSM | `[]` | sharedNodes=1; ids=1864126084; w1460105519 and w175853322 share OSM node 1864126084 |
| `w1462368982` | `w195929170` | DIRECT_OSM | `[]` | sharedNodes=1; ids=13413892288; w1462368982 and w195929170 share OSM node 13413892288 |
| `w1501164930` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=13743356930; w1501164930 and w906802025 share OSM node 13743356930 |
| `w1501165019` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=13743355678; w1501165019 and w906802025 share OSM node 13743355678 |
| `w1501165023` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=13743355875; w1501165023 and w906802025 share OSM node 13743355875 |
| `w167688573` | `w20542134` | DIRECT_OSM | `[]` | sharedNodes=1; ids=220267645; w167688573 and w20542134 share OSM node 220267645 |
| `w191300071` | `w191300072` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2018880894; w191300071 and w191300072 share OSM node 2018880894 |
| `w191300072` | `w884128196` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8222342876; w191300072 and w884128196 share OSM node 8222342876 |
| `w191468052` | `w28838371` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2020422602; w191468052 and w28838371 share OSM node 2020422602 |
| `w191573376` | `w28838371` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2021567277; w191573376 and w28838371 share OSM node 2021567277 |
| `w191615745` | `w28838371` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2021987828; w191615745 and w28838371 share OSM node 2021987828 |
| `w191615746` | `w28838371` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2021987628; w191615746 and w28838371 share OSM node 2021987628 |
| `w191615747` | `w28838371` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2021987491; w191615747 and w28838371 share OSM node 2021987491 |
| `w191615748` | `w28838371` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2021987299; w191615748 and w28838371 share OSM node 2021987299 |
| `w192241823` | `w443774155` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2028002278; w192241823 and w443774155 share OSM node 2028002278 |
| `w195011307` | `w260065513` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2655506013; w195011307 and w260065513 share OSM node 2655506013 |
| `w195929170` | `w212766612` | DIRECT_OSM | `[]` | sharedNodes=2; ids=2063165114,2225810080; w195929170 and w212766612 share OSM node 2063165114, 2225810080 |
| `w195929170` | `w906802024` | DIRECT_OSM | `[]` | sharedNodes=1; ids=247941917; w195929170 and w906802024 share OSM node 247941917 |
| `w207645000` | `w207645001` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2178986782; w207645000 and w207645001 share OSM node 2178986782 |
| `w212370774` | `w906802019` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420373062; w212370774 and w906802019 share OSM node 8420373062 |
| `w217721693` | `w299384445` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2270239126; w217721693 and w299384445 share OSM node 2270239126 |
| `w229644709` | `w76207976` | DIRECT_OSM | `[]` | sharedNodes=1; ids=899128200; w229644709 and w76207976 share OSM node 899128200 |
| `w231923190` | `w906802022` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420373143; w231923190 and w906802022 share OSM node 8420373143 |
| `w234067887` | `w691693544` | DIRECT_OSM | `[]` | sharedNodes=2; ids=2423749269,2423749273; w234067887 and w691693544 share OSM node 2423749269, 2423749273 |
| `w234067887` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420373073; w234067887 and w906802025 share OSM node 8420373073 |
| `w237330209` | `w906802016` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2452488495; w237330209 and w906802016 share OSM node 2452488495 |
| `w28237778` | `w28237780` | DIRECT_OSM | `[]` | sharedNodes=1; ids=310147238; w28237778 and w28237780 share OSM node 310147238 |
| `w28237780` | `w28838371` | DIRECT_OSM | `[]` | sharedNodes=1; ids=310147304; w28237780 and w28838371 share OSM node 310147304 |
| `w287616945` | `w287616948` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2911962541; w287616945 and w287616948 share OSM node 2911962541 |
| `w28838371` | `w884128196` | DIRECT_OSM | `[]` | sharedNodes=1; ids=247941768; w28838371 and w884128196 share OSM node 247941768 |
| `w288428252` | `w49220133` | DIRECT_OSM | `[]` | sharedNodes=1; ids=624667729; w288428252 and w49220133 share OSM node 624667729 |
| `w30163681` | `w60082952` | DIRECT_OSM | `[]` | sharedNodes=1; ids=746628875; w30163681 and w60082952 share OSM node 746628875 |
| `w30163681` | `w906802017` | DIRECT_OSM | `[]` | sharedNodes=1; ids=332392239; w30163681 and w906802017 share OSM node 332392239 |
| `w30164445` | `w82331216` | DIRECT_OSM | `[]` | sharedNodes=1; ids=332399409; w30164445 and w82331216 share OSM node 332399409 |
| `w30196364` | `w30196495` | DIRECT_OSM | `[]` | sharedNodes=1; ids=332739673; w30196364 and w30196495 share OSM node 332739673 |
| `w30196538` | `w308143904` | DIRECT_OSM | `[]` | sharedNodes=2; sharedEdges=1; ids=332745905,3134276014; w30196538 and w308143904 share OSM node 332745905, 3134276014 |
| `w308145402` | `w308145403` | DIRECT_OSM | `[]` | sharedNodes=1; ids=3134289308; w308145402 and w308145403 share OSM node 3134289308 |
| `w308146279` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420373246; w308146279 and w906802025 share OSM node 8420373246 |
| `w308146766` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420373160; w308146766 and w906802025 share OSM node 8420373160 |
| `w308319722` | `w308319728` | DIRECT_OSM | `[]` | sharedNodes=2; ids=3136100613,4487732677; w308319722 and w308319728 share OSM node 3136100613, 4487732677 |
| `w308319728` | `w906802017` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420355397; w308319728 and w906802017 share OSM node 8420355397 |
| `w308336991` | `w308336995` | DIRECT_OSM | `[]` | sharedNodes=1; ids=3136252878; w308336991 and w308336995 share OSM node 3136252878 |
| `w308676450` | `w790979304` | DIRECT_OSM | `[]` | sharedNodes=2; ids=3139428013,3139436363; w308676450 and w790979304 share OSM node 3139428013, 3139436363 |
| `w32487176` | `w81753515` | DIRECT_OSM | `[]` | sharedNodes=2; ids=220277673,952397092; w32487176 and w81753515 share OSM node 220277673, 952397092 |
| `w32487176` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=220277673; w32487176 and w906802025 share OSM node 220277673 |
| `w32487176` | `w906802027` | DIRECT_OSM | `[]` | sharedNodes=1; ids=952397092; w32487176 and w906802027 share OSM node 952397092 |
| `w32487402` | `w906802022` | DIRECT_OSM | `[]` | sharedNodes=1; ids=365264664; w32487402 and w906802022 share OSM node 365264664 |
| `w32487402` | `w906802023` | DIRECT_OSM | `[]` | sharedNodes=1; ids=365264682; w32487402 and w906802023 share OSM node 365264682 |
| `w372155332` | `w81732492` | DIRECT_OSM | `[]` | sharedNodes=1; ids=3756879870; w372155332 and w81732492 share OSM node 3756879870 |
| `w451958337` | `w451958339` | DIRECT_OSM | `[]` | sharedNodes=1; ids=4487619628; w451958337 and w451958339 share OSM node 4487619628 |
| `w451958337` | `w451958342` | DIRECT_OSM | `[]` | sharedNodes=1; ids=4487619636; w451958337 and w451958342 share OSM node 4487619636 |
| `w48872395` | `w906802015` | DIRECT_OSM | `[]` | sharedNodes=1; ids=620102064; w48872395 and w906802015 share OSM node 620102064 |
| `w49220132` | `w848485110` | DIRECT_OSM | `[]` | sharedNodes=1; ids=624667695; w49220132 and w848485110 share OSM node 624667695 |
| `w62456617` | `w906802018` | DIRECT_OSM | `[]` | sharedNodes=1; ids=365255204; w62456617 and w906802018 share OSM node 365255204 |
| `w640414647` | `w640414648` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2655782788; w640414647 and w640414648 share OSM node 2655782788 |
| `w640414647` | `w906802019` | DIRECT_OSM | `[]` | sharedNodes=1; ids=2655782667; w640414647 and w906802019 share OSM node 2655782667 |
| `w753214808` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420373234; w753214808 and w906802025 share OSM node 8420373234 |
| `w78343141` | `w81759425` | DIRECT_OSM | `[]` | sharedNodes=1; ids=919686935; w78343141 and w81759425 share OSM node 919686935 |
| `w790979304` | `w790979305` | DIRECT_OSM | `[]` | sharedNodes=1; ids=7394413557; w790979304 and w790979305 share OSM node 7394413557 |
| `w790979304` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420373237; w790979304 and w906802025 share OSM node 8420373237 |
| `w81303076` | `w81732492` | DIRECT_OSM | `[]` | sharedNodes=1; ids=947139160; w81303076 and w81732492 share OSM node 947139160 |
| `w81323084` | `w906802021` | DIRECT_OSM | `[]` | sharedNodes=1; ids=947338538; w81323084 and w906802021 share OSM node 947338538 |
| `w81753515` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=220277673; w81753515 and w906802025 share OSM node 220277673 |
| `w81753515` | `w906802027` | DIRECT_OSM | `[]` | sharedNodes=1; ids=952397092; w81753515 and w906802027 share OSM node 952397092 |
| `w81781050` | `w906802020` | DIRECT_OSM | `[]` | sharedNodes=1; ids=952755607; w81781050 and w906802020 share OSM node 952755607 |
| `w81781076` | `w906802022` | DIRECT_OSM | `[]` | sharedNodes=1; ids=952755942; w81781076 and w906802022 share OSM node 952755942 |
| `w884128196` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420373163; w884128196 and w906802025 share OSM node 8420373163 |
| `w906802015` | `w906802017` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420355361; w906802015 and w906802017 share OSM node 8420355361 |
| `w906802016` | `w906802017` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420355416; w906802016 and w906802017 share OSM node 8420355416 |
| `w906802017` | `w906802023` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420355383; w906802017 and w906802023 share OSM node 8420355383 |
| `w906802018` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420373227; w906802018 and w906802025 share OSM node 8420373227 |
| `w906802019` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420373054; w906802019 and w906802025 share OSM node 8420373054 |
| `w906802020` | `w906802022` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420373094; w906802020 and w906802022 share OSM node 8420373094 |
| `w906802021` | `w906802022` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420373128; w906802021 and w906802022 share OSM node 8420373128 |
| `w906802023` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420373257; w906802023 and w906802025 share OSM node 8420373257 |
| `w906802024` | `w906802025` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8420373162; w906802024 and w906802025 share OSM node 8420373162 |
| `w927079942` | `w927079943` | DIRECT_OSM | `[]` | sharedNodes=1; ids=8601858524; w927079942 and w927079943 share OSM node 8601858524 |
| `w979432568` | `w979432569` | DIRECT_OSM | `[]` | sharedNodes=1; ids=9061270661; w979432568 and w979432569 share OSM node 9061270661 |
| `r1159264` | `r399081` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 81323084, "key": "w81323084"}]` | connector=w81323084; r1159264 and r399081 share no requirement of a common node; open waterway w81323084 shares OSM nodes with both |
| `r1203668` | `r399081` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 32487402, "key": "w32487402"}]` | connector=w906802023; r1203668 and r399081 share no requirement of a common node; open waterway w906802023 shares OSM nodes with both |
| `r17001378` | `r399081` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 1238091262, "key": "w1238091262"}]` | connector=w1238091262; r399081 and r17001378 share no requirement of a common node; open waterway w1238091262 shares OSM nodes with both |
| `r399081` | `r399614` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 195929170, "key": "w195929170"}]` | connector=w195929170; r399614 and r399081 share no requirement of a common node; open waterway w195929170 shares OSM nodes with both |
| `r399081` | `r9617478` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 32487176, "key": "w32487176"}]` | connector=w32487176; r399081 and r9617478 share no requirement of a common node; open waterway w32487176 shares OSM nodes with both |
| `r399081` | `w20542134` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 167688573, "key": "w167688573"}]` | connector=w167688573; r399081 and w20542134 share no requirement of a common node; open waterway w167688573 shares OSM nodes with both |
| `r399081` | `w261237885` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 103320388, "key": "w103320388"}]` | connector=w103320388; r399081 and w261237885 share no requirement of a common node; open waterway w103320388 shares OSM nodes with both |
| `r399081` | `w30164445` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 82331216, "key": "w82331216"}]` | connector=w82331216; r399081 and w30164445 share no requirement of a common node; open waterway w82331216 shares OSM nodes with both |
| `r399081` | `w30196364` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 30196495, "key": "w30196495"}]` | connector=w30196495; r399081 and w30196364 share no requirement of a common node; open waterway w30196495 shares OSM nodes with both |
| `r399081` | `w308145402` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 308145403, "key": "w308145403"}]` | connector=w308145403; r399081 and w308145402 share no requirement of a common node; open waterway w308145403 shares OSM nodes with both |
| `r399081` | `w308319722` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 308319728, "key": "w308319728"}]` | connector=w308319728; w308319722 and r399081 share no requirement of a common node; open waterway w308319728 shares OSM nodes with both |
| `r399081` | `w308676450` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 790979304, "key": "w790979304"}]` | connector=w790979304; w308676450 and r399081 share no requirement of a common node; open waterway w790979304 shares OSM nodes with both |
| `r399081` | `w32486887` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 1347279844, "key": "w1347279844"}]` | connector=w1347279844; r399081 and w32486887 share no requirement of a common node; open waterway w1347279844 shares OSM nodes with both |
| `r399081` | `w49220132` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 848485110, "key": "w848485110"}]` | connector=w848485110; r399081 and w49220132 share no requirement of a common node; open waterway w848485110 shares OSM nodes with both |
| `r399081` | `w49220133` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 288428252, "key": "w288428252"}]` | connector=w288428252; w49220133 and r399081 share no requirement of a common node; open waterway w288428252 shares OSM nodes with both |
| `r399081` | `w691693544` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 234067887, "key": "w234067887"}]` | connector=w234067887; w691693544 and r399081 share no requirement of a common node; open waterway w234067887 shares OSM nodes with both |
| `r399081` | `w76207976` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 229644709, "key": "w229644709"}]` | connector=w229644709; w76207976 and r399081 share no requirement of a common node; open waterway w229644709 shares OSM nodes with both |
| `r399081` | `w78343141` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 81759425, "key": "w81759425"}]` | connector=w81759425; r399081 and w78343141 share no requirement of a common node; open waterway w81759425 shares OSM nodes with both |
| `r399081` | `w81303076` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 81732492, "key": "w81732492"}]` | connector=w81732492; w81303076 and r399081 share no requirement of a common node; open waterway w81732492 shares OSM nodes with both |
| `r399081` | `w81753515` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 32487176, "key": "w32487176"}]` | connector=w906802025; w81753515 and r399081 share no requirement of a common node; open waterway w906802025 shares OSM nodes with both |
| `r9617478` | `w81753515` | WATERWAY_CONNECTOR | `[{"osmType": "way", "osmId": 32487176, "key": "w32487176"}]` | connector=w906802027; w81753515 and r9617478 share no requirement of a common node; open waterway w906802027 shares OSM nodes with both |

## Notes

- Research topology discovery only. Not a production WaterSystem.
- Names are never used as a join or discovery key.
- BFS expands only through DIRECT_OSM and WATERWAY_CONNECTOR.
- GEOMETRY_CONTACT / NEARBY / PORTAGE are candidates, not confirmed water connections.
- Navigability is not evaluated.

Княжа и Княжка, одноимённые озёра, relation vs внешняя акватория — разные вершины.
Две outer-площади seed-relation не сливаются в один polygon.
