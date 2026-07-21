# Money Engine

Автоматическая система поиска ниш и заработка в интернете.

## Что делает система

1. **Сканирует** Reddit, Hacker News и Google Trends каждые 6 часов
2. **Анализирует** боли, спрос и потенциал монетизации
3. **Оценивает** каждую нишу по 100-балльной шкале
4. **Генерирует** готовые отчёты (Markdown) и лендинги (HTML) для продажи
5. **Показывает** всё в веб-дашборде

## Модели монетизации

| Тип | Описание | Цена |
|-----|----------|------|
| `micro_saas` | Микро-SaaS инструмент | $9-49/мес |
| `digital_report` | Отчёт по нише | $19-49 |
| `affiliate` | Партнёрский маркетинг | комиссия |
| `freelance` | Услуга под ключ | $150-500 |
| `content_seo` | SEO-контент + реклама | $9+ |

## Быстрый старт

```bash
cd money_engine
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env

# Одноразовое сканирование
python main.py scan

# Запуск сервера с авто-сканированием
python main.py start
```

Откройте http://localhost:8000 — дашборд с нишами и кнопкой сканирования.

## Настройка оплаты

1. Создайте продукт в [Stripe](https://stripe.com) или [Gumroad](https://gumroad.com)
2. Добавьте ссылку на оплату в `.env`:
   ```
   STRIPE_PAYMENT_LINK=https://buy.stripe.com/your-link
   ```
3. Лендинги автоматически получат кнопку «Купить»

## Как зарабатывать

1. Запустите `python main.py start`
2. Система найдёт ниши с оценкой 65+
3. Для каждой ниши создаётся отчёт + лендинг в `output/`
4. Опубликуйте лендинги (Vercel, Netlify, GitHub Pages)
5. Продвигайте в нишевых сообществах
6. Получайте оплату через Stripe/Gumroad

## API

| Endpoint | Метод | Описание |
|----------|-------|----------|
| `/` | GET | Дашборд |
| `/api/scan` | POST | Запустить сканирование |
| `/api/opportunities` | GET | Список ниш |
| `/api/stats` | GET | Статистика |
| `/landings/{file}` | GET | Лендинг для продажи |
| `/reports/{file}` | GET | Отчёт |

## Архитектура

```
money_engine/
├── src/
│   ├── collectors/     # Reddit, HN, Google Trends
│   ├── analyzer/       # Скоринг ниш
│   ├── generator/      # Отчёты и лендинги
│   ├── pipeline.py     # Полный цикл
│   ├── api.py          # FastAPI + дашборд
│   └── scheduler.py    # Авто-запуск каждые N часов
├── templates/          # Jinja2 шаблоны
├── output/
│   ├── reports/        # Markdown отчёты
│   └── landings/       # HTML лендинги
└── data/               # SQLite база
```
