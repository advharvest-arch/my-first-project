"""Write docs/osm-water-model-audit.md and .json (research only)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .assemble import assert_no_computed_links, summarize_sample

MD_MEMBER_SAMPLE = 25
MD_MEMBER_FULL_LIMIT = 80


def _fmt_tags(tags: dict[str, str]) -> str:
    if not tags:
        return "_(нет тегов)_"
    parts = [f"`{k}={v}`" for k, v in sorted(tags.items())]
    return ", ".join(parts)


def _membership_md(membership: list[dict[str, Any]] | None) -> str:
    if not membership:
        return "нет (элемент не входит в скачанные parent relation)"
    rows = []
    for m in membership:
        rtags = m.get("relation_tags") or {}
        rtype = rtags.get("type", "")
        rows.append(
            f"- relation/{m.get('relation_id')} role=`{m.get('role') or ''}` "
            f"type=`{rtype}` tags: {_fmt_tags(rtags)}"
        )
    return "\n".join(rows)


def _members_table(members: list[dict[str, Any]], *, limit: int) -> str:
    if not members:
        return "_(нет членов)_"
    lines = [
        "| role | type | id | classification | geometry | vertices | closed | start node | end node | tags |",
        "|---|---|---:|---|---|---:|---|---:|---:|---|",
    ]
    shown = members[:limit]
    for m in shown:
        tags = m.get("tags") or {}
        tag_s = ", ".join(f"{k}={v}" for k, v in sorted(tags.items())[:8]) or "—"
        if len(tags) > 8:
            tag_s += " …"
        lines.append(
            "| {role} | {typ} | {oid} | {cls} | {geom} | {vc} | {cl} | {sn} | {en} | {tags} |".format(
                role=m.get("role") or "_(empty)_",
                typ=m.get("osm_type"),
                oid=m.get("osm_id"),
                cls=m.get("classification"),
                geom=m.get("geometry_type"),
                vc=m.get("vertex_count") if m.get("vertex_count") is not None else "—",
                cl="yes" if m.get("closed") else ("no" if m.get("closed") is False else "—"),
                sn=m.get("start_node_id") if m.get("start_node_id") is not None else "—",
                en=m.get("end_node_id") if m.get("end_node_id") is not None else "—",
                tags=tag_s.replace("|", "/"),
            )
        )
    if len(members) > limit:
        lines.append(
            f"| … | | | | | | | | | ещё {len(members) - limit} членов — полный список в JSON |"
        )
    return "\n".join(lines)


def _ambiguous_notes(objects: list[dict[str, Any]]) -> list[str]:
    notes: list[str] = []
    for obj in objects:
        tags = obj.get("tags") or {}
        rc = obj.get("role_counts") or {}
        if obj.get("osm_type") == "way" and obj.get("classification") == "polygon-lake":
            if tags.get("natural") == "water" and not tags.get("water"):
                notes.append(
                    f"{obj['osm_type']}/{obj['osm_id']}: `natural=water` без `water=lake|reservoir|...`; "
                    "класс polygon-lake по правилу Inspector (`natural=water`)."
                )
            if not (obj.get("membership") or []):
                notes.append(
                    f"{obj['osm_type']}/{obj['osm_id']}: way-озеро без parent relation в `rel(bw)` "
                    "(не «дыра» в MP)."
                )
        other_roles = rc.get("other_roles") or []
        if other_roles:
            notes.append(
                f"{obj['osm_type']}/{obj['osm_id']}: роли вне outer/inner/main_stream/side_stream: "
                + ", ".join(f"`{r}`" for r in other_roles)
            )
        islet_noted = False
        for mem in obj.get("members") or []:
            extra = [
                m
                for m in (mem.get("membership") or [])
                if m.get("relation_id") != obj.get("osm_id")
            ]
            if extra and obj.get("osm_id") == 2406778 and mem.get("osm_id") == 180396592:
                ids = ", ".join(f"relation/{m.get('relation_id')}" for m in extra)
                notes.append(
                    f"way/{mem['osm_id']} объявлен членом нескольких MP ({ids}) — это OSM membership, "
                    "не proximity."
                )
            if (
                not islet_noted
                and mem.get("role") == "inner"
                and (mem.get("tags") or {}).get("place") == "islet"
            ):
                notes.append(
                    f"{obj['osm_type']}/{obj['osm_id']} inner way/{mem['osm_id']} имеет `place=islet`: "
                    "остров как дыра MP, не осевая линия."
                )
                islet_noted = True
    return notes


def _check_180396592(objects: list[dict[str, Any]]) -> dict[str, Any]:
    target = None
    parent = None
    for obj in objects:
        if obj.get("osm_type") == "relation" and obj.get("osm_id") == 2406778:
            parent = obj
            for m in obj.get("members") or []:
                if m.get("osm_type") == "way" and m.get("osm_id") == 180396592:
                    target = m
                    break
    ok = False
    reasons: list[str] = []
    if target is None:
        reasons.append("way/180396592 не найден среди членов relation/2406778")
    else:
        if target.get("classification") != "mp-outer":
            reasons.append(f"classification={target.get('classification')} (ожидалось mp-outer)")
        if target.get("geometry_type") != "LineString":
            reasons.append(f"geometry_type={target.get('geometry_type')} (ожидалось LineString)")
        if target.get("vertex_count") != 3:
            reasons.append(f"vertex_count={target.get('vertex_count')} (ожидалось 3)")
        if target.get("tags"):
            reasons.append(f"tags не пусты: {target.get('tags')}")
        if target.get("classification") == "other":
            reasons.append("ошибочно попал в other/centerline-other")
        if target.get("closed") is True:
            reasons.append("way закрыт, ожидался open")
        ok = not reasons
    return {
        "ok": ok,
        "found": target is not None,
        "member": target,
        "parent_classification": parent.get("classification") if parent else None,
        "reasons": reasons,
    }


def render_markdown(report: dict[str, Any]) -> str:
    objects: list[dict[str, Any]] = report["objects"]
    stats: dict[str, Any] = report["stats"]
    check = report["check_way_180396592"]
    lines: list[str] = []
    lines.append("# OSM water model audit")
    lines.append("")
    lines.append(
        "Исследовательский отчёт: как OSM **на самом деле** кодирует воду "
        "на эталонных объектах Европейской России."
    )
    lines.append("")
    lines.append(
        "**Не топология.** Нет соединений полигон↔осевая линия, нет KNN, "
        "ST_DWithin, «одна река», принадлежности по имени или bbox."
    )
    lines.append("")
    lines.append(
        "Классификация тегов/ролей согласована с OSM Water Inspector "
        "(`sea-map/src/osm-water-inspect.ts`), но реализована отдельно в "
        "`water-data/research/osm_water_model_audit/`. Inspector не менялся."
    )
    lines.append("")
    lines.append(f"Сгенерировано: `{report.get('generated_at')}`")
    lines.append("")
    lines.append("## Метод")
    lines.append("")
    lines.append(
        "- Источник: OSM API 0.6 (`relation/id`, пакетный `ways.json`, `way/id/relations`); "
        "координаты узлов не сохраняются, только списки node id. Overpass — запасной путь."
    )
    lines.append(
        "- Для relation скачиваются сам объект и **объявленные** члены `members[]`."
    )
    lines.append(
        "- Членство в relation — только из `members[]` скачанных relation "
        "(для way-seed: `rel(bw)`)."
    )
    lines.append(
        "- Имена (`name=*`) использованы **только** на этапе поиска seed id; "
        "классификатор их не читает."
    )
    lines.append(
        "- `start_node_id` / `end_node_id` — идентификаторы OSM node, не координаты."
    )
    lines.append("")
    lines.append("## Эталонные объекты")
    lines.append("")
    lines.append("| key | поиск (не классификация) | OSM | скачан | class | geometry | члены |")
    lines.append("|---|---|---|---|---|---|---:|")
    for obj in objects:
        nmem = obj.get("member_count")
        if nmem is None:
            nmem = len(obj.get("members") or []) if obj.get("members") is not None else "—"
        err = obj.get("error") or "yes"
        if obj.get("error"):
            err = f"NO ({obj['error']})"
        lines.append(
            f"| `{obj.get('seed_key')}` | {obj.get('seed_label')} | "
            f"{obj.get('osm_type')}/{obj.get('osm_id')} | {err} | "
            f"`{obj.get('classification')}` | `{obj.get('geometry_type')}` | {nmem} |"
        )
    lines.append("")
    lines.append("## Сводная статистика")
    lines.append("")
    lines.append(
        "Счётчики **seed-объектов** (площадные классы) и **seed + объявленные члены** "
        "(осевые линии и mp-outer/inner). Дубликаты между разными relation не схлопываются: "
        "это не граф, а описание выборки."
    )
    lines.append("")
    lines.append("| показатель | значение |")
    lines.append("|---|---:|")
    lines.append(
        f"| seed всего / скачано / нет | {stats['seed_count']} / {stats['fetched']} / {stats['missing']} |"
    )
    lines.append(f"| polygon-lake (seeds) | {stats['polygon_lake']} |")
    lines.append(f"| polygon-reservoir (seeds) | {stats['polygon_reservoir']} |")
    lines.append(f"| polygon-river-area (seeds) | {stats['polygon_river_area']} |")
    lines.append(f"| centerline-river (seeds+members) | {stats['centerline_river']} |")
    lines.append(f"| centerline-canal (seeds+members) | {stats['centerline_canal']} |")
    lines.append(f"| centerline-stream (seeds+members) | {stats['centerline_stream']} |")
    lines.append(f"| mp-outer (seeds+members) | {stats['mp_outer']} |")
    lines.append(f"| mp-inner (seeds+members) | {stats['mp_inner']} |")
    lines.append(f"| waterway-relation (seeds) | {stats['waterway_relation']} |")
    rw = stats["relations_with_role"]
    lines.append(f"| relation с outer | {rw['outer']} |")
    lines.append(f"| relation с inner | {rw['inner']} |")
    lines.append(f"| relation с main_stream | {rw['main_stream']} |")
    lines.append(f"| relation с side_stream | {rw['side_stream']} |")
    lines.append(f"| way без тегов в role=outer | {stats['untagged_outer_ways']} |")
    lines.append(f"| inner (члены role=inner / class mp-inner) | {stats['inner_members']} |")
    lines.append("")
    lines.append("Классификация seed-объектов:")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps(stats["by_seed_classification"], ensure_ascii=False, indent=2))
    lines.append("```")
    lines.append("")
    lines.append("Классификация объявленных членов:")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps(stats["by_member_classification"], ensure_ascii=False, indent=2))
    lines.append("```")
    lines.append("")

    amb = report.get("ambiguous") or []
    lines.append("## Неоднозначные случаи")
    lines.append("")
    if not amb:
        lines.append("В выборке нет дополнительных неоднозначностей сверх описанных ниже.")
    else:
        for note in amb:
            lines.append(f"- {note}")
    lines.append("")

    lines.append("## Проверка way/180396592 в relation/2406778")
    lines.append("")
    if check.get("ok"):
        lines.append(
            "**PASS.** `way/180396592` — `mp-outer`, `LineString`, 3 вершины, без тегов, "
            "не `centerline-other` / `other`."
        )
    else:
        lines.append("**FAIL.** " + "; ".join(check.get("reasons") or ["unknown"]))
    if check.get("member"):
        m = check["member"]
        lines.append("")
        lines.append(f"- classification: `{m.get('classification')}`")
        lines.append(f"- geometry_type: `{m.get('geometry_type')}`")
        lines.append(f"- vertex_count: `{m.get('vertex_count')}`")
        lines.append(f"- closed: `{m.get('closed')}`")
        lines.append(f"- tags: {_fmt_tags(m.get('tags') or {})}")
        lines.append(
            f"- start_node_id: `{m.get('start_node_id')}`, end_node_id: `{m.get('end_node_id')}`"
        )
        extra = [x for x in (m.get("membership") or []) if x.get("relation_id") != 2406778]
        if extra:
            lines.append(
                "- другие **объявленные** parent relation (OSM membership, не proximity):"
            )
            for x in extra:
                lines.append(f"  - relation/{x.get('relation_id')} role=`{x.get('role')}`")
    lines.append("")

    lines.append("## Разница: осевая линия vs площадь реки")
    lines.append("")
    lines.append(
        "В OSM это **два разных типа объектов**, даже если человек читает оба как «река»."
    )
    lines.append("")
    lines.append("| | осевая линия | площадь реки |")
    lines.append("|---|---|---|")
    lines.append(
        "| типичные теги | `waterway=river` (way) или "
        "`type=waterway` + `waterway=river` (relation) | "
        "`type=multipolygon` + `natural=water` + `water=river` |"
    )
    lines.append(
        "| класс аудита | `centerline-river` / `waterway-relation` | `polygon-river-area` |"
    )
    lines.append(
        "| геометрия | LineString / GeometryCollection из осевых way | "
        "MultiPolygon (кольца outer/inner) |"
    )
    lines.append("| Inspector | линия, не площадь | площадь, члены — граница MP |")
    lines.append("")
    lines.append("Примеры в этой выборке:")
    lines.append("")
    lines.append(
        "- `way/28237778` — обычный `waterway=river` way → `centerline-river`, LineString."
    )
    lines.append(
        "- `relation/379295` — `type=waterway` Селижаровка → `waterway-relation`; "
        "члены с role `main_stream` классифицируются как осевые линии."
    )
    lines.append(
        "- `relation/2406778` и `relation/2580469` — `water=river` multipolygon → "
        "`polygon-river-area`. Их outer — **не** осевая линия."
    )
    lines.append("")

    lines.append("## outer/inner — граница, не осевая линия")
    lines.append("")
    lines.append(
        "У `type=multipolygon` роли `outer` и `inner` описывают **кольца полигона** "
        "(береговая линия / остров). Way часто **без тегов** и **не замкнут**: "
        "кольцо собирается из нескольких way. Это граница площади, а не `waterway=*`."
    )
    lines.append("")
    lines.append(
        "Классификатор ставит `mp-outer` / `mp-inner` по **роли в MP**, даже если way "
        "открытый, из трёх вершин и без тегов. Иначе Inspector ошибочно показал бы "
        "`centerline-other`."
    )
    lines.append("")
    lines.append("Контрольный пример: `way/180396592` (см. проверку выше).")
    lines.append("")

    lines.append("## Сосуществование полигона и осевой линии (не связь)")
    lines.append("")
    lines.append(
        "OSM часто хранит **и** площадь, **и** осевую линию рядом. Это два объекта. "
        "Общая география / имя / близость **не** являются членством. Inspector и этот "
        "аудит связывают объекты только через `relation.members[]`."
    )
    lines.append("")
    lines.append("В этой выборке (объявленное членство vs соседство):")
    lines.append("")
    lines.append(
        "- `relation/2406778` (polygon-river-area) **не** содержит `way/28237778` "
        "(`waterway=river`) в `members[]`. Осевая линия Селижаровки живёт в "
        "`relation/379295`. Аудит **не** соединяет их."
    )
    lines.append(
        "- `relation/379295` — waterway; `relation/2406778` — речная площадь. "
        "Разные `type=*`. Нет ребра «это одна река»."
    )
    lines.append(
        "- Крупные озёра (Селигер, Ладога, Онега, Белое) — MP `water=lake`. "
        "Отдельные `waterway=river` way в OSM могут впадать в озеро; пока way "
        "не listed в `members[]` озера, это **не** член озера."
    )
    lines.append(
        "- Волга `relation/1730417` (`type=waterway`) — осевой relation, не площадь. "
        "Площади Волги в OSM — другие relation с `water=river` / `water=reservoir` "
        "(например Рыбинское `1521563`). Аудит не склеивает их по имени «Волга»."
    )
    lines.append("")

    lines.append("## Relation `type=waterway` и `main_stream`")
    lines.append("")
    found_ms = [obj for obj in objects if (obj.get("role_counts") or {}).get("main_stream")]
    if not found_ms:
        lines.append("В скачанной выборке не оказалось relation с role `main_stream`.")
    else:
        for obj in found_ms:
            rc = obj["role_counts"]
            lines.append(
                f"- `{obj['osm_type']}/{obj['osm_id']}` ({obj.get('seed_label')}) "
                f"class=`{obj.get('classification')}` "
                f"main_stream={rc.get('main_stream')} side_stream={rc.get('side_stream')} "
                f"outer={rc.get('outer')} inner={rc.get('inner')} other={rc.get('other')}"
            )
            mains = [m for m in (obj.get("members") or []) if m.get("role") == "main_stream"]
            sample = mains[:12]
            ids = ", ".join(f"{m['osm_type']}/{m['osm_id']}" for m in sample)
            extra = f" … +{len(mains) - 12}" if len(mains) > 12 else ""
            lines.append(f"  - примеры main_stream: {ids}{extra}")
            if mains:
                m0 = mains[0]
                lines.append(
                    f"  - первый член: class=`{m0.get('classification')}` "
                    f"geom=`{m0.get('geometry_type')}` tags: {_fmt_tags(m0.get('tags') or {})}"
                )
    lines.append("")
    lines.append(
        "Роль `main_stream` не превращает way в полигон и не доказывает связь "
        "с соседним `water=river` multipolygon."
    )
    lines.append("")

    lines.append("## Объекты")
    lines.append("")
    for obj in objects:
        lines.append(f"### {obj.get('seed_label')} — {obj.get('osm_type')}/{obj.get('osm_id')}")
        lines.append("")
        if obj.get("error"):
            lines.append(f"**Не скачан:** `{obj['error']}`")
            lines.append("")
            continue
        lines.append(f"- classification: `{obj.get('classification')}`")
        lines.append(f"- geometry_type: `{obj.get('geometry_type')}`")
        lines.append(f"- fetch: `{obj.get('fetch_source')}`")
        lines.append(f"- tags: {_fmt_tags(obj.get('tags') or {})}")
        if obj.get("osm_type") == "way":
            lines.append(
                f"- vertices: `{obj.get('vertex_count')}`, closed: `{obj.get('closed')}`, "
                f"start_node_id: `{obj.get('start_node_id')}`, "
                f"end_node_id: `{obj.get('end_node_id')}`"
            )
        lines.append("- членство в relation:")
        lines.append(_membership_md(obj.get("membership")))
        if obj.get("osm_type") == "relation":
            rc = obj.get("role_counts") or {}
            lines.append("")
            lines.append(
                f"- члены: {obj.get('member_count')} "
                f"(outer={rc.get('outer')}, inner={rc.get('inner')}, "
                f"main_stream={rc.get('main_stream')}, side_stream={rc.get('side_stream')}, "
                f"other={rc.get('other')})"
            )
            if rc.get("other_roles"):
                lines.append(
                    f"- прочие роли: {', '.join('`' + r + '`' for r in rc['other_roles'])}"
                )
            n = obj.get("member_count") or 0
            limit = MD_MEMBER_FULL_LIMIT if n <= MD_MEMBER_FULL_LIMIT else MD_MEMBER_SAMPLE
            lines.append("")
            lines.append(_members_table(obj.get("members") or [], limit=limit))
        lines.append("")

    lines.append("## Ограничения")
    lines.append("")
    lines.append("- Снимок OSM на момент запроса; теги и члены могут измениться.")
    lines.append(
        "- Для крупных relation (Ладога, Волга) Overpass может отдать только "
        "`out tags` у вложенных relation; у way-членов теги и node id есть."
    )
    lines.append(
        "- Дополнительные parent relation членов запрашиваются только если у seed "
        "не слишком много way-членов (см. `MEMBER_PARENT_FETCH_MAX_WAYS`); "
        "иначе членство = родитель-seed."
    )
    lines.append(
        "- Геометрия relation как MultiPolygon **не собирается** из outer-колец: "
        "для relation указан тип по тегам, для членов — собственный тип way."
    )
    lines.append(
        "- Координаты не сохраняются; замкнутость = совпадение первого и последнего "
        "**node id** (≥4 узлов)."
    )
    lines.append("- Выборка — эталонный список, не вся Европейская Россия.")
    lines.append("- Production (WRG, БД, маршрутизация, Inspector) этим скриптом не меняется.")
    lines.append("")
    return "\n".join(lines) + "\n"


def build_report(
    objects: list[dict[str, Any]],
    *,
    generated_at: str | None = None,
) -> dict[str, Any]:
    stats = summarize_sample(objects)
    report = {
        "title": "OSM water model audit",
        "generated_at": generated_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "scope": "research-only",
        "not_computed": [
            "no metric joins",
            "no nearest-centerline search",
            "no polygon membership by geometry",
            "no one-river merge",
            "no KNN / ST_DWithin",
            "no polygon-centerline join",
        ],
        "classification": (
            "aligned with sea-map OSM Water Inspector tags/roles; implemented separately"
        ),
        "objects": objects,
        "stats": stats,
        "check_way_180396592": _check_180396592(objects),
        "ambiguous": _ambiguous_notes(objects),
    }
    assert_no_computed_links(report)
    return report


def write_report(report: dict[str, Any], out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "osm-water-model-audit.json"
    md_path = out_dir / "osm-water-model-audit.md"
    json_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    md_path.write_text(render_markdown(report), encoding="utf-8")
    return md_path, json_path
