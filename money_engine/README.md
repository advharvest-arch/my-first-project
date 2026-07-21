# Money Engine — под ключ

Полностью автоматическая система заработка. Одна команда — всё работает.

## Быстрый старт (3 способа)

### Способ 1: Одна команда (рекомендуется)

```bash
cd money_engine
chmod +x install.sh start.sh
./install.sh          # установка + 50 проектов
./start.sh            # запуск
```

### Способ 2: Python

```bash
cd money_engine
pip install -r requirements.txt
python3 main.py turnkey --count 50
```

### Способ 3: Docker

```bash
cd money_engine
cp .env.example .env
docker compose up -d
```

## Что происходит автоматически

```
./install.sh
    │
    ├─ Установка зависимостей
    ├─ Создание .env
    ├─ Сканирование ниш (Reddit, HN, Trends)
    ├─ Деплой 50 микропроектов (игры, утилиты, affiliate)
    ├─ Генерация главной страницы + SEO (sitemap, robots)
    ├─ Экспорт статического сайта + ZIP-архив
    └─ Готово к запуску
```

## После установки

| URL | Что это |
|-----|---------|
| http://localhost:8000 | Дашборд управления |
| http://localhost:8000/hub/ | Витрина всех проектов |
| http://localhost:8000/p/{slug}/ | Отдельный микропроект |
| http://localhost:8000/site/ | Статический сайт для хостинга |

## Монетизация (один раз)

Откройте `.env` и добавьте ID рекламной сети:

```env
AD_SLOT_YANDEX=R-A-123456-1
# или
AD_SLOT_ADSENSE=ca-pub-123456789
```

Перезапустите `./start.sh` — реклама появится во всех проектах.

## Деплой в интернет (для реального трафика)

После `./install.sh` готов архив `output/money-engine-site.zip`.

Загрузите на любой бесплатный хостинг:

1. **Cloudflare Pages** — перетащите папку `output/site/`
2. **Vercel** — `npx vercel output/site`
3. **GitHub Pages** — залейте содержимое `output/site/`

Обновите в `.env`:
```env
PUBLIC_BASE_URL=https://ваш-домен.ru
```

## Масштабирование

```bash
# 100 проектов = ~10 000 ₽/день
python3 main.py turnkey --count 100 --skip-scan
```

Или в `.env`: `FLEET_TARGET_SIZE=100`

## Продакшн на VPS

```bash
# Скопируйте на сервер
scp -r money_engine/ user@server:/opt/money-engine

# На сервере
cd /opt/money-engine
./install.sh 100
sudo cp deploy/money-engine.service /etc/systemd/system/
sudo cp deploy/nginx.conf /etc/nginx/sites-available/money-engine
sudo systemctl enable --now money-engine
```

## Формула дохода

```
Проекты × ₽/день = Доход
50 × 100₽ = 5 000₽/день
100 × 100₽ = 10 000₽/день
```

Система работает полностью автоматически после `./install.sh`.
