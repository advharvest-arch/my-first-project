# E2.16 — User trial / Hybrid Router

**Goal:** Let a human manually test the already-implemented Hybrid WaterGraph on the real map.  
**No algorithm changes.** No new seams. No BRouter/safety edits.  
**Production default:** `USE_WATER_GRAPH=false`.

---

## How to enable Hybrid mode

1. Open the app with **`?wg=1`** in the URL  
   Example: `…/p/aquaroute/?wg=1` or local `http://localhost:5173/?wg=1`
2. Or (DEV build only): check **«Hybrid WaterGraph (пилот)»** in the test panel  
   The checkbox also writes `?wg=1` into the URL.

When Hybrid is on, a short banner appears above the status line:  
`Режим: Hybrid WaterGraph (пилот)…`

After **Проложить / BUILD ROUTE**, the status shows who built the route:

- `маршрутизатор: WaterGraph`
- `маршрутизатор: BRouter (запасной)`
- `маршрутизатор: маршрут не построен`

The DEV panel **Result** block shows the same coarse **Router:** line (no graphBuildMs / components / snap_empty).

---

## How to return to normal mode

1. Remove `?wg=1` (and `useWaterGraph`) from the URL and reload, **or**
2. Uncheck **Hybrid WaterGraph** in the DEV panel (clears `?wg=`).

Default / production builds without the query stay on **legacy BRouter** (`USE_WATER_GRAPH=false`).

You can still place A/B and press **Проложить** exactly as before — Hybrid only changes the first attempt when the flag is on.

---

## Automatically verified corridors (E2.15 suite; unchanged logic)

| Route | Hybrid expected |
| --- | --- |
| Belomor | WaterGraph |
| N08 | WaterGraph |
| N06 | BRouter fallback |
| VG-mid | not built / no Volga↔Akhtuba sew |
| Flag off | legacy (normal) |

---

## Production flag

`USE_WATER_GRAPH` **remains `false` by default.** Hybrid is opt-in via `?wg=1` or the DEV checkbox only.
