# OPEN_RUSSIAN_DATA_READY

E1.5 research package under `sea-map/research/open-russian-data/`.  
**No production changes. No letters. No ENC purchase. No PR/merge/deploy (per task).**

Checked: **2026-08-27**.

---

## 1. Какие российские данные реально доступны бесплатно?

| Класс | Примеры | Статус |
| --- | --- | --- |
| Нормативы/классификаторы ЭНК | Волго-Балт: классификатор кодов ЭНК, РД/требования | **public** |
| Схемы/каталоги покрытия | Волго-Балт ENC page, ЦКТ folio list | **public meta**; cells closed |
| Перечни судовых ходов / категории / сроки | Распоряжения Росморречфлота (АТ-442 и правки) на сайтах бассейнов | **public PDF** |
| Оперативные бюллетени | КиМ ежесуточные; Волга/Волго-Балт/Дон разделы | **public** |
| Участки ВВП таблицами | Камводпуть XLSX | **public** |
| Габариты мостов | Камводпуть PDF | **public** |
| Путевые условия HTML | Азово-Дон `waterbox/character` | **public** |
| КНН / ИС (ЕГС) | Волга cartography | **restricted** (покупка/заявка) |
| Ячейки S-57/S-63 | фонд ГЭНК | **closed** |

## 2. Какие можно использовать технически?

Сейчас технически извлекаемы:

- КиМ bulletin PDF → depths/widths + NavigationEvent (fixture → 40+ WaterFacts, closures)
- Кама XLSX → named segments
- Волго-Балт normative PDFs → coverage/classifier **metadata** (не геометрия фарватера)
- Волжские распоряжения → таблицы (OCR сложный; samples сохранены)

Не технически (в этом проходе): сами ENC cells; полный ИС; идеальный HTML scrape габаритов шлюзов Волго-Балта (числа не в тексте).

## 3. Коммерческое/продуктовое использование без отдельного разрешения

**Только то, что прямо следует из опубликованного:**

- Публичный доступ к просмотру/скачиванию HTML/PDF **наблюдался**.
- **Нет** опубликованной лицензии вида «можно строить коммерческий routing graph / redistributable DB».
- Волго-Балт **прямо** запрещает свободное получение ячеек ЭНК без лицензии.
- Молчание условий ≠ разрешение. Для продуктового слоя фактов с атрибуцией — нужна отдельная правовая оценка; исследование **не утверждает** commercial OK.

## 4. Какие данные дают геометрию?

| Источник | Геометрия? |
| --- | --- |
| OSM / BRouter / lake masks | **да** (уже в AquaRoute) |
| Открытые бюллетени/распоряжения | **нет** centreline; есть км-привязки и текстовые участки |
| Классификатор ЭНК / каталоги фолио | границы покрытия meta, не судовой ход |
| ENC cells | да, но **closed** |

## 5. Какие дают только метаданные?

Почти все открытые российские источники этого этапа: depths, widths, lock names, seasons, closures, segment names, bridge clearances, classifier codes, hazard narratives.

## 6. Какие могут существенно улучшить WaterGraph?

Приоритет следующего (research→позже soft metadata):

1. **КиМ + Волга bulletins** → edge constraints / availability / advisory  
2. **Кама segments + bridge clearances** → coverage + height metadata  
3. **АТ-442 family** → seasonal open/close + guaranteed dims (после устойчивого table extract)  
4. **Дон character/forecast** → draft limits / non-guaranteed warnings  
5. Волго-Балт lock dims — после numeric extract  

Не заменяют Phase A–D геометрию; усиливают **confidence / soft priors / events**.

## 7. Какие особенно ценны для будущего AI?

- NavigationEvent (closures, one-way, lock works)
- guaranteed vs actual depth divergence
- official↔OSM/BRouter disagreement
- source confidence / coverage gaps
- userCorrection + RouteTrace outcomes  

Принцип: AI не придумывает фарватер; учится на фактах → маршрутах → ошибках → corrections.

---

## Most valuable open datasets (shortlist)

1. Kim-online informational bulletins  
2. Volga ops + fairway dispositions (public PDFs)  
3. Kamvodput XLSX + bridge PDFs  
4. Volgo-Balt ENC **classifiers** (meta for future ENC, not cells)  
5. ADGBU path conditions + depth forecasts  

## Examples extracted

See `normalized/water-facts.sample.json`, `normalized/navigation-events.sample.json`.

Пример события: запрет КиМ шлюз №7–№8, 44.0–41.0 км (bulletin 2024-05-17).  
Пример факта: `г. Тверь - Иваньковский г/у` guaranteed/actual 400 cm / 100 m.

## OSM / BRouter / RouteTrace comparison

`fixtures/osm-comparison.json` — Volga, Oka, Kama, Don:

- **Only OSM:** continuous polylines  
- **Only RU open:** official depths/events/segment inventories  
- **Conflict risk:** OSM navigability vs «габариты не гарантируются» / shallow guaranteed depths  
- **Gap:** no open official fairway centreline  

## Recommended next stage (still no ENC letters)

1. Soft **Open Knowledge Layer** ingest (Kim + Kama first) as metadata beside WaterGraph — separate task.  
2. Improve PDF table OCR for AT-442.  
3. Optional careful RIS.kim API discovery (terms first).  
4. Keep ENC DATA_PILOT paused until product needs geometry ENC uniquely provides.

## AI-ready signals

Listed in `water-graph-hints.ts` (`AI_READY_SIGNALS`).

## Repo layout

```
research/open-russian-data/
  README.md SOURCES.md schema.md sources.json
  types.ts normalize.ts pdf-extract.ts source-quality.ts water-graph-hints.ts
  run-open-data.ts
  fixtures/ raw/ normalized/ reports/ tests/
```

Run:

```bash
npx tsx research/open-russian-data/run-open-data.ts
npx vitest run research/open-russian-data/tests
```
