# Календарный график монтажа 10 колонн двумя кранами

Интерактивный пример календарного графика совместной работы двух башенных кранов при монтаже 10 железобетонных колонн.

## Как открыть

### Вариант 1 — локально (надёжно)

Скачайте `index.html` из ветки PR и откройте файл двойным щелчком в браузере. Сервер не нужен.

Или из клона репозитория:

```bash
git checkout cursor/crane-joint-schedule-ae50
# macOS
open index.html
# Linux
xdg-open index.html
# Windows
start index.html
```

### Вариант 2 — онлайн-просмотр с GitHub (без Pages)

Откройте ссылку (рендер HTML с ветки PR):

[Открыть график в браузере](https://htmlpreview.github.io/?https://github.com/advharvest-arch/my-first-project/blob/cursor/crane-joint-schedule-ae50/index.html)

> GitHub Pages (`*.github.io`) для этого репозитория не включён — поэтому `https://advharvest-arch.github.io/my-first-project/` даёт **404**. Это ожидаемо.

### Вариант 3 — включить GitHub Pages (постоянный сайт)

В настройках репозитория: **Settings → Pages → Source: Deploy from a branch** → ветка `cursor/crane-joint-schedule-ae50` (или `main` после merge) → папка `/ (root)` → Save.  
После этого сайт будет по адресу `https://advharvest-arch.github.io/my-first-project/`.

## Что внутри

- период **20–24.07.2026** (5 рабочих дней, смена 08:00–17:00);
- краны **К1** (Liebherr 280 EC-H, оси А–Б) и **К2** (Potain MDT 259, оси В–Д);
- монтаж колонн **К-1 … К-10**: параллельная работа на разных осях;
- **совместный подъём** тяжёлых колонн К-5 и К-6 (масса > 12 т);
- диаграмма Ганта (дорожки кранов + по колоннам);
- таблица операций и показатели графика;
- прокрутка периода линией «сейчас».
