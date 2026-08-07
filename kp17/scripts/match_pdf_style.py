#!/usr/bin/env python3
"""Match KP15/KP17 original drafting style more closely.

- Rebuild main-schema dims by exploding left-эталон DIMENSIONS (+DX)
  with ArchTick (same placement as original sheet).
- Rebuild section 8-8 dims/leaders from original 8-8 layout, with new-schema
  lengths/labels; use ArchTick and MULTILEADER callouts.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

import ezdxf
from ezdxf.addons import Importer
from ezdxf.math import Vec3

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "reference" / "KP17_new_applied.dxf"
REF = ROOT / "reference" / "KP17_new_schema.dxf"
OUT_DXF = ROOT / "reference" / "KP17_new_applied.dxf"
OUT_SHEET = ROOT / "drawings" / "KP17.dxf"
OUT_DWG = ROOT / "drawings" / "KP17.dwg"
OUT_NATIVE = ROOT / "drawings" / "KP17_native.dwg"
ODA = Path("/tmp/squashfs-root/usr/bin/ODAFileConverter")

DX = 24920.28973354732
TOP = -70052.79067665164
BOT = -100002.7906766517
X_L, X_R = 34622.7, 35422.7


def style_name(doc) -> str:
    names = {s.dxf.name for s in doc.styles}
    return "GOST-2.304_Type-B" if "GOST-2.304_Type-B" in names else "Standard"


def clear_band_dim_primitives(msp, x0, x1, y0, y1, keep_texts=()) -> int:
    kill = []
    for e in list(msp.query("LINE")):
        mx = (e.dxf.start.x + e.dxf.end.x) / 2
        my = (e.dxf.start.y + e.dxf.end.y) / 2
        if x0 < mx < x1 and y0 < my < y1:
            kill.append(e)
    for e in list(msp.query("INSERT")):
        if e.dxf.name != "_ArchTick":
            continue
        if x0 < e.dxf.insert.x < x1 and y0 < e.dxf.insert.y < y1:
            kill.append(e)
    for e in list(msp.query("MTEXT")):
        if not (x0 < e.dxf.insert.x < x1 and y0 < e.dxf.insert.y < y1):
            continue
        t = e.text
        if any(k in t for k in keep_texts):
            continue
        plain = re.sub(r"\\[^;]*;", "", t)
        plain = re.sub(r"[{}]", "", plain).replace("\\P", " ").strip()
        if plain in ("8-8",) or plain.startswith("Сторона"):
            continue
        if (
            re.match(r"^(%%C)?\d", plain)
            or plain.startswith("%%C")
            or "поз" in plain
            or "стык" in plain
            or "Р17" in plain
            or plain in ("Ф1", "Ф4", "11", "Б")
            or plain.startswith("Ф")
        ):
            kill.append(e)
    for e in kill:
        try:
            msp.delete_entity(e)
        except Exception:
            pass
    return len(kill)


def explode_dim_block(doc, msp, blk, dx: float = 0.0, dy: float = 0.0, text_override: str | None = None) -> int:
    """Copy dim anonymous-block graphics into modelspace, shifted."""
    n = 0
    for e in blk:
        t = e.dxftype()
        if t == "LINE":
            s, ee = e.dxf.start, e.dxf.end
            msp.add_line(
                (s.x + dx, s.y + dy),
                (ee.x + dx, ee.y + dy),
                dxfattribs={"color": 7, "layer": "0"},
            )
            n += 1
        elif t == "MTEXT":
            txt = text_override if text_override is not None else e.text
            # If override is bare measurement, keep \\A1; prefix when present
            if text_override is not None and e.text.startswith("\\A1;"):
                txt = "\\A1;" + text_override
            msp.add_mtext(
                txt,
                dxfattribs={
                    "insert": (e.dxf.insert.x + dx, e.dxf.insert.y + dy, 0),
                    "char_height": e.dxf.char_height if e.dxf.hasattr("char_height") else 150,
                    "rotation": e.dxf.rotation if e.dxf.hasattr("rotation") else 0,
                    "style": e.dxf.style if e.dxf.hasattr("style") else style_name(doc),
                    "attachment_point": e.dxf.attachment_point if e.dxf.hasattr("attachment_point") else 5,
                    "layer": "0",
                    "color": 7,
                },
            )
            n += 1
        elif t == "INSERT":
            msp.add_blockref(
                e.dxf.name,
                (e.dxf.insert.x + dx, e.dxf.insert.y + dy, 0),
                dxfattribs={
                    "xscale": e.dxf.xscale,
                    "yscale": e.dxf.yscale,
                    "zscale": e.dxf.zscale,
                    "rotation": e.dxf.rotation,
                    "layer": "0",
                    "color": 7,
                },
            )
            n += 1
        elif t == "SOLID":
            vs = []
            for attr in ("vtx0", "vtx1", "vtx2", "vtx3"):
                if e.dxf.hasattr(attr):
                    v = getattr(e.dxf, attr)
                    vs.append((v.x + dx, v.y + dy))
            if len(vs) >= 3:
                msp.add_lwpolyline(vs, close=True, dxfattribs={"color": 7, "layer": "0"})
                n += 1
    return n


def restore_schema_dims(doc, ref) -> None:
    msp = doc.modelspace()
    n = clear_band_dim_primitives(
        msp, 5500, 18000, -102500, -68000, keep_texts=("Схема расположения", "Сторона", "Отм")
    )
    print("cleared crude schema dims", n)

    # Deduplicate schema side labels
    seen = set()
    for e in list(msp.query("MTEXT")):
        if "Сторона" in e.text and 9000 < e.dxf.insert.x < 14000:
            key = (round(e.dxf.insert.x), "g" if "грунт" in e.text else "k")
            if key in seen:
                msp.delete_entity(e)
            else:
                seen.add(key)

    rmsp = ref.modelspace()
    added = 0
    for dim in rmsp.query("DIMENSION"):
        pts = [
            getattr(dim.dxf, a)
            for a in ("defpoint", "defpoint2", "defpoint3")
            if dim.dxf.hasattr(a)
        ]
        if not pts:
            continue
        cx = sum(p.x for p in pts) / len(pts)
        cy = sum(p.y for p in pts) / len(pts)
        if not (-20000 < cx < 0 and -102000 < cy < -68000):
            continue
        gname = dim.dxf.geometry
        if not gname:
            continue
        blk = ref.blocks.get(gname)
        if blk is None:
            continue
        # Measurement text: for %%C<> keep as diameter from measurement
        override = None
        text = dim.dxf.text or ""
        try:
            m = dim.get_measurement()
        except Exception:
            m = None
        if text == "%%C<>" and m is not None:
            override = f"%%C{m:.0f}"
        elif text == "" and m is not None:
            override = f"{m:.0f}"
        elif "<>" in text and m is not None:
            override = text.replace("<>", f"{m:.0f}")
        added += explode_dim_block(doc, msp, blk, dx=DX, dy=0.0, text_override=override)
    print("restored schema dim primitives", added)


def add_vdim_arch(msp, doc, x_dim, y_hi, y_lo, text, tick=100.0) -> None:
    """Vertical dim with ArchTick like original УРСТ style."""
    # extension lines from object toward dim line are omitted (original used short ticks)
    msp.add_line((x_dim - 60, y_hi), (x_dim + 60, y_hi), dxfattribs={"color": 7, "layer": "0"})
    msp.add_line((x_dim - 60, y_lo), (x_dim + 60, y_lo), dxfattribs={"color": 7, "layer": "0"})
    msp.add_line((x_dim, y_hi - 100), (x_dim, y_lo + 100), dxfattribs={"color": 7, "layer": "0"})
    for y in (y_hi, y_lo):
        msp.add_blockref("_ArchTick", (x_dim, y), dxfattribs={"layer": "0", "color": 7})
    mid = (y_hi + y_lo) / 2
    msp.add_mtext(
        f"\\A1;{text}",
        dxfattribs={
            "insert": (x_dim + 80, mid, 0),
            "char_height": 180 if len(text) < 16 else 150,
            "style": style_name(doc),
            "attachment_point": 5,  # middle-center like original
            "layer": "0",
            "color": 7,
            "rotation": 0,
        },
    )


def add_hdim_arch(msp, doc, y_dim, x_l, x_r, text) -> None:
    msp.add_line((x_l, y_dim - 60), (x_l, y_dim + 60), dxfattribs={"color": 7, "layer": "0"})
    msp.add_line((x_r, y_dim - 60), (x_r, y_dim + 60), dxfattribs={"color": 7, "layer": "0"})
    msp.add_line((x_l - 100, y_dim), (x_r + 100, y_dim), dxfattribs={"color": 7, "layer": "0"})
    for x in (x_l, x_r):
        msp.add_blockref("_ArchTick", (x, y_dim), dxfattribs={"layer": "0", "color": 7})
    msp.add_mtext(
        f"\\A1;{text}",
        dxfattribs={
            "insert": ((x_l + x_r) / 2, y_dim - 150, 0),
            "char_height": 180,
            "style": style_name(doc),
            "attachment_point": 2,
            "layer": "0",
            "color": 7,
        },
    )


def restore_section_88(doc, ref) -> None:
    msp = doc.modelspace()
    # Clear our crude 8-8 annotation column + left dims, keep bars/inserts/label/sides
    n = clear_band_dim_primitives(
        msp,
        34000,
        37500,
        -102500,
        -67500,
        keep_texts=("Сторона", "8-8"),
    )
    print("cleared crude 8-8 dims/leaders", n)

    # Also remove leftover DIMENSION 800 if still there
    for e in list(msp.query("DIMENSION")):
        pts = [
            getattr(e.dxf, a)
            for a in ("defpoint", "defpoint2", "defpoint3")
            if e.dxf.hasattr(a)
        ]
        if not pts:
            continue
        cx = sum(p.x for p in pts) / len(pts)
        if 34500 < cx < 37500:
            msp.delete_entity(e)

    # --- Dims matching original 8-8 layout, new schema values ---
    # Right (котлован) chain near x≈36187 / 36699 like original
    x_a = 35790.0
    x_b = 36187.0
    x_c = 36699.0
    x_d = 37020.0

    add_vdim_arch(msp, doc, x_b, TOP, -71152.79, "1100")
    add_vdim_arch(msp, doc, x_a, TOP, -71652.79, "1600 (поз. 2)")
    add_vdim_arch(msp, doc, x_a, -71202.79, -71652.79, "стык 450")
    add_vdim_arch(msp, doc, x_a, -71202.79, -82902.79, "11700 (поз. 4)")
    add_vdim_arch(msp, doc, x_a, -82902.79, -94602.79, "11700 (поз. 4)")
    add_vdim_arch(msp, doc, x_a, -94152.79, -94602.79, "стык 450")
    add_vdim_arch(msp, doc, x_a, -94152.79, BOT, "5850 (поз. 8)")
    add_vdim_arch(msp, doc, x_c, -71152.79, -100552.79, "14х2100=29400 (поз. Р17)")
    add_vdim_arch(msp, doc, x_b, -100552.79, BOT, "450")
    add_hdim_arch(msp, doc, BOT - 286.0, X_L, X_R, "800")

    # Left (грунт) chain
    x_l = 34340.0
    add_vdim_arch(msp, doc, x_l, TOP, -81752.79, "11700 (поз. 1)")
    add_vdim_arch(msp, doc, x_l, -71202.79, -77052.79, "5850 (поз. 3)")
    add_vdim_arch(msp, doc, x_l, -77052.79, -88752.79, "11700 (поз. 5)")
    add_vdim_arch(msp, doc, x_l, -88752.79, -94602.79, "5850 (поз. 6)")
    add_vdim_arch(msp, doc, x_l, -94152.79, BOT, "5850 (поз. 7)")

    # Import original MULTILEADER callouts (Ф1/Ф4/11/Б) for 8-8
    want = []
    for e in ref.modelspace().query("MULTILEADER"):
        ctx = getattr(e, "context", None)
        if not (ctx and getattr(ctx, "mtext", None)):
            continue
        try:
            ix, iy = ctx.mtext.insert.x, ctx.mtext.insert.y
        except Exception:
            continue
        txt = ctx.mtext.default_content or ""
        if 35600 < ix < 36000 and -102000 < iy < -68000:
            if any(k in txt for k in ("Ф1", "Ф4", "11", "Б")):
                want.append(e)
    print("importing 8-8 mleaders", len(want))
    if want:
        # Avoid duplicate import: skip if similar mleader already exists
        existing = 0
        for e in msp.query("MULTILEADER"):
            ctx = getattr(e, "context", None)
            if not (ctx and getattr(ctx, "mtext", None)):
                continue
            try:
                ix, iy = ctx.mtext.insert.x, ctx.mtext.insert.y
            except Exception:
                continue
            if 35600 < ix < 36000 and -102000 < iy < -68000:
                existing += 1
        if existing < len(want):
            # remove existing first to avoid duplicates
            for e in list(msp.query("MULTILEADER")):
                ctx = getattr(e, "context", None)
                if not (ctx and getattr(ctx, "mtext", None)):
                    continue
                try:
                    ix, iy = ctx.mtext.insert.x, ctx.mtext.insert.y
                except Exception:
                    continue
                if 35600 < ix < 36000 and -102000 < iy < -68000:
                    msp.delete_entity(e)
            importer = Importer(ref, doc)
            importer.import_entities(want, msp)
            importer.finalize()
            print("imported", len(want))
        else:
            print("mleaders already present", existing)

    # Ensure side labels
    has = {"g": False, "k": False}
    for e in msp.query("MTEXT"):
        if 33000 < e.dxf.insert.x < 36000 and "Сторона" in e.text:
            if "грунт" in e.text:
                has["g"] = True
            if "котлован" in e.text:
                has["k"] = True
    st = style_name(doc)
    if not has["g"]:
        msp.add_mtext(
            "\\pxqc;Сторона\\Pгрунта",
            dxfattribs={
                "insert": (33407.17, -69528.09, 0),
                "char_height": 200,
                "style": st,
                "attachment_point": 5,
                "layer": "0",
            },
        )
    if not has["k"]:
        msp.add_mtext(
            "\\pxqc;Сторона\\Pкотлована",
            dxfattribs={
                "insert": (35578.85, -69528.09, 0),
                "char_height": 200,
                "style": st,
                "attachment_point": 5,
                "layer": "0",
            },
        )
    print("8-8 restored")


def to_dwg() -> None:
    # Ensure X display
    if not os.environ.get("DISPLAY"):
        os.environ["DISPLAY"] = ":99"
    os.environ.setdefault("QT_QPA_PLATFORM", "xcb")
    os.environ["LD_LIBRARY_PATH"] = str(ODA.parent)
    inp, outp = Path("/tmp/oda_style_in"), Path("/tmp/oda_style_out")
    inp.mkdir(exist_ok=True)
    outp.mkdir(exist_ok=True)
    for f in list(inp.glob("*")) + list(outp.glob("*")):
        f.unlink()
    shutil.copy(OUT_DXF, inp / "KP17.dxf")
    subprocess.run(
        [str(ODA), str(inp), str(outp), "ACAD2018", "DWG", "0", "1", "*.DXF"],
        check=False,
        capture_output=True,
        timeout=90,
    )
    produced = outp / "KP17.dwg"
    if not produced.exists():
        raise SystemExit("ODA failed")
    shutil.copy(produced, OUT_DWG)
    shutil.copy(produced, OUT_NATIVE)
    print("DWG", OUT_DWG, produced.stat().st_size)


def main() -> None:
    doc = ezdxf.readfile(SRC)
    ref = ezdxf.readfile(REF)
    restore_schema_dims(doc, ref)
    restore_section_88(doc, ref)
    doc.saveas(OUT_DXF)
    shutil.copy(OUT_DXF, OUT_SHEET)
    to_dwg()
    with zipfile.ZipFile(ROOT / "drawings" / "KP17.zip", "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(OUT_DWG, "KP17.dwg")
        zf.write(OUT_SHEET, "KP17.dxf")
    # quick verify
    msp = doc.modelspace()
    ticks = sum(
        1
        for e in msp.query("INSERT")
        if e.dxf.name == "_ArchTick" and 6000 < e.dxf.insert.x < 18000
    )
    ticks88 = sum(
        1
        for e in msp.query("INSERT")
        if e.dxf.name == "_ArchTick" and 34000 < e.dxf.insert.x < 37500
    )
    print("ArchTicks schema", ticks, "8-8", ticks88)
    print("done")


if __name__ == "__main__":
    main()
