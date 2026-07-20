#!/usr/bin/env python3
"""Конвертация исходного PDF КП17 → DXF/DWG один-в-один (векторная геометрия).

Пайплайн:
  PDF → SVG (pdftocairo) → DXF outlines (Inkscape) → clean R2013 DXF (ezdxf)
  → DWG (ODA File Converter)

Текст на листе представлен контурами глифов (как в PDF-plot), визуально 1:1.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import ezdxf
from ezdxf import bbox, units
from ezdxf.math import Vec3

ROOT = Path(__file__).resolve().parents[2]
DRAW = ROOT / "drawings"
REF_PDF = ROOT / "reference" / "KP17_original.pdf"
ODA_BIN = Path("/tmp/squashfs-root/usr/bin/ODAFileConverter")
PT_TO_MM = 25.4 / 72.0


def pdf_to_svg(pdf: Path, svg: Path) -> None:
    subprocess.run(["pdftocairo", "-svg", str(pdf), str(svg.with_suffix(""))], check=True)
    # pdftocairo writes <name>.svg when given prefix
    produced = Path(str(svg.with_suffix("")) + ".svg")
    if produced != svg and produced.exists():
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
    inp = Path("/tmp/oda_kp17_in")
    outp = Path("/tmp/oda_kp17_out")
    inp.mkdir(exist_ok=True)
    outp.mkdir(exist_ok=True)
    for f in inp.glob("*"):
        f.unlink()
    for f in outp.glob("*"):
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
    if not produced.exists():
        err = outp / (dxf.stem + ".dwg.err")
        raise SystemExit(f"DWG conversion failed: {err.read_text() if err.exists() else 'no output'}")
    shutil.copy(produced, dwg)
    print(f"DWG {dwg} ({dwg.stat().st_size} bytes)")


def main():
    pdf = REF_PDF if REF_PDF.exists() else Path(sys.argv[1])
    work = Path("/tmp/kp17_1to1")
    work.mkdir(exist_ok=True)
    svg = work / "kp17.svg"
    ink = work / "kp17_inkscape.dxf"
    print("1) PDF → SVG")
    pdf_to_svg(pdf, svg)
    print("2) SVG → Inkscape DXF outlines")
    svg_to_inkscape_dxf(svg, ink)
    print("3) Rebuild clean DXF in mm (A0)")
    dxf = DRAW / "KP17.dxf"
    rebuild_clean_dxf(ink, dxf)
    print("4) DXF → DWG")
    dxf_to_dwg(dxf, DRAW / "KP17.dwg")
    print("Done: drawings/KP17.dwg is 1:1 vector from PDF")


if __name__ == "__main__":
    main()
