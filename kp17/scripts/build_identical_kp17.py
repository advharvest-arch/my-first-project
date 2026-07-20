#!/usr/bin/env python3
"""КП17: визуально = PDF, объекты = AutoCAD (MTEXT/GOST, DIMENSION, LINE/RECTANG, TABLE).

Пайплайн:
  1) Геометрия листа из PDF (Inkscape outlines → только линии/полилинии, без контуров букв)
  2) Весь текст PDF → MTEXT шрифтом GOSTCommon (как в PDF), точные координаты
  3) Числовые размеры → DIMENSION (LINEAR, засечки)
  4) Спецификации → блоки-таблицы в координатах PDF
  5) Цвет 7 (монохром)
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
from ezdxf.addons.tablepainter import TablePainter
from ezdxf.math import Matrix44, Vec3
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTChar, LTCurve, LTFigure, LTLine, LTRect, LTTextBox, LTTextLine

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from kp17.data import kp17_data as D  # noqa: E402

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


def ensure_outlines() -> Path:
    if OUTLINES.exists() and OUTLINES.stat().st_size > 1_000_000:
        return OUTLINES
    svg = Path("/tmp/kp17.svg")
    if not svg.exists():
        subprocess.run(
            ["pdftocairo", "-svg", str(REF_PDF), "/tmp/kp17"],
            check=True,
        )
    subprocess.run(
        [
            "inkscape",
            str(svg if svg.exists() else Path("/tmp/kp17.svg")),
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
    for name in (
        "GEOMETRY",
        "GEOMETRY_THIN",
        "GEOMETRY_THICK",
        "TEXT",
        "DIMS",
        "TABLE",
        "TABLE_GRID",
        "REBAR",
        "FRAME",
    ):
        doc.layers.add(name, color=COLOR)

    font = "GOSTCommon.ttf"
    for sn in ("GOST", "GOSTCommon", "Standard"):
        if sn in doc.styles:
            doc.styles.get(sn).dxf.font = font
        else:
            doc.styles.new(sn, dxfattribs={"font": font})

    if "KP17" not in doc.dimstyles:
        doc.dimstyles.new("KP17")
    ds = doc.dimstyles.get("KP17")
    ds.dxf.dimtxsty = "GOST"
    ds.dxf.dimtxt = 1.8
    ds.dxf.dimclrd = COLOR
    ds.dxf.dimclre = COLOR
    ds.dxf.dimclrt = COLOR
    ds.dxf.dimexe = 0.8
    ds.dxf.dimexo = 0.5
    ds.dxf.dimasz = 0.01
    ds.dxf.dimtsz = 1.0  # засечки как на стройчертежах
    ds.dxf.dimtad = 1
    ds.dxf.dimtofl = 1
    ds.dxf.dimgap = 0.4
    return doc


def pt(x, y):
    return (x * PT_TO_MM, y * PT_TO_MM)


def import_pdf_geometry(doc, msp):
    """Геометрия PDF без контуров букв (splines) — визуальная основа."""
    src_path = ensure_outlines()
    print(f"  outlines: {src_path}")
    src = ezdxf.readfile(src_path)
    n_poly = n_skip = 0
    for e in src.modelspace():
        if e.dxftype() != "LWPOLYLINE":
            # SPLINE = в основном глифы текста — пропускаем (текст будет MTEXT)
            n_skip += 1
            continue
        pts = list(e.get_points("xy"))
        if len(pts) < 2:
            n_skip += 1
            continue
        scaled = [(p[0] * PT_TO_MM, p[1] * PT_TO_MM) for p in pts]
        # короткие 4-угльники → как RECTANG на слой REBAR/FRAME
        layer = "GEOMETRY"
        if e.closed and len(pts) <= 5:
            xs = [p[0] for p in scaled]
            ys = [p[1] for p in scaled]
            w, h = max(xs) - min(xs), max(ys) - min(ys)
            if w > 5 and h > 5:
                layer = "REBAR"
        msp.add_lwpolyline(
            scaled,
            close=bool(e.closed),
            dxfattribs={"layer": layer, "color": COLOR},
        )
        n_poly += 1
    print(f"  geometry polylines={n_poly} skipped={n_skip}")
    return n_poly


def extract_texts(pdf: Path):
    texts = []
    for page in extract_pages(str(pdf)):
        def walk(obj):
            if isinstance(obj, LTTextLine):
                t = obj.get_text().replace("\n", " ").strip()
                if not t:
                    return
                chars = [c for c in obj if isinstance(c, LTChar)]
                rot = 0.0
                font = "GOSTCommon"
                if chars:
                    a, b = chars[0].matrix[0], chars[0].matrix[1]
                    rot = math.degrees(math.atan2(b, a))
                    font = getattr(chars[0], "fontname", font) or font
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
                        "font": font,
                    }
                )
            elif isinstance(obj, LTTextBox):
                for ch in obj:
                    walk(ch)
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
    return texts


def extract_lines(pdf: Path):
    lines = []
    for page in extract_pages(str(pdf)):
        def walk(obj):
            if isinstance(obj, LTLine):
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
    return lines


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
            x0, y0 = min(g["x0"] for g in group), min(g["y0"] for g in group)
            x1, y1 = max(g["x1"] for g in group), max(g["y1"] for g in group)
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
                    "font": "GOSTCommon",
                    "is_dim_candidate": True,
                }
            )
        else:
            other.append(t)
    return other


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
        if vertical and not (min(L["y0"], L["y1"]) - 8 <= cy <= max(L["y0"], L["y1"]) + 8):
            continue
        if (not vertical) and not (min(L["x0"], L["x1"]) - 8 <= cx <= max(L["x0"], L["x1"]) + 8):
            continue
        best_score = dist
        best = L
    return best


def add_mtext(msp, t):
    s = t["t"]
    h_mm = max(t["h"] * PT_TO_MM * 0.92, 0.7)
    rot = t["rot"]
    if rot > 180:
        rot -= 360
    if rot < -180:
        rot += 360
    vertical = abs(abs(rot) - 90) < 20
    width = max(t["w"] * PT_TO_MM * (1.2 if not vertical else 0.5), h_mm * 2)

    # многострочность: длинные примечания
    content = s
    mt = msp.add_mtext(
        content,
        dxfattribs={
            "layer": "TEXT",
            "style": "GOST",
            "char_height": h_mm,
            "width": width if not vertical else h_mm * 4,
            "color": COLOR,
            "rotation": 90 if vertical else (rot if abs(rot) > 5 else 0),
            "attachment_point": 5 if vertical else 7,  # middle-center / bottom-left
        },
    )
    if vertical:
        mt.set_location(pt(t["cx"], t["cy"]))
    else:
        mt.set_location(pt(t["x0"], t["y0"]))
    return mt


def try_dimension(msp, t, lines) -> bool:
    s = t["t"].strip()
    if not re.fullmatch(r"\d{2,5}", s):
        return False
    if s in NOT_DIM:
        return False
    if s not in DIM_WHITELIST and len(s) < 3:
        return False
    vertical = abs(abs(t["rot"]) - 90) < 20 or t.get("is_dim_candidate")
    L = find_dim_line(t, lines, vertical=vertical)
    if L is None:
        return False
    h_mm = max(t["h"] * PT_TO_MM * 0.9, 1.0)
    p1, p2 = pt(L["x0"], L["y0"]), pt(L["x1"], L["y1"])
    try:
        if vertical:
            dim = msp.add_linear_dim(
                base=pt(t["cx"], (L["y0"] + L["y1"]) / 2),
                p1=p1,
                p2=p2,
                angle=90,
                dimstyle="KP17",
                override={
                    "dimtxsty": "GOST",
                    "dimtxt": h_mm,
                    "dimclrd": COLOR,
                    "dimclre": COLOR,
                    "dimclrt": COLOR,
                    "dimtsz": max(h_mm * 0.4, 0.6),
                    "dimasz": 0.01,
                    "dimse1": 1,
                    "dimse2": 1,
                    "dimsd1": 1,
                    "dimsd2": 1,
                },
                dxfattribs={"layer": "DIMS", "color": COLOR},
            )
        else:
            dim = msp.add_linear_dim(
                base=pt((L["x0"] + L["x1"]) / 2, t["cy"]),
                p1=p1,
                p2=p2,
                angle=0,
                dimstyle="KP17",
                override={
                    "dimtxsty": "GOST",
                    "dimtxt": h_mm,
                    "dimclrd": COLOR,
                    "dimclre": COLOR,
                    "dimclrt": COLOR,
                    "dimtsz": max(h_mm * 0.4, 0.6),
                    "dimasz": 0.01,
                    "dimse1": 1,
                    "dimse2": 1,
                    "dimsd1": 1,
                    "dimsd2": 1,
                },
                dxfattribs={"layer": "DIMS", "color": COLOR},
            )
        dim.set_text(s)
        dim.render()
        return True
    except Exception:
        return False


def add_texts_and_dims(msp, texts, lines):
    n_mt = n_dim = 0
    for t in texts:
        s = t["t"].strip()
        vertical = abs(abs(t["rot"]) - 90) < 20 or t.get("is_dim_candidate")
        is_dim = (
            re.fullmatch(r"\d{2,5}", s)
            and s not in NOT_DIM
            and (s in DIM_WHITELIST or len(s) >= 3)
            and (t.get("is_dim_candidate") or vertical or len(s) >= 3)
        )
        if is_dim and try_dimension(msp, t, lines):
            n_dim += 1
        else:
            add_mtext(msp, t)
            n_mt += 1
    return n_mt, n_dim


def add_spec_tables(msp, doc):
    """Таблицы в координатах PDF (мм)."""
    # PDF points → mm: x_mm = x_pt * PT_TO_MM
    def P(x, y):
        return (x * PT_TO_MM, y * PT_TO_MM)

    # --- Спецификация каркаса ---
    rows = [["Поз.", "Наименование", "Кол.", "Масса ед.", "Масса"]]
    for b in D.WORKING_BARS:
        mu, mt = D.BAR_MASS[b["pos"]]
        rows.append(
            [
                str(b["pos"]),
                f"Пруток {b['d']}x{b['L']}-{b['grade']} ГОСТ 34028-2016",
                str(b["qty"]),
                f"{mu:.2f}",
                f"{mt:.2f}",
            ]
        )
    for d_ in D.DETAILS:
        rows.append(
            [
                str(d_["pos"]),
                f"Пруток {d_['d']}x{d_['L']}-{d_['grade']}",
                str(d_["qty"]),
                f"{d_['mass_unit']:.2f}",
                f"{d_['mass_total']:.2f}",
            ]
        )
    for e in D.EMBEDDED:
        rows.append([e["pos"], e["name"], str(e["qty"]), f"{e['mass_unit']:.2f}", f"{e['mass_total']:.2f}"])
    rows.append(["", "Итого", "", "", f"{D.TITLE['mass']:.2f}"])

    def make_table(block, rows, col_w, row_h=3.2):
        if block in doc.blocks:
            try:
                doc.blocks.delete_block(block, safe=False)
            except Exception:
                pass
        blk = doc.blocks.new(block)
        tp = TablePainter(
            insert=(0, len(rows) * row_h),
            nrows=len(rows),
            ncols=len(col_w),
            cell_width=20,
            cell_height=row_h,
        )
        for i, w in enumerate(col_w):
            tp.set_col_width(i, w)
        tp.new_cell_style("default", text_style="GOST", char_height=1.35, text_color=COLOR)
        for r, row in enumerate(rows):
            for c, val in enumerate(row):
                tp.text_cell(r, c, val)
        tp.grid_layer_name = "TABLE_GRID"
        tp.fg_layer_name = "TABLE"
        tp.render(blk)
        return len(rows) * row_h

    # позиция заголовка спецификации ~ (2881,2270) pt
    h1 = make_table("TABLE_SPEC_KP17", rows, [10, 85, 12, 16, 16])
    x, y = P(2881, 2270 - h1 / PT_TO_MM)
    # insert at bottom-left of table area under title
    msp.add_blockref("TABLE_SPEC_KP17", P(2881, 1600), dxfattribs={"layer": "TABLE", "color": COLOR})

    # расход стали
    sc = D.STEEL_CONSUMPTION
    steel = [
        ["Марка", "А240", "Ø12", "Ø22", "Ø25", "Ø32", "Ø36", "Итого", "Всего"],
        [
            "КП17",
            f"{sc['A240_d25']:.1f}",
            f"{sc['A500C']['12']:.0f}",
            f"{sc['A500C']['22']:.0f}",
            f"{sc['A500C']['25']:.0f}",
            f"{sc['A500C']['32']:.0f}",
            f"{sc['A500C']['36']:.0f}",
            f"{sc['A500C']['total']:.0f}",
            f"{sc['grand_total']:.2f}",
        ],
    ]
    make_table("TABLE_STEEL_KP17", steel, [12, 14, 14, 14, 14, 14, 14, 14, 16], row_h=4)
    msp.add_blockref("TABLE_STEEL_KP17", P(2888, 1180), dxfattribs={"layer": "TABLE", "color": COLOR})

    welds = [["№", "Стандарт", "Обозначение"]] + [
        [str(w["n"]), w["std"], w["symbol"]] for w in D.WELDS
    ]
    make_table("TABLE_WELDS_KP17", welds, [8, 40, 28], row_h=4)
    msp.add_blockref("TABLE_WELDS_KP17", P(3059, 920), dxfattribs={"layer": "TABLE", "color": COLOR})


def force_black(doc, msp):
    for layer in doc.layers:
        if not layer.dxf.name.startswith("*"):
            layer.dxf.color = COLOR
    for e in msp:
        try:
            e.dxf.color = COLOR
        except Exception:
            pass


def dxf_to_dwg(dxf: Path, dwg: Path) -> bool:
    if not ODA_BIN.exists():
        return False
    inp, outp = Path("/tmp/oda_id_in"), Path("/tmp/oda_id_out")
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
    produced = outp / (dxf.stem + ".dwg")
    if produced.exists():
        shutil.copy(produced, dwg)
        fout = dwg.parent / "fonts"
        fout.mkdir(exist_ok=True)
        for f in (ROOT / "fonts").glob("*.ttf"):
            shutil.copy(f, fout / f.name)
        print(f"DWG {dwg} ({dwg.stat().st_size} bytes)")
        return True
    err = outp / (dxf.stem + ".dwg.err")
    if err.exists():
        print(err.read_text()[:500])
    return False


def build():
    if not FONT.exists():
        raise SystemExit(f"Missing font {FONT}")
    print("1) Setup")
    doc = setup_doc()
    msp = doc.modelspace()

    print("2) PDF geometry (no glyph outlines)")
    import_pdf_geometry(doc, msp)

    print("3) PDF texts → MTEXT/DIMENSION")
    texts = merge_vertical_digits(extract_texts(REF_PDF))
    lines = extract_lines(REF_PDF)
    n_mt, n_dim = add_texts_and_dims(msp, texts, lines)
    print(f"   MTEXT={n_mt} DIMENSION={n_dim}")

    print("4) Tables at PDF positions")
    # Таблицы уже есть в геометрии PDF + MTEXT ячеек (визуал = PDF).
    # Отдельные INSERT TABLE_* дают наложение — не добавляем их в лист.
    # Для правки спецификации используйте MTEXT в правой части листа
    # или python3 -m kp17.scripts.build_native_kp17 (схемный лист).
    print("   (table grid+text from PDF geometry/MTEXT — visual match)")

    force_black(doc, msp)
    dxf = DRAW / "KP17.dxf"
    doc.saveas(dxf)
    from collections import Counter

    print(f"5) Saved {dxf}")
    print("   entities:", Counter(e.dxftype() for e in msp))
    print("   extents:", bbox.extents(msp, fast=True))
    dxf_to_dwg(dxf, DRAW / "KP17.dwg")
    return dxf


if __name__ == "__main__":
    build()
