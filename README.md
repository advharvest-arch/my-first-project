# AdvHarvest Autopilot

Рабочая система: **находит насущные потребности людей в интернете** и готовит пакеты решений.

## Запуск

```bash
npm run demo           # полный прогон: скан → планы → solution files → fulfill
npm start              # дашборд http://localhost:3847
npm run autopilot      # фоновый цикл каждые 15 мин
npm run autopilot:once # один фоновый цикл
```

Node.js ≥ 18, без npm-зависимостей.

## Контур

```
Scout → Score → Solution pack → Approve → Fulfill → Ledger
```

### Источники
| Источник | Что даёт |
|---|---|
| **FL.ru RSS** | Платные заказы с бюджетом (RU) |
| **Hacker News Ask** | Живые просьбы «как / нужно / looking for» |
| **Stack Overflow / RU** | Нерешённые технические боли |
| **GitHub Issues** | Просьбы о помощи в коде |
| **Lobsters** | Ask / активные обсуждения |

### Способы закрыть потребность
- гайд / ответ
- микро-инструмент
- услуга под ключ
- подбор исполнителя

Каждый план сохраняется в `workspace/solutions/*.md` с брифом, шагами и черновиком ответа.

## Конфиг

`config/default.json` — источники, порог score, интервал автопилота, ключевые слова.  
Оверлей: `data/config.json` (через `POST /api/config`).

## API

- `GET /api/dashboard`
- `POST /api/cycle?force=1`
- `POST /api/scout?force=1`
- `GET /api/solutions` · `GET /api/solutions/:file`
- `POST /api/offers/:id/approve` · `POST /api/offers/:id/realize`
- `GET|POST /api/config`

## Принцип

Сначала закрываем реальную боль человека. Деньги — следствие полезного решения.
