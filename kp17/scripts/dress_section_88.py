#!/usr/bin/env python3
"""Dress section 8-8 like KP15/KP17 original: dims + leaders; pull schema dims closer."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path

import ezdxf

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "reference" / "KP17_new_applied.dxf"
OUT_DXF = ROOT / "reference" / "KP17_new_applied.dxf"
OUT_SHEET = ROOT / "drawings" / "KP17.dxf"
OUT_DWG = ROOT / "drawings" / "KP17.dwg"
OUT_NATIVE = ROOT / "drawings" / "KP17_native.dwg"
ODA = Path("/tmp/squashfs-root/usr/bin/ODAFileConverter")

TOP = -70052.79067665164
BOT = -100002.7906766517
# 8-8 profile
CX = 35022.7
X_G = 34715.0  # грунт bars
X_K = 35330.0  # котлован bars
HALF = 400.0  # 800 width / 2
X_L = CX - HALF  # 34622.7
X_R = CX + HALF  # 35422.7

STYLE = "GOST-2.304_Type-B"


def style_name(doc) -> str:
    names = {s.dxf.name for s in doc.styles}
    return STYLE if STYLE in names else "Standard"


def add_vdim(
    msp,
    x_dim: float,
    y_hi: float,
    y_lo: float,
    text: str,
    style: str,
    tick: float = 70.0,
    text_side: str = "right",
) -> None:
    msp.add_line((x_dim - tick, y_hi), (x_dim + tick, y_hi), dxfattribs={"color": 7, "layer": "0"})
    msp.add_line((x_dim - tick, y_lo), (x_dim + tick, y_lo), dxfattribs={"color": 7, "layer": "0"})
    msp.add_line((x_dim, y_hi), (x_dim, y_lo), dxfattribs={"color": 7, "layer": "0"})
    for y in (y_hi, y_lo):
        msp.add_line((x_dim - 35, y - 35), (x_dim + 35, y + 35), dxfattribs={"color": 7, "layer": "0"})
    mid = (y_hi + y_lo) / 2.0
    if text_side == "left":
        tx, attach = x_dim - 90, 6  # middle-right
    else:
        tx, attach = x_dim + 90, 4  # middle-left
    msp.add_mtext(
        text,
        dxfattribs={
            "insert": (tx, mid, 0),
            "char_height": 160 if len(text) < 12 else 140,
            "style": style,
            "layer": "0",
            "color": 7,
            "attachment_point": attach,
        },
    )


def add_hdim(msp, y_dim: float, x_l: float, x_r: float, text: str, style: str, tick: float = 70.0) -> None:
    msp.add_line((x_l, y_dim - tick), (x_l, y_dim + tick), dxfattribs={"color": 7, "layer": "0"})
    msp.add_line((x_r, y_dim - tick), (x_r, y_dim + tick), dxfattribs={"color": 7, "layer": "0"})
    msp.add_line((x_l, y_dim), (x_r, y_dim), dxfattribs={"color": 7, "layer": "0"})
    for x in (x_l, x_r):
        msp.add_line((x - 35, y_dim - 35), (x + 35, y_dim + 35), dxfattribs={"color": 7, "layer": "0"})
    mid = (x_l + x_r) / 2.0
    msp.add_mtext(
        text,
        dxfattribs={
            "insert": (mid, y_dim - 120, 0),
            "char_height": 180,
            "style": style,
            "layer": "0",
            "color": 7,
            "attachment_point": 2,  # middle-center
        },
    )


def add_leader(msp, x0: float, y: float, x1: float, text: str, style: str, h: float = 150.0) -> None:
    """Short horizontal leader from object to callout text."""
    msp.add_line((x0, y), (x1, y), dxfattribs={"color": 7, "layer": "0"})
    msp.add_mtext(
        text,
        dxfattribs={
            "insert": (x1 + 40, y, 0),
            "char_height": h,
            "style": style,
            "layer": "0",
            "color": 7,
            "attachment_point": 4,
        },
    )


def clear_old_88_dims(msp) -> int:
    """Remove previous primitive dims we may have added / orphan 800 DIMENSION."""
    kill = []
    for e in msp.query("DIMENSION"):
        pts = [
            getattr(e.dxf, a)
            for a in ("defpoint", "defpoint2", "defpoint3")
            if e.dxf.hasattr(a)
        ]
        if not pts:
            continue
        cx = sum(p.x for p in pts) / len(pts)
        cy = sum(p.y for p in pts) / len(pts)
        if 34500 < cx < 37500 and -102500 < cy < -68000:
            kill.append(e)

    # Remove our previous simple frame lines and any dim primitives in the
    # annotation column to the right of 8-8 (x>35450), but keep Ф MTEXT for now
    # (will rebuild leaders).
    for e in list(msp.query("LINE")):
        mx = (e.dxf.start.x + e.dxf.end.x) / 2
        my = (e.dxf.start.y + e.dxf.end.y) / 2
        if 35450 < mx < 37500 and -102500 < my < -68000:
            kill.append(e)
        # old simple frame at ±400
        if abs(mx - X_L) < 2 or abs(mx - X_R) < 2:
            if abs(e.dxf.start.y - e.dxf.end.y) > 20000:
                kill.append(e)
        if abs(my - TOP) < 2 or abs(my - BOT) < 2:
            if 34600 < mx < 35450 and abs(e.dxf.start.x - e.dxf.end.x) > 700:
                kill.append(e)

    for e in list(msp.query("MTEXT")):
        x, y = e.dxf.insert.x, e.dxf.insert.y
        if not (35450 < x < 37500 and -102500 < y < -68000):
            continue
        t = e.text.strip()
        if "Сторона" in t or t == "8-8":
            continue
        # rebuild callouts and dim texts
        if t in ("Ф1", "Ф4", "11", "Б") or t.startswith("Ф"):
            kill.append(e)
        elif re.match(r"^(\d+|<>|стык|14х)", t) or "поз" in t or "Р17" in t:
            kill.append(e)
        elif t.replace("%%C", "").isdigit() or t.startswith("%%C"):
            kill.append(e)

    for e in kill:
        try:
            msp.delete_entity(e)
        except Exception:
            pass
    return len(kill)


def dress_section_88(doc) -> None:
    msp = doc.modelspace()
    st = style_name(doc)
    n = clear_old_88_dims(msp)
    print("cleared old 8-8 dim clutter", n)

    # Ensure side labels
    has_g = any(
        "грунт" in e.text and e.dxf.insert.x < CX
        for e in msp.query("MTEXT")
        if 34000 < e.dxf.insert.x < 36000
    )
    has_k = any(
        "котлован" in e.text and e.dxf.insert.x > CX
        for e in msp.query("MTEXT")
        if 34000 < e.dxf.insert.x < 36000
    )
    if not has_g:
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
        print("added Сторона грунта")
    if not has_k:
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
        print("added Сторона котлована")

    # --- Dimensions (like original KP17 8-8, new schema lengths) ---
    # Chain on котлован side (right), x_dim just outside profile
    x1 = X_R + 280  # ~35700
    x2 = X_R + 700  # ~36120
    x3 = X_R + 1100  # ~36520
    x4 = X_R + 1550  # ~36970

    # Top offset 1100 (as in original)
    add_vdim(msp, x2, TOP, -71152.79067665164, "1100", st)

    # Котлован bar lengths (new schema)
    add_vdim(msp, x1, TOP, -71652.79067665164, "1600 (поз. 2)", st)
    add_vdim(msp, x1, -71202.79067665164, -71652.79067665164, "стык 450", st)
    add_vdim(msp, x1, -71202.79067665164, -82902.79067665164, "11700 (поз. 4)", st)
    add_vdim(msp, x1, -82902.79067665164, -94602.79067665164, "11700 (поз. 4)", st)
    add_vdim(msp, x1, -94152.79067665164, -94602.79067665164, "стык 450", st)
    add_vdim(msp, x1, -94152.79067665164, BOT, "5850 (поз. 8)", st)

    # Overall cage height mark + bottom 450 (frame)
    add_vdim(msp, x3, -71152.79067665164, -100552.7906766517, "14х2100=29400 (поз. Р17)", st)
    add_vdim(msp, x2, -100552.7906766517, BOT, "450", st)

    # Width 800 under the section
    add_hdim(msp, BOT - 286.0, X_L, X_R, "800", st)

    # Грунт side lengths (left of profile)
    xl = X_L - 280
    add_vdim(msp, xl, TOP, -81752.79067665164, "11700 (поз. 1)", st, text_side="left")
    add_vdim(msp, xl, -71202.79067665164, -77052.79067665164, "5850 (поз. 3)", st, text_side="left")
    add_vdim(msp, xl, -77052.79067665164, -88752.79067665164, "11700 (поз. 5)", st, text_side="left")
    add_vdim(msp, xl, -88752.79067665164, -94602.79067665164, "5850 (поз. 6)", st, text_side="left")
    add_vdim(msp, xl, -94152.79067665164, BOT, "5850 (поз. 7)", st, text_side="left")

    # --- Leaders / callouts (Ф1, Ф4, 11, Б) with lines to profile ---
    # Positions from original
    callouts = [
        (-71231.22, "Ф1"),
        (-73331.22, "Ф1"),
        (-75283.67, "Ф1"),
        (-77161.88, "Ф4"),
        (-78083.61, "11"),
        (-79631.22, "Ф4"),
        (-81731.22, "Ф4"),
        (-83831.22, "Ф4"),
        (-85931.22, "Ф4"),
        (-88031.22, "Ф4"),
        (-90131.22, "Ф4"),
        (-92231.22, "Ф4"),
        (-94331.22, "Ф1"),
        (-96431.22, "Ф1"),
        (-98531.22, "Ф1"),
        (-100631.22, "Ф1"),
    ]
    for y, txt in callouts:
        add_leader(msp, X_R, y, X_R + 220, txt, st, h=150)

    # Detail Б near top
    add_leader(msp, X_R, -69324.18, X_R + 180, "Б", st, h=200)

    print("dressed section 8-8 with dims + leaders")


def resnap_schema_dims(doc) -> None:
    """Move main-schema length/diam texts closer to bars; shorten dim-line offset."""
    msp = doc.modelspace()
    st = style_name(doc)

    bars = []
    for e in msp.query("LWPOLYLINE"):
        pts = list(e.get_points("xy"))
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        mx = sum(xs) / len(xs)
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        if 7000 < mx < 17000 and -102000 < min(ys) < -68000 and 15 < w < 50 and h > 500:
            bars.append({"x": mx, "ymin": min(ys), "ymax": max(ys), "h": h, "d": w})

    # Delete previous rebuilt schema dim primitives in main band and redraw closer
    kill = []
    for e in msp.query("LINE"):
        mx = (e.dxf.start.x + e.dxf.end.x) / 2
        my = (e.dxf.start.y + e.dxf.end.y) / 2
        if 5500 < mx < 18000 and -102500 < my < -68000:
            kill.append(e)
    for e in msp.query("MTEXT"):
        x, y = e.dxf.insert.x, e.dxf.insert.y
        if not (5500 < x < 18000 and -102500 < y < -68000):
            continue
        if "Схема расположения" in e.text:
            continue
        plain = e.text.replace("\\A1;", "").strip()
        if (
            re.match(r"^(%%C)?\d", plain)
            or plain.startswith("%%C")
            or re.fullmatch(r"\d+", plain)
        ):
            kill.append(e)
    for e in kill:
        try:
            msp.delete_entity(e)
        except Exception:
            pass
    print("cleared main schema dim primitives", len(kill))

    def vdim(x_dim, y_hi, y_lo, text, side="right"):
        add_vdim(msp, x_dim, y_hi, y_lo, text, st, tick=60, text_side=side)

    def diam(x_bar, y, d, left=False):
        tx = x_bar - 120 if left else x_bar + 60
        msp.add_mtext(
            f"%%C{d:.0f}",
            dxfattribs={
                "insert": (tx, y, 0),
                "char_height": 140,
                "style": st,
                "layer": "0",
                "color": 7,
                "attachment_point": 4 if not left else 6,
            },
        )

    # Group by column
    cols: dict[float, list] = {}
    for b in bars:
        key = round(b["x"] / 40) * 40
        cols.setdefault(key, []).append(b)

    for key, col in sorted(cols.items()):
        col = sorted(col, key=lambda b: -b["ymax"])
        x_bar = col[0]["x"]
        left = x_bar < 12000
        # dim line close to bar: ~320 mm offset
        x_dim = x_bar - 320 if left else x_bar + 320
        for b in col:
            vdim(x_dim, b["ymax"], b["ymin"], f"{b['h']:.0f}", side="left" if left else "right")
            diam(x_bar, (b["ymax"] + b["ymin"]) / 2, b["d"], left=left)

    # Overall / offsets — keep near the schema, not floating far away
    vdim(7550, TOP, BOT, "29950", side="left")
    vdim(10450, TOP, -71202.79067665164, "1150", side="right")
    vdim(12350, TOP, -71202.79067665164, "1150", side="left")
    vdim(12950, -71202.79067665164, -71652.79067665164, "450", side="left")
    vdim(10350, -94152.79067665164, -94602.79067665164, "450", side="right")
    vdim(13650, -94152.79067665164, -94602.79067665164, "450", side="right")
    vdim(15480, TOP, -79802.79067665164, "9750", side="right")
    vdim(15480, -91502.79067665164, BOT, "8500", side="right")
    vdim(7800, -81752.79067665164, BOT, "18250", side="left")
    print("resnapped main schema dims close to bars")


def to_dwg(dxf: Path, dwg: Path) -> None:
    inp, outp = Path("/tmp/oda_88d_in"), Path("/tmp/oda_88d_out")
    inp.mkdir(exist_ok=True)
    outp.mkdir(exist_ok=True)
    for f in list(inp.glob("*")) + list(outp.glob("*")):
        f.unlink()
    shutil.copy(dxf, inp / "KP17.dxf")
    env = {**os.environ, "LD_LIBRARY_PATH": str(ODA.parent)}
    subprocess.run(
        [str(ODA), str(inp), str(outp), "ACAD2018", "DWG", "0", "1", "*.DXF"],
        check=False,
        env=env,
        capture_output=True,
    )
    produced = outp / "KP17.dwg"
    if not produced.exists():
        raise SystemExit("ODA failed")
    shutil.copy(produced, dwg)
    shutil.copy(produced, OUT_NATIVE)
    print("DWG", dwg, produced.stat().st_size)


def verify(doc) -> None:
    msp = doc.modelspace()
    texts_88 = [
        e.text[:40]
        for e in msp.query("MTEXT")
        if 34500 < e.dxf.insert.x < 37500 and -102500 < e.dxf.insert.y < -68000
    ]
    print("8-8 texts sample:", texts_88[:12], "... total", len(texts_88))
    has_800 = any(e.text.strip() == "800" for e in msp.query("MTEXT"))
    has_f = sum(1 for e in msp.query("MTEXT") if e.text.strip() in ("Ф1", "Ф4", "11", "Б"))
    print(f"800 label={has_800} F/11/B callouts={has_f}")
    # schema dim proximity
    bars = []
    for e in msp.query("LWPOLYLINE"):
        pts = list(e.get_points("xy"))
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        mx = sum(xs) / len(xs)
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        if 7000 < mx < 17000 and 15 < w < 50 and h > 500:
            bars.append(mx)
    far = 0
    for e in msp.query("MTEXT"):
        if not (6000 < e.dxf.insert.x < 17000 and -102000 < e.dxf.insert.y < -68000):
            continue
        t = e.text.strip()
        if not re.fullmatch(r"\d+", t):
            continue
        if int(t) not in (1600, 5850, 11700):
            continue
        dx = min(abs(e.dxf.insert.x - bx) for bx in bars)
        if dx > 500:
            far += 1
            print(" far dim", t, e.dxf.insert.x, "dx", dx)
    print("bar-length dims farther than 500:", far)


def main() -> None:
    doc = ezdxf.readfile(SRC)
    dress_section_88(doc)
    resnap_schema_dims(doc)
    verify(doc)
    doc.saveas(OUT_DXF)
    shutil.copy(OUT_DXF, OUT_SHEET)
    to_dwg(OUT_DXF, OUT_DWG)
    with zipfile.ZipFile(ROOT / "drawings" / "KP17.zip", "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(OUT_DWG, "KP17.dwg")
        zf.write(OUT_SHEET, "KP17.dxf")
    # cleanup ref images if any
    for p in ROOT.glob("drawings/kp15_88*.png"):
        p.unlink(missing_ok=True)
    print("done")


if __name__ == "__main__":
    main()
