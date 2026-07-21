#!/usr/bin/env python3
"""Align native KP17 DWG to KP15 PDF sample using KP17 geometry.

Fixes:
  - cage elevation dims still showing old lengths (3050 / 8450 / wrong pos)
  - right-hand schema title missing «КП17»
  - orphan dim-block texts
  - export native DWG via ODA
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import ezdxf
from ezdxf.math import Vec3

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "reference" / "KP17_new_applied.dxf"
OUT_DXF = ROOT / "reference" / "KP17_new_applied.dxf"
OUT_SHEET = ROOT / "drawings" / "KP17.dxf"
OUT_DWG = ROOT / "drawings" / "KP17.dwg"
OUT_NATIVE = ROOT / "drawings" / "KP17_native.dwg"
ODA = Path("/tmp/squashfs-root/usr/bin/ODAFileConverter")

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

# Absolute Y extents from KP17 new-schema bars (same as KP15 composition)
Y = {
    "top": -70052.79067665164,
    "bot": -100002.7906766517,
    # грунт
    "g1": (-70052.79067665164, -81752.79067665164),  # Ø22×11700
    "g3": (-71202.79067665164, -77052.79067665164),  # Ø28×5850
    "g5": (-77052.79067665164, -88752.79067665164),  # Ø28×11700
    "g6": (-88752.79067665164, -94602.79067665164),  # Ø32×5850
    "g7": (-94152.79067665164, -100002.7906766517),  # Ø22×5850
    # котлован
    "k2": (-70052.79067665164, -71652.79067665164),  # Ø22×1600
    "k4u": (-71202.79067665164, -82902.79067665164),  # Ø36×11700
    "k4l": (-82902.79067665164, -94602.79067665164),  # Ø36×11700
    "k8": (-94152.79067665164, -100002.7906766517),  # Ø25×5850
    "k1": (-79802.79067665164, -91502.79067665164),  # Ø22×11700
}


def _remap_y(y: float, old_hi: float, old_lo: float, new_hi: float, new_lo: float) -> float:
    """Map y from old vertical span onto new span (endpoints snap, mid interpolates)."""
    if abs(y - old_hi) < 1.5:
        return new_hi
    if abs(y - old_lo) < 1.5:
        return new_lo
    # also snap near overhangs (±100 used for dim-line extensions)
    if abs(y - (old_hi + 100)) < 1.5:
        return new_hi + 100
    if abs(y - (old_hi - 100)) < 1.5:
        return new_hi - 100
    if abs(y - (old_lo + 100)) < 1.5:
        return new_lo + 100
    if abs(y - (old_lo - 100)) < 1.5:
        return new_lo - 100
    span_old = old_hi - old_lo
    if abs(span_old) < 1e-6:
        return new_hi
    t = (y - old_lo) / span_old
    return new_lo + t * (new_hi - new_lo)


def set_dim_vertical(doc, handle: str, y_hi: float, y_lo: float, label: str) -> None:
    """Re-point a vertical DIMENSION and rewrite its anonymous-block geometry/label."""
    msp = doc.modelspace()
    dim = msp.query(f'*[handle=="{handle}"]').first
    if dim is None:
        print("missing dim", handle)
        return

    old_ys = [dim.dxf.defpoint2.y, dim.dxf.defpoint3.y]
    old_hi, old_lo = max(old_ys), min(old_ys)

    p2 = dim.dxf.defpoint2
    p3 = dim.dxf.defpoint3
    # Preserve which end was which: higher Y → y_hi
    if p2.y >= p3.y:
        dim.dxf.defpoint2 = Vec3(p2.x, y_hi, p2.z)
        dim.dxf.defpoint3 = Vec3(p3.x, y_lo, p3.z)
    else:
        dim.dxf.defpoint2 = Vec3(p2.x, y_lo, p2.z)
        dim.dxf.defpoint3 = Vec3(p3.x, y_hi, p3.z)

    dp = dim.dxf.defpoint
    dim.dxf.defpoint = Vec3(
        dp.x, _remap_y(dp.y, old_hi, old_lo, y_hi, y_lo), dp.z
    )
    dim.dxf.text = label

    gname = dim.dxf.geometry
    blk = doc.blocks.get(gname)
    if blk is None:
        print("no geom block", gname)
        return

    for e in blk:
        t = e.dxftype()
        if t == "LINE":
            s, ee = e.dxf.start, e.dxf.end
            e.dxf.start = Vec3(s.x, _remap_y(s.y, old_hi, old_lo, y_hi, y_lo), s.z)
            e.dxf.end = Vec3(ee.x, _remap_y(ee.y, old_hi, old_lo, y_hi, y_lo), ee.z)
        elif t == "POINT":
            loc = e.dxf.location
            e.dxf.location = Vec3(
                loc.x, _remap_y(loc.y, old_hi, old_lo, y_hi, y_lo), loc.z
            )
        elif t == "INSERT" and "Tick" in e.dxf.name:
            ins = e.dxf.insert
            e.dxf.insert = (
                ins.x,
                _remap_y(ins.y, old_hi, old_lo, y_hi, y_lo),
                ins.z,
            )
        elif t == "MTEXT":
            old = e.text
            prefix = ""
            m = re.match(r"(\\A\d;)", old)
            if m:
                prefix = m.group(1)
            e.text = prefix + label
            mid_y = (y_hi + y_lo) / 2.0
            e.dxf.insert = (e.dxf.insert.x, mid_y, e.dxf.insert.z)

    print(f"dim {handle}/{gname}: {old_hi:.1f}..{old_lo:.1f} → {y_hi:.1f}..{y_lo:.1f} {label}")


def fix_cage_dims(doc) -> None:
    """Map KP17 elevation dims to KP15-like lengths/positions."""
    # --- котлован view (right elevation, x≈28k) ---
    # pos.2 3050 → 1600
    set_dim_vertical(doc, "4CDD9", Y["k2"][0], Y["k2"][1], "<> (поз. 2)")
    # стык under pos2: 450 between -71652.8 and -71202.8
    set_dim_vertical(doc, "4CDE3", Y["k2"][1] + 450.0, Y["k2"][1], "стык <>")
    # pos.4 upper 11700
    set_dim_vertical(doc, "4CDDE", Y["k4u"][0], Y["k4u"][1], "<> (поз. 4)")
    # стык between two pos4
    set_dim_vertical(doc, "4CDED", Y["k4u"][1] + 450.0, Y["k4u"][1], "стык <>")
    # was pos.7 11700 → second pos.4 11700
    set_dim_vertical(doc, "4CDE8", Y["k4l"][0], Y["k4l"][1], "<> (поз. 4)")
    # стык above pos8
    set_dim_vertical(doc, "4CDF7", Y["k8"][0] + 450.0, Y["k8"][0], "стык <>")
    # was pos.1 5850 → pos.8 5850
    set_dim_vertical(doc, "4CDF2", Y["k8"][0], Y["k8"][1], "<> (поз. 8)")

    # --- грунт view (left elevation, x≈20k) ---
    # was pos.1 5850 at top → pos.3 5850
    set_dim_vertical(doc, "4CD8D", Y["g3"][0], Y["g3"][1], "<> (поз. 3)")
    # was pos.3 11700 → pos.1 11700 (full top bar)
    set_dim_vertical(doc, "4CD88", Y["g1"][0], Y["g1"][1], "<> (поз. 1)")
    # was pos.5 5850 → pos.5 11700
    set_dim_vertical(doc, "4C6BA", Y["g5"][0], Y["g5"][1], "<> (поз. 5)")
    # was pos.8 8450 → pos.7 5850
    set_dim_vertical(doc, "4C6BF", Y["g7"][0], Y["g7"][1], "<> (поз. 7)")
    # was pos.6 11700 → pos.6 5850
    set_dim_vertical(doc, "834EA", Y["g6"][0], Y["g6"][1], "<> (поз. 6)")
    # стык near old pos1/pos3 boundary on грунт
    set_dim_vertical(doc, "66200", Y["g3"][0] + 450.0, Y["g3"][0], "стык <>")
    set_dim_vertical(doc, "66215", Y["g5"][1] + 450.0, Y["g5"][1], "стык <>")


def fix_orphan_dim_blocks(doc) -> None:
    mapping = {
        "*D155": r"\A1;1600",
        "*D161": r"\A1;5850",
        "*D469": r"\A1;1600 (поз. 2)",
        "*D479": r"\A1;5850 (поз. 8)",
        "*D80": r"\A1;<> (поз. 2)",
        "*D126": r"\A1;<> (поз. 7)",
    }
    for name, text in mapping.items():
        blk = doc.blocks.get(name)
        if blk is None:
            continue
        for e in blk:
            if e.dxftype() == "MTEXT":
                e.text = text
                print("orphan/block text", name, "→", text)


def fix_titles(msp) -> None:
    for e in msp.query("MTEXT"):
        t = e.text
        if "Схема расположения рабочей арматуры каркаса" in t and "КП17" not in t:
            e.text = t.rstrip() + " КП17"
            # ensure no double spaces issues
            e.text = re.sub(r"каркаса\s+КП17", "каркаса КП17", e.text)
            print("fixed title at", e.dxf.insert, "→", e.text[:80])
        # KP15 leftovers
        if "КП15" in t:
            e.text = t.replace("КП15", "КП17")
            print("retitled KP15→KP17", e.text[:80])


def to_dwg(dxf: Path, dwg: Path) -> None:
    if not ODA.exists():
        raise SystemExit("ODA converter missing")
    inp, outp = Path("/tmp/oda_align_in"), Path("/tmp/oda_align_out")
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
        raise SystemExit("ODA did not produce DWG")
    shutil.copy(produced, dwg)
    shutil.copy(produced, OUT_NATIVE)
    print("DWG", dwg, produced.stat().st_size)


def verify(doc) -> None:
    msp = doc.modelspace()
    bad = []
    for e in msp.query("DIMENSION"):
        text = getattr(e.dxf, "text", "") or ""
        try:
            m = e.get_measurement()
        except Exception:
            m = None
        if "3050" in text or (m is not None and abs(m - 3050) < 0.1 and "поз. 2" in text):
            # after fix, measurement may still compute old until regen; check block text
            pass
        g = doc.blocks.get(e.dxf.geometry)
        if g:
            for t in g.query("MTEXT"):
                if "3050" in t.text or "8450" in t.text:
                    bad.append((e.dxf.handle, t.text))
    print("remaining 3050/8450 in live dim blocks:", bad)
    titles = [
        e.text
        for e in msp.query("MTEXT")
        if "Схема расположения" in e.text
    ]
    print("schema titles:", titles)


def main() -> None:
    doc = ezdxf.readfile(SRC)
    msp = doc.modelspace()
    fix_cage_dims(doc)
    fix_orphan_dim_blocks(doc)
    fix_titles(msp)
    verify(doc)
    doc.saveas(OUT_DXF)
    shutil.copy(OUT_DXF, OUT_SHEET)
    to_dwg(OUT_DXF, OUT_DWG)
    # zip
    import zipfile

    zpath = ROOT / "drawings" / "KP17.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(OUT_DWG, "KP17.dwg")
        zf.write(OUT_SHEET, "KP17.dxf")
    print("zip", zpath, zpath.stat().st_size)


if __name__ == "__main__":
    main()
