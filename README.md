# AdvHarvest Autopilot

Рабочая система: находит насущные потребности в интернете и готовит решения.

## Запуск

```bash
npm run demo              # скан → планы → solution packs
npm start                 # http://localhost:3847
npm run work              # очередь: что делать сейчас
npm run work -- --approve 3 --paid
npm run autopilot         # фон каждые 15 мин
npm test                  # smoke tests
```

## Контур

```
Scout → Filter → Score → Proposal → Solution pack → Queue → Approve → Fulfill
```

### Источники
FL.ru (платные заказы), Hacker News Ask, Stack Overflow / RU, GitHub, Lobsters.

### Очередь работы
`npm run work` показывает приоритетные задачи: сначала `approved` и paid (FL.ru), с готовым сообщением для копирования.

В дашборде: **Approve топ-3 paid**, фильтры планов, Copy msg.

### Solution packs
Каждый план → `workspace/solutions/*.md` с КП, ценой, сроком, scope и готовым текстом сообщения.

## Конфиг
`config/default.json` — порог score, `minPaidBudget`, источники, ключевые слова.
