#!/usr/bin/env python3
"""Make KP17 main schema identical to the left reference and fix sections 1-1…7-7.

Also repositions cage elevation bars to match the new schema Y extents.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import ezdxf
from ezdxf.math import Vec2

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "drawings" / "KP17.dxf"
OUT_DXF = ROOT / "reference" / "KP17_new_applied.dxf"
OUT_DWG = ROOT / "drawings" / "KP17.dwg"
OUT_SHEET = ROOT / "drawings" / "KP17.dxf"
ODA = Path("/tmp/squashfs-root/usr/bin/ODAFileConverter")

DX = 24920.28973354732  # title alignment left→main

NEW_SPEC = {
    1: (22, 11700, 28),
    2: (22, 1600, 14),
    3: (28, 5850, 14),
    4: (36, 11700, 14),
    5: (28, 11700, 14),
    6: (32, 5850, 14),
    7: (22, 5850, 14),
    8: (25, 5850, 14),
}

# Section leaf blocks → new position (derived from new schema cut zones)
# 1-1 [1,2]; 2-2 [1,3,4]; 3-3 [1,4,5]; 4-4 [1,1,4,5];
# 5-5 [1,4,6]; 6-6 [6,7,8]; 7-7 [7,8]
SECTION_LEAF_POS = {
    # KP15 PDF example compositions (same schema as new KP17)
    # 1-1: 1, 2
    "*U238": 1,
    "*U234": 2,
    # 2-2: 1, 3, 4 (+ *U480/481 pos2)
    "*U297": 1,
    "*U264": 3,
    "*U248": 4,
    "*U480": 2,
    # 3-3: 1, 3, 4
    "*U301": 1,
    "*U292": 3,
    "*U285": 4,
    # 4-4: 1, 5, 4, 1
    "*U305": 1,
    "*U231": 5,
    "*U281": 4,
    "*U252": 1,
    # 5-5: 5, 4, 1
    "*U242": 5,
    "*U266": 4,
    "*U291": 1,
    # 6-6: 7, 6, 8 (+ *U482/483 pos4)
    "*U268": 7,
    "*U246": 6,
    "*U259": 8,
    "*U482": 4,
    # 7-7: 7, 8
    "*U289": 7,
    "*U255": 8,
}

# Cage leaf → (pos, side) ; side: 'k'=котлован, 'g'=грунт
# Target world ymin from new schema bars
CAGE_TARGET = {
    # котлован
    "*U34": (1, "k", -91502.79),   # Ø22×11700
    "*U226": (2, "k", -71652.79),  # Ø22×1600
    "*U16": (4, "k", -82902.79),   # Ø36×11700 upper
    "*U224": (4, "k", -94602.79),  # Ø36×11700 lower
    "*U30": (8, "k", -100002.79),  # Ø25×5850
    # грунт
    "*U24": (1, "g", -81752.79),   # Ø22×11700
    "*U26": (3, "g", -77052.79),   # Ø28×5850
    "*U18": (5, "g", -88752.79),   # Ø28×11700
    "*U22": (7, "g", -100002.79),  # Ø22×5850
    # pos6 added as *U470 leaf under parent *U471
}

PARENT_FOR_LEAF = {
    "*U34": "*U35",
    "*U226": "*U227",
    "*U16": "*U17",
    "*U224": "*U225",
    "*U30": "*U31",
    "*U24": "*U25",
    "*U26": "*U27",
    "*U18": "*U21",
    "*U22": "*U23",
}


def redraw_leaf_bar(block, new_d: float, new_len: float, y0: float = 0.0) -> None:
    """Force leaf bar to diameter×length with local y in [y0, y0+len]."""
    poly = next(e for e in block if e.dxftype() == "LWPOLYLINE")
    half = new_d / 2.0
    y1 = y0 + new_len
    # rectangle centered on x=0
    new_pts = [(-half, y0), (half, y0), (half, y1), (-half, y1)]
    poly.set_points(new_pts)

    for wipe in (e for e in block if e.dxftype() == "WIPEOUT"):
        wipe.dxf.insert = ( -half, y0, 0)
        L = max(new_len, 1.0)
        wipe.dxf.u_pixel = (L, 0, 0)
        wipe.dxf.v_pixel = (0, L, 0)
        span = new_d / L
        wipe.set_boundary_path(
            [
                Vec2(-0.5, -0.5),
                Vec2(-0.5 + span, -0.5),
                Vec2(-0.5 + span, 0.5),
                Vec2(-0.5, 0.5),
                Vec2(-0.5, -0.5),
            ]
        )


def set_section_radii(doc) -> None:
    for leaf, pos in SECTION_LEAF_POS.items():
        blk = doc.blocks.get(leaf)
        if blk is None:
            print("missing section leaf", leaf)
            continue
        d = NEW_SPEC[pos][0]
        n = 0
        for e in blk.query("CIRCLE"):
            if 5 < e.dxf.radius < 30:
                e.dxf.radius = d / 2.0
                n += 1
        print(f"section {leaf} → pos{pos} Ø{d} circles={n}")


# Mark Y (original) → new position. Stable because mark inserts were not moved.
SECTION_MARK_Y_TO_POS = {
    -50937: 1,
    -51936: 2,
    -53281: 1,
    -53592: 3,
    -53981: 4,
    -55631: 1,
    -56331: 3,
    -56634: 4,
    -57982: 1,
    -58289: 5,
    -58681: 4,
    -58986: 1,
    -60333: 5,
    -61031: 4,
    -61331: 1,
    -62684: 7,
    -62992: 6,
    -63681: 8,
    -65037: 7,
    -66031: 8,
}


def update_section_marks(msp) -> None:
    """Remap plain 1..8 MULTILEADER marks by stable Y→pos table."""
    updated = 0
    for e in msp.query("MULTILEADER"):
        ctx = getattr(e, "context", None)
        if not (ctx and getattr(ctx, "mtext", None)):
            continue
        t = (ctx.mtext.default_content or "").strip()
        if not re.fullmatch(r"[1-8]", t) and not re.fullmatch(r"\{\\C0;[1-8]\}", t):
            continue
        try:
            ix, iy = ctx.mtext.insert.x, ctx.mtext.insert.y
        except Exception:
            continue
        if not (18000 <= ix <= 22000 and -67000 <= iy <= -50000):
            continue
        # nearest key in Y table
        key = min(SECTION_MARK_Y_TO_POS.keys(), key=lambda yy: abs(yy - iy))
        if abs(key - iy) > 3.0:
            continue
        pos = SECTION_MARK_Y_TO_POS[key]
        if re.fullmatch(r"[1-8]", t):
            ctx.mtext.default_content = str(pos)
        else:
            ctx.mtext.default_content = "{\\C0;" + str(pos) + "}"
        updated += 1
    print("section marks updated", updated)


def clean_extra_schema_geometry(msp) -> None:
    """Remove leftover old polyline in main schema band not present on left."""
    # Extra known leftover: horizontal poly at y≈-100702.8 x≈16635
    kill = []
    for e in msp.query("LWPOLYLINE"):
        pts = list(e.get_points("xy"))
        if not pts:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        # leftover dimension-ish line under schema
        if 16000 < cx < 17000 and abs(cy + 100702.79) < 1.0 and abs(h) < 1 and 900 < w < 1100:
            kill.append(e)
        # another possible leftover at x≈24425 ( -495.4 + DX )
        if 24000 < cx < 25000 and abs(cy + 100702.79) < 1.0 and abs(h) < 1 and 900 < w < 1100:
            kill.append(e)
    for e in kill:
        msp.delete_entity(e)
    print("removed leftover schema polys", len(kill))


def reposition_cage(doc, msp) -> None:
    """Resize cage leaves and move parent INSERTs so world Y matches new schema."""
    # First resize known leaves and move parents
    for leaf, (pos, side, ymin) in CAGE_TARGET.items():
        d, L, _ = NEW_SPEC[pos]
        blk = doc.blocks.get(leaf)
        if blk is None:
            print("missing cage leaf", leaf)
            continue
        redraw_leaf_bar(blk, float(d), float(L), y0=0.0)
        parent_name = PARENT_FOR_LEAF[leaf]
        moved = 0
        for e in msp.query("INSERT"):
            if e.dxf.name != parent_name:
                continue
            # keep X, set Y to ymin (leaf draws y=0..L upward)
            e.dxf.insert = (e.dxf.insert.x, ymin, e.dxf.insert.z)
            moved += 1
        print(f"cage {leaf}/parent {parent_name} → pos{pos} Ø{d}×{L} ymin={ymin} moved={moved}")

    # Add грунт pos6 if missing: duplicate *U23/*U22 as *U471/*U470
    ensure_grun_pos6(doc, msp)


def ensure_grun_pos6(doc, msp) -> None:
    """Ensure грунт view has pos6 Ø32×5850 at ymin=-94602.79."""
    ymin = -94602.79
    d, L, _ = NEW_SPEC[6]

    # If a parent already places Ø32-ish bar near that Y, skip
    # Create leaf *U470 from *U22 geometry if needed
    if doc.blocks.get("*U470") is None:
        new_blk = doc.blocks.new("*U470")
        half = d / 2.0
        new_blk.add_lwpolyline(
            [(-half, 0), (half, 0), (half, L), (-half, L)],
            close=True,
        )
        print("created leaf *U470")
    else:
        redraw_leaf_bar(doc.blocks.get("*U470"), float(d), float(L), y0=0.0)

    # Parent block *U471 with 14 inserts of *U470 like *U23
    if doc.blocks.get("*U471") is None:
        src_parent = doc.blocks.get("*U23")
        new_p = doc.blocks.new("*U471")
        xs = []
        if src_parent is not None:
            for e in src_parent:
                if e.dxftype() == "INSERT" and e.dxf.name == "*U22":
                    xs.append(e.dxf.insert.x)
        if not xs:
            xs = [i * 140.0 for i in range(14)]
        for x in xs:
            new_p.add_blockref("*U470", (x, 0))
        print("created parent *U471 inserts", len(xs))

    # Modelspace insert on грунт side near *U23
    existing = [
        e
        for e in msp.query("INSERT")
        if e.dxf.name == "*U471"
        or (
            e.dxf.name == "*U23"
            and abs(e.dxf.insert.y - ymin) < 1.0
        )
    ]
    # Find reference *U23 for X/scale
    ref = next((e for e in msp.query("INSERT") if e.dxf.name == "*U23"), None)
    already = next((e for e in msp.query("INSERT") if e.dxf.name == "*U471"), None)
    if already is not None:
        already.dxf.insert = (already.dxf.insert.x, ymin, already.dxf.insert.z)
        print("repositioned existing *U471")
        return
    if ref is None:
        print("no *U23 ref for pos6 insert")
        return
    msp.add_blockref(
        "*U471",
        (ref.dxf.insert.x, ymin),
        dxfattribs={"xscale": ref.dxf.xscale, "yscale": ref.dxf.yscale, "zscale": ref.dxf.zscale},
    )
    print("added грунт pos6 INSERT *U471 at", ref.dxf.insert.x, ymin)


def update_cage_callouts(msp) -> None:
    """Update elevation callouts like '1 A500C %%C22 шаг 140' near cage."""
    for e in msp.query("MULTILEADER"):
        ctx = getattr(e, "context", None)
        if not (ctx and getattr(ctx, "mtext", None)):
            continue
        t = ctx.mtext.default_content or ""
        m = re.search(r"([1-8])\s*A500C\s*%%C\d+", t)
        if not m:
            m = re.search(r"\\C0;([1-8])\\P", t)
        if not m:
            continue
        pos = int(m.group(1))
        if pos not in NEW_SPEC:
            continue
        d = NEW_SPEC[pos][0]
        # replace %%Cdd
        nt = re.sub(r"%%C\d+", f"%%C{d}", t)
        # also split ∅ digits pattern used in ISO callouts
        nt = re.sub(
            r"(%%C)(\\fISOCPEUR[^;]*;)(\d+)(\\f)",
            lambda mo: mo.group(1) + mo.group(2) + str(d) + mo.group(4) if False else mo.group(0),
            nt,
        )
        # simpler: if content has pos header already matching, just diam
        if nt != t:
            ctx.mtext.default_content = nt


def to_dwg(dxf: Path, dwg: Path) -> None:
    if not ODA.exists():
        print("ODA missing")
        return
    inp, outp = Path("/tmp/oda_fix_in"), Path("/tmp/oda_fix_out")
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
    if produced.exists():
        shutil.copy(produced, dwg)
        print("DWG", dwg, produced.stat().st_size)


def verify(doc, msp) -> None:
    print("\n=== VERIFY section radii ===")
    for leaf, pos in sorted(SECTION_LEAF_POS.items()):
        blk = doc.blocks.get(leaf)
        rs = sorted({round(e.dxf.radius, 2) for e in blk.query("CIRCLE")}) if blk else []
        expect = NEW_SPEC[pos][0] / 2
        ok = rs == [expect] or (len(rs) == 1 and abs(rs[0] - expect) < 0.01)
        print(f"  {leaf} pos{pos} r={rs} expect={expect} {'OK' if ok else 'FAIL'}")

    print("\n=== VERIFY schema bars left vs main ===")
    YMIN, YMAX = -102000, -69000

    def bars(x0, x1, dx=0.0):
        out = []
        for e in msp.query("LWPOLYLINE"):
            pts = list(e.get_points("xy"))
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
            if not (x0 <= cx <= x1 and YMIN <= cy <= YMAX):
                continue
            w, h = max(xs) - min(xs), max(ys) - min(ys)
            if h > 500 and w < 80:
                out.append((round(cx - dx, 1), round(cy, 1), round(w, 1), round(h, 1)))
        return sorted(out)

    left = bars(-18000, -8000)
    main = bars(-18000 + DX, -8000 + DX, DX)
    print("left", len(left), "main", len(main), "match", left == main)
    if left != main:
        print(" only left", [b for b in left if b not in main])
        print(" only main", [b for b in main if b not in left])


def main():
    shutil.copy(SRC, OUT_DXF)
    doc = ezdxf.readfile(OUT_DXF)
    msp = doc.modelspace()

    clean_extra_schema_geometry(msp)
    set_section_radii(doc)
    update_section_marks(msp)
    reposition_cage(doc, msp)
    update_cage_callouts(msp)

    # Fix *U470 if created empty before wipe/poly
    blk = doc.blocks.get("*U470")
    if blk is not None and not list(blk.query("LWPOLYLINE")):
        d, L, _ = NEW_SPEC[6]
        half = d / 2
        blk.add_lwpolyline([(-half, 0), (half, 0), (half, L), (-half, L)], close=True)

    verify(doc, msp)

    doc.saveas(OUT_DXF)
    shutil.copy(OUT_DXF, OUT_SHEET)
    to_dwg(OUT_DXF, OUT_DWG)
    print("done", OUT_DXF, OUT_DWG)


if __name__ == "__main__":
    main()
