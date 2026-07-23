#!/usr/bin/env python3
"""Собрать полный лист: векторная подложка из PDF + редактируемые слои КП17."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import ezdxf
from ezdxf.addons import Importer

ROOT = Path(__file__).resolve().parents[2]
DRAW = ROOT / "drawings"
ODA_BIN = Path("/tmp/squashfs-root/usr/bin/ODAFileConverter")


def merge():
    base = ezdxf.readfile(DRAW / "KP17.dxf")
    under = ezdxf.readfile(DRAW / "KP17_underlay_from_pdf.dxf")

    if "UNDERLAY" not in base.layers:
        base.layers.add("UNDERLAY", color=8)
    base.layers.get("UNDERLAY").off()  # по умолчанию выключена — включать для сверки

    importer = Importer(under, base)
    importer.import_modelspace()
    importer.finalize()

    # всё импортированное с UNDERLAY (уже так в underlay-файле)
    out_dxf = DRAW / "KP17_full.dxf"
    base.saveas(out_dxf)
    print(f"Merged DXF: {out_dxf} entities={len(base.modelspace())}")
    return out_dxf


def to_dwg(dxf_path: Path):
    if not ODA_BIN.exists():
        print("ODA converter not found; skip DWG", file=sys.stderr)
        return None
    inp = Path("/tmp/oda_in2")
    outp = Path("/tmp/oda_out2")
    inp.mkdir(exist_ok=True)
    outp.mkdir(exist_ok=True)
    for f in inp.glob("*"):
        f.unlink()
    for f in outp.glob("*"):
        f.unlink()
    shutil.copy(dxf_path, inp / dxf_path.name)
    env = dict(**os.environ)
    env["LD_LIBRARY_PATH"] = str(ODA_BIN.parent) + ":" + env.get("LD_LIBRARY_PATH", "")
    subprocess.run(
        [str(ODA_BIN), str(inp), str(outp), "ACAD2018", "DWG", "0", "1", "*.DXF"],
        check=False,
        env=env,
        capture_output=True,
    )
    dwg = outp / (dxf_path.stem + ".dwg")
    if dwg.exists():
        dest = DRAW / dwg.name
        shutil.copy(dwg, dest)
        print(f"DWG: {dest} ({dest.stat().st_size} bytes)")
        return dest
    print("DWG conversion failed", file=sys.stderr)
    return None


if __name__ == "__main__":
    dxf = merge()
    to_dwg(dxf)
    to_dwg(DRAW / "KP17.dxf")
