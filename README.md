# КП17 — семантический DWG (как PDF: чёрный, TEXT / DIMENSION / LINE)

## Скачать

https://github.com/advharvest-arch/my-first-project/raw/cursor/kp17-dwg-sheet-6d73/drawings/KP17.dwg

## Состав объектов

| Тип | ~кол-во | Слой | Цвет |
|-----|---------|------|------|
| TEXT / MTEXT | ~1150 | TEXT | 7 (чёрный) |
| DIMENSION | ~160 | DIMS | 7 |
| LINE / LWPOLYLINE | ~8600 | GEOMETRY… | 7 |

Все слои и объекты — **цвет 7**, как монохромный PDF.

- Подписи, спецификация, примечания → редактируемый **TEXT/MTEXT**
- Числовые размеры (11700, 30950, 1900…) → **DIMENSION**
- Линии чертежа → **LINE / LWPOLYLINE**

## Пересборка

```bash
python3 -m kp17.scripts.pdf_to_semantic_dwg
```
