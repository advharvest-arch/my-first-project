# КП17 — редактируемый чертёж (DXF/DWG)

Полный лист арматурного каркаса **КП17** (формат А0) в AutoCAD-совместимых форматах.

## Файлы чертежа

| Файл | Назначение |
|------|------------|
| `drawings/KP17.dwg` / `.dxf` | **Основной редактируемый лист**: слои, текст, таблицы, геометрия |
| `drawings/KP17_underlay_from_pdf.dwg` / `.dxf` | Векторная подложка с исходного PDF (AutoCAD 2021) |
| `drawings/KP17_full.dwg` / `.dxf` | Редактируемый лист + подложка (слой `UNDERLAY`, по умолчанию выключен) |
| `reference/KP17_original.pdf` | Исходный PDF |

## Слои (`KP17.dwg`)

- `REBAR` — рабочая арматура  
- `TRANSVERSE` — поперечная / распределительная  
- `EMBEDDED` — рамы Р17, фиксаторы  
- `SECTIONS` — сечения 1-1…7-7, 8-8  
- `DETAILS` — ведомость деталей  
- `SCHEME` — схема рабочей арматуры  
- `TABLE` / `TEXT` / `NOTES` / `DIMS` — таблицы, текст, примечания, размеры  
- `FRAME` / `TITLE` — рамка и штамп  
- `UNDERLAY` — только в `KP17_full` (геометрия из PDF)

## Как пересобрать лист

```bash
python3 -m kp17.scripts.generate_kp17          # → drawings/KP17.dxf
python3 -m kp17.scripts.merge_and_dwg          # DXF→DWG + full
```

Данные спецификации и размеров: `kp17/data/kp17_data.py`.

## Как править

**Через данные (рекомендуется):**

```bash
python3 -m kp17.scripts.edit_kp17 --set-bar-qty 3 16 --regen
python3 -m kp17.scripts.edit_kp17 --set-length 32000 --regen
python3 -m kp17.scripts.edit_kp17 --set-mass 6500.0 --regen
```

**Вручную в AutoCAD/nanoCAD:** открыть `drawings/KP17.dwg`, править объекты на слоях.

**Программно через ezdxf:** открыть DXF/DWG-пайплайн, изменить сущности, пересохранить.

## Зависимости

```bash
pip3 install --user ezdxf
```

Конвертация DXF→DWG: ODA File Converter (уже использован при сборке артефактов в `drawings/`).
