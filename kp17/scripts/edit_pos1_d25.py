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
    if "Пруток 22x5850" in text or "Пруток 25x5850" in text:
        return True
    if "1 A500C %%C22" in text or "1 A500C %%C25" in text:
        return True
    if re.search(r"\\C0;1\\PА500C", text) and "%%C" in text and (
        "22" in text or "25" in text
    ):
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


# UTF-16LE ∅22 / ∅25 inside MULTILEADER binary (DXF group 310)
_BIN_DIAM_22 = b"\x05\x22\x32\x00\x32\x00"  # ∅22
_BIN_DIAM_25 = b"\x05\x22\x32\x00\x35\x00"  # ∅25


def patch_mleader_binary_diam(raw: str, handles: set[str]) -> tuple[str, int]:
    """Patch embedded MLEADER binary so AutoCAD shows Ø25 (not stale Ø22)."""
    import binascii

    lines = raw.splitlines(keepends=True)
    wanted = {h.upper() for h in handles}
    n_patch = 0
    i = 0
    while i < len(lines) - 1:
        if lines[i].strip() != "5":
            i += 1
            continue
        h = lines[i + 1].strip().upper()
        if h not in wanted:
            i += 1
            continue
        start = i
        while start > 0 and lines[start].strip() != "0":
            start -= 1
        end = i + 2
        while end < len(lines) - 1:
            if lines[end].strip() == "0":
                nxt = lines[end + 1].strip()
                if nxt in {
                    "LINE",
                    "LWPOLYLINE",
                    "CIRCLE",
                    "ARC",
                    "DIMENSION",
                    "MULTILEADER",
                    "MTEXT",
                    "TEXT",
                    "INSERT",
                    "HATCH",
                    "WIPEOUT",
                    "ATTDEF",
                    "SOLID",
                    "SPLINE",
                    "ELLIPSE",
                    "POINT",
                    "ACAD_TABLE",
                    "VIEWPORT",
                    "3DFACE",
                    "SEQEND",
                }:
                    break
            end += 1
        hex_idxs = [j + 1 for j in range(start, end) if lines[j].strip() == "310"]
        if not hex_idxs:
            i = end
            continue
        chunks = [lines[j].strip() for j in hex_idxs]
        data = binascii.unhexlify("".join(chunks))
        if _BIN_DIAM_22 not in data:
            i = end
            continue
        data = data.replace(_BIN_DIAM_22, _BIN_DIAM_25, 1)
        new_hex = binascii.hexlify(data).decode("ascii").upper()
        pos = 0
        for j, old in zip(hex_idxs, chunks):
            n = len(old)
            piece = new_hex[pos : pos + n]
            pos += n
            if lines[j].endswith("\r\n"):
                ending = "\r\n"
            elif lines[j].endswith("\n"):
                ending = "\n"
            else:
                ending = ""
            lines[j] = piece + ending
        n_patch += 1
        i = end
    return "".join(lines), n_patch


def widen_rect_poly(poly, *, keep_right: bool = False) -> float:
    """Widen a ~22-wide rectangle polyline to NEW_D. Returns new width."""
    pts = list(poly.get_points("xy"))
    xs = [p[0] for p in pts]
    minx, maxx = min(xs), max(xs)
    cx = (minx + maxx) / 2
    new_pts = []
    if abs(cx) < 1.0:
        # centered (±11 → ±12.5), e.g. *U24
        half = NEW_D / 2
        for x, y in pts:
            nx = half if x > 0 else (-half if x < 0 else 0.0)
            new_pts.append((nx, y))
    elif keep_right:
        # schema bars: keep right edge, extend left (like existing Ø25 50C26)
        for x, y in pts:
            if abs(x - minx) < 0.2:
                nx = maxx - NEW_D
            elif abs(x - maxx) < 0.2:
                nx = maxx
            else:
                nx = x
            new_pts.append((nx, y))
    else:
        # cage view blocks: keep left edge, extend right
        for x, y in pts:
            if abs(x - minx) < 0.2:
                nx = minx
            elif abs(x - maxx) < 0.2:
                nx = minx + NEW_D
            else:
                nx = x
            new_pts.append((nx, y))
    poly.set_points(new_pts)
    nxs = [p[0] for p in new_pts]
    return max(nxs) - min(nxs)


def redraw_pos1_bar_block(block) -> None:
    """Widen 22×5850 bar rectangle + wipeout fill to Ø25."""
    poly = next(e for e in block if e.dxftype() == "LWPOLYLINE")
    widen_rect_poly(poly, keep_right=False)
    new_pts = list(poly.get_points("xy"))

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


def redraw_pos1_schema_bars(msp) -> int:
    """Widen modelspace 22×5850 bars on «Схема расположения» to Ø25."""
    n = 0
    for e in msp.query("LWPOLYLINE"):
        pts = list(e.get_points("xy"))
        if len(pts) < 4:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        cy = (max(ys) + min(ys)) / 2
        # pos.1 schema bars only (not 3050/8450 of pos.2/8)
        if abs(w - 22) > 0.6 or abs(h - BAR_LEN) > 1.0:
            continue
        if not (-110000 < cy < -65000):
            continue
        new_w = widen_rect_poly(e, keep_right=True)
        print("schema bar", e.dxf.handle, f"-> {new_w:.0f}×{BAR_LEN:.0f}")
        n += 1
    return n


def shift_dim_block_to_diameter(doc, dim, new_d: float = NEW_D) -> None:
    """Rewrite anonymous *D block so AutoCAD measures new_d (not stale 22)."""
    gname = dim.dxf.get("geometry") if dim.dxf.hasattr("geometry") else None
    if not gname:
        return
    block = doc.blocks.get(gname)
    if block is None:
        return

    point_xs = [e.dxf.location.x for e in block.query("POINT")]
    if len(point_xs) < 2:
        return
    old_left, old_right = min(point_xs), max(point_xs)
    old_span = old_right - old_left
    if abs(old_span - new_d) < 0.05:
        # already correct width; still fix text if needed
        pass
    elif abs(old_span - 22) > 0.6:
        print("skip dim block", gname, "unexpected span", old_span)
        return

    new_left = old_right - new_d
    delta = new_left - old_left

    def map_x(x: float) -> float:
        # keep right-side geometry; shift everything to the left of right edge
        if x >= old_right - 0.05:
            return x
        return x + delta

    def map_vec(v):
        return (map_x(v.x), v.y, v.z)

    for ent in block:
        dt = ent.dxftype()
        if dt == "LINE":
            ent.dxf.start = map_vec(ent.dxf.start)
            ent.dxf.end = map_vec(ent.dxf.end)
        elif dt == "POINT":
            ent.dxf.location = map_vec(ent.dxf.location)
        elif dt == "INSERT":
            ent.dxf.insert = map_vec(ent.dxf.insert)
        elif dt in ("MTEXT", "TEXT"):
            # text insert can stay; content must show Ø25
            if dt == "TEXT":
                if "%%C22" in ent.dxf.text:
                    ent.dxf.text = ent.dxf.text.replace("%%C22", "%%C25")
            else:
                if "%%C22" in ent.text:
                    ent.text = ent.text.replace("%%C22", "%%C25")
                # also handle plain measured rendering leftovers
                if ent.text.strip() in ("\\A1;22", "\\A1;%%C22"):
                    ent.text = "\\A1;%%C25"

    # Sync DIMENSION entity defpoints / measurement / visible override
    p2, p3 = dim.dxf.defpoint2, dim.dxf.defpoint3
    if p2.x >= p3.x:
        dim.dxf.defpoint2 = (old_right, p2.y, p2.z)
        dim.dxf.defpoint3 = (new_left, p3.y, p3.z)
    else:
        dim.dxf.defpoint2 = (new_left, p2.y, p2.z)
        dim.dxf.defpoint3 = (old_right, p3.y, p3.z)
    dp = dim.dxf.defpoint
    dim.dxf.defpoint = (map_x(dp.x), dp.y, dp.z)
    dim.dxf.text = "%%C25"
    if dim.dxf.hasattr("actual_measurement"):
        dim.dxf.actual_measurement = new_d
    print(
        "dim block",
        gname,
        f"span {old_span:.0f}→{new_d:.0f}",
        f"left {old_left:.1f}→{new_left:.1f}",
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

    # 2) Schema layout bars (modelspace 22×5850 → 25×5850)
    n_schema = redraw_pos1_schema_bars(msp)
    print("schema bars redrawn", n_schema)

    # 3) Section circles 1-1…7-7 (kotlovan), pos.1 only: r 11 → 12.5
    for leaf in POS1_CIRCLE_LEAVES:
        for c in doc.blocks.get(leaf).query("CIRCLE"):
            c.dxf.radius = 12.5
        print("section circle", leaf, "-> r=12.5")

    # 4) Schema diameter dimensions for pos.1 — rewrite *D blocks (AutoCAD source of truth)
    n_dim = 0
    for e in msp.query("DIMENSION"):
        t = e.dxf.text or ""
        if "%%C" not in t:
            continue
        p2, p3 = e.dxf.defpoint2, e.dxf.defpoint3
        dist = math.hypot(p2.x - p3.x, p2.y - p3.y)
        # original or already-widened
        if not (abs(dist - 22) < 0.5 or abs(dist - 25) < 0.5):
            continue
        mid = ((p2.x + p3.x) / 2, (p2.y + p3.y) / 2)
        dmin = min(math.hypot(mid[0] - tx, mid[1] - ty) for tx, ty in POS1_DIM_TIPS)
        if dmin > 1500:
            continue
        # Prefer block POINT span (authoritative for AutoCAD regen)
        shift_dim_block_to_diameter(doc, e, NEW_D)
        n_dim += 1
    print("schema Ø dims", n_dim)

    # 5) Tables
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

    # 6) Callouts (text + embedded binary — AutoCAD reads group 310)
    pos1_leader_handles: set[str] = set()
    for e in msp.query("MULTILEADER"):
        ctx = getattr(e, "context", None)
        if not (ctx and getattr(ctx, "mtext", None)):
            continue
        content = ctx.mtext.default_content or ""
        if is_pos1_callout(content):
            ctx.mtext.default_content = fix_pos1_callout(content)
            pos1_leader_handles.add(e.dxf.handle)
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
    raw = "".join(out)
    raw, n_bin = patch_mleader_binary_diam(raw, pos1_leader_handles)
    print("mleader binary Ø22→Ø25", n_bin, "handles", sorted(pos1_leader_handles))
    dst.write_text(raw, encoding="utf-8")


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
    print(f"pos.1: Ø22→Ø25 (cage+schema+sections+dims+tables), total {NEW_TOTAL}")
    edit_doc(src, OUT_DXF)
    shutil.copy(OUT_DXF, ROOT / "drawings" / "KP17.dxf")
    to_dwg(OUT_DXF, OUT_DWG)
    doc = ezdxf.readfile(OUT_DXF)
    msp = doc.modelspace()
    for bname in ("*U24", "*U34"):
        poly = next(e for e in doc.blocks.get(bname) if e.dxftype() == "LWPOLYLINE")
        pts = list(poly.get_points("xy"))
        xs = [p[0] for p in pts]
        print(bname, "width", max(xs) - min(xs))
    for leaf in POS1_CIRCLE_LEAVES:
        r = list(doc.blocks.get(leaf).query("CIRCLE"))[0].dxf.radius
        print(leaf, "r", r)
    for e in msp.query("LWPOLYLINE"):
        pts = list(e.get_points("xy"))
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        cy = (max(ys) + min(ys)) / 2
        if abs(h - BAR_LEN) < 1 and -110000 < cy < -65000 and abs(w - 25) < 0.1:
            print("schema", e.dxf.handle, f"{w:.0f}x{h:.0f}")
    print("done", OUT_DXF)


if __name__ == "__main__":
    main()
