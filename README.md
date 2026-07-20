# КП17 — визуально как PDF + объекты AutoCAD

## Скачать

**DWG:** https://github.com/advharvest-arch/my-first-project/raw/cursor/kp17-dwg-sheet-6d73/drawings/KP17.dwg

**Шрифт (обязательно):** `drawings/fonts/GOSTCommon.ttf`  
Скопируйте в папку Fonts AutoCAD (`C:\Windows\Fonts` или Support File Search Path), иначе подписи не совпадут с PDF.

## Как сделано

| Слой / тип | Содержание |
|------------|------------|
| `GEOMETRY` / `REBAR` — **LWPOLYLINE** | Линии листа **точно с PDF** (без контуров букв) |
| `TEXT` — **MTEXT** | Весь текст PDF, шрифт **GOSTCommon**, координаты с PDF |
| `DIMS` — **DIMENSION** | Размеры (11700, 30950, 1900…) как объекты AutoCAD |
| Цвет | **7** (монохром, как PDF) |

Визуально лист совпадает с исходным PDF; текст и размеры — редактируемые объекты, не «штрихи».

## Пересборка

```bash
python3 -m kp17.scripts.build_identical_kp17
```

Нужны: Inkscape, poppler-utils, ODA File Converter, `fonts/GOSTCommon.ttf`.
