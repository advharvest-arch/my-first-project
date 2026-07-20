# КП17 — как PDF визуально, объекты AutoCAD без наложений

## Скачать

https://github.com/advharvest-arch/my-first-project/raw/cursor/kp17-dwg-sheet-6d73/drawings/KP17.dwg

**Шрифт:** `drawings/fonts/GOSTCommon.ttf` → скопировать в папку Fonts AutoCAD (иначе подставится другой шрифт).

## Что в файле

1. **Без наложения текста** — контуры букв (SPLINE/мелкие штрихи под текстом) не импортируются; подписи только **MTEXT** (стиль GOST / GOSTCommon.ttf), без дублей и без «склеенных» цифр.
2. **Размеры — объекты DIMENSION** — 227 шт. LINEAR с блоком `*D…` (линия + засечки + текст внутри размера). PDF-линии размеров в этих местах убраны, чтобы не было «линия + текст отдельно».
3. **Визуал листа** — остальная геометрия с PDF (LWPOLYLINE), цвет ACI 7 (монохром как в исходнике).

| Тип | Кол-во | Слой |
|-----|--------|------|
| LWPOLYLINE | ~5400 | GEOMETRY / REBAR |
| MTEXT | ~1030 | TEXT |
| DIMENSION | 227 | DIMS |

В AutoCAD: клик по размеру → Properties → объект **Dimension** (не Line + Text).

## Пересборка

```bash
python3 -m kp17.scripts.build_identical_kp17
```
