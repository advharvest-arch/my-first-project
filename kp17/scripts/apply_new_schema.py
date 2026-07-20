#!/usr/bin/env python3
"""Apply new left-side reinforcement schema to the full KP17 drawing.

Source: reference/KP17_new_schema.dxf (from «KP17 (новая схема).dwg»)
- Replace main/right schema bars to match new schema
- Update callouts (text + MLEADER binary ∅)
- Resize cage leaf bar blocks
- Update section circles on котлован
- Recalculate *T37 / *T39
"""
from __future__ import annotations

import binascii
import math
import os
import re
import shutil
import subprocess
from pathlib import Path

import ezdxf
from ezdxf.math import Vec2

ROOT = Path(__file__).resolve().parents[2]
SRC_DXF = ROOT / "reference" / "KP17_new_schema.dxf"
SRC_DWG = ROOT / "reference" / "KP17 (новая схема).dwg"
OUT_DXF = ROOT / "reference" / "KP17_new_applied.dxf"
OUT_DWG = ROOT / "drawings" / "KP17.dwg"
ODA = Path("/tmp/squashfs-root/usr/bin/ODAFileConverter")

# title-based alignment: new schema (x<0) → main schema
DX_MAIN = 11644.34776850127 - (-13275.94196504605)  # 24920.2897...
DX_RIGHT = DX_MAIN + (32872.4 - 9824.5)  # main→right side labels offset

KG_M = {
    22: 2.9836,
    25: 3.8530,
    28: 4.83,
    32: 6.3128,
    36: 7.9897,
}

# pos: (diam, length_mm, qty)
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

# Old cage leaf blocks → new (diam, length). Role by current view usage.
# котлован: *U34/35 pos1-ish, *U16/17 pos3, *U226/227 pos6, *U224/225 pos5, *U30/31 pos8
# грунт: *U26/27 pos2, *U18/21 pos4, *U22/23 pos7, *U24/25 pos1
CAGE_LEAF_RESIZE = {
    # грунт view
    "*U26": (22, 1600),   # was pos2 22x3050 → new pos2 22x1600 (still грунт? new pos2 is котлован — length match pos2)
    "*U18": (36, 11700),  # was pos4 32x11700 → new pos4 36x11700
    "*U22": (22, 5850),   # was pos7 25x11700 → new pos7 22x5850
    "*U24": (22, 11700),  # was pos1 25x5850 → new pos1 22x11700
    # котлован view
    "*U34": (22, 11700),  # was pos1 25x5850 → new pos1 22x11700
    "*U16": (36, 11700),  # was pos3 36x11700 → new pos4 36x11700 (same size)
    "*U226": (32, 5850),  # was pos6 22x11700 → new pos6 32x5850
    "*U224": (28, 11700), # was pos5 36x5850 → new pos5 28x11700
    "*U30": (25, 5850),   # was pos8 22x8450 → new pos8 25x5850
}

# Section circle leaves on котлован (from prior mapping) — update radii to new котлован diams
# New котлован positions: 1Ø22, 2Ø22, 4Ø36, 8Ø25
# Keep previous leaf handles but set radius from new diam/2 where we know pos.
SECTION_CIRCLE_RADIUS = {
    # prior pos.1 leaves on котлован → now still often pos-related; set by expected new diams
    # Will be updated more precisely after scanning marks.
}

_BIN_DIAM = {
    d: (b"\x05\x22" + f"{d}".encode("utf-16le"))  # ∅NN
    for d in (22, 25, 28, 32, 36)
}


def fmt_comma(x: float) -> str:
    return f"{x:.2f}".replace(".", ",")


def unit_mass(d: int, length: int) -> float:
    return round(KG_M[d] * length / 1000.0, 2)


def row_mass(d: int, length: int, qty: int) -> float:
    return round(unit_mass(d, length) * qty, 2)


def ensure_source() -> Path:
    if SRC_DXF.exists() and SRC_DXF.stat().st_size > 1_000_000:
        return SRC_DXF
    if not SRC_DWG.exists():
        raise SystemExit(f"Missing {SRC_DWG}")
    inp, outp = Path("/tmp/oda_new_in"), Path("/tmp/oda_new_out")
    inp.mkdir(exist_ok=True)
    outp.mkdir(exist_ok=True)
    for f in inp.glob("*"):
        f.unlink()
    shutil.copy(SRC_DWG, inp / "KP17_new_schema.dwg")
    env = {**os.environ, "LD_LIBRARY_PATH": str(ODA.parent)}
    subprocess.run(
        [str(ODA), str(inp), str(outp), "ACAD2018", "DXF", "0", "1", "*.DWG"],
        check=False,
        env=env,
        capture_output=True,
    )
    return outp / "KP17_new_schema.dxf"


def poly_bbox(e):
    pts = list(e.get_points("xy"))
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), max(xs), min(ys), max(ys), pts


def is_schema_bar(e, x0, x1) -> bool:
    if e.dxftype() != "LWPOLYLINE":
        return False
    minx, maxx, miny, maxy, pts = poly_bbox(e)
    w, h = maxx - minx, maxy - miny
    cx = (minx + maxx) / 2
    cy = (miny + maxy) / 2
    return x0 < cx < x1 and -102000 < cy < -69000 and 15 < w < 45 and h > 500


def collect_new_schema_bars(msp):
    bars = []
    for e in msp.query("LWPOLYLINE"):
        if not is_schema_bar(e, -25000, -5000):
            continue
        minx, maxx, miny, maxy, pts = poly_bbox(e)
        bars.append(
            {
                "w": maxx - minx,
                "h": maxy - miny,
                "minx": minx,
                "maxx": maxx,
                "miny": miny,
                "maxy": maxy,
                "pts": pts,
                "handle": e.dxf.handle,
            }
        )
    return bars


def replace_schema_bars(msp, bars, dx: float, x0: float, x1: float) -> int:
    """Delete old bars in target band; add translated copies of new bars."""
    old = [e for e in msp.query("LWPOLYLINE") if is_schema_bar(e, x0, x1)]
    for e in old:
        msp.delete_entity(e)
    n = 0
    for b in bars:
        new_pts = [(x + dx, y) for x, y in b["pts"]]
        pl = msp.add_lwpolyline(new_pts, close=False)
        pl.dxf.layer = "0"
        n += 1
    print(f"schema bars @dx={dx:.1f}: removed {len(old)}, added {n}")
    return n


def redraw_leaf_bar(block, new_d: float, new_len: float) -> None:
    """Resize leaf bar rectangle (+ wipeout) to new diameter × length."""
    poly = next(e for e in block if e.dxftype() == "LWPOLYLINE")
    pts = list(poly.get_points("xy"))
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    old_w = maxx - minx
    old_h = maxy - miny
    cx = (minx + maxx) / 2
    # Keep vertical orientation (height = length)
    if old_h >= old_w:
        # vertical bar
        if abs(cx) < 1.0:
            half = new_d / 2
            # keep vertical center of span; extend/shrink about mid y
            midy = (miny + maxy) / 2
            y0, y1 = midy - new_len / 2, midy + new_len / 2
            # preserve original end preference if one end near 0 or known anchors
            # Prefer keep maxy (top) like many bars, else keep miny
            if abs(maxy) > abs(miny):
                y1 = maxy
                y0 = maxy - new_len
            else:
                y0 = miny
                y1 = miny + new_len
            new_pts = []
            for x, y in pts:
                nx = half if x > 0 else (-half if x < 0 else 0.0)
                # map old y ends to new ends
                if abs(y - maxy) <= abs(y - miny):
                    ny = y1
                else:
                    ny = y0
                new_pts.append((nx, ny))
        else:
            # keep left edge for width; keep top for length when possible
            y1 = maxy
            y0 = maxy - new_len
            new_pts = []
            for x, y in pts:
                if abs(x - minx) < 0.2:
                    nx = minx
                elif abs(x - maxx) < 0.2:
                    nx = minx + new_d
                else:
                    nx = x
                ny = y1 if abs(y - maxy) <= abs(y - miny) else y0
                new_pts.append((nx, ny))
    else:
        # horizontal — unexpected for these leaves; skip
        print("skip unusual orientation", block.name)
        return
    poly.set_points(new_pts)

    wipe = next((e for e in block if e.dxftype() == "WIPEOUT"), None)
    if wipe is None:
        return
    nxs = [p[0] for p in new_pts]
    nys = [p[1] for p in new_pts]
    insert_x, insert_y = min(nxs), min(nys)
    wipe.dxf.insert = (insert_x, insert_y, 0)
    # wipeout UV in prior scripts used BAR_LEN on both axes; keep length-based
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


def update_callout_text(text: str) -> str | None:
    """Rewrite pos 1..8 diameter in callout text to NEW_SPEC. Returns new text or None."""
    original = text

    # GOST-style: "1 A500C %%C25" / "8 A500C %%C22"
    def repl_gost(m):
        pos = int(m.group(1))
        if pos in NEW_SPEC:
            return f"{pos} A500C %%C{NEW_SPEC[pos][0]}"
        return m.group(0)

    text = re.sub(r"([1-8]) A500C %%C\d+", repl_gost, text)

    # ISO-style fragmented: {\C0;1\PА500C ... %%C ... 25 ...}
    def repl_iso(m):
        pos = int(m.group(1))
        if pos not in NEW_SPEC:
            return m.group(0)
        d = NEW_SPEC[pos][0]
        # replace first diameter number after %%C
        body = m.group(0)
        return re.sub(
            r"(%%C[^0-9]{0,120}?)(\d{2})(\s)",
            lambda mm: mm.group(1) + str(d) + mm.group(3),
            body,
            count=1,
        )

    text = re.sub(
        r"\{\\C0;([1-8])\\PА500C.*?мм\}",
        repl_iso,
        text,
        flags=re.DOTALL,
    )

    # Compact ISO without A500: "1Ø22" patterns in plain/default after strip — also "%%C22" near leading pos
    # Handle leaders like content already partially plain in default_content with ∅ in binary only

    if text == original:
        # try simpler patterns: ";1 A500" already handled; "NØdd" won't appear in DXF (%%C)
        return None
    return text


def patch_mleader_binary_for_handles(raw: str, handle_to_diam: dict[str, int]) -> tuple[str, int]:
    lines = raw.splitlines(keepends=True)
    wanted = {h.upper(): d for h, d in handle_to_diam.items()}
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
        target_d = wanted[h]
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
        data = bytearray(binascii.unhexlify("".join(chunks)))
        # Replace any existing ∅22/25/28/32/36 with target
        replaced = False
        for d_old, pat in _BIN_DIAM.items():
            idx = data.find(pat)
            if idx >= 0:
                new_pat = _BIN_DIAM[target_d]
                data[idx : idx + len(pat)] = new_pat
                replaced = True
                break
        if not replaced:
            i = end
            continue
        new_hex = binascii.hexlify(bytes(data)).decode("ascii").upper()
        pos = 0
        for j, old in zip(hex_idxs, chunks):
            n = len(old)
            piece = new_hex[pos : pos + n]
            pos += n
            ending = "\r\n" if lines[j].endswith("\r\n") else ("\n" if lines[j].endswith("\n") else "")
            lines[j] = piece + ending
        n_patch += 1
        i = end
    return "".join(lines), n_patch


def shift_dim_block_to_diameter(doc, dim, new_d: float) -> None:
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
        for ent in block.query("MTEXT TEXT"):
            gt = ent.dxf.text if ent.dxftype() == "TEXT" else ent.text
            if "%%C" in gt:
                new_gt = re.sub(r"%%C\d+", f"%%C{int(new_d)}", gt)
                if ent.dxftype() == "TEXT":
                    ent.dxf.text = new_gt
                else:
                    ent.text = new_gt
        dim.dxf.text = f"%%C{int(new_d)}"
        if dim.dxf.hasattr("actual_measurement"):
            dim.dxf.actual_measurement = float(new_d)
        return
    new_left = old_right - new_d
    delta = new_left - old_left

    def map_x(x: float) -> float:
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
            gt = ent.dxf.text if dt == "TEXT" else ent.text
            if "%%C" in gt:
                new_gt = re.sub(r"%%C\d+", f"%%C{int(new_d)}", gt)
                if dt == "TEXT":
                    ent.dxf.text = new_gt
                else:
                    ent.text = new_gt
    p2, p3 = dim.dxf.defpoint2, dim.dxf.defpoint3
    if p2.x >= p3.x:
        dim.dxf.defpoint2 = (old_right, p2.y, p2.z)
        dim.dxf.defpoint3 = (new_left, p3.y, p3.z)
    else:
        dim.dxf.defpoint2 = (new_left, p2.y, p2.z)
        dim.dxf.defpoint3 = (old_right, p3.y, p3.z)
    dp = dim.dxf.defpoint
    dim.dxf.defpoint = (map_x(dp.x), dp.y, dp.z)
    dim.dxf.text = f"%%C{int(new_d)}"
    if dim.dxf.hasattr("actual_measurement"):
        dim.dxf.actual_measurement = float(new_d)


def update_schema_diameter_dims(doc, msp, new_bars_main) -> int:
    """Match diameter dims on main schema to nearby new bars and set diameter."""
    n = 0
    for e in msp.query("DIMENSION"):
        t = e.dxf.text or ""
        if "%%C" not in t:
            continue
        p2, p3 = e.dxf.defpoint2, e.dxf.defpoint3
        mid = ((p2.x + p3.x) / 2, (p2.y + p3.y) / 2)
        if not (8500 < mid[0] < 16000 and -102000 < mid[1] < -69000):
            continue
        # nearest new bar by x proximity
        best = None
        best_d = 1e18
        for b in new_bars_main:
            cx = (b["minx"] + b["maxx"]) / 2 + DX_MAIN
            cy = (b["miny"] + b["maxy"]) / 2
            # dim is near bar mid-x and somewhere along height
            d = abs(mid[0] - cx) + 0.02 * abs(mid[1] - cy)
            if d < best_d:
                best_d = d
                best = b
        if best is None or best_d > 800:
            continue
        new_d = best["w"]
        # skip if not a known diam
        if abs(new_d - round(new_d)) > 0.2:
            continue
        new_d = float(round(new_d))
        shift_dim_block_to_diameter(doc, e, new_d)
        n += 1
    print("schema diameter dims updated", n)
    return n


def update_tables(doc) -> None:
    rows = {}
    for pos, (d, L, qty) in NEW_SPEC.items():
        u = unit_mass(d, L)
        r = row_mass(d, L, qty)
        rows[pos] = {
            "name": f"Пруток {d}x{L}-А500С ГОСТ 34028-2016",
            "unit": u,
            "row": r,
            "qty": qty,
            "d": d,
            "L": L,
        }
    sum_1_8 = round(sum(r["row"] for r in rows.values()), 2)

    # Read old total from *T37 to compute delta
    old_1_8 = 631.12 + 127.40 + 1308.72 + 1034.04 + 654.36 + 488.74 + 631.12 + 352.94
    # current file may already have pos1 as 631.12 (Ø25) — use that baseline
    old_total = 6616.39
    new_total = round(old_total - old_1_8 + sum_1_8, 2)

    # Steel by diameter from pos1-8 + keep other rows contribution roughly:
    # Recompute A500C diam columns from scratch for diam used in pos1-8,
    # using only pos1-8 changes vs old pos1-8 diam buckets.

    print("new rows:")
    for pos in range(1, 9):
        r = rows[pos]
        print(f"  {pos}: {r['name']} qty={r['qty']} unit={r['unit']} row={fmt_comma(r['row'])}")
    print("sum1-8", sum_1_8, "new_total", new_total)

    t37 = doc.blocks.get("*T37")
    # Map by position number cell at known y rows (from earlier dump)
    # y positions for pos rows
    y_of_pos = {
        1: -3750,
        2: -4550,
        3: -5350,
        4: -6150,
        5: -6950,
        6: -7750,
        7: -8550,
        8: -9417,
    }
    for e in t37.query("MTEXT"):
        y = e.dxf.insert.y
        t = e.text
        for pos, y0 in y_of_pos.items():
            if abs(y - y0) > 5 and not (pos == 8 and abs(y + 9417) < 5):
                continue
            if abs(y - y0) > 30:
                continue
            r = rows[pos]
            if "Пруток" in t:
                # preserve formatting wrappers if present
                if "Пруток" in t:
                    e.text = re.sub(
                        r"Пруток \d+x\d+-А500С ГОСТ 34028-2016",
                        r["name"].replace("Пруток ", "Пруток ").split("Пруток ")[-1]
                        and r["name"][r["name"].find("Пруток") :],
                        t,
                    )
                    # simpler: replace whole known patterns
                    e.text = re.sub(
                        r"Пруток \d+x\d+-А[0-9А-ЯCС]+ ГОСТ 34028-2016",
                        r["name"],
                        t,
                    )
                    if "Пруток" in e.text and r["name"] not in e.text:
                        # fallback replace between markers
                        e.text = t.replace(t[t.find("Пруток") : t.find("ГОСТ") + len("ГОСТ 34028-2016")], r["name"])
            else:
                plain = re.sub(r"\\[^;]*;", "", t).strip().strip("{}")
                # unit mass like 22.54 or 9.10
                if re.fullmatch(r"\d+\.\d{2}", plain):
                    e.text = f"{r['unit']:.2f}"
                elif re.fullmatch(r"\d+,\d{2}", plain):
                    e.text = fmt_comma(r["row"]) if float(plain.replace(",", ".")) > r["unit"] * 2 else fmt_comma(r["unit"])
                # carefully: row masses are comma, unit often dot
                if "," in plain and re.fullmatch(r"\d+,\d{2}", plain):
                    e.text = fmt_comma(r["row"])
                elif "." in plain and re.fullmatch(r"\d+\.\d{2}", plain):
                    e.text = f"{r['unit']:.2f}"

    # Fix name replacements more reliably — second pass by y and content type
    for e in t37.query("MTEXT"):
        y = e.dxf.insert.y
        t = e.text
        for pos, y0 in y_of_pos.items():
            if abs(y - y0) > 30:
                continue
            r = rows[pos]
            if "Пруток" in t and "А500С" in t:
                # keep any wrapping braces/formatting; replace designation core
                e.text = re.sub(
                    r"Пруток \d+x\d+-А500С ГОСТ 34028-2016",
                    r["name"],
                    t,
                )
            plain = re.sub(r"\\[^;]*;", "", e.text).strip().strip("{}")
            if re.fullmatch(r"\d+\.\d{2}", plain):
                # distinguish unit vs other: unit typically < 200
                val = float(plain)
                if val < 200:
                    e.text = e.text.replace(plain, f"{r['unit']:.2f}")
            if re.fullmatch(r"\d+,\d{2}", plain):
                val = float(plain.replace(",", "."))
                if val >= 50:  # row mass
                    e.text = e.text.replace(plain, fmt_comma(r["row"]))

    # Total mass cell
    for e in t37.query("MTEXT"):
        t = e.text
        plain = re.sub(r"\\[^;]*;", "", t).strip().strip("{}")
        if plain in ("6616,39", "6616.39", "6474,15", "6474.15") or (
            abs(e.dxf.insert.y + 21558.2) < 3 and ("6616" in plain or "6474" in plain)
        ):
            if "," in plain:
                e.text = t.replace(plain, fmt_comma(new_total))
            else:
                e.text = t.replace(plain, f"{new_total:.2f}")

    # *T39 steel schedule — update diameter totals for changed mix
    # Compute new A500C mass by diameter from NEW_SPEC only for working bars,
    # then adjust old schedule cells if present.
    by_d = {}
    for pos, (d, L, qty) in NEW_SPEC.items():
        by_d[d] = by_d.get(d, 0.0) + row_mass(d, L, qty)
    for d in sorted(by_d):
        print(f"  steel Ø{d}: {by_d[d]:.2f}")

    # Store for raw replace
    update_tables.new_total = new_total
    update_tables.by_d = by_d
    update_tables.rows = rows
    update_tables.sum_1_8 = sum_1_8


def update_section_circles(doc, msp) -> None:
    """Set section circle radii on котлован based on MULTILEADER marks near sections."""
    # Collect mark "N" leaders near section bands and map leaf circle blocks via inserts
    # Simpler approach: set all previously known pos leaves and also any r matching old diams
    # New котлован diams: 22,22,36,25 → r 11, 11, 18, 12.5
    # Find circle leaf blocks used in section area by scanning inserts with small circle leaves.
    # For now update circles that are r in {11,12.5,14,16,18} in section parent blocks — too broad.

    # Practical: find MULTILEADER with content exactly "1".."8" near section Y bands,
    # find nearest CIRCLE insert leaf, set radius = NEW_SPEC[pos][0]/2
    marks = []
    for e in msp.query("MULTILEADER"):
        ctx = getattr(e, "context", None)
        if not (ctx and getattr(ctx, "mtext", None)):
            continue
        t = (ctx.mtext.default_content or "").strip()
        if t in {str(i) for i in range(1, 9)} or re.fullmatch(r"\{\\C0;[1-8]\}", t):
            pos = int(re.search(r"[1-8]", t).group(0))
            try:
                ins = (ctx.mtext.insert.x, ctx.mtext.insert.y)
            except Exception:
                continue
            marks.append((pos, ins[0], ins[1]))

    # Circle leaves: blocks containing a single small circle
    circle_leaves = {}
    for b in doc.blocks:
        if not b.name.startswith("*U"):
            continue
        cs = list(b.query("CIRCLE"))
        if len(cs) == 1 and 5 < cs[0].dxf.radius < 25:
            circle_leaves[b.name] = cs[0]

    # INSERTS of those leaves in model
    updated = 0
    for e in msp.query("INSERT"):
        if e.dxf.name not in circle_leaves:
            continue
        ix, iy = e.dxf.insert.x, e.dxf.insert.y
        # only section-ish band (below schema)
        if iy > -45000 or iy < -67000:
            continue
        if ix < 16000 or ix > 23000:
            continue
        # nearest mark
        if not marks:
            continue
        pos, mx, my = min(marks, key=lambda m: (m[1] - ix) ** 2 + (m[2] - iy) ** 2)
        if (mx - ix) ** 2 + (my - iy) ** 2 > 400 ** 2:
            continue
        d = NEW_SPEC[pos][0]
        circle_leaves[e.dxf.name].dxf.radius = d / 2.0
        updated += 1
    print("section circles updated", updated)


def to_dwg(dxf: Path, dwg: Path) -> None:
    if not ODA.exists():
        print("ODA missing — DXF only")
        return
    inp, outp = Path("/tmp/oda_apply_in"), Path("/tmp/oda_apply_out")
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


def main():
    src = ensure_source()
    print("source", src)
    shutil.copy(src, OUT_DXF)
    doc = ezdxf.readfile(OUT_DXF)
    msp = doc.modelspace()

    new_bars = collect_new_schema_bars(msp)
    print("new schema bars", len(new_bars), [(b["w"], b["h"]) for b in new_bars])

    # 1) Replace main + right schema bars
    replace_schema_bars(msp, new_bars, DX_MAIN, 8500, 16000)
    replace_schema_bars(msp, new_bars, DX_RIGHT, 32000, 39000)

    # 2) Resize cage leaf bars
    for bname, (d, L) in CAGE_LEAF_RESIZE.items():
        blk = doc.blocks.get(bname)
        if blk is None:
            print("missing block", bname)
            continue
        redraw_leaf_bar(blk, float(d), float(L))
        print("resized", bname, f"→ {d}x{L}")

    # 3) Callouts text
    leader_handles: dict[str, int] = {}
    n_call = 0
    for e in msp.query("MULTILEADER"):
        ctx = getattr(e, "context", None)
        if not (ctx and getattr(ctx, "mtext", None)):
            continue
        content = ctx.mtext.default_content or ""
        # determine pos
        pos = None
        m = re.search(r"([1-8]) A500C %%C", content)
        if m:
            pos = int(m.group(1))
        if pos is None:
            m = re.search(r"\\C0;([1-8])\\PА500C", content)
            if m:
                pos = int(m.group(1))
        if pos is None:
            continue
        new_t = update_callout_text(content)
        if new_t:
            ctx.mtext.default_content = new_t
            n_call += 1
        leader_handles[e.dxf.handle] = NEW_SPEC[pos][0]
    for e in msp.query("MTEXT"):
        if re.search(r"[1-8] A500C %%C\d+", e.text):
            new_t = update_callout_text(e.text)
            if new_t:
                e.text = new_t
                n_call += 1
    print("callouts text updated", n_call)

    # 4) Schema diameter dims on main band
    update_schema_diameter_dims(doc, msp, new_bars)

    # 5) Section circles
    update_section_circles(doc, msp)

    # 6) Tables
    update_tables(doc)

    doc.saveas(OUT_DXF)

    # Raw patches: names/totals + mleader binary
    raw = OUT_DXF.read_text(encoding="utf-8", errors="ignore")
    rows = update_tables.rows
    for pos, r in rows.items():
        # replace any remaining old пруток patterns for this length/diam combo is risky;
        # already done in entities.
        pass
    raw = raw.replace("6616,39", fmt_comma(update_tables.new_total))
    raw = raw.replace("6616.39", f"{update_tables.new_total:.2f}")

    # Force пруток names in raw for pos rows if needed
    replacements = [
        ("Пруток 25x5850-А500С ГОСТ 34028-2016", rows[1]["name"]),  # careful: may hit pos8 too if same
    ]
    # Better explicit old→new unique old names from prior table
    old_names = {
        1: "Пруток 25x5850-А500С ГОСТ 34028-2016",
        2: "Пруток 22x3050-А500С ГОСТ 34028-2016",
        3: "Пруток 36x11700-А500С ГОСТ 34028-2016",
        4: "Пруток 32x11700-А500С ГОСТ 34028-2016",
        5: "Пруток 36x5850-А500С ГОСТ 34028-2016",
        6: "Пруток 22x11700-А500С ГОСТ 34028-2016",
        7: "Пруток 25x11700-А500С ГОСТ 34028-2016",
        8: "Пруток 22x8450-А500С ГОСТ 34028-2016",
    }
    # pos1 old name equals possible new pos8 name (25x5850) — do pos1 after copying carefully
    # Order: replace unique olds first (2,3,4,5,6,7,8-old22x8450), then pos1
    for pos in (1, 2, 3, 4, 5, 6, 7, 8):
        raw = raw.replace(old_names[pos], rows[pos]["name"])

    raw, n_bin = patch_mleader_binary_for_handles(raw, leader_handles)
    print("mleader binary patched", n_bin)
    OUT_DXF.write_text(raw, encoding="utf-8")

    shutil.copy(OUT_DXF, ROOT / "drawings" / "KP17.dxf")
    to_dwg(OUT_DXF, OUT_DWG)
    print("done", OUT_DXF)


if __name__ == "__main__":
    main()
