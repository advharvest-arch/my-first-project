# Money Engine — под ключ

Полностью автоматическая система заработка. **Одна кнопка.**

## Запуск

```bash
chmod +x run.sh
./run.sh
```

Всё. Установка + 50 проектов + сервер — автоматически.

| URL | Описание |
|-----|----------|
| http://localhost:8000 | Дашборд |
| http://localhost:8000/hub/ | Витрина проектов |
| http://localhost:8000/p/{slug}/ | Игра / утилита |

**Ctrl+C** — остановить.

```bash
./run.sh 100   # 100 проектов (~10 000₽/день)
```

## Docker (альтернатива)

```bash
docker compose up -d
```

## Монетизация

В `.env` добавьте `AD_SLOT_YANDEX` или `AD_SLOT_ADSENSE`, перезапустите `./run.sh`.

## Переустановка

```bash
rm data/.installed
./run.sh
```
