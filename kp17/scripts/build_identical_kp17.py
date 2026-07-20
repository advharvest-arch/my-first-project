#!/usr/bin/env python3
"""КП17: визуал PDF + без наложения текста + настоящие DIMENSION.

1) Геометрия из Inkscape-outlines PDF (полная картинка)
2) Вырезаем полилинии внутри bbox текста (контуры букв) — нет наложения
3) Вырезаем линии размеров → вместо них цельные DIMENSION
4) Текст только MTEXT (GOSTCommon), размеры только DIMENSION
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
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTChar, LTFigure, LTLine, LTTextBox, LTTextLine

ROOT = Path(__file__).resolve().parents[2]
DRAW = ROOT / "drawings"
FONT = ROOT / "fonts" / "GOSTCommon.ttf"
REF_PDF = ROOT / "reference" / "KP17_original.pdf"
OUTLINES = Path("/tmp/kp17_outlines.dxf")
ODA_BIN = Path("/tmp/squashfs-root/usr/bin/ODAFileConverter")
PT_TO_MM = 25.4 / 72.0
COLOR = 7

DIM_WHITELIST = {
    "25", "30", "40", "45", "50", "70", "83", "90", "92", "94", "100", "105",
    "140", "295", "300", "305", "325", "370", "450", "452", "467", "490", "500",
    "548", "580", "590", "592", "600", "612", "614", "642", "700", "720", "800",
    "818", "950", "968", "1100", "1200", "1540", "1820", "1860", "1900", "2100",
    "3050", "5850", "8450", "11700", "29400", "29700", "30950",
}
NOT_DIM = {str(i) for i in range(1, 18)}


def pt(x, y):
    return (x * PT_TO_MM, y * PT_TO_MM)


def ensure_outlines():
    if OUTLINES.exists() and OUTLINES.stat().st_size > 1_000_000:
        return OUTLINES
    svg = Path("/tmp/kp17.svg")
    if not svg.exists():
        subprocess.run(["pdftocairo", "-svg", str(REF_PDF), "/tmp/kp17"], check=True)
    subprocess.run(
        [
            "inkscape",
            str(svg),
            "--export-extension=org.ekips.output.dxf_outlines",
            f"--export-filename={OUTLINES}",
        ],
        check=True,
    )
    return OUTLINES


def setup_doc():
    doc = ezdxf.new("R2013", setup=True)
    doc.units = units.MM
    doc.header["$INSUNITS"] = units.MM
    doc.header["$MEASUREMENT"] = 1
    for name in ("GEOMETRY", "TEXT", "DIMS", "REBAR", "FRAME"):
        doc.layers.add(name, color=COLOR)
    for sn in ("GOST", "GOSTCommon", "Standard"):
        if sn in doc.styles:
            doc.styles.get(sn).dxf.font = "GOSTCommon.ttf"
        else:
            doc.styles.new(sn, dxfattribs={"font": "GOSTCommon.ttf"})
    if "KP17" not in doc.dimstyles:
        doc.dimstyles.new("KP17")
    ds = doc.dimstyles.get("KP17")
    ds.dxf.dimtxsty = "GOST"
    ds.dxf.dimtxt = 1.8
    ds.dxf.dimclrd = COLOR
    ds.dxf.dimclre = COLOR
    ds.dxf.dimclrt = COLOR
    ds.dxf.dimexe = 1.0
    ds.dxf.dimexo = 0.5
    ds.dxf.dimasz = 0.01
    ds.dxf.dimtsz = 1.25
    ds.dxf.dimtad = 1
    ds.dxf.dimtofl = 1
    ds.dxf.dimgap = 0.45
    return doc


def extract_texts_and_dimlines(pdf: Path):
    texts, lines = [], []
    for page in extract_pages(str(pdf)):
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
                    {"x0": obj.x0, "y0": obj.y0, "x1": obj.x1, "y1": obj.y1}
                )
            elif isinstance(obj, LTFigure):
                for ch in obj:
                    walk(ch)
            elif hasattr(obj, "__iter__") and not isinstance(obj, (LTChar, str)):
                try:
                    for ch in obj:
                        walk(ch)
                except TypeError:
                    pass

        walk(page)
    return texts, lines


def merge_vertical_digits(texts):
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
            s = "".join(g["t"] for g in reversed(group))
            if s in NOT_DIM or (s not in DIM_WHITELIST and len(s) < 3):
                other.extend(group)
                continue
            x0 = min(g["x0"] for g in group)
            y0 = min(g["y0"] for g in group)
            x1 = max(g["x1"] for g in group)
            y1 = max(g["y1"] for g in group)
            other.append(
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
                    "is_dim_candidate": True,
                }
            )
        else:
            other.append(t)
    return other


def is_dim_value(t) -> bool:
    s = t["t"].strip()
    if not re.fullmatch(r"\d{2,5}", s) or s in NOT_DIM:
        return False
    if s in DIM_WHITELIST:
        return True
    return len(s) >= 3 and (t.get("is_dim_candidate") or abs(abs(t["rot"]) - 90) < 20)


def find_dim_line(text, lines, vertical: bool):
    cx, cy = text["cx"], text["cy"]
    best, best_i, best_score = None, -1, 1e18
    for i, L in enumerate(lines):
        dx, dy = L["x1"] - L["x0"], L["y1"] - L["y0"]
        length = math.hypot(dx, dy)
        if length < 12:
            continue
        is_vert = abs(dx) < abs(dy) * 0.2
        is_horz = abs(dy) < abs(dx) * 0.2
        if vertical and not is_vert:
            continue
        if (not vertical) and not is_horz:
            continue
        mx, my = (L["x0"] + L["x1"]) / 2, (L["y0"] + L["y1"]) / 2
        dist = math.hypot(mx - cx, my - cy)
        if dist > 50 or dist >= best_score:
            continue
        if vertical and not (min(L["y0"], L["y1"]) - 10 <= cy <= max(L["y0"], L["y1"]) + 10):
            continue
        if (not vertical) and not (min(L["x0"], L["x1"]) - 10 <= cx <= max(L["x0"], L["x1"]) + 10):
            continue
        best_score, best, best_i = dist, L, i
    return best, best_i


def text_bboxes_mm(texts, pad_pt=1.5):
    """BBox текстов в мм (с запасом) — для вырезания контуров букв из геометрии."""
    boxes = []
    for t in texts:
        boxes.append(
            (
                (t["x0"] - pad_pt) * PT_TO_MM,
                (t["y0"] - pad_pt) * PT_TO_MM,
                (t["x1"] + pad_pt) * PT_TO_MM,
                (t["y1"] + pad_pt) * PT_TO_MM,
            )
        )
    return boxes


def poly_len(pts):
    return sum(
        math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
        for i in range(len(pts) - 1)
    )


def is_glyph_like(pts_mm) -> bool:
    """Контур буквы: короткий ход или маленький bbox (мм)."""
    if len(pts_mm) < 2:
        return True
    length = poly_len(pts_mm)
    xs = [p[0] for p in pts_mm]
    ys = [p[1] for p in pts_mm]
    bw, bh = max(xs) - min(xs), max(ys) - min(ys)
    if length < 6.0:
        return True
    if bw < 5.5 and bh < 5.5 and length < 25:
        return True
    if max(bw, bh) < 3.5:
        return True
    return False


def poly_inside_any_bbox(pts_mm, boxes) -> bool:
    if not pts_mm:
        return False
    cx = sum(p[0] for p in pts_mm) / len(pts_mm)
    cy = sum(p[1] for p in pts_mm) / len(pts_mm)
    for x0, y0, x1, y1 in boxes:
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            return True
        if len(pts_mm) <= 16 and all(x0 <= p[0] <= x1 and y0 <= p[1] <= y1 for p in pts_mm):
            return True
    return False


def dim_exclusion_boxes_mm(dim_items, pad=3.0):
    """Зоны размерных линий в мм — геометрию размеров не импортируем."""
    boxes = []
    for t, dl, _ in dim_items:
        xs = [dl["x0"], dl["x1"], t["x0"], t["x1"]]
        ys = [dl["y0"], dl["y1"], t["y0"], t["y1"]]
        boxes.append(
            (
                (min(xs) - pad) * PT_TO_MM,
                (min(ys) - pad) * PT_TO_MM,
                (max(xs) + pad) * PT_TO_MM,
                (max(ys) + pad) * PT_TO_MM,
            )
        )
    return boxes


def import_visual_geometry(msp, text_boxes, dim_boxes):
    """Полная геометрия PDF минус контуры букв и зоны размеров."""
    ensure_outlines()
    src = ezdxf.readfile(OUTLINES)
    n_keep = n_drop_text = n_drop_dim = n_skip = 0
    all_boxes = text_boxes  # glyph cut
    for e in src.modelspace():
        t = e.dxftype()
        pts = []
        closed = False
        if t == "LWPOLYLINE":
            pts = list(e.get_points("xy"))
            closed = bool(e.closed)
        elif t == "SPLINE":
            # глифы текста в outlines — всегда SPLINE; не импортируем (будет MTEXT)
            n_drop_text += 1
            continue
        elif t == "LINE":
            pts = [(e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)]
        else:
            n_skip += 1
            continue
        if len(pts) < 2:
            n_skip += 1
            continue
        scaled = [(p[0] * PT_TO_MM, p[1] * PT_TO_MM) for p in pts]
        # убираем только геометрию в зонах размеров (её заменит DIMENSION)
        if poly_inside_any_bbox(scaled, dim_boxes):
            n_drop_dim += 1
            continue
        # слой: крупные замкнутые прямоугольники → REBAR
        layer = "GEOMETRY"
        if closed and 3 <= len(scaled) <= 5:
            xs = [p[0] for p in scaled]
            ys = [p[1] for p in scaled]
            if max(xs) - min(xs) > 8 and max(ys) - min(ys) > 8:
                layer = "REBAR"
        msp.add_lwpolyline(
            scaled, close=closed, dxfattribs={"layer": layer, "color": COLOR}
        )
        n_keep += 1
    print(f"   geometry keep={n_keep} drop_text={n_drop_text} drop_dim={n_drop_dim} skip={n_skip}")
    return n_keep


def add_mtext(msp, t):
    h_mm = max(t["h"] * PT_TO_MM * 0.92, 0.7)
    rot = t["rot"]
    if rot > 180:
        rot -= 360
    if rot < -180:
        rot += 360
    vertical = abs(abs(rot) - 90) < 20
    width = max(t["w"] * PT_TO_MM * 1.15, h_mm * 3)
    mt = msp.add_mtext(
        t["t"],
        dxfattribs={
            "layer": "TEXT",
            "style": "GOST",
            "char_height": h_mm,
            "width": width if not vertical else h_mm * 5,
            "color": COLOR,
            "rotation": 90 if vertical else (0 if abs(rot) < 5 else rot),
            "attachment_point": 5 if vertical else 7,
        },
    )
    if vertical:
        mt.set_location(pt(t["cx"], t["cy"]))
    else:
        mt.set_location(pt(t["x0"], t["y0"]))
    return mt


def add_dimension(msp, t, dim_line) -> bool:
    s = t["t"].strip()
    vertical = abs(abs(t["rot"]) - 90) < 20 or t.get("is_dim_candidate")
    h_mm = max(t["h"] * PT_TO_MM * 0.95, 1.2)
    p1, p2 = pt(dim_line["x0"], dim_line["y0"]), pt(dim_line["x1"], dim_line["y1"])
    if vertical:
        base = pt(t["cx"], (dim_line["y0"] + dim_line["y1"]) / 2)
        angle = 90
    else:
        base = pt((dim_line["x0"] + dim_line["x1"]) / 2, t["cy"])
        angle = 0
    try:
        dim = msp.add_linear_dim(
            base=base,
            p1=p1,
            p2=p2,
            angle=angle,
            dimstyle="KP17",
            override={
                "dimtxsty": "GOST",
                "dimtxt": h_mm,
                "dimclrd": COLOR,
                "dimclre": COLOR,
                "dimclrt": COLOR,
                "dimtsz": max(h_mm * 0.55, 0.8),
                "dimasz": 0.01,
                "dimexe": 1.0,
                "dimexo": 0.5,
                "dimgap": 0.4,
                "dimtad": 1,
                "dimse1": 0,
                "dimse2": 0,
                "dimsd1": 0,
                "dimsd2": 0,
            },
            dxfattribs={"layer": "DIMS", "color": COLOR},
        )
        dim.set_text(s)
        dim.render()
        return True
    except Exception:
        return False


def force_black(doc, msp):
    for layer in doc.layers:
        if not layer.dxf.name.startswith("*"):
            layer.dxf.color = COLOR
    for e in msp:
        try:
            e.dxf.color = COLOR
        except Exception:
            pass


def to_dwg(dxf: Path):
    if not ODA_BIN.exists():
        return False
    inp, outp = Path("/tmp/oda_v3_in"), Path("/tmp/oda_v3_out")
    inp.mkdir(exist_ok=True)
    outp.mkdir(exist_ok=True)
    for f in list(inp.glob("*")) + list(outp.glob("*")):
        f.unlink()
    shutil.copy(dxf, inp / dxf.name)
    for f in (ROOT / "fonts").glob("*.ttf"):
        shutil.copy(f, inp / f.name)
    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = str(ODA_BIN.parent) + ":" + env.get("LD_LIBRARY_PATH", "")
    subprocess.run(
        [str(ODA_BIN), str(inp), str(outp), "ACAD2018", "DWG", "0", "1", "*.DXF"],
        check=False,
        env=env,
        capture_output=True,
    )
    produced = outp / "KP17.dwg"
    if produced.exists():
        shutil.copy(produced, DRAW / "KP17.dwg")
        fout = DRAW / "fonts"
        fout.mkdir(exist_ok=True)
        for f in (ROOT / "fonts").glob("*.ttf"):
            shutil.copy(f, fout / f.name)
        print(f"   DWG {(DRAW/'KP17.dwg').stat().st_size} bytes")
        return True
    return False


def build():
    if not FONT.exists():
        raise SystemExit(f"Missing {FONT}")

    print("1) Texts + dim lines from PDF")
    texts0, lines = extract_texts_and_dimlines(REF_PDF)
    texts = merge_vertical_digits(texts0)
    print(f"   texts={len(texts)} lines={len(lines)}")

    print("2) Classify DIMENSION candidates")
    dim_items, regular = [], []
    for t in texts:
        if not is_dim_value(t):
            regular.append(t)
            continue
        vertical = abs(abs(t["rot"]) - 90) < 20 or t.get("is_dim_candidate")
        dl, idx = find_dim_line(t, lines, vertical)
        if dl is None:
            regular.append(t)
            continue
        dim_items.append((t, dl, idx))
    print(f"   dims={len(dim_items)} mtext={len(regular)}")

    doc = setup_doc()
    msp = doc.modelspace()

    print("3) Visual geometry (PDF) minus glyphs & dim zones")
    tb = text_bboxes_mm(texts, pad_pt=2.0)
    db = dim_exclusion_boxes_mm(dim_items, pad=4.0)
    import_visual_geometry(msp, tb, db)

    print("4) True DIMENSION objects")
    n_dim = 0
    for t, dl, _ in dim_items:
        if add_dimension(msp, t, dl):
            n_dim += 1
        else:
            add_mtext(msp, t)
    print(f"   DIMENSION={n_dim}")

    print("5) MTEXT only (no dim duplicates)")
    for t in regular:
        add_mtext(msp, t)
    print(f"   MTEXT={len(regular)}")

    force_black(doc, msp)
    dxf = DRAW / "KP17.dxf"
    doc.saveas(dxf)
    from collections import Counter

    print("6) Saved", dxf)
    print("   entities:", Counter(e.dxftype() for e in msp))
    print("   extents:", bbox.extents(msp, fast=True))
    to_dwg(dxf)
    return dxf


if __name__ == "__main__":
    build()
