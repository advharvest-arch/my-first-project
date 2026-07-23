#!/usr/bin/env python3
"""PDF КП17 → семантический DXF/DWG: как в PDF (чёрный), TEXT/DIMENSION/LINE.

Принципы:
  1) Цвет всех слоёв и объектов = 7 (чёрный/белый), как исходный PDF.
  2) Весь текст из PDF → TEXT/MTEXT (без потерь).
  3) Размеры → DIMENSION только для уверенных числовых подписей;
     при ошибке остаётся TEXT.
  4) Геометрия → LINE / LWPOLYLINE.
"""
from __future__ import annotations

import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import ezdxf
from ezdxf import bbox, units
from ezdxf.enums import TextEntityAlignment
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTChar, LTCurve, LTFigure, LTLine, LTRect, LTTextBox, LTTextLine

ROOT = Path(__file__).resolve().parents[2]
DRAW = ROOT / "drawings"
REF_PDF = ROOT / "reference" / "KP17_original.pdf"
ODA_BIN = Path("/tmp/squashfs-root/usr/bin/ODAFileConverter")
PT_TO_MM = 25.4 / 72.0

# Все слои — цвет 7 (как чёрный чертёж PDF)
LAYER_DEFS = {
    "GEOMETRY": 7,
    "GEOMETRY_THIN": 7,
    "GEOMETRY_THICK": 7,
    "TEXT": 7,
    "DIMS": 7,
    "FRAME": 7,
}

# Допустимые значения размеров с листа КП17 (мм)
DIM_WHITELIST = {
    "25", "30", "40", "45", "50", "70", "83", "90", "92", "94", "100", "105",
    "140", "295", "300", "305", "325", "370", "450", "452", "467", "490", "500",
    "548", "580", "590", "592", "600", "612", "614", "642", "700", "720", "800",
    "818", "950", "968", "1100", "1200", "1540", "1820", "1860", "1900", "2100",
    "3050", "5850", "8450", "11700", "29400", "29700", "30950",
}
# номера позиций / мелкие метки — НЕ размеры
NOT_DIM = {"11", "12", "13", "14", "15", "16", "17", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"}


def pt(x: float, y: float):
    return (x * PT_TO_MM, y * PT_TO_MM)


def extract_semantic(pdf: Path) -> dict:
    texts, lines, rects, curves = [], [], [], []
    page_w = page_h = 0.0

    for page in extract_pages(str(pdf)):
        page_w, page_h = page.width, page.height

        def walk(obj):
            if isinstance(obj, LTTextLine):
                raw = obj.get_text()
                # сохраняем многострочность для вертикали
                t = raw.replace("\n", " ").strip()
                raw_lines = [ln for ln in raw.splitlines() if ln.strip()]
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
                        "raw_lines": raw_lines,
                        "x0": obj.x0,
                        "y0": obj.y0,
                        "x1": obj.x1,
                        "y1": obj.y1,
                        "h": max(obj.y1 - obj.y0, 1.0),
                        "w": max(obj.x1 - obj.x0, 1.0),
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
                curves.append(
                    {
                        "pts": pts,
                        "bbox": obj.bbox,
                        "lw": float(getattr(obj, "linewidth", 0) or 0),
                    }
                )
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
    """Склеить одиночные вертикальные цифры в числа размеров (снизу вверх)."""
    vertical, other = [], []
    for t in texts:
        if abs(abs(t["rot"]) - 90) < 15 and re.fullmatch(r"\d", t["t"]):
            vertical.append(t)
        else:
            other.append(t)

    vertical.sort(key=lambda t: (round(t["cx"], 0), -t["cy"]))
    used = set()
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
            last = group[-1]
            gap = last["cy"] - u["cy"]
            if 0 < gap < last["h"] * 2.2:
                group.append(u)
                used.add(j)
            elif gap >= last["h"] * 2.2:
                break
        if len(group) >= 2:
            # PDF: цифры сверху вниз в extraction → число читается снизу вверх
            s = "".join(g["t"] for g in reversed(group))
            # отбраковать мусорные склейки
            if s in NOT_DIM or (s not in DIM_WHITELIST and len(s) < 3):
                for g in group:
                    other.append(g)
                continue
            if s not in DIM_WHITELIST and not re.fullmatch(r"\d{3,5}", s):
                for g in group:
                    other.append(g)
                continue
            x0 = min(g["x0"] for g in group)
            y0 = min(g["y0"] for g in group)
            x1 = max(g["x1"] for g in group)
            y1 = max(g["y1"] for g in group)
            other.append(
                {
                    "t": s,
                    "raw_lines": [s],
                    "x0": x0,
                    "y0": y0,
                    "x1": x1,
                    "y1": y1,
                    "h": group[0]["h"],
                    "w": x1 - x0,
                    "rot": 90.0,
                    "cx": (x0 + x1) / 2,
                    "cy": (y0 + y1) / 2,
                    "is_dim_candidate": True,
                }
            )
        else:
            other.append(t)
    return other


def layer_for_lw(lw: float) -> str:
    if lw >= 0.6:
        return "GEOMETRY_THICK"
    if 0 < lw <= 0.2:
        return "GEOMETRY_THIN"
    return "GEOMETRY"


def setup_doc():
    doc = ezdxf.new("R2013", setup=True)
    doc.units = units.MM
    doc.header["$INSUNITS"] = units.MM
    doc.header["$MEASUREMENT"] = 1
    for name, color in LAYER_DEFS.items():
        if name in doc.layers:
            doc.layers.get(name).dxf.color = color
        else:
            doc.layers.add(name, color=color)
    # сбросить цвет служебных
    for name in ("0", "Defpoints"):
        if name in doc.layers:
            doc.layers.get(name).dxf.color = 7

    if "GOST" not in doc.styles:
        doc.styles.new("GOST", dxfattribs={"font": "DejaVuSans.ttf"})
    else:
        doc.styles.get("GOST").dxf.font = "DejaVuSans.ttf"

    if "KP17" not in doc.dimstyles:
        doc.dimstyles.new("KP17")
    ds = doc.dimstyles.get("KP17")
    ds.dxf.dimtxsty = "GOST"
    ds.dxf.dimclrd = 7  # dim line color
    ds.dxf.dimclre = 7  # extension line color
    ds.dxf.dimclrt = 7  # text color
    ds.dxf.dimtxt = 1.8
    ds.dxf.dimexe = 0.8
    ds.dxf.dimexo = 0.4
    ds.dxf.dimasz = 1.2
    ds.dxf.dimtad = 1
    ds.dxf.dimtofl = 1
    return doc


def add_geometry(msp, data):
    n = 0
    attribs_base = {"color": 7}
    for L in data["lines"]:
        layer = layer_for_lw(L["lw"])
        msp.add_line(
            pt(L["x0"], L["y0"]),
            pt(L["x1"], L["y1"]),
            dxfattribs={**attribs_base, "layer": layer},
        )
        n += 1
    for r in data["rects"]:
        layer = layer_for_lw(r["lw"])
        x0, y0, x1, y1 = r["x0"], r["y0"], r["x1"], r["y1"]
        msp.add_lwpolyline(
            [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)],
            close=True,
            dxfattribs={**attribs_base, "layer": layer},
        )
        n += 1
    for c in data["curves"]:
        pts = c["pts"]
        if len(pts) < 2:
            continue
        layer = layer_for_lw(c["lw"])
        if pts and not isinstance(pts[0], (list, tuple)):
            pairs = [(pts[i], pts[i + 1]) for i in range(0, len(pts) - 1, 2)]
        else:
            pairs = [(p[0], p[1]) for p in pts]
        if len(pairs) < 2:
            continue
        msp.add_lwpolyline(
            [pt(x, y) for x, y in pairs],
            dxfattribs={**attribs_base, "layer": layer},
        )
        n += 1
    return n


def find_dim_line(text, lines, vertical: bool):
    cx, cy = text["cx"], text["cy"]
    best, best_score = None, 1e18
    for L in lines:
        dx, dy = L["x1"] - L["x0"], L["y1"] - L["y0"]
        length = math.hypot(dx, dy)
        if length < 10:
            continue
        is_vert = abs(dx) < abs(dy) * 0.2
        is_horz = abs(dy) < abs(dx) * 0.2
        if vertical and not is_vert:
            continue
        if (not vertical) and not is_horz:
            continue
        mx, my = (L["x0"] + L["x1"]) / 2, (L["y0"] + L["y1"]) / 2
        dist = math.hypot(mx - cx, my - cy)
        if dist > 45 or dist >= best_score:
            continue
        if vertical:
            if not (min(L["y0"], L["y1"]) - 8 <= cy <= max(L["y0"], L["y1"]) + 8):
                continue
            # размерная линия должна быть близко по X
            if abs(mx - cx) > 30:
                continue
        else:
            if not (min(L["x0"], L["x1"]) - 8 <= cx <= max(L["x0"], L["x1"]) + 8):
                continue
            if abs(my - cy) > 25:
                continue
        best_score = dist
        best = L
    return best


def is_pure_dim_number(s: str) -> bool:
    s = s.strip()
    if not re.fullmatch(r"\d{2,5}", s):
        return False
    if s in NOT_DIM:
        return False
    if s in DIM_WHITELIST:
        return True
    # прочие 3–5-значные числа с листа (детали ведомости)
    return len(s) >= 3


def add_text_entity(msp, t):
    s = t["t"]
    h_mm = max(t["h"] * PT_TO_MM * 0.9, 0.7)
    rot = t["rot"]
    if rot > 180:
        rot -= 360
    if rot < -180:
        rot += 360
    vertical = abs(abs(rot) - 90) < 20

    if len(s) > 90 and abs(rot) < 15:
        mt = msp.add_mtext(
            s,
            dxfattribs={
                "layer": "TEXT",
                "style": "GOST",
                "char_height": h_mm,
                "color": 7,
                "width": max(t["w"] * PT_TO_MM * 1.05, 60),
            },
        )
        mt.set_location(pt(t["x0"], t["y1"]))
        return "MTEXT"

    e = msp.add_text(
        s,
        dxfattribs={
            "layer": "TEXT",
            "style": "GOST",
            "height": h_mm,
            "rotation": 90 if vertical else (rot if abs(rot) > 5 else 0),
            "width": 0.85,
            "color": 7,
        },
    )
    if vertical:
        e.set_placement(pt(t["cx"], t["cy"]), align=TextEntityAlignment.MIDDLE_CENTER)
        e.dxf.rotation = 90
    else:
        e.set_placement(pt(t["x0"], t["y0"]), align=TextEntityAlignment.LEFT)
    return "TEXT"


def try_add_dimension(msp, t, lines) -> bool:
    s = t["t"].strip()
    if not is_pure_dim_number(s):
        return False
    # не делаем DIMENSION из мелких позиционных номеров (часто 1–2 цифры уже отсечены)
    if len(s) < 3 and not t.get("is_dim_candidate"):
        return False

    vertical = abs(abs(t["rot"]) - 90) < 20 or t.get("is_dim_candidate")
    L = find_dim_line(t, lines, vertical=vertical)
    if L is None:
        return False

    h_mm = max(t["h"] * PT_TO_MM * 0.9, 1.0)
    p1, p2 = pt(L["x0"], L["y0"]), pt(L["x1"], L["y1"])
    try:
        if vertical:
            base = pt(t["cx"], (L["y0"] + L["y1"]) / 2)
            dim = msp.add_linear_dim(
                base=base,
                p1=p1,
                p2=p2,
                angle=90,
                dimstyle="KP17",
                override={
                    "dimtxsty": "GOST",
                    "dimtxt": h_mm,
                    "dimclrd": 7,
                    "dimclre": 7,
                    "dimclrt": 7,
                    # линии размеров уже есть в геометрии PDF — не дублировать
                    "dimse1": 1,
                    "dimse2": 1,
                    "dimsd1": 1,
                    "dimsd2": 1,
                    "dimexe": 0,
                    "dimexo": 0,
                    "dimasz": 0.01,
                },
                dxfattribs={"layer": "DIMS", "color": 7},
            )
        else:
            base = pt((L["x0"] + L["x1"]) / 2, t["cy"])
            dim = msp.add_linear_dim(
                base=base,
                p1=p1,
                p2=p2,
                angle=0,
                dimstyle="KP17",
                override={
                    "dimtxsty": "GOST",
                    "dimtxt": h_mm,
                    "dimclrd": 7,
                    "dimclre": 7,
                    "dimclrt": 7,
                    "dimse1": 1,
                    "dimse2": 1,
                    "dimsd1": 1,
                    "dimsd2": 1,
                    "dimexe": 0,
                    "dimexo": 0,
                    "dimasz": 0.01,
                },
                dxfattribs={"layer": "DIMS", "color": 7},
            )
        dim.set_text(s)
        dim.render()
        return True
    except Exception:
        return False


def add_texts_and_dims(msp, texts, lines):
    """Сначала ВСЕ тексты; затем размеры поверх (текст размера удаляем только при успехе)."""
    n_text = n_mtext = n_dim = 0
    # Разделяем: кандидаты в размеры vs обычный текст
    dim_candidates = []
    regular = []
    for t in texts:
        s = t["t"].strip()
        vertical = abs(abs(t["rot"]) - 90) < 20 or t.get("is_dim_candidate")
        if is_pure_dim_number(s) and (t.get("is_dim_candidate") or len(s) >= 3 or vertical):
            dim_candidates.append(t)
        else:
            regular.append(t)

    for t in regular:
        kind = add_text_entity(msp, t)
        if kind == "MTEXT":
            n_mtext += 1
        else:
            n_text += 1

    for t in dim_candidates:
        if try_add_dimension(msp, t, lines):
            n_dim += 1
        else:
            # не потерять — оставить как TEXT
            kind = add_text_entity(msp, t)
            if kind == "MTEXT":
                n_mtext += 1
            else:
                n_text += 1

    return n_text, n_mtext, n_dim


def dxf_to_dwg(dxf: Path, dwg: Path) -> bool:
    if not ODA_BIN.exists():
        print("WARN: ODA missing", file=sys.stderr)
        return False
    inp, outp = Path("/tmp/oda_sem_in"), Path("/tmp/oda_sem_out")
    inp.mkdir(exist_ok=True)
    outp.mkdir(exist_ok=True)
    for f in list(inp.glob("*")) + list(outp.glob("*")):
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
    return False


def build(pdf: Path = REF_PDF):
    print("1) Extract PDF…")
    data = extract_semantic(pdf)
    print(
        f"   texts={len(data['texts'])} lines={len(data['lines'])} "
        f"rects={len(data['rects'])} curves={len(data['curves'])}"
    )
    texts = merge_vertical_digits(data["texts"])
    print(f"   after digit-merge={len(texts)}")

    doc = setup_doc()
    msp = doc.modelspace()
    print("2) Geometry…")
    n_geom = add_geometry(msp, data)
    print(f"   geom ents={n_geom}")
    print("3) TEXT + DIMENSION…")
    n_text, n_mtext, n_dim = add_texts_and_dims(msp, texts, data["lines"])
    print(f"   TEXT={n_text} MTEXT={n_mtext} DIMENSION={n_dim}")

    dxf = DRAW / "KP17.dxf"
    doc.saveas(dxf)
    ext = bbox.extents(msp, fast=True)
    print(f"4) Saved {dxf} total={len(msp)} size_mm≈{tuple(round(x,1) for x in ext.size)}")
    dxf_to_dwg(dxf, DRAW / "KP17.dwg")

    # verify colors
    bad = [l.dxf.name for l in doc.layers if not l.dxf.name.startswith("*") and l.dxf.color not in (7, 256, 0)]
    if bad:
        print("WARN non-black layers:", bad)
    return dxf


if __name__ == "__main__":
    build()
