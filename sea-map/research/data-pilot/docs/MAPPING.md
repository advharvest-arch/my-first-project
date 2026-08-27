# E2 DATA_PILOT — S-57 → AquaRoute mapping

Research-only. Production routing unchanged.

## Object mapping

| Российская ЭНК (S-57) | AquaRoute / WaterGraph | Пилот |
| --- | --- | --- |
| RECTRC | официальная ось судового хода → `edge:official_axis` | да |
| FAIRWY | preferred / fairway edge → `edge:preferred_fairway` | да |
| GATCON | шлюз / ворота → `node:lock` | да |
| LOKBSN | камера шлюза (контекст) → `node:lock` | да |
| DAMCON | плотина / barrier → `node:dam` | да |
| OBSTRN | hazard / запрет → `node:hazard` или `zone:hazard_area` | да |
| DEPARE | глубины / зона → `zone:depth_area` | да |
| DRGARE | дноуглубление → `zone:dredged_area` | позже |
| BRIDGE | мост + VERCLR → `node:bridge` | позже |
| DISMAR | километраж → `node:distance_mark` | позже |

## Pipeline (research)

```
S-57 / S-63-decoded JSON
  → parseS57Collection
  → normalizeFeatures (RECTRC / FAIRWY / GATCON / LOKBSN / DAMCON / OBSTRN / DEPARE / …)
  → toWaterGraph (WaterGraph adapter)
  → WaterGraphLayerBundle { edges, nodes, zones, provenance }
```

No Dijkstra / A* / measureWaterChain integration in E2.

## Attributes of interest

| Class | Key attrs | Use |
| --- | --- | --- |
| RECTRC | CATTRK, OBJNAM | official track centreline |
| FAIRWY | OBJNAM | preferred corridor |
| GATCON | CATGAT, OBJNAM | lock/gate |
| DAMCON | CATDAM | barrier / hydro gate seed |
| OBSTRN | CATOBS, RESTRN, VALSOU | hazard |
| DEPARE | DRVAL1, DRVAL2 | depth band |
| BRIDGE | VERCLR, VERCCL, VERCOP | air draught |
| DISMAR | distance / disver | chainage metadata |

## Future AI link (RouteTrace unchanged)

```
chosen route (RouteTrace)
  → official fairway (RECTRC/FAIRWY)
  → distance from official fairway
  → official hazard (OBSTRN)
  → lock/dam (GATCON/DAMCON)
  → seasonal restriction
  → userCorrection (schema-only today)
  → AI learning signal
```

ENC says where the official fairway is; RouteTrace explains why the algorithm chose a path; later models learn from divergence.
