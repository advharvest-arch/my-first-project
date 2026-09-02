# Open Russian Water Data — sources

Date checked: **2026-08-27**. Machine catalog: `sources.json`.

## Legend

| accessType | Meaning |
| --- | --- |
| public | reachable without login |
| restricted | exists but sold/by application |
| closed | license / federal ENC cells / unknown dumps — **do not use** |
| paid | commercial purchase |

## Source table

| id | org | URL | access | machine | routing | AI | notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| volgobalt-cartography | Волго-Балт | https://www.volgo-balt.ru/activity/kartografiya/ | public | partial | low | medium | ENC classifiers + RD; **not** cells |
| volgobalt-enc-cells | Росморречфлот фонд | https://volgo-balt.ru/activity/kartografiya/elektronnye-karty.php | **closed** | no | high* | high* | *if licensed; E1.5 excluded |
| volgobalt-lock-dims | Волго-Балт | https://www.volgo-balt.ru/activity/poleznye-gabarity-kamer-shlyuzov/ | public | partial | medium | medium | lock names; numeric dims need better scrape |
| volgobalt-bulletins | Волго-Балт | https://www.volgo-balt.ru/activity/informatsionnyy-byulleten-federal/ | public | partial | high | high | ops bulletins |
| volga-fairways | Волжский бассейн | https://xn--80adbch2buek4ak3i.xn--p1ai/navigatsiya/perechen_sudovyih_hodov/ | public | partial | high | high | AT-442 family PDFs |
| volga-ops | Волжский бассейн | https://xn--80adbch2buek4ak3i.xn--p1ai/navigatsiya/operativnaya_informatsiya_o_sudohodnyih_usloviyah/ | public | partial | high | high | depth forecasts / bulletins |
| volga-knn-is | Волжский бассейн | https://xn--80adbch2buek4ak3i.xn--p1ai/navigatsiya/kartografiya/ | **restricted** | no | high | high | KNN/IS by purchase/application |
| kim-bulletins | КиМ | https://kim-online.ru/10-navigatsiya | public | partial | high | high | **best PDF→facts** in this pass |
| kim-ris | КиМ | https://ris.kim-online.ru | public | unknown | medium | medium | experimental RIS; not scraped |
| kama-dimensions | Камводпуть | https://kamvodput.ru/waterway/waterwaydimensions/ | public | **yes** | medium | medium | XLSX segments + bridge PDFs |
| don-character | Азово-Дон | https://adgbu.ru/waterbox/character/ | public | partial | medium | medium | textual dims / hazards |
| don-depth-forecast | Азово-Дон | https://adgbu.ru/waterbox/prognoz/ | public | partial | medium | high | forecast series |
| gov-1800r | Правительство РФ | legal portals | public | partial | low | low | official ВВП list |
| ckt-enc-catalog | ЦКТ | https://cktspb.ru/elektronnye-karty/vvp | public | partial | none | low | folio coverage meta only |
| random-enc-mirrors | unknown | n/a | **closed** | no | none | none | forbidden |

## Basin checklist (min. 5)

| Basin | Open useful? | What we got |
| --- | --- | --- |
| Волжский | yes | fairway dispositions, ops PDFs; KNN/IS restricted |
| Волго-Балт | yes | ENC **normative** docs + classifiers; lock page; bulletins; cells closed |
| Московский (КиМ) | **best** | daily bulletins with depths/widths/km + closures |
| Камский | yes | XLSX segments, bridge clearances, disposition PDF |
| Донской (Азово-Дон) | yes | HTML path conditions, forecasts, draft limits |

## Legal note (only published facts)

- Public HTML/PDF on basin sites = **access without auth observed**.
- Pages **do not** publish a blanket commercial license for building a redistributable derived database.
- Волго-Балт ENC page **explicitly** says cells are federal property and require license agreement → CLOSED for cells.
- Волжский cartography page says ИС can be **purchased** → RESTRICTED.
- Product use of **cited official facts** (with provenance) is a legal judgment beyond this research; we do **not** assert commercial permission where terms are silent.
