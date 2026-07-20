#!/usr/bin/env python3
"""Change KP17 position 1 rebar Ø22 → Ø25: redraw bars + recalc tables.

Updates on the original DWG:
  - Geometry blocks *U24 / *U34 (22×5850 → 25×5850) + WIPEOUT fills
  - MULTILEADER callouts for поз. 1 only (поз. 2/6/8 stay Ø22)
  - Спецификация *T37 and ведомость расхода стали *T39
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
REF_DXF = Path("/tmp/oda_src_out/KP17_original.dxf")
REF_DWG = ROOT / "reference" / "KP17_original.dwg"
OUT_DXF = ROOT / "reference" / "KP17_pos1_d25.dxf"
OUT_DWG = ROOT / "drawings" / "KP17.dwg"
ODA = Path("/tmp/squashfs-root/usr/bin/ODAFileConverter")

OLD_ROW = 488.88
NEW_UNIT = round((45.08 / 11.7) * 5.85, 2)  # 22.54
NEW_ROW = round(NEW_UNIT * 28, 2)  # 631.12
NEW_TOTAL = round(6474.15 - OLD_ROW + NEW_ROW, 2)
NEW_D22 = round(1666.76 - OLD_ROW, 2)
NEW_D25 = round(631.12 + NEW_ROW, 2)
NEW_A500 = round(6017.00 - OLD_ROW + NEW_ROW, 2)
NEW_ARM = round(6066.00 - OLD_ROW + NEW_ROW, 2)
NEW_D = 25.0
BAR_LEN = 5850.0

# Section circle leaf blocks for pos.1 on kotlovan side (разрезы 1-1…7-7)
POS1_CIRCLE_LEAVES = ("*U234", "*U248", "*U268", "*U285", "*U289")

# Schema diameter dim tips for pos.1 (ISO callouts)
POS1_DIM_TIPS = (
    (9442.227284744735, -99966.02281184404),
    (13209.34392743162, -71172.04711154554),
)


def fmt_comma(x: float) -> str:
    return f"{x:.2f}".replace(".", ",")


def ensure_source_dxf() -> Path:
    if REF_DXF.exists() and REF_DXF.stat().st_size > 1_000_000:
        return REF_DXF
    if not REF_DWG.exists():
        raise SystemExit(f"Missing {REF_DWG}")
    if not ODA.exists():
        raise SystemExit("ODA File Converter not found")
    inp, outp = Path("/tmp/oda_src_in"), Path("/tmp/oda_src_out")
    inp.mkdir(exist_ok=True)
    outp.mkdir(exist_ok=True)
    for f in inp.glob("*"):
        f.unlink()
    shutil.copy(REF_DWG, inp / "KP17_original.dwg")
    env = {**os.environ, "LD_LIBRARY_PATH": str(ODA.parent)}
    subprocess.run(
        [str(ODA), str(inp), str(outp), "ACAD2018", "DXF", "0", "1", "*.DWG"],
        check=False,
        env=env,
        capture_output=True,
    )
    return outp / "KP17_original.dxf"


def is_pos1_callout(text: str) -> bool:
    if "Пруток 22x5850" in text:
        return True
    if "1 A500C %%C22" in text:
        return True
    if re.search(r"\\C0;1\\PА500C", text) and "%%C" in text and "22" in text:
        return True
    return False


def fix_pos1_callout(text: str) -> str:
    text = text.replace("Пруток 22x5850", "Пруток 25x5850")
    text = text.replace("1 A500C %%C22", "1 A500C %%C25")
    text = re.sub(
        r"(\{\\C0;1\\PА500C.*?%%C[^0-9]{0,120}?)22(\s)",
        lambda m: m.group(1) + "25" + m.group(2),
        text,
        count=1,
    )
    return text


def redraw_pos1_bar_block(block) -> None:
    """Widen 22×5850 bar rectangle + wipeout fill to Ø25."""
    poly = next(e for e in block if e.dxftype() == "LWPOLYLINE")
    pts = list(poly.get_points("xy"))
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    cx = (minx + maxx) / 2
    new_pts = []
    if abs(cx) < 1.0:
        # centered (±11 → ±12.5), e.g. *U24
        half = NEW_D / 2
        for x, y in pts:
            nx = half if x > 0 else (-half if x < 0 else 0.0)
            new_pts.append((nx, y))
    else:
        # keep left edge, extend right to width 25 (like existing Ø25 *U22)
        for x, y in pts:
            if abs(x - minx) < 0.2:
                nx = minx
            elif abs(x - maxx) < 0.2:
                nx = minx + NEW_D
            else:
                nx = x
            new_pts.append((nx, y))
    poly.set_points(new_pts)

    wipe = next((e for e in block if e.dxftype() == "WIPEOUT"), None)
    if wipe is None:
        return
    nxs = [p[0] for p in new_pts]
    nys = [p[1] for p in new_pts]
    insert_x, insert_y = min(nxs), min(nys)
    wipe.dxf.insert = (insert_x, insert_y, 0)
    wipe.dxf.u_pixel = (BAR_LEN, 0, 0)
    wipe.dxf.v_pixel = (0, BAR_LEN, 0)
    span = NEW_D / BAR_LEN
    wipe.set_boundary_path(
        [
            Vec2(-0.5, -0.5),
            Vec2(-0.5 + span, -0.5),
            Vec2(-0.5 + span, 0.5),
            Vec2(-0.5, 0.5),
            Vec2(-0.5, -0.5),
        ]
    )


def edit_doc(src: Path, dst: Path) -> None:
    import math

    shutil.copy(src, dst)
    doc = ezdxf.readfile(dst)
    msp = doc.modelspace()

    # 1) Redraw bars on both cage views
    for bname in ("*U24", "*U34"):
        redraw_pos1_bar_block(doc.blocks.get(bname))
        print("redrawn", bname)

    # 2) Section circles 1-1…7-7 (kotlovan), pos.1 only: r 11 → 12.5
    for leaf in POS1_CIRCLE_LEAVES:
        for c in doc.blocks.get(leaf).query("CIRCLE"):
            c.dxf.radius = 12.5
        print("section circle", leaf, "-> r=12.5")

    # 3) Schema diameter dimensions for pos.1: span 22 → 25, text %%C25
    n_dim = 0
    for e in msp.query("DIMENSION"):
        t = e.dxf.text or ""
        if "%%C" not in t:
            continue
        p2, p3 = e.dxf.defpoint2, e.dxf.defpoint3
        dist = math.hypot(p2.x - p3.x, p2.y - p3.y)
        if abs(dist - 22) > 0.5:
            continue
        mid = ((p2.x + p3.x) / 2, (p2.y + p3.y) / 2)
        dmin = min(math.hypot(mid[0] - tx, mid[1] - ty) for tx, ty in POS1_DIM_TIPS)
        if dmin > 1500:
            continue
        tip = min(POS1_DIM_TIPS, key=lambda t: math.hypot(mid[0] - t[0], mid[1] - t[1]))
        if abs(p2.x - tip[0]) <= abs(p3.x - tip[0]):
            new_p3_x = p2.x - NEW_D if p3.x < p2.x else p2.x + NEW_D
            e.dxf.defpoint3 = (new_p3_x, p3.y, p3.z)
        else:
            new_p2_x = p3.x - NEW_D if p2.x < p3.x else p3.x + NEW_D
            e.dxf.defpoint2 = (new_p2_x, p2.y, p2.z)
        e.dxf.text = "%%C25"
        n_dim += 1
    print("schema Ø dims", n_dim)

    # 4) Tables
    for e in doc.blocks.get("*T37").query("MTEXT"):
        t, y = e.text, e.dxf.insert.y
        if abs(y + 3750) < 5:
            if "Пруток 22x5850" in t:
                e.text = t.replace("Пруток 22x5850", "Пруток 25x5850")
            elif t.strip() == "17.46":
                e.text = f"{NEW_UNIT:.2f}"
            elif t.strip() in ("488,88", "488.88"):
                e.text = fmt_comma(NEW_ROW)
        if "6474" in t and abs(y + 21558.2) < 2:
            e.text = fmt_comma(NEW_TOTAL) if "," in t else f"{NEW_TOTAL:.2f}"

    for e in doc.blocks.get("*T39").query("MTEXT"):
        t, x = e.text.strip(), e.dxf.insert.x
        if t == "1666.76":
            e.text = f"{NEW_D22:.2f}"
        elif t == "631.12" and abs(x - 9905.3) < 150:
            e.text = f"{NEW_D25:.2f}"
        elif t == "6017,00":
            e.text = fmt_comma(NEW_A500)
        elif t == "6066,00":
            e.text = fmt_comma(NEW_ARM)
        elif t in ("6474.15", "6474,15") and abs(x - 23314.9) < 300:
            e.text = f"{NEW_TOTAL:.2f}" if t == "6474.15" else fmt_comma(NEW_TOTAL)

    # 5) Callouts
    for e in msp.query("MULTILEADER"):
        ctx = getattr(e, "context", None)
        if not (ctx and getattr(ctx, "mtext", None)):
            continue
        content = ctx.mtext.default_content or ""
        if is_pos1_callout(content):
            ctx.mtext.default_content = fix_pos1_callout(content)
    for e in msp.query("MTEXT"):
        if is_pos1_callout(e.text):
            e.text = fix_pos1_callout(e.text)

    doc.saveas(dst)

    raw = dst.read_text(encoding="utf-8", errors="ignore")
    for a, b in [
        ("Пруток 22x5850", "Пруток 25x5850"),
        ("1 A500C %%C22", "1 A500C %%C25"),
        ("17.46", f"{NEW_UNIT:.2f}"),
        ("488,88", fmt_comma(NEW_ROW)),
        ("488.88", f"{NEW_ROW:.2f}"),
        ("1666.76", f"{NEW_D22:.2f}"),
        ("6017,00", fmt_comma(NEW_A500)),
        ("6066,00", fmt_comma(NEW_ARM)),
        ("6474,15", fmt_comma(NEW_TOTAL)),
        ("6474.15", f"{NEW_TOTAL:.2f}"),
    ]:
        raw = raw.replace(a, b)
    raw = re.sub(
        r"(\{\\C0;1\\PА500C \\fISOCPEUR\|b0\|i0\|c204\|p34;%%C\\fISOCPEUR\|b0\|i0\|c0\|p34;)22( )",
        r"\g<1>25\2",
        raw,
    )
    out, i = [], 0
    while True:
        j = raw.find("1177.88", i)
        if j < 0:
            out.append(raw[i:])
            break
        out.append(raw[i:j])
        window_end = min(len(raw), j + 500)
        out.append(raw[j:window_end].replace("631.12", f"{NEW_D25:.2f}"))
        i = window_end
    dst.write_text("".join(out), encoding="utf-8")


def to_dwg(dxf: Path, dwg: Path) -> None:
    if not ODA.exists():
        print("ODA missing — DXF only")
        return
    inp, outp = Path("/tmp/oda_edit_in"), Path("/tmp/oda_edit_out")
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
        shutil.copy(produced, ROOT / "reference" / "KP17_pos1_d25.dwg")
        print("DWG", dwg, produced.stat().st_size)


def main():
    src = ensure_source_dxf()
    print("source", src)
    print(f"pos.1: Ø22→Ø25 (bars+sections+dims+tables), total {NEW_TOTAL}")
    edit_doc(src, OUT_DXF)
    shutil.copy(OUT_DXF, ROOT / "drawings" / "KP17.dxf")
    to_dwg(OUT_DXF, OUT_DWG)
    doc = ezdxf.readfile(OUT_DXF)
    for bname in ("*U24", "*U34"):
        poly = next(e for e in doc.blocks.get(bname) if e.dxftype() == "LWPOLYLINE")
        pts = list(poly.get_points("xy"))
        xs = [p[0] for p in pts]
        print(bname, "width", max(xs) - min(xs))
    for leaf in POS1_CIRCLE_LEAVES:
        r = list(doc.blocks.get(leaf).query("CIRCLE"))[0].dxf.radius
        print(leaf, "r", r)
    print("done", OUT_DXF)


if __name__ == "__main__":
    main()
