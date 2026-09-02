# E1.5 — Open Russian Water Data (research only)

Maximize AquaRoute knowledge using **open** Russian basin/nav sources.

- No ENC cells / S-63
- No official letters
- No production routing changes
- No PR/merge/deploy for this task

## Quick start

```bash
cd sea-map
npx tsx research/open-russian-data/run-open-data.ts
npx vitest run research/open-russian-data/tests
```

## Knowledge layer target

```
OSM + BRouter + lake masks
 + Russian open normative/nav facts
 + RouteTrace
        → WaterGraph metadata
        → AI-ready signals
```

## Key docs

- `reports/OPEN_RUSSIAN_DATA_READY.md` — final report
- `SOURCES.md` / `sources.json` — catalog
- `schema.md` — WaterFact / NavigationEvent
- `raw/PROVENANCE.json` — download provenance (large PDFs gitignored; re-fetch via URL)
