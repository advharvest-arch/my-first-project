# E2.4 — WaterGraph Connection Model / Provenance

**Status:** DATA MODEL ONLY. `USE_WATER_GRAPH=false`. **No seam edges.**  
Production routing, BRouter, Overpass, thresholds, safety, accept/reject — **unchanged**.

## Why this stage

E2.3 showed gaps are not alike:

| Case | E2.3 class | Implication |
| --- | --- | --- |
| VG-mid Volga↔Akhtuba | `SEPARATE_WATER_OBJECT` | Must not join |
| Belomor north tear | `DATA_GAP` | Same canal identity; mid geometry missing |
| N06/N08 | `PHYSICAL_CONNECTION_ONLY` | Mask/fairway proximity ≠ navigable proof |
| X3 | `NO_EVIDENCE` | Nothing to connect |

Therefore **one universal seam rule is unsafe**. E2.4 introduces a typed connection + provenance model so a later stage can add edges **only** where evidence is confirmed.

---

## Concepts

### Physical connection
Geometry/topology suggests water bodies touch or belong to one physical system (same reservoir mask, same named canal identity, floodplain co-location).

**Does not imply boats may legally/safely pass.**

### Navigable connection
Evidence that a **navigable** route exists between components (continuous canal/river object with passage, verified lock corridor, etc.).

**physical ≠ navigable.** Never auto-promote.

### CONFIRMED_CONNECTION
Enough open-data evidence that a future stage *may* create a graph edge.

In E2.4, `getConfirmedConnections()` is expected to return **[]** for current fixtures — we refuse to invent seams.

### CANDIDATE_CONNECTION
Diagnostic only. Visible in RouteTrace. **Not** used by Dijkstra. **Does not** create edges.

### Rejected
Explicitly not a corridor link (separate water objects, barriers, no evidence).

### Provenance
Every signal carries `{ sourceType, sourceId, sourceDetail }` with types:
`osm` | `mask` | `knowledge` | `known_barrier` | `fairway` | `derived` | `unknown`.

No fake source IDs.

---

## Evidence levels

| Level | Meaning |
| --- | --- |
| `CONFIRMED` | Only on `connectionStatus=confirmed` (none in current fixtures) |
| `STRONG` | Clear identity / barrier / data-gap identity — still may be candidate |
| `WEAK` | Soft signals (mask proximity, fairway, knowledge co-list) |
| `NONE` | Absent |
| `CONTRADICTED` | Barrier / illegal crossing blocks navigability claim |

---

## What is NEVER enough for CONFIRMED

Encoded as `INSUFFICIENT_FOR_CONFIRMED` / `policy.*AloneConfirms=false`:

- distance alone
- same name alone
- fairway proximity alone
- mask proximity alone
- same river tag alone
- geographic closeness
- knowledge co-occurrence alone

`canConfirmConnection()` currently **always returns ok=false** until a future stage supplies explicit sufficient evidence beyond these alone-signals.

---

## Fixture expectations

### VG-mid
- `relationType`: `separate_water_object` / `possible_distributary`
- `connectionStatus`: **rejected**
- `navigableConnectionEvidence`: **NONE**
- **Do not connect** — different named rivers; knowledge co-list is hydrological only

### Belomor
- `relationType`: **data_gap** (+ canal continuation identity)
- `connectionStatus`: **candidate**
- physical/navigable identity levels: **STRONG**
- **Not a seam** — next step is **centerline ingest repair**, not inventing a chord across 19 km

### N06 / N08
- waterway/fairway → mask: **candidate** only
- navigable: **NONE** / weak physical mask proximity
- fairway is soft preference only

### X3
- no usable evidence pairs → confirmed **0**

---

## API (no graph mutation)

```ts
buildConnectionEvidence(input)
classifyConnectionEvidence(corridorEvidence)
getConfirmedConnections(report)  // [] for current fixtures
getCandidateConnections(report)  // diagnostic only
```

RouteTrace: `waterGraphConnections: { confirmedCount, candidateCount, rejectedCount, connections, policy }`.

---

## What the next stage may safely use

| Type | Safe as graph edge now? | Next step |
| --- | --- | --- |
| Separate water objects (VG-mid) | **No** | Keep rejected |
| DATA_GAP same canal (Belomor) | **No seam** | Prefer **ingest missing OSM geometry** |
| waterway↔mask (N06/N08) | **No** | Remain candidates until stronger navigable proof |
| Lock transitions with concrete portals | Not yet (no fixture confirmed) | Need verified lock corridors at the gap |
| Distance / fairway / mask / name alone | **Never** | Policy forbids |

**Stop — no seams in E2.4.**
