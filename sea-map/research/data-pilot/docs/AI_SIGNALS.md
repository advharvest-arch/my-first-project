# E2 — Future AI signals (RouteTrace unchanged)

E0 `RouteTrace` already records chosen candidates, phases, hydro, and has
schema-only `userCorrection`. **Do not modify RouteTrace in E2.**

## Learning chain (design)

```
chosen route          ← RouteTrace.final / geometry
        ↓
official fairway      ← ENC RECTRC / FAIRWY → WaterGraph official_axis
        ↓
distance from fairway ← haversine / corridor distance
        ↓
official hazard       ← OBSTRN
        ↓
lock / dam            ← GATCON / DAMCON (+ LOKBSN)
        ↓
seasonal restriction  ← PERSTA / notices when licensed
        ↓
user correction       ← RouteTrace.userCorrection (future UI)
        ↓
AI learning signal    ← draftAiLearningSignal() in research adapter
```

## Intended labels

| Hint | Meaning |
| --- | --- |
| `on_official_fairway` | route hugs RECTRC |
| `near_fairway` | small offset (channel width) |
| `off_fairway` | algorithm / OSM detour vs official track |
| `near_hazard` | close to OBSTRN |
| `via_lock` | path interacts with GATCON/DAMCON |

## Product wording

ENC tells us where the **official** fairway and hazards are.  
RouteTrace tells us **why** AquaRoute chose a path.  
Later AI learns from **divergences** and user corrections — without replacing
STEM/VETL/DAM guards or safety thresholds.
