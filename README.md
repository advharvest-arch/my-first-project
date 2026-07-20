# КП17 — нативный DWG для AutoCAD

## Скачать

https://github.com/advharvest-arch/my-first-project/raw/cursor/kp17-dwg-sheet-6d73/drawings/KP17.dwg

Шрифт из PDF (положите в папку Fonts AutoCAD или рядом с чертежом):  
`drawings/fonts/GOSTCommon.ttf`

## Типы объектов (не контуры PDF)

| Что | Тип AutoCAD | Слой |
|-----|-------------|------|
| Подписи, примечания | **MTEXT** (шрифт GOSTCommon) | TEXT |
| Размеры | **DIMENSION** (LINEAR) | DIMS |
| Каркасы / сечения | **LWPOLYLINE** (RECTANG, замкнутый) | REBAR / SECTION |
| Спецификация, ведомости | **INSERT** блоков-таблиц `TABLE_*` (сетка + текст ячеек) | TABLE |
| Оформление | рамка, штамп | FRAME / TITLE |

Цвет всех слоёв: **7** (как монохромный PDF).

## Пересборка

```bash
python3 -m kp17.scripts.build_native_kp17
```

## Замечание по TABLE

Настоящий объект `ACAD_TABLE` создаётся штатно только в AutoCAD. Здесь таблицы — блоки `TABLE_SPEC_KP17`, `TABLE_STEEL_KP17`, `TABLE_WELDS_KP17` с сеткой и текстом ячеек (удобно править). В AutoCAD: выделите INSERT → при необходимости расчлените или пересоздайте как TABLE.
