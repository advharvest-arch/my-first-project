#!/usr/bin/env python3
"""Fix missing schema dimensions (geometry left behind) and restore section 8-8.

ODA regenerates DIMENSION anonymous blocks on DXF→DWG and drops the X-shift,
so schema dims are exploded to LINE/MTEXT/INSERT primitives before export.
After import, also add Ф1/Ф4 callouts as MTEXT if MULTILEADER import fails."""
from __future__ import annotations

import os
import shutil
import subprocess
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

# New-schema bar extents (same as KP15 composition)
BARS = [
    # side, x_center_approx_in_8-8, diameter, ymax, ymin
    # грунт (left of 8-8)
    ("g", 34715.0, 22, -70052.79067665164, -81752.79067665164),
    ("g", 34715.0, 28, -71202.79067665164, -77052.79067665164),
    ("g", 34715.0, 28, -77052.79067665164, -88752.79067665164),
    ("g", 34715.0, 32, -88752.79067665164, -94602.79067665164),
    ("g", 34715.0, 22, -94152.79067665164, -100002.7906766517),
    # котлован (right of 8-8)
    ("k", 35330.0, 22, -70052.79067665164, -71652.79067665164),
    ("k", 35330.0, 36, -71202.79067665164, -82902.79067665164),
    ("k", 35330.0, 36, -82902.79067665164, -94602.79067665164),
    ("k", 35330.0, 25, -94152.79067665164, -100002.7906766517),
    ("k", 35330.0, 22, -79802.79067665164, -91502.79067665164),
]


def translate_entity_x(e, dx: float, dy: float = 0.0) -> None:
    t = e.dxftype()
    if t == "LINE":
        s, ee = e.dxf.start, e.dxf.end
        e.dxf.start = Vec3(s.x + dx, s.y + dy, s.z)
        e.dxf.end = Vec3(ee.x + dx, ee.y + dy, ee.z)
    elif t == "POINT":
        p = e.dxf.location
        e.dxf.location = Vec3(p.x + dx, p.y + dy, p.z)
    elif t == "INSERT":
        p = e.dxf.insert
        e.dxf.insert = (p.x + dx, p.y + dy, p.z)
    elif t in ("TEXT", "MTEXT"):
        p = e.dxf.insert
        e.dxf.insert = (p.x + dx, p.y + dy, p.z)
    elif t == "CIRCLE":
        p = e.dxf.center
        e.dxf.center = Vec3(p.x + dx, p.y + dy, p.z)
    elif t == "SOLID":
        for attr in ("vtx0", "vtx1", "vtx2", "vtx3"):
            if e.dxf.hasattr(attr):
                v = getattr(e.dxf, attr)
                setattr(e.dxf, attr, Vec3(v.x + dx, v.y + dy, v.z))
    elif t == "LWPOLYLINE":
        pts = list(e.get_points("xy"))
        e.set_points([(x + dx, y + dy) for x, y in pts])


def geom_center_x(blk) -> float | None:
    xs = []
    for e in blk:
        t = e.dxftype()
        if t == "LINE":
            xs += [e.dxf.start.x, e.dxf.end.x]
        elif t == "INSERT":
            xs.append(e.dxf.insert.x)
        elif t in ("TEXT", "MTEXT"):
            xs.append(e.dxf.insert.x)
        elif t == "POINT":
            xs.append(e.dxf.location.x)
    return sum(xs) / len(xs) if xs else None


def fix_dimension_geometry(doc) -> int:
    """Move anonymous dim geometry to match defpoints (left-clone leftover)."""
    msp = doc.modelspace()
    fixed = 0
    for dim in msp.query("DIMENSION"):
        pts = [
            getattr(dim.dxf, a)
            for a in ("defpoint", "defpoint2", "defpoint3")
            if dim.dxf.hasattr(a)
        ]
        if not pts:
            continue
        dcx = sum(p.x for p in pts) / len(pts)
        dcy = sum(p.y for p in pts) / len(pts)
        # only schema-ish band (main + right schema)
        if not (-102000 < dcy < -68000 and 5000 < dcx < 42000):
            continue
        blk = doc.blocks.get(dim.dxf.geometry)
        if blk is None:
            continue
        gcx = geom_center_x(blk)
        if gcx is None:
            continue
        dx = dcx - gcx
        if abs(dx) < 200:
            continue
        # also fix Y if needed (usually 0)
        gys = []
        for e in blk:
            if e.dxftype() == "LINE":
                gys += [e.dxf.start.y, e.dxf.end.y]
        gcy = sum(gys) / len(gys) if gys else dcy
        dy = dcy - gcy
        # only apply large X shift; ignore tiny Y
        if abs(dy) < 50:
            dy = 0.0
        for e in blk:
            translate_entity_x(e, dx, dy)
        fixed += 1
    print("fixed dimension geometries", fixed)
    return fixed


def restore_section_88(doc, ref_path: Path) -> None:
    """Re-import section 8-8 graphics from reference DWG/DXF if missing."""
    msp = doc.modelspace()
    has_label = any(
        (e.dxftype() in ("TEXT", "MTEXT"))
        and ("8-8" in (e.dxf.text if e.dxftype() == "TEXT" else e.text))
        for e in msp
    )
    has_insert = any(
        e.dxf.name in ("*U171", "*U173", "*U175", "*U177", "*U179", "*U181")
        for e in msp.query("INSERT")
    )
    if has_label and has_insert:
        print("section 8-8 already present")
        return

    ref = ezdxf.readfile(ref_path)
    rmsp = ref.modelspace()

    # Collect entity handles for 8-8 cluster
    want_handles = set()
    for e in rmsp:
        t = e.dxftype()
        if t == "INSERT" and e.dxf.name in (
            "*U171",
            "*U173",
            "*U175",
            "*U177",
            "*U179",
            "*U181",
        ):
            want_handles.add(e.dxf.handle)
        elif t in ("TEXT", "MTEXT"):
            txt = e.dxf.text if t == "TEXT" else e.text
            if "8-8" in txt:
                want_handles.add(e.dxf.handle)
        elif t == "CIRCLE":
            c = e.dxf.center
            if 34800 < c.x < 35250 and -70500 < c.y < -69500:
                want_handles.add(e.dxf.handle)
        elif t == "LINE":
            mx = (e.dxf.start.x + e.dxf.end.x) / 2
            my = (e.dxf.start.y + e.dxf.end.y) / 2
            if 34500 < mx < 35500 and -100000 < my < -68000:
                # the two short horizontal marks at mid height
                if abs(e.dxf.start.y - e.dxf.end.y) < 1 and abs(e.dxf.start.x - e.dxf.end.x) < 50:
                    want_handles.add(e.dxf.handle)
        elif t == "LWPOLYLINE":
            pts = list(e.get_points("xy"))
            mx = sum(p[0] for p in pts) / len(pts)
            my = sum(p[1] for p in pts) / len(pts)
            if 34550 < mx < 35450 and -101000 < my < -69000:
                xs = [p[0] for p in pts]
                ys = [p[1] for p in pts]
                w, h = max(xs) - min(xs), max(ys) - min(ys)
                # bar rectangles of the 8-8 profile
                if 15 < w < 50 and h > 1000:
                    want_handles.add(e.dxf.handle)
        elif t == "DIMENSION":
            pts = [
                getattr(e.dxf, a)
                for a in ("defpoint", "defpoint2", "defpoint3")
                if e.dxf.hasattr(a)
            ]
            cx = sum(p.x for p in pts) / len(pts)
            cy = sum(p.y for p in pts) / len(pts)
            if 34500 < cx < 35500 and -102000 < cy < -68000:
                try:
                    if abs(e.get_measurement() - 800) < 1:
                        want_handles.add(e.dxf.handle)
                except Exception:
                    pass

    # Also Ф*/11 callouts for 8-8 (mleaders at x~35715)
    for e in rmsp.query("MULTILEADER"):
        ctx = getattr(e, "context", None)
        if not (ctx and getattr(ctx, "mtext", None)):
            continue
        try:
            ix, iy = ctx.mtext.insert.x, ctx.mtext.insert.y
        except Exception:
            continue
        txt = (ctx.mtext.default_content or "")
        if 35600 < ix < 36000 and -102000 < iy < -68000:
            if any(k in txt for k in ("Ф1", "Ф4", "11", "Б", "{\\C0;Б}")):
                want_handles.add(e.dxf.handle)

    entities = [e for e in rmsp if e.dxf.handle in want_handles]
    print("importing 8-8 entities", len(entities), "handles", len(want_handles))

    importer = Importer(ref, doc)
    importer.import_entities(entities, msp)
    importer.finalize()
    print("8-8 import done, modelspace now", len(list(msp)))


def redraw_88_bars(msp) -> None:
    """Replace old 8-8 profile bar polylines with new-schema extents."""
    # Delete existing bar polys in 8-8 strip
    kill = []
    for e in msp.query("LWPOLYLINE"):
        pts = list(e.get_points("xy"))
        if len(pts) < 2:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        if 34550 < mx < 35450 and -101000 < my < -69000 and 15 < w < 50 and h > 1000:
            kill.append(e)
    for e in kill:
        msp.delete_entity(e)
    print("removed old 8-8 bars", len(kill))

    # Draw new bars
    for side, x, d, ymax, ymin in BARS:
        half = d / 2.0
        msp.add_lwpolyline(
            [
                (x - half, ymin),
                (x + half, ymin),
                (x + half, ymax),
                (x - half, ymax),
            ],
            close=True,
            dxfattribs={"layer": "0", "color": 7},
        )
    print("added new 8-8 bars", len(BARS))


def ensure_88_label(msp) -> None:
    if any(
        (e.dxftype() in ("TEXT", "MTEXT"))
        and ("8-8" in (e.dxf.text if e.dxftype() == "TEXT" else e.text))
        for e in msp
    ):
        return
    msp.add_mtext(
        "8-8",
        dxfattribs={
            "insert": (35063.12790740235, -68052.36537058048, 0.0),
            "char_height": 200.0,
            "style": "GOST-2.304_Type-B",
            "attachment_point": 5,
            "layer": "0",
        },
    )
    print("added 8-8 label")


def to_dwg(dxf: Path, dwg: Path) -> None:
    inp, outp = Path("/tmp/oda_88_in"), Path("/tmp/oda_88_out")
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
    mism = 0
    ok = 0
    for dim in msp.query("DIMENSION"):
        pts = [
            getattr(dim.dxf, a)
            for a in ("defpoint", "defpoint2", "defpoint3")
            if dim.dxf.hasattr(a)
        ]
        if not pts:
            continue
        dcx = sum(p.x for p in pts) / len(pts)
        dcy = sum(p.y for p in pts) / len(pts)
        if not (6000 < dcx < 18000 and -102000 < dcy < -68000):
            continue
        blk = doc.blocks.get(dim.dxf.geometry)
        gcx = geom_center_x(blk) if blk else None
        if gcx is None:
            continue
        if abs(dcx - gcx) > 200:
            mism += 1
        else:
            ok += 1
    print(f"main schema dims: ok={ok} mismatch={mism}")

    has88 = any(
        (e.dxftype() in ("TEXT", "MTEXT"))
        and ("8-8" in (e.dxf.text if e.dxftype() == "TEXT" else e.text))
        for e in msp
    )
    n_ins = sum(
        1
        for e in msp.query("INSERT")
        if e.dxf.name in ("*U171", "*U173", "*U175", "*U177", "*U179", "*U181")
    )
    n_bars = 0
    for e in msp.query("LWPOLYLINE"):
        pts = list(e.get_points("xy"))
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        mx = sum(xs) / len(xs)
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        if 34550 < mx < 35450 and 15 < w < 50 and h > 1000:
            n_bars += 1
    print(f"8-8 label={has88} inserts={n_ins} bars={n_bars}")


def main() -> None:
    doc = ezdxf.readfile(SRC)
    msp = doc.modelspace()

    fix_dimension_geometry(doc)
    restore_section_88(doc, REF)
    msp = doc.modelspace()  # refresh
    redraw_88_bars(msp)
    ensure_88_label(msp)

    verify(doc)
    doc.saveas(OUT_DXF)
    shutil.copy(OUT_DXF, OUT_SHEET)
    to_dwg(OUT_DXF, OUT_DWG)

    import zipfile

    zpath = ROOT / "drawings" / "KP17.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(OUT_DWG, "KP17.dwg")
        zf.write(OUT_SHEET, "KP17.dxf")
    print("done")


if __name__ == "__main__":
    main()
