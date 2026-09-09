# Seliger topology graph validation

Исследовательская проверка PR #85. **БД, WRG, seligerDebug не изменялись.**
Evidence каждого confirmed edge пересчитан из OSM store (node id / edge id),
а не принят на слово из `edge.evidence`.

## 1. Summary

- DIRECT_OSM checked: **189**
- WATERWAY_CONNECTOR checked: **20**
- INVALID_DIRECT_CONNECTIONS: **0**
- INVALID_WATERWAY_CONNECTORS: **0**
- suspicious: **1**
- confirmed component: **136**
- confirmed nodes with no shortest path: **0**

## 2. Direct OSM validation

Все DIRECT_OSM имеют хотя бы один shared OSM node или shared OSM edge,
пересчитанный из store. Claimed `sharedNodes` ⊆ фактического пересечения.

Полный перечень DIRECT_OSM — в JSON (`confirmed_connections.directOsm`).

## 3. Waterway connector validation

| A | connector | B | nodes A | nodes B | geom A | geom B | skipped | valid |
|---|---|---|---:|---:|---|---|---|---|
| `r1159264` | `w81323084` | `r399081` | 1 | 1 | True | True | — | True |
| `r1203668` | `w32487402` | `r399081` | 2 | 2 | True | True | — | True |
| `r1203668` | `w906802023` | `r399081` | 1 | 1 | True | True | — | True |
| `r17001378` | `w1238091262` | `r399081` | 2 | 1 | True | True | — | True |
| `r399081` | `w195929170` | `r399614` | 1 | 1 | True | True | — | True |
| `r399081` | `w167688573` | `w20542134` | 1 | 1 | False | True | — | True |
| `r399081` | `w103320388` | `w261237885` | 1 | 2 | True | True | — | True |
| `r399081` | `w82331216` | `w30164445` | 1 | 1 | True | True | — | True |
| `r399081` | `w30196495` | `w30196364` | 1 | 1 | True | True | — | True |
| `r399081` | `w308145403` | `w308145402` | 1 | 1 | True | True | — | True |
| `r399081` | `w308319728` | `w308319722` | 1 | 2 | True | True | — | True |
| `r399081` | `w790979304` | `w308676450` | 1 | 2 | True | True | — | True |
| `r399081` | `w1347279844` | `w32486887` | 1 | 1 | True | True | — | True |
| `r399081` | `w848485110` | `w49220132` | 1 | 1 | True | True | — | True |
| `r399081` | `w288428252` | `w49220133` | 1 | 1 | True | True | — | True |
| `r399081` | `w234067887` | `w691693544` | 1 | 2 | True | True | — | True |
| `r399081` | `w229644709` | `w76207976` | 1 | 1 | True | True | — | True |
| `r399081` | `w81759425` | `w78343141` | 1 | 1 | True | True | — | True |
| `r399081` | `w81732492` | `w81303076` | 1 | 1 | True | True | — | True |
| `r399081` | `w906802025` | `w81753515` | 1 | 1 | True | True | — | True |
| `r9617478` | `w906802027` | `w81753515` | 2 | 1 | True | True | — | True |

INVALID_WATERWAY_CONNECTORS: **0**. Каждый connector делит OSM node и с A, и с B.
Proximity без shared node не использовалась как доказательство.

## 4. BFS validation

Кратчайший путь по confirmed edges (DIRECT_OSM ∪ WATERWAY_CONNECTOR).
Каждый hop имеет type + evidence. Скрытых переходов нет: если ребра нет в графе,
пути нет.

### `r399081` Селигер seed

hopsFromSeed (discovery) = 0; shortest confirmed path length = 0

`r399081` (seed)

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

`r399081` (seed)

### `r1203668` Полоновка

hopsFromSeed (discovery) = 1; shortest confirmed path length = 1

- `r399081` → `r1203668` **DIRECT_OSM**  
  evidence: sharedNodes=6 ids=[365264662, 365264663, 365264664, 365264682]

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `r1203668` **DIRECT_OSM**  
  evidence: sharedNodes=6 ids=[365264662, 365264663, 365264664, 365264682]

### `w81753515` Княжа area

hopsFromSeed (discovery) = 1; shortest confirmed path length = 1

- `r399081` → `w81753515` **DIRECT_OSM**  
  evidence: sharedNodes=3 ids=[220277673, 952396939, 952397004]

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `w81753515` **DIRECT_OSM**  
  evidence: sharedNodes=3 ids=[220277673, 952396939, 952397004]

### `r9617478` Серемо

hopsFromSeed (discovery) = 2; shortest confirmed path length = 2

- `r399081` → `w32487176` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[220277673]
- `w32487176` → `r9617478` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[952397092]

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `w32487176` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[220277673]
- `w32487176` → `r9617478` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[952397092]

### `r9617480` Глубокое r9617480

hopsFromSeed (discovery) = 3; shortest confirmed path length = 3

- `r399081` → `w32487176` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[220277673]
- `w32487176` → `r9617478` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[952397092]
- `r9617478` → `r9617480` **DIRECT_OSM**  
  evidence: sharedNodes=3 ids=[220279942, 365262227, 8420373444]

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `w32487176` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[220277673]
- `w32487176` → `r9617478` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[952397092]
- `r9617478` → `r9617480` **DIRECT_OSM**  
  evidence: sharedNodes=3 ids=[220279942, 365262227, 8420373444]

### `r9617479` Мелкое

hopsFromSeed (discovery) = 4; shortest confirmed path length = 4

- `r399081` → `w32487176` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[220277673]
- `w32487176` → `r9617478` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[952397092]
- `r9617478` → `r9617480` **DIRECT_OSM**  
  evidence: sharedNodes=3 ids=[220279942, 365262227, 8420373444]
- `r9617480` → `r9617479` **DIRECT_OSM**  
  evidence: sharedNodes=3 ids=[365262214, 365262221, 8420373450]

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `w32487176` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[220277673]
- `w32487176` → `r9617478` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[952397092]
- `r9617478` → `r9617480` **DIRECT_OSM**  
  evidence: sharedNodes=3 ids=[220279942, 365262227, 8420373444]
- `r9617480` → `r9617479` **DIRECT_OSM**  
  evidence: sharedNodes=3 ids=[365262214, 365262221, 8420373450]

### `r18072605` Княжка

hopsFromSeed (discovery) = 5; shortest confirmed path length = 5

- `r399081` → `w32487176` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[220277673]
- `w32487176` → `r9617478` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[952397092]
- `r9617478` → `r9617480` **DIRECT_OSM**  
  evidence: sharedNodes=3 ids=[220279942, 365262227, 8420373444]
- `r9617480` → `r9617479` **DIRECT_OSM**  
  evidence: sharedNodes=3 ids=[365262214, 365262221, 8420373450]
- `r9617479` → `r18072605` **DIRECT_OSM**  
  evidence: sharedNodes=2 ids=[12188675901, 12188675941]

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `w32487176` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[220277673]
- `w32487176` → `r9617478` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[952397092]
- `r9617478` → `r9617480` **DIRECT_OSM**  
  evidence: sharedNodes=3 ids=[220279942, 365262227, 8420373444]
- `r9617480` → `r9617479` **DIRECT_OSM**  
  evidence: sharedNodes=3 ids=[365262214, 365262221, 8420373450]
- `r9617479` → `r18072605` **DIRECT_OSM**  
  evidence: sharedNodes=2 ids=[12188675901, 12188675941]

### `w1316976066` Варварина протока

hopsFromSeed (discovery) = 1; shortest confirmed path length = 1

- `r399081` → `w1316976066` **DIRECT_OSM**  
  evidence: sharedNodes=2 ids=[12188675959, 12188675960]

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `w1316976066` **DIRECT_OSM**  
  evidence: sharedNodes=2 ids=[12188675959, 12188675960]

### `r18358803` Святое

hopsFromSeed (discovery) = 2; shortest confirmed path length = 2

- `r399081` → `w1316976066` **DIRECT_OSM**  
  evidence: sharedNodes=2 ids=[12188675959, 12188675960]
- `w1316976066` → `r18358803` **DIRECT_OSM**  
  evidence: sharedNodes=2 ids=[12188675942, 12188675977]

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `w1316976066` **DIRECT_OSM**  
  evidence: sharedNodes=2 ids=[12188675959, 12188675960]
- `w1316976066` → `r18358803` **DIRECT_OSM**  
  evidence: sharedNodes=2 ids=[12188675942, 12188675977]

### `w20542134` Белое-южное

hopsFromSeed (discovery) = 2; shortest confirmed path length = 1

- `r399081` → `w20542134` **WATERWAY_CONNECTOR** connector=w167688573  
  evidence: via w167688573

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `w167688573` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[14085575805]
- `w167688573` → `w20542134` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[220267645]

### `w167688573` canal

hopsFromSeed (discovery) = 1; shortest confirmed path length = 1

- `r399081` → `w167688573` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[14085575805]

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `w167688573` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[14085575805]

### `r399614` Сиг

hopsFromSeed (discovery) = 2; shortest confirmed path length = 1

- `r399081` → `r399614` **WATERWAY_CONNECTOR** connector=w195929170  
  evidence: via w195929170

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `w195929170` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[247941917]
- `w195929170` → `r399614` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[2063164680]

### `w195929170` Сиговка

hopsFromSeed (discovery) = 1; shortest confirmed path length = 1

- `r399081` → `w195929170` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[247941917]

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `w195929170` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[247941917]

### `w30164445` Рясивое

hopsFromSeed (discovery) = 2; shortest confirmed path length = 1

- `r399081` → `w30164445` **WATERWAY_CONNECTOR** connector=w82331216  
  evidence: via w82331216

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `w82331216` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[2421493972]
- `w82331216` → `w30164445` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[332399409]

### `r1159264` Ласцо

hopsFromSeed (discovery) = 2; shortest confirmed path length = 1

- `r399081` → `r1159264` **WATERWAY_CONNECTOR** connector=w81323084  
  evidence: via w81323084

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `w81323084` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[947338538]
- `w81323084` → `r1159264` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[526889446]

### `w81323084` Зуёвка / Ласцо connector

hopsFromSeed (discovery) = 1; shortest confirmed path length = 1

- `r399081` → `w81323084` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[947338538]

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `w81323084` **DIRECT_OSM**  
  evidence: sharedNodes=1 ids=[947338538]

### `r17001378` rel 17001378

hopsFromSeed (discovery) = 1; shortest confirmed path length = 1

- `r399081` → `r17001378` **DIRECT_OSM**  
  evidence: sharedNodes=3 ids=[950124294, 9235426556, 11500497926]

DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):

- `r399081` → `r17001378` **DIRECT_OSM**  
  evidence: sharedNodes=3 ids=[950124294, 9235426556, 11500497926]

Полные пути всех узлов компонента — JSON `confirmed_component.shortestPaths`.

## 5. Island validation

| object | parent island | direct topology | connector | in BFS | ok |
|---|---|---|---|---|---|
| `w1305535843` island pond | [31057309] | False | False | False | True |
| `w1135420114` island pond | [1135420115] | False | False | False | True |
| `w20542134` Белое-южное | [30171650, 430623975, 430623978, 430623981, 430623977, 430623976, 430623979, 430623980] | False | True | True | True |
| `w49220130` Чёрное | [30171650, 430623975, 430623978, 430623981, 430623977, 430623976, 430623979, 430623980] | False | False | False | True |

Островная вода без connector/shared node **не** должна быть в confirmed BFS.
Нарушений нет.

## 6. Nearby validation

| object | in BFS | nearby listed | distance m | ok |
|---|---|---|---:|---|
| `w119343953` Садок | False | PORTAGE_CANDIDATE | 16.350230228451505 | True |
| `w430378915` w430378915 | False | PORTAGE_CANDIDATE | 29.84473811443329 | True |
| `r16459681` r16459681 | False | NEARBY_CANDIDATE | 172.56269744552228 | True |
| `r1729194` Дивное | False | NEARBY_CANDIDATE | 183.12688783200156 | True |
| `r6407846` r6407846 | False | NEARBY_CANDIDATE | 113.54121765706503 | True |

Ни один nearby-focus объект не входит в confirmed BFS.

## 7. Polonets validation

- present: True
- inConfirmedComponent: **False**
- nearby: {'key': 'r1236637', 'osmType': 'relation', 'osmId': 1236637, 'name': 'озеро Полонец', 'distanceM': 2211.180937099554, 'geometryRelation': 'disjoint', 'candidateReason': 'in seed scan radius; no confirmed OSM water path', 'connectionType': 'NEARBY_CANDIDATE', 'inConfirmedComponent': False}
- Полонец вне confirmed component; сохранён как nearby/external finding.

## 8. Duplicate-name validation

- Глубокое relation `r9617480`: {'key': 'r9617480', 'inConfirmedComponent': True, 'hopsFromSeed': 3, 'name': 'Глубокое'}
- Глубокое way `w30196394`: {'key': 'w30196394', 'inConfirmedComponent': False, 'hopsFromSeed': None, 'name': 'Глубокое'}
- sameVertex: False
- both in confirmed component: False
Имена не являются ключом: объекты с одним name остаются разными вершинами.

## 9. Invalid edges

- INVALID_DIRECT_CONNECTIONS (0):
  - *(empty, expected)*
- INVALID_WATERWAY_CONNECTORS (0):
  - *(empty)*

## 10. Suspicious edges

### PR #85 finding (documented before the fix)

Алгоритм WATERWAY_CONNECTOR строил клику всех confirmed areas,
делящих node с одним waterway. Way **32487176** (ось Княжи) касается
трёх площадей: Селигер, Княжа `w81753515`, Серемо `r9617478`.
Поэтому PR #85 создавал area–area ребро Селигер—Серемо и прятал Княжу.

| from | to | connector | still present after fix |
|---|---|---|---|
| `r399081` | `r9617478` | `w32487176` | **False** |
| `r399081` | `w81753515` | `w32487176` | **False** |
| `r9617478` | `w81753515` | `w32487176` | **False** |

- `r399081` — `r9617478`: PR #85 emitted Seliger—Sereymo via the Knyazha axis way 32487176. The way shares endpoint 220277673 with Seliger and endpoint 952397092 with Sereymo, so node identity is real; but area w81753515 (Княжа) shares both endpoints and occupies the whole way. The pair skipped Knyazha.
  createdBy: clique of all confirmed areas sharing nodes with a waterway
  shouldBe: no area–area WATERWAY_CONNECTOR when ≥3 areas touch the way; chain is r399081 —DIRECT_OSM— w81753515 —DIRECT_OSM— r9617478 (river w32487176 remains a vertex)
- `r399081` — `w81753515`: same clique; Sereymo is a third area on the way
  createdBy: clique of all confirmed areas sharing nodes with a waterway
  shouldBe: DIRECT_OSM Seliger—Knyazha is sufficient; do not pair via the 3-area axis
- `r9617478` — `w81753515`: same clique; Seliger is a third area on the way
  createdBy: clique of all confirmed areas sharing nodes with a waterway
  shouldBe: DIRECT_OSM Knyazha—Sereymo is sufficient

Исправление: WATERWAY_CONNECTOR только если на connector ровно **две**
confirmed area. Иначе connector остаётся вершиной, цепочка идёт через неё
и через промежуточные площади по DIRECT_OSM.

- `r399081` — `w20542134` via `w167688573`: shared OSM nodes (proof) but reconstructed geometries do not touch; skipped=None

## 11. Final conclusion

Confirmed graph отвечает на вопрос «почему A связан с B» для каждого ребра:
DIRECT_OSM → конкретные shared node/edge ids; WATERWAY_CONNECTOR → OSM id
connector + shared nodes с обоими концами. Proximity и островная вода без
connector в BFS не входят. Полонец снаружи компонента.

Suspicious (не invalid): 1.
Сейчас это geometry cross-check (shared OSM node есть, shapely-полигон
seed не пересекает линию connector — типично endpoint на inner ring).
Это не proximity-join и не скрытый skip.
