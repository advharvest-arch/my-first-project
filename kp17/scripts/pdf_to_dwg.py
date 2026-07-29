#!/usr/bin/env python3
"""Convert a PDF drawing sheet to DXF/DWG (vector outlines).

Pipeline:
  PDF → SVG (pdftocairo) → DXF outlines (Inkscape) → clean R2013 DXF (ezdxf)
  → DWG (ODA File Converter)

Usage:
  python3 kp17/scripts/pdf_to_dwg.py reference/uploaded_sheet.pdf drawings/uploaded_sheet
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import ezdxf
from ezdxf import bbox, units
from ezdxf.math import Vec3

ODA_BIN = Path("/tmp/squashfs-root/usr/bin/ODAFileConverter")
PT_TO_MM = 25.4 / 72.0


def pdf_to_svg(pdf: Path, svg: Path) -> None:
    prefix = svg.with_suffix("")
    subprocess.run(["pdftocairo", "-svg", str(pdf), str(prefix)], check=True)
    # pdftocairo may write "<prefix>" or "<prefix>.svg"
    candidates = [Path(str(prefix) + ".svg"), Path(str(prefix))]
    produced = next((p for p in candidates if p.exists() and p.stat().st_size > 0), None)
    if produced is None:
        raise SystemExit(f"pdftocairo did not produce SVG for {pdf}")
    if produced != svg:
        produced.replace(svg)


def svg_to_inkscape_dxf(svg: Path, dxf: Path) -> None:
    subprocess.run(
        [
            "inkscape",
            str(svg),
            "--export-extension=org.ekips.output.dxf_outlines",
            f"--export-filename={dxf}",
        ],
        check=True,
    )


def rebuild_clean_dxf(src_dxf: Path, out_dxf: Path) -> int:
    src = ezdxf.readfile(src_dxf)
    doc = ezdxf.new("R2013", setup=True)
    doc.units = units.MM
    doc.header["$INSUNITS"] = units.MM
    doc.header["$MEASUREMENT"] = 1
    doc.layers.add("GEOMETRY", color=7)
    doc.layers.add("TEXT_OUTLINE", color=7)
    msp = doc.modelspace()

    def scale_pts(pts):
        return [(p[0] * PT_TO_MM, p[1] * PT_TO_MM) for p in pts]

    for e in src.modelspace():
        t = e.dxftype()
        if t == "LWPOLYLINE":
            pts = list(e.get_points("xy"))
            if len(pts) < 2:
                continue
            msp.add_lwpolyline(
                scale_pts(pts),
                close=e.closed,
                dxfattribs={"layer": "GEOMETRY"},
            )
        elif t == "SPLINE":
            try:
                pts = list(e.flattening(0.05))
            except Exception:
                pts = [Vec3(p) for p in e.control_points]
            if len(pts) < 2:
                continue
            xy = [(p.x, p.y) for p in pts]
            msp.add_lwpolyline(
                scale_pts(xy),
                close=bool(getattr(e, "closed", False)),
                dxfattribs={"layer": "TEXT_OUTLINE"},
            )
        elif t == "LINE":
            msp.add_line(
                (e.dxf.start.x * PT_TO_MM, e.dxf.start.y * PT_TO_MM),
                (e.dxf.end.x * PT_TO_MM, e.dxf.end.y * PT_TO_MM),
                dxfattribs={"layer": "GEOMETRY"},
            )

    out_dxf.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(out_dxf)
    ext = bbox.extents(msp, fast=True)
    print(f"DXF {out_dxf} ents={len(msp)} size_mm={tuple(ext.size)}")
    return len(msp)


def dxf_to_dwg(dxf: Path, dwg: Path) -> None:
    if not ODA_BIN.exists():
        raise SystemExit(
            "ODA File Converter not found. Install and extract AppImage to /tmp/squashfs-root"
        )
    inp = Path("/tmp/oda_pdf2dwg_in")
    outp = Path("/tmp/oda_pdf2dwg_out")
    inp.mkdir(exist_ok=True)
    outp.mkdir(exist_ok=True)
    for f in inp.glob("*"):
        f.unlink()
    for f in outp.glob("*"):
        f.unlink()
    shutil.copy(dxf, inp / dxf.name)
    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = str(ODA_BIN.parent) + ":" + env.get("LD_LIBRARY_PATH", "")
    env.setdefault("DISPLAY", ":99")
    env.setdefault("QT_QPA_PLATFORM", "xcb")
    subprocess.run(
        [str(ODA_BIN), str(inp), str(outp), "ACAD2018", "DWG", "0", "1", "*.DXF"],
        check=False,
        env=env,
        capture_output=True,
    )
    produced = outp / (dxf.stem + ".dwg")
    if not produced.exists():
        produced = next(outp.glob("*.dwg"), None)
    if not produced or not produced.exists():
        err = outp / (dxf.stem + ".dwg.err")
        raise SystemExit(
            f"DWG conversion failed: {err.read_text() if err.exists() else 'no output'}"
        )
    shutil.copy(produced, dwg)
    print(f"DWG {dwg} ({dwg.stat().st_size} bytes)")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    pdf = Path(sys.argv[1]).resolve()
    out_stem = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else Path("drawings") / pdf.stem
    if not pdf.exists():
        raise SystemExit(f"PDF not found: {pdf}")

    work = Path("/tmp/pdf2dwg") / pdf.stem
    work.mkdir(parents=True, exist_ok=True)
    svg = work / "sheet.svg"
    ink = work / "sheet_inkscape.dxf"
    dxf = out_stem.with_suffix(".dxf")
    dwg = out_stem.with_suffix(".dwg")

    print("1) PDF → SVG")
    pdf_to_svg(pdf, svg)
    print("2) SVG → Inkscape DXF outlines")
    svg_to_inkscape_dxf(svg, ink)
    print("3) Rebuild clean DXF in mm")
    rebuild_clean_dxf(ink, dxf)
    print("4) DXF → DWG")
    dxf_to_dwg(dxf, dwg)

    zpath = out_stem.with_suffix(".zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(dwg, dwg.name)
        z.write(dxf, dxf.name)
    print(f"ZIP {zpath}")
    print(f"Done: {dwg}")


if __name__ == "__main__":
    main()
