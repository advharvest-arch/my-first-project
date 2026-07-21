# Money Engine — под ключ

Полностью автоматическая система заработка. **Одна кнопка.**

## Запуск

```bash
chmod +x run.sh
./run.sh
```

Или из папки `money_engine`:

```bash
cd money_engine && chmod +x run.sh && ./run.sh
```

Всё. Установка, настройка 50 проектов и запуск сервера — автоматически.

| URL | Что откроется |
|-----|---------------|
| http://localhost:8000 | Дашборд |
| http://localhost:8000/hub/ | Витрина проектов |

**Ctrl+C** — остановить.

## Опции

```bash
./run.sh 100    # 100 проектов вместо 50
```

## Монетизация

После запуска добавьте в `money_engine/.env`:

```env
AD_SLOT_YANDEX=R-A-ваш-id
```

Перезапустите `./run.sh`.

Подробности: [money_engine/README.md](money_engine/README.md)
