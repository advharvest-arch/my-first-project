#!/usr/bin/env python3
"""КП17: визуал как PDF, без наложения текста, размеры = DIMENSION.

- Геометрия с PDF (Inkscape outlines), без SPLINE-глифов и без штрихов под MTEXT
- В зонах размеров PDF-линии убраны полностью (остаётся объект DIMENSION)
- Текст только MTEXT (GOSTCommon), без дублей и без «склеенных» цифр
- Размеры только LINEAR DIMENSION (+засечки), цельный объект AutoCAD
"""
from __future__ import annotations

import math
import os
import re
import shutil
import subprocess
import sys
from collections import Counter, defaultdict
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
    "140", "165", "200", "295", "300", "305", "325", "370", "415", "450", "452",
    "467", "490", "500", "548", "580", "590", "592", "600", "612", "614", "621",
    "624", "642", "700", "720", "800", "818", "950", "968", "1100", "1200",
    "1540", "1820", "1860", "1900", "2100", "3050", "5850", "7650", "8450",
    "11600", "11700", "29400", "29700", "30950",
}
# longest first for segmentation
DIM_BY_LEN = sorted(DIM_WHITELIST, key=len, reverse=True)
NOT_DIM = {str(i) for i in range(1, 18)} | {"0"}


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


def extract_texts_and_lines(pdf: Path):
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
                lines.append({"x0": obj.x0, "y0": obj.y0, "x1": obj.x1, "y1": obj.y1})
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


def segment_whitelist(digits: str) -> list[str] | None:
    """Split digit string into DIM_WHITELIST values (greedy longest)."""
    if not digits:
        return []
    out = []
    i = 0
    while i < len(digits):
        matched = None
        for w in DIM_BY_LEN:
            if digits.startswith(w, i):
                matched = w
                break
        if matched is None:
            return None
        out.append(matched)
        i += len(matched)
    return out


def _make_merged(group):
    """Bottom→top reading for vertical dims."""
    ordered = list(reversed(group))  # bottom first
    s = "".join(g["t"] for g in ordered)
    parts = segment_whitelist(s)
    if parts is None:
        # try top→bottom reading
        s2 = "".join(g["t"] for g in group)
        parts = segment_whitelist(s2)
        if parts is not None:
            ordered = group
            s = s2
        else:
            return None
    # map each whitelist part back to geometry from ordered digits
    results = []
    idx = 0
    for part in parts:
        chunk = ordered[idx : idx + len(part)]
        idx += len(part)
        x0 = min(g["x0"] for g in chunk)
        y0 = min(g["y0"] for g in chunk)
        x1 = max(g["x1"] for g in chunk)
        y1 = max(g["y1"] for g in chunk)
        results.append(
            {
                "t": part,
                "x0": x0,
                "y0": y0,
                "x1": x1,
                "y1": y1,
                "h": chunk[0]["h"],
                "w": x1 - x0,
                "rot": 90.0,
                "cx": (x0 + x1) / 2,
                "cy": (y0 + y1) / 2,
                "is_dim_candidate": True,
            }
        )
    return results


def merge_vertical_digits(texts):
    """Merge stacked digit glyphs into whitelist dimension values only."""
    vertical, other = [], []
    for t in texts:
        if abs(abs(t["rot"]) - 90) < 15 and re.fullmatch(r"\d", t["t"]):
            vertical.append(t)
        else:
            other.append(t)

    # cluster by x
    cols: dict[int, list] = defaultdict(list)
    for t in vertical:
        cols[int(round(t["cx"] / 2.5))].append(t)

    used_ids = set()
    for col in cols.values():
        col.sort(key=lambda t: -t["cy"])  # top → bottom
        i = 0
        while i < len(col):
            if id(col[i]) in used_ids:
                i += 1
                continue
            # collect tight run
            run = [col[i]]
            j = i + 1
            while j < len(col):
                prev, cur = run[-1], col[j]
                gap = prev["cy"] - cur["cy"]
                # digits of one number are ~1×h apart; between numbers usually >> 2×h
                if abs(cur["cx"] - run[0]["cx"]) > 3.5:
                    break
                if gap > prev["h"] * 1.65:
                    break
                if gap <= 0:
                    j += 1
                    continue
                run.append(cur)
                j += 1

            if len(run) >= 2:
                merged = _make_merged(run)
                if merged:
                    for g in run:
                        used_ids.add(id(g))
                    other.extend(merged)
                    i = j
                    continue
            # no merge — keep singles (position marks etc.)
            if id(col[i]) not in used_ids:
                other.append(col[i])
                used_ids.add(id(col[i]))
            i += 1

    for t in vertical:
        if id(t) not in used_ids:
            other.append(t)
    return other


def dedupe_texts(texts, tol=1.2):
    out, seen = [], set()
    for t in texts:
        key = (
            t["t"].strip(),
            round(t["cx"] / tol),
            round(t["cy"] / tol),
            round(t["rot"] / 5) * 5,
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
    # drop garbage long digit strings not in whitelist
    cleaned = []
    for t in out:
        s = t["t"].strip()
        if re.fullmatch(r"\d{6,}", s) and s not in DIM_WHITELIST:
            continue
        cleaned.append(t)
    return cleaned


def is_dim_value(t) -> bool:
    s = t["t"].strip()
    if not re.fullmatch(r"\d{2,5}", s) or s in NOT_DIM:
        return False
    if s in DIM_WHITELIST:
        return True
    return False


def find_dim_line(text, lines, vertical: bool, max_dist: float = 80.0):
    cx, cy = text["cx"], text["cy"]
    best, best_i, best_score = None, -1, 1e18
    for i, L in enumerate(lines):
        dx, dy = L["x1"] - L["x0"], L["y1"] - L["y0"]
        length = math.hypot(dx, dy)
        if length < 8:
            continue
        is_vert = abs(dx) < abs(dy) * 0.25
        is_horz = abs(dy) < abs(dx) * 0.25
        if vertical and not is_vert:
            continue
        if (not vertical) and not is_horz:
            continue
        mx, my = (L["x0"] + L["x1"]) / 2, (L["y0"] + L["y1"]) / 2
        if vertical:
            # dim line near text in X, overlapping in Y
            dist = abs(mx - cx)
            if not (min(L["y0"], L["y1"]) - 15 <= cy <= max(L["y0"], L["y1"]) + 15):
                continue
        else:
            dist = abs(my - cy)
            if not (min(L["x0"], L["x1"]) - 15 <= cx <= max(L["x0"], L["x1"]) + 15):
                continue
        if dist > max_dist or dist >= best_score:
            continue
        # prefer longer lines slightly
        score = dist - min(length, 200) * 0.01
        if score < best_score:
            best_score, best, best_i = score, L, i
    return best, best_i


def synthesize_dim_line(text, vertical: bool):
    """Fallback dim line from text box when PDF line not found."""
    s = text["t"].strip()
    # span heuristic from digit count (pt)
    span = max(text["h"] * max(len(s), 2) * 1.1, 18.0)
    if vertical:
        x = text["cx"] - text["h"] * 1.2
        return {
            "x0": x,
            "y0": text["cy"] - span / 2,
            "x1": x,
            "y1": text["cy"] + span / 2,
        }
    y = text["cy"] + text["h"] * 1.1
    return {
        "x0": text["cx"] - span / 2,
        "y0": y,
        "x1": text["cx"] + span / 2,
        "y1": y,
    }


def poly_len(pts):
    return sum(
        math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
        for i in range(len(pts) - 1)
    )


def text_boxes_mm(texts, pad_pt=2.0):
    boxes = []
    for t in texts:
        th = max(t["h"] * PT_TO_MM, 0.8)
        boxes.append(
            (
                (t["x0"] - pad_pt) * PT_TO_MM,
                (t["y0"] - pad_pt) * PT_TO_MM,
                (t["x1"] + pad_pt) * PT_TO_MM,
                (t["y1"] + pad_pt) * PT_TO_MM,
                th,
            )
        )
    return boxes


def is_glyph_under_text(pts_mm, boxes) -> bool:
    if len(pts_mm) < 2:
        return False
    length = poly_len(pts_mm)
    xs = [p[0] for p in pts_mm]
    ys = [p[1] for p in pts_mm]
    bw, bh = max(xs) - min(xs), max(ys) - min(ys)
    # keep rebar-like squares
    if 1.2 <= bw <= 12 and 1.2 <= bh <= 12 and 0.5 <= (bw / max(bh, 0.01)) <= 2.0:
        if length > 8:
            return False
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
    for x0, y0, x1, y1, th in boxes:
        if not (x0 <= cx <= x1 and y0 <= cy <= y1):
            continue
        # letter-sized debris under text
        if max(bw, bh) <= th * 2.2 and length <= th * 12:
            return True
        if max(bw, bh) <= 8 and length <= 25:
            return True
    return False


def dim_boxes_mm(dim_items, pad=5.0):
    """Tight boxes around dim line + text; PDF ticks/lines inside are removed."""
    boxes = []
    for t, dl, _ in dim_items:
        xs = [dl["x0"], dl["x1"], t["x0"], t["x1"]]
        ys = [dl["y0"], dl["y1"], t["y0"], t["y1"]]
        vertical = abs(dl["x1"] - dl["x0"]) < abs(dl["y1"] - dl["y0"]) * 0.25
        if vertical:
            xs = [min(xs) - pad * 1.8, max(xs) + pad * 1.8]
            ys = [min(ys) - pad * 0.6, max(ys) + pad * 0.6]
        else:
            xs = [min(xs) - pad * 0.6, max(xs) + pad * 0.6]
            ys = [min(ys) - pad * 1.8, max(ys) + pad * 1.8]
        boxes.append(
            (
                min(xs) * PT_TO_MM,
                min(ys) * PT_TO_MM,
                max(xs) * PT_TO_MM,
                max(ys) * PT_TO_MM,
            )
        )
    return boxes


def in_dim_zone(pts_mm, boxes) -> bool:
    if not pts_mm:
        return False
    cx = sum(p[0] for p in pts_mm) / len(pts_mm)
    cy = sum(p[1] for p in pts_mm) / len(pts_mm)
    for x0, y0, x1, y1 in boxes:
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            return True
    return False


def matches_dim_line(pts_mm, dim_items, tol_mm=1.8) -> bool:
    """Drop outline strokes that duplicate a known dimension line."""
    if len(pts_mm) < 2:
        return False
    a, b = pts_mm[0], pts_mm[-1]
    for _t, dl, _ in dim_items:
        p1 = (dl["x0"] * PT_TO_MM, dl["y0"] * PT_TO_MM)
        p2 = (dl["x1"] * PT_TO_MM, dl["y1"] * PT_TO_MM)
        # endpoints near dim line endpoints (either orientation)
        d1 = math.hypot(a[0] - p1[0], a[1] - p1[1]) + math.hypot(b[0] - p2[0], b[1] - p2[1])
        d2 = math.hypot(a[0] - p2[0], a[1] - p2[1]) + math.hypot(b[0] - p1[0], b[1] - p1[1])
        if min(d1, d2) < tol_mm * 2:
            return True
    return False


def import_geometry(msp, text_boxes, dim_boxes, dim_items):
    ensure_outlines()
    src = ezdxf.readfile(OUTLINES)
    n_keep = n_drop_text = n_drop_dim = n_skip = 0
    for e in src.modelspace():
        t = e.dxftype()
        if t == "SPLINE":
            n_drop_text += 1
            continue
        if t == "LWPOLYLINE":
            pts = list(e.get_points("xy"))
            closed = bool(e.closed)
        elif t == "LINE":
            pts = [(e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)]
            closed = False
        else:
            n_skip += 1
            continue
        if len(pts) < 2:
            n_skip += 1
            continue
        scaled = [(p[0] * PT_TO_MM, p[1] * PT_TO_MM) for p in pts]
        if is_glyph_under_text(scaled, text_boxes):
            n_drop_text += 1
            continue
        plen = poly_len(scaled)
        # remove PDF dim strokes: matching dim lines, or short debris in dim boxes
        if matches_dim_line(scaled, dim_items):
            n_drop_dim += 1
            continue
        if in_dim_zone(scaled, dim_boxes) and plen < 90:
            n_drop_dim += 1
            continue
        layer = "GEOMETRY"
        if closed and 3 <= len(scaled) <= 5:
            xs = [p[0] for p in scaled]
            ys = [p[1] for p in scaled]
            if 1.5 <= max(xs) - min(xs) <= 14 and 1.5 <= max(ys) - min(ys) <= 14:
                layer = "REBAR"
        msp.add_lwpolyline(scaled, close=closed, dxfattribs={"layer": layer, "color": COLOR})
        n_keep += 1
    print(f"   geometry keep={n_keep} drop_text={n_drop_text} drop_dim={n_drop_dim} skip={n_skip}")


def add_mtext(msp, t):
    h_mm = max(t["h"] * PT_TO_MM * 0.92, 0.7)
    rot = t["rot"]
    if rot > 180:
        rot -= 360
    if rot < -180:
        rot += 360
    vertical = abs(abs(rot) - 90) < 20
    width = max(t["w"] * PT_TO_MM * 1.1, h_mm * 3)
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
            },
            dxfattribs={"layer": "DIMS", "color": COLOR},
        )
        dim.set_text(s)
        dim.render()
        return True
    except Exception as e:
        print("   dim fail", s, e)
        return False


def build():
    if not FONT.exists():
        raise SystemExit(f"Missing {FONT}")

    print("1) Extract texts/lines")
    raw_texts, lines = extract_texts_and_lines(REF_PDF)
    texts = dedupe_texts(merge_vertical_digits(raw_texts))
    print(f"   texts={len(texts)} lines={len(lines)}")

    print("2) DIMENSION candidates")
    dim_items, regular = [], []
    used_line_idx = set()
    for t in texts:
        if not is_dim_value(t):
            regular.append(t)
            continue
        vertical = abs(abs(t["rot"]) - 90) < 20 or t.get("is_dim_candidate")
        dl, idx = find_dim_line(t, lines, vertical, max_dist=90)
        if dl is None:
            dl = synthesize_dim_line(t, vertical)
            idx = -1
            print(f"   synthesize dim {t['t']} @ ({t['cx']:.0f},{t['cy']:.0f})")
        elif idx in used_line_idx:
            # same line claimed — still ok for parallel dims, keep
            pass
        if idx >= 0:
            used_line_idx.add(idx)
        dim_items.append((t, dl, idx))
    print(f"   dims={len(dim_items)} mtext={len(regular)}")

    doc = setup_doc()
    msp = doc.modelspace()

    # text boxes for glyph filter: all remaining text + dim values
    all_for_boxes = regular + [t for t, _, _ in dim_items]
    print("3) Geometry")
    import_geometry(msp, text_boxes_mm(all_for_boxes), dim_boxes_mm(dim_items), dim_items)

    print("4) DIMENSION objects")
    n_dim = 0
    for t, dl, _ in dim_items:
        if add_dimension(msp, t, dl):
            n_dim += 1
        else:
            add_mtext(msp, t)
    print(f"   DIMENSION={n_dim}")

    print("5) MTEXT (non-dimension only)")
    for t in regular:
        # never emit whitelist dim values as loose MTEXT
        if t["t"].strip() in DIM_WHITELIST and re.fullmatch(r"\d{2,5}", t["t"].strip()):
            # should have been dimension — synthesize
            vertical = abs(abs(t["rot"]) - 90) < 20
            if add_dimension(msp, t, synthesize_dim_line(t, vertical)):
                n_dim += 1
                continue
        add_mtext(msp, t)

    for layer in doc.layers:
        if not layer.dxf.name.startswith("*"):
            layer.dxf.color = COLOR
    for e in msp:
        try:
            e.dxf.color = COLOR
        except Exception:
            pass

    dxf = DRAW / "KP17.dxf"
    doc.saveas(dxf)
    print("6) Saved", Counter(e.dxftype() for e in msp))
    print("   extents", bbox.extents(msp, fast=True))

    # verify no dim-value MTEXT overlay
    dim_vals = {str(d.dxf.text).strip() for d in msp.query("DIMENSION")}
    overlay = [
        mt.text.strip()
        for mt in msp.query("MTEXT")
        if mt.text.strip() in dim_vals and mt.text.strip() in DIM_WHITELIST
    ]
    print(f"   dim-value MTEXT overlays: {Counter(overlay)}")
    print(f"   *D blocks: {sum(1 for b in doc.blocks if b.name.startswith('*D'))}")

    if ODA_BIN.exists():
        inp, outp = Path("/tmp/oda_v5_in"), Path("/tmp/oda_v5_out")
        inp.mkdir(exist_ok=True)
        outp.mkdir(exist_ok=True)
        for f in list(inp.glob("*")) + list(outp.glob("*")):
            f.unlink()
        shutil.copy(dxf, inp / "KP17.dxf")
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
        if (outp / "KP17.dwg").exists():
            shutil.copy(outp / "KP17.dwg", DRAW / "KP17.dwg")
            (DRAW / "fonts").mkdir(exist_ok=True)
            for f in (ROOT / "fonts").glob("*.ttf"):
                shutil.copy(f, DRAW / "fonts" / f.name)
            print("   DWG", (DRAW / "KP17.dwg").stat().st_size)


if __name__ == "__main__":
    build()
