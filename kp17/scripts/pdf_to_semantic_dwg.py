#!/usr/bin/env python3
"""PDF КП17 → семантический DXF/DWG (TEXT, DIMENSION, LINE, TABLE).

Не контуры глифов, а объекты AutoCAD:
  - LTText*  → TEXT / MTEXT
  - числа размеров → DIMENSION (LINEAR) с override текста
  - LTLine/LTRect/LTCurve → LINE / LWPOLYLINE
  - спецификация → TABLE
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

import ezdxf
from ezdxf import units, bbox
from ezdxf.enums import TextEntityAlignment
from pdfminer.high_level import extract_pages
from pdfminer.layout import (
    LTChar,
    LTCurve,
    LTFigure,
    LTLine,
    LTRect,
    LTTextBox,
    LTTextLine,
)

ROOT = Path(__file__).resolve().parents[2]
DRAW = ROOT / "drawings"
REF_PDF = ROOT / "reference" / "KP17_original.pdf"
ODA_BIN = Path("/tmp/squashfs-root/usr/bin/ODAFileConverter")
PT_TO_MM = 25.4 / 72.0

# слои
LAYERS = {
    "FRAME": 7,
    "GEOMETRY": 7,
    "GEOMETRY_THIN": 8,
    "GEOMETRY_THICK": 5,
    "TEXT": 3,
    "DIMS": 1,
    "TABLE": 4,
    "CENTER": 2,
}


def pt(x: float, y: float):
    return (x * PT_TO_MM, y * PT_TO_MM)


def extract_semantic(pdf: Path) -> dict:
    texts, lines, rects, curves = [], [], [], []
    page_w = page_h = 0.0

    for page in extract_pages(str(pdf)):
        page_w, page_h = page.width, page.height

        def walk(obj):
            if isinstance(obj, LTTextLine):
                t = obj.get_text().replace("\n", " ").strip()
                if not t:
                    return
                chars = [c for c in obj if isinstance(c, LTChar)]
                rot = 0.0
                if chars:
                    a, b = chars[0].matrix[0], chars[0].matrix[1]
                    rot = math.degrees(math.atan2(b, a))
                texts.append(
                    {
                        "t": t,
                        "x0": obj.x0,
                        "y0": obj.y0,
                        "x1": obj.x1,
                        "y1": obj.y1,
                        "h": obj.y1 - obj.y0,
                        "w": obj.x1 - obj.x0,
                        "rot": rot,
                        "cx": (obj.x0 + obj.x1) / 2,
                        "cy": (obj.y0 + obj.y1) / 2,
                    }
                )
            elif isinstance(obj, LTTextBox):
                for ch in obj:
                    walk(ch)
            elif isinstance(obj, LTLine):
                lines.append(
                    {
                        "x0": obj.x0,
                        "y0": obj.y0,
                        "x1": obj.x1,
                        "y1": obj.y1,
                        "lw": float(getattr(obj, "linewidth", 0) or 0),
                    }
                )
            elif isinstance(obj, LTRect):
                rects.append(
                    {
                        "x0": obj.x0,
                        "y0": obj.y0,
                        "x1": obj.x1,
                        "y1": obj.y1,
                        "lw": float(getattr(obj, "linewidth", 0) or 0),
                    }
                )
            elif isinstance(obj, LTCurve):
                pts = list(getattr(obj, "pts", []) or [])
                curves.append({"pts": pts, "bbox": obj.bbox, "lw": float(getattr(obj, "linewidth", 0) or 0)})
            elif isinstance(obj, LTFigure):
                for ch in obj:
                    walk(ch)
            elif hasattr(obj, "__iter__"):
                try:
                    for ch in obj:
                        walk(ch)
                except TypeError:
                    pass

        walk(page)

    return {
        "page": {"w": page_w, "h": page_h},
        "texts": texts,
        "lines": lines,
        "rects": rects,
        "curves": curves,
    }


def merge_vertical_digits(texts: list) -> list:
    """Склеить разбитые вертикальные цифры размеров: 1,1,7,0,0 → 11700."""
    vertical = []
    other = []
    for t in texts:
        if abs(abs(t["rot"]) - 90) < 15 and re.fullmatch(r"\d", t["t"]):
            vertical.append(t)
        else:
            other.append(t)

    vertical.sort(key=lambda t: (round(t["cx"], 0), -t["cy"]))
    used = set()
    merged = []
    for i, t in enumerate(vertical):
        if i in used:
            continue
        group = [t]
        used.add(i)
        for j in range(i + 1, len(vertical)):
            if j in used:
                continue
            u = vertical[j]
            if abs(u["cx"] - t["cx"]) > 3.5:
                continue
            # следующая цифра ниже предыдущей
            last = group[-1]
            gap = last["cy"] - u["cy"]
            if 0 < gap < last["h"] * 2.2:
                group.append(u)
                used.add(j)
            elif gap >= last["h"] * 2.2:
                break
        if len(group) >= 2:
            # В PDF вертикальные цифры размеров идут снизу вверх → читаем reverse
            s = "".join(g["t"] for g in reversed(group))
            x0 = min(g["x0"] for g in group)
            y0 = min(g["y0"] for g in group)
            x1 = max(g["x1"] for g in group)
            y1 = max(g["y1"] for g in group)
            merged.append(
                {
                    "t": s,
                    "x0": x0,
                    "y0": y0,
                    "x1": x1,
                    "y1": y1,
                    "h": group[0]["h"],
                    "w": x1 - x0,
                    "rot": 90.0,
                    "cx": (x0 + x1) / 2,
                    "cy": (y0 + y1) / 2,
                    "is_dim": True,
                }
            )
        else:
            other.append(t)
    return other + merged


def is_dimension_value(s: str) -> bool:
    s = s.strip()
    if re.fullmatch(r"\d{2,5}", s):
        return True
    if re.fullmatch(r"\d+[хx×]\d+=\d+", s, re.I):
        return True
    if re.fullmatch(r"\d+[.,]\d+", s):
        return True
    return False


def layer_for_lw(lw: float) -> str:
    if lw >= 0.6:
        return "GEOMETRY_THICK"
    if lw > 0 and lw <= 0.2:
        return "GEOMETRY_THIN"
    return "GEOMETRY"


def setup_doc():
    doc = ezdxf.new("R2013", setup=True)
    doc.units = units.MM
    doc.header["$INSUNITS"] = units.MM
    doc.header["$MEASUREMENT"] = 1
    for name, color in LAYERS.items():
        doc.layers.add(name, color=color)
    # Кириллица
    if "GOST" not in doc.styles:
        doc.styles.new("GOST", dxfattribs={"font": "DejaVuSans.ttf"})
    else:
        doc.styles.get("GOST").dxf.font = "DejaVuSans.ttf"
    # Dim style
    if "KP17" not in doc.dimstyles:
        doc.dimstyles.new("KP17")
    ds = doc.dimstyles.get("KP17")
    ds.dxf.dimtxsty = "GOST"
    ds.dxf.dimtxt = 2.0
    ds.dxf.dimexe = 1.0
    ds.dxf.dimexo = 0.5
    ds.dxf.dimasz = 1.5
    ds.dxf.dimtad = 1
    return doc


def add_geometry(msp, data):
    for L in data["lines"]:
        layer = layer_for_lw(L["lw"])
        msp.add_line(pt(L["x0"], L["y0"]), pt(L["x1"], L["y1"]), dxfattribs={"layer": layer})
    for r in data["rects"]:
        layer = layer_for_lw(r["lw"])
        x0, y0, x1, y1 = r["x0"], r["y0"], r["x1"], r["y1"]
        msp.add_lwpolyline(
            [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)],
            close=True,
            dxfattribs={"layer": layer},
        )
    for c in data["curves"]:
        pts = c["pts"]
        if len(pts) < 2:
            continue
        layer = layer_for_lw(c["lw"])
        # pts may be flat list or list of pairs
        if pts and not isinstance(pts[0], (list, tuple)):
            pairs = [(pts[i], pts[i + 1]) for i in range(0, len(pts) - 1, 2)]
        else:
            pairs = [(p[0], p[1]) for p in pts]
        if len(pairs) < 2:
            continue
        msp.add_lwpolyline([pt(x, y) for x, y in pairs], dxfattribs={"layer": layer})


def find_dim_endpoints(text, lines, vertical: bool):
    """Найти концы размерной линии рядом с текстом."""
    cx, cy = text["cx"], text["cy"]
    best = None
    best_score = 1e18
    for L in lines:
        dx = L["x1"] - L["x0"]
        dy = L["y1"] - L["y0"]
        length = math.hypot(dx, dy)
        if length < 8:
            continue
        is_vert = abs(dx) < abs(dy) * 0.25
        is_horz = abs(dy) < abs(dx) * 0.25
        if vertical and not is_vert:
            continue
        if not vertical and not is_horz:
            continue
        # расстояние от центра текста до середины линии
        mx, my = (L["x0"] + L["x1"]) / 2, (L["y0"] + L["y1"]) / 2
        dist = math.hypot(mx - cx, my - cy)
        # размерная линия обычно рядом с текстом
        limit = 40 if vertical else 35
        if dist < limit and dist < best_score:
            # линия должна перекрывать текст по основной оси
            if vertical and not (min(L["y0"], L["y1"]) - 5 <= cy <= max(L["y0"], L["y1"]) + 5):
                continue
            if not vertical and not (min(L["x0"], L["x1"]) - 5 <= cx <= max(L["x0"], L["x1"]) + 5):
                continue
            best_score = dist
            best = L
    return best


def add_texts_and_dims(msp, doc, texts, lines):
    n_text = n_dim = n_mtext = 0
    for t in texts:
        s = t["t"]
        h_mm = max(t["h"] * PT_TO_MM * 0.85, 0.8)
        rot = t["rot"]
        # нормализуем угол
        if rot > 180:
            rot -= 360
        if rot < -180:
            rot += 360

        # MTEXT для длинных примечаний
        if len(s) > 80 and abs(rot) < 10:
            mt = msp.add_mtext(
                s,
                dxfattribs={
                    "layer": "TEXT",
                    "style": "GOST",
                    "char_height": h_mm,
                    "width": max(t["w"] * PT_TO_MM, 80),
                },
            )
            mt.set_location(pt(t["x0"], t["y1"]))
            n_mtext += 1
            continue

        vertical = abs(abs(rot) - 90) < 20
        want_dim = t.get("is_dim") or (is_dimension_value(s) and (vertical or len(s) >= 3))

        if want_dim and re.fullmatch(r"\d{2,5}", s.strip()):
            L = find_dim_endpoints(t, lines, vertical=vertical)
            try:
                if L is not None:
                    p1 = pt(L["x0"], L["y0"])
                    p2 = pt(L["x1"], L["y1"])
                    dim_attribs = {"layer": "DIMS"}
                    # base — смещение размерной линии к тексту
                    if vertical:
                        base = pt(t["cx"], (L["y0"] + L["y1"]) / 2)
                        dim = msp.add_linear_dim(
                            base=base,
                            p1=p1,
                            p2=p2,
                            angle=90,
                            dimstyle="KP17",
                            override={"dimtxsty": "GOST", "dimtxt": h_mm},
                            dxfattribs=dim_attribs,
                        )
                    else:
                        base = pt((L["x0"] + L["x1"]) / 2, t["cy"])
                        dim = msp.add_linear_dim(
                            base=base,
                            p1=p1,
                            p2=p2,
                            angle=0,
                            dimstyle="KP17",
                            override={"dimtxsty": "GOST", "dimtxt": h_mm},
                            dxfattribs=dim_attribs,
                        )
                    dim.set_text(s.strip())
                    dim.render()
                    n_dim += 1
                    continue
            except Exception:
                pass

        # обычный TEXT
        insert = pt(t["x0"], t["y0"])
        e = msp.add_text(
            s,
            dxfattribs={
                "layer": "TEXT",
                "style": "GOST",
                "height": h_mm,
                "rotation": rot if not vertical else 90,
                "width": 0.85,
            },
        )
        if vertical:
            e.set_placement(pt(t["cx"], t["cy"]), align=TextEntityAlignment.MIDDLE_CENTER)
            e.dxf.rotation = 90
        else:
            e.set_placement(insert, align=TextEntityAlignment.LEFT)
        n_text += 1

    return n_text, n_mtext, n_dim


def add_spec_table(msp, doc):
    """Спецификация уже приходит из PDF как TEXT; отдельную TABLE не дублируем.

    При необходимости можно собрать ACAD_TABLE/TablePainter поверх.
    """
    return 0


def dxf_to_dwg(dxf: Path, dwg: Path):
    if not ODA_BIN.exists():
        print("WARN: ODA missing, skip DWG", file=sys.stderr)
        return False
    inp, outp = Path("/tmp/oda_sem_in"), Path("/tmp/oda_sem_out")
    inp.mkdir(exist_ok=True)
    outp.mkdir(exist_ok=True)
    for f in inp.glob("*"):
        f.unlink()
    for f in outp.glob("*"):
        f.unlink()
    shutil.copy(dxf, inp / dxf.name)
    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = str(ODA_BIN.parent) + ":" + env.get("LD_LIBRARY_PATH", "")
    subprocess.run(
        [str(ODA_BIN), str(inp), str(outp), "ACAD2018", "DWG", "0", "1", "*.DXF"],
        check=False,
        env=env,
        capture_output=True,
    )
    produced = outp / (dxf.stem + ".dwg")
    if produced.exists():
        shutil.copy(produced, dwg)
        print(f"DWG {dwg} ({dwg.stat().st_size} bytes)")
        return True
    err = outp / (dxf.stem + ".dwg.err")
    print("DWG failed", err.read_text()[:500] if err.exists() else "", file=sys.stderr)
    return False


def build(pdf: Path = REF_PDF):
    print("Extracting semantic content from PDF…")
    data = extract_semantic(pdf)
    print(
        f"  texts={len(data['texts'])} lines={len(data['lines'])} "
        f"rects={len(data['rects'])} curves={len(data['curves'])}"
    )
    texts = merge_vertical_digits(data["texts"])
    print(f"  texts after merge={len(texts)}")

    # cache
    (DRAW / "kp17_semantic.json").write_text(
        json.dumps(
            {
                "page": data["page"],
                "n_texts": len(texts),
                "n_lines": len(data["lines"]),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    doc = setup_doc()
    msp = doc.modelspace()
    print("Adding geometry…")
    add_geometry(msp, data)
    print("Adding TEXT / MTEXT / DIMENSION…")
    n_text, n_mtext, n_dim = add_texts_and_dims(msp, doc, texts, data["lines"])
    print(f"  TEXT={n_text} MTEXT={n_mtext} DIMENSION={n_dim}")
    n_tab = add_spec_table(msp, doc)
    print(f"  TABLE={n_tab}")

    dxf = DRAW / "KP17.dxf"
    doc.saveas(dxf)
    ext = bbox.extents(msp, fast=True)
    print(f"Saved {dxf} ents={len(msp)} extents={ext.extmin}..{ext.extmax}")

    dwg = DRAW / "KP17.dwg"
    dxf_to_dwg(dxf, dwg)
    return dxf, dwg, {"text": n_text, "mtext": n_mtext, "dim": n_dim, "table": n_tab, "ents": len(msp)}


if __name__ == "__main__":
    build()
