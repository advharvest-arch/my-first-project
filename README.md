# КП17 — семантический DWG/DXF (TEXT, DIMENSION, LINE)

## Скачать

**DWG:** https://github.com/advharvest-arch/my-first-project/raw/cursor/kp17-dwg-sheet-6d73/drawings/KP17.dwg

**DXF:** https://github.com/advharvest-arch/my-first-project/raw/cursor/kp17-dwg-sheet-6d73/drawings/KP17.dxf

## Что внутри (объекты AutoCAD)

| Тип | Кол-во (ориентир) | Слой |
|-----|-------------------|------|
| `TEXT` | ~995 | `TEXT` |
| `MTEXT` | ~15 | `TEXT` |
| `DIMENSION` | ~196 | `DIMS` |
| `LINE` | ~4210 | `GEOMETRY` / `_THIN` / `_THICK` |
| `LWPOLYLINE` | ~4420 | `GEOMETRY`… |

Текст редактируется как текст, размеры — как размеры (LINEAR DIMENSION с подписью из чертежа).

Формат листа: **A0**, мм. Исходник: `reference/KP17_original.pdf`.

## Пересобрать

```bash
pip3 install -r requirements.txt
python3 -m kp17.scripts.pdf_to_semantic_dwg
```

Нужны: `pdfminer.six`, ODA File Converter (для DXF→DWG).
