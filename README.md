# КП17 — чертёж один-в-один с PDF (DWG/DXF)

## Скачать

**DWG (1:1 с PDF):**  
https://github.com/advharvest-arch/my-first-project/raw/cursor/kp17-dwg-sheet-6d73/drawings/KP17.dwg

**DXF:**  
https://github.com/advharvest-arch/my-first-project/raw/cursor/kp17-dwg-sheet-6d73/drawings/KP17.dxf

## Что внутри

`drawings/KP17.dwg` — векторная копия исходного листа A0 из AutoCAD PDF:

- все виды, сечения, узлы, таблицы, примечания, штамп;
- формат **A0** в миллиметрах (~1189×841);
- ~129 тыс. полилиний (геометрия + контуры текста).

Текст в PDF-plot представлен контурами букв (как после печати в PDF) — визуально совпадает с оригиналом.

Исходник: `reference/KP17_original.pdf`.

## Пересобрать из PDF

```bash
pip3 install -r requirements.txt
# нужен Inkscape, poppler-utils и ODA File Converter
python3 -m kp17.scripts.pdf_to_kp17_dwg
```

## Правки

Откройте `drawings/KP17.dwg` в AutoCAD / nanoCAD / BricsCAD и редактируйте геометрию напрямую.

Дополнительно есть параметрический генератор (`kp17/scripts/generate_kp17.py` → `KP17_parametric.dxf`) для схемных правок по данным в `kp17/data/kp17_data.py` — это не 1:1 копия PDF.
