# Schemas (research)

## WaterFact

```json
{
  "id": "wf-…",
  "basin": "moscow|volga|kama|don|…",
  "waterway": "volga|oka|moscow_canal|…",
  "segment": "text",
  "fromKm": 44.0,
  "toKm": 41.0,
  "restriction": "string|null",
  "depthCm": 400,
  "widthM": 100,
  "heightM": null,
  "season": null,
  "lock": null,
  "barrier": null,
  "navigationStatus": "open|restricted|closed|unknown",
  "guaranteedDepthCm": 400,
  "actualDepthCm": 400,
  "factKind": "dimension|lock|barrier|restriction|segment|season|hazard|coverage_meta|other",
  "provenance": {
    "source": "via sourceId",
    "sourceUrl": "https://…",
    "retrievedAt": "ISO-8601",
    "documentDate": "YYYY-MM-DD",
    "page": 1,
    "originalText": "…",
    "normalizedValue": "in ExtractedRecord",
    "confidence": 0.72
  }
}
```

This is **not** a routing graph.

## NavigationEvent

```json
{
  "id": "nev-…",
  "waterway": "moscow_canal",
  "locationText": "…",
  "eventType": "closure|restriction|fairway_change|lock_repair|depth_limit|height_limit|seasonal|other",
  "validFrom": null,
  "validTo": null,
  "restriction": "запрещение движения судов",
  "fromKm": 44,
  "toKm": 41,
  "source": "provenance.sourceId",
  "confidence": 0.8
}
```

## RouteTrace research concept (production unchanged)

```
RouteTrace
  → externalFacts[]: { factId, source, confidence, matchedWaterway, matchedSegment }
```

## WaterGraph metadata adapter (soft)

```
RussianOpenData → WaterFacts → WaterGraph metadata hints
  lock → lock_portal
  dam/barrier → barrier
  depth → edge_constraint (soft)
  season/closure → edge_availability
  fairway mention / named segment → fairway_prior (soft)
  restriction → advisory / reject-candidate later
```

## Source quality (NOT routing cost)

`sourceQuality = mean(authority, freshness, geographicPrecision, machineReadability, provenanceScore)`
