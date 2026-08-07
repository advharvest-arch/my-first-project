#!/usr/bin/env python3
"""Remove the right-hand duplicate schema overlapping section 8-8.

Keeps section 8-8 (label, profile bars, inserts, Ф callouts, 800 dim)
and the main schema on the left. Removes cloned right schema bars,
title, exploded dims, and schema callouts.
"""
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

# Title shift main → right duplicate
DX2 = 34692.24776850127 - 11644.347768501268  # ≈23047.9

# 8-8 profile bar X (keep)
KEEP_BAR_X = {34715.0, 35330.0}


def near(a: float, b: float, tol: float = 3.0) -> bool:
    return abs(a - b) < tol


def is_88_bar_x(x: float) -> bool:
    return any(near(x, kx, 5.0) for kx in KEEP_BAR_X)


def remove_right_schema(doc) -> dict:
    msp = doc.modelspace()
    kill = []
    stats = {
        "title": 0,
        "bars": 0,
        "mtext_dims": 0,
        "lines": 0,
        "ticks": 0,
        "mleaders": 0,
        "circles": 0,
        "polys_other": 0,
        "dims": 0,
    }

    # --- main schema dim text fingerprints for matching right copies ---
    main_dim_texts = []
    for e in msp.query("MTEXT"):
        x, y = e.dxf.insert.x, e.dxf.insert.y
        if 6000 < x < 18000 and -102000 < y < -68000:
            t = e.text.replace("\\A1;", "").strip()
            if re.match(r"^(%%C)?\d", t) or t.startswith("%%C"):
                main_dim_texts.append((t, x, y))

    # Also main ArchTick X fingerprint near dims
    main_tick_xy = []
    for e in msp.query("INSERT"):
        if e.dxf.name != "_ArchTick":
            continue
        x, y = e.dxf.insert.x, e.dxf.insert.y
        if 6000 < x < 18000 and -102000 < y < -68000:
            main_tick_xy.append((x, y))

    # Main dim LINE fingerprints (midpoint)
    main_lines = []
    for e in msp.query("LINE"):
        mx = (e.dxf.start.x + e.dxf.end.x) / 2
        my = (e.dxf.start.y + e.dxf.end.y) / 2
        if 6000 < mx < 18000 and -102000 < my < -68000:
            main_lines.append(
                (
                    e.dxf.start.x,
                    e.dxf.start.y,
                    e.dxf.end.x,
                    e.dxf.end.y,
                )
            )

    for e in list(msp):
        t = e.dxftype()

        # Title of right schema
        if t == "MTEXT" and "Схема расположения" in e.text:
            if e.dxf.insert.x > 20000:
                kill.append(e)
                stats["title"] += 1
                continue

        # Right-schema bars (not 8-8)
        if t == "LWPOLYLINE":
            pts = list(e.get_points("xy"))
            if len(pts) < 2:
                continue
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            mx = sum(xs) / len(xs)
            my = sum(ys) / len(ys)
            w, h = max(xs) - min(xs), max(ys) - min(ys)
            if not (30000 < mx < 40000 and -102000 < my < -68000):
                continue
            if 15 < w < 50 and h > 1000:
                if is_88_bar_x(mx):
                    continue  # keep 8-8
                kill.append(e)
                stats["bars"] += 1
                continue
            # other junk polys in right band (frames, huge leftovers) — keep only
            # very near 8-8 center strip if small
            if h > 20000 or w > 2000:
                kill.append(e)
                stats["polys_other"] += 1
                continue
            # top horizontal ticks of right schema (y≈-69761)
            if h < 5 and w > 500 and abs(my + 69761) < 5:
                kill.append(e)
                stats["polys_other"] += 1
                continue

        # Exploded dim MTEXT copies on the right
        if t == "MTEXT":
            x, y = e.dxf.insert.x, e.dxf.insert.y
            if not (28000 < x < 42000 and -102000 < y < -68000):
                continue
            raw = e.text
            plain = re.sub(r"\\[^;]*;", "", raw)
            plain = re.sub(r"[{}]", "", plain).replace("\\P", " ").strip()
            # keep 8-8 label and Ф/11/Б callouts
            if plain == "8-8" or plain in ("Ф1", "Ф4", "11", "Б") or plain.startswith("Ф"):
                continue
            if "Сторона" in raw:
                # keep side labels for 8-8 profile (грунт/котлован)
                continue
            # match shifted main dim text
            tt = raw.replace("\\A1;", "").strip()
            matched = any(
                tt == mt and abs(y - my) < 2.0 and abs(x - (mx + DX2)) < 80.0
                for mt, mx, my in main_dim_texts
            )
            # also kill any numeric/%%C dim-looking text in right schema wings
            # (outside narrow 8-8 strip 34650..35450) that looks like a dim
            in_88_strip = 34650 < x < 35500
            looks_dim = bool(re.match(r"^(%%C)?\d", tt)) or tt.startswith("%%C")
            if matched or (looks_dim and not in_88_strip):
                kill.append(e)
                stats["mtext_dims"] += 1
                continue

        # Exploded dim LINEs that are right copies
        if t == "LINE":
            x1, y1 = e.dxf.start.x, e.dxf.start.y
            x2, y2 = e.dxf.end.x, e.dxf.end.y
            mx, my = (x1 + x2) / 2, (y1 + y2) / 2
            if not (28000 < mx < 42000 and -102000 < my < -68000):
                continue
            # keep short marks belonging to 8-8 (the two ~800-wide horizontals)
            if abs(y1 - y2) < 1 and abs(x2 - x1) < 50 and 34500 < mx < 35500:
                continue
            matched = any(
                abs(x1 - (a + DX2)) < 5
                and abs(y1 - b) < 5
                and abs(x2 - (c + DX2)) < 5
                and abs(y2 - d) < 5
                for a, b, c, d in main_lines
            )
            # also kill dim-looking lines in right wings (not in 8-8 core 34600-35450)
            in_core = 34600 < mx < 35450
            if matched or not in_core:
                # but don't kill if it's the 800-width dim remnants inside core—handled above
                if not in_core or matched:
                    kill.append(e)
                    stats["lines"] += 1
                    continue

        # ArchTick copies
        if t == "INSERT" and e.dxf.name == "_ArchTick":
            x, y = e.dxf.insert.x, e.dxf.insert.y
            if not (28000 < x < 42000 and -102000 < y < -68000):
                continue
            matched = any(
                abs(x - (mx + DX2)) < 5 and abs(y - my) < 5 for mx, my in main_tick_xy
            )
            in_core = 34600 < x < 35450
            if matched or not in_core:
                kill.append(e)
                stats["ticks"] += 1
                continue

        # Right schema MULTILEADERs (поз callouts), keep nothing in schema style here
        # except we already have Ф as MTEXT
        if t == "MULTILEADER":
            ctx = getattr(e, "context", None)
            if not (ctx and getattr(ctx, "mtext", None)):
                continue
            try:
                ix, iy = ctx.mtext.insert.x, ctx.mtext.insert.y
            except Exception:
                continue
            if not (30000 < ix < 40000 and -102000 < iy < -68000):
                continue
            txt = ctx.mtext.default_content or ""
            # keep if Ф/11 — but those were imported as MTEXT; mleaders here are schema
            if any(k in txt for k in ("A500C", "шаг", "%%C", "поз")):
                kill.append(e)
                stats["mleaders"] += 1
                continue
            # also kill generic schema leaders in right band outside 8-8 callout column
            if ix < 35600:
                kill.append(e)
                stats["mleaders"] += 1
                continue

        # Circles that are diameter marks of right schema (not 8-8 top circle)
        if t == "CIRCLE":
            c = e.dxf.center
            if not (30000 < c.x < 40000 and -102000 < c.y < -68000):
                continue
            # keep the small circle near top of 8-8 (~35019, -70086)
            if abs(c.x - 35019) < 30 and abs(c.y + 70086) < 50:
                continue
            if 5 < e.dxf.radius < 40:
                kill.append(e)
                stats["circles"] += 1
                continue

        # leftover DIMENSION entities in right schema band (except 800)
        if t == "DIMENSION":
            pts = [
                getattr(e.dxf, a)
                for a in ("defpoint", "defpoint2", "defpoint3")
                if e.dxf.hasattr(a)
            ]
            if not pts:
                continue
            cx = sum(p.x for p in pts) / len(pts)
            cy = sum(p.y for p in pts) / len(pts)
            if not (30000 < cx < 40000 and -102000 < cy < -68000):
                continue
            try:
                m = e.get_measurement()
            except Exception:
                m = None
            if m is not None and abs(m - 800) < 1:
                continue  # keep 8-8 width
            kill.append(e)
            stats["dims"] += 1

    for e in kill:
        try:
            msp.delete_entity(e)
        except Exception:
            pass
    print("removed", {k: v for k, v in stats.items() if v})
    print("total killed", len(kill))
    return stats


def snap_main_schema_dims(msp) -> int:
    """Pull obviously drifting exploded dim texts toward nearest matching bar mid."""
    bars = []
    for e in msp.query("LWPOLYLINE"):
        pts = list(e.get_points("xy"))
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        mx = sum(xs) / len(xs)
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        if 7000 < mx < 17000 and -102000 < min(ys) < -68000 and 15 < w < 50 and h > 500:
            bars.append((mx, min(ys), max(ys), h))

    moved = 0
    for e in msp.query("MTEXT"):
        x, y = e.dxf.insert.x, e.dxf.insert.y
        if not (6000 < x < 18000 and -102000 < y < -68000):
            continue
        t = e.text.replace("\\A1;", "").strip()
        if not re.fullmatch(r"\d+", t):
            continue
        val = float(t)
        if val not in (1600, 5850, 11700):
            continue
        # find bar with same length whose mid is closest in Y and reasonably near in X
        candidates = [b for b in bars if abs(b[3] - val) < 1.0]
        if not candidates:
            continue
        bx, ymin, ymax, h = min(candidates, key=lambda b: abs((b[1] + b[2]) / 2 - y) + abs(b[0] - x) * 0.05)
        target_y = (ymin + ymax) / 2
        # place text just outside bar (to the left or right of bar)
        # keep current side relative to bar
        target_x = bx - 400 if x < bx else bx + 400
        if abs(x - target_x) > 1200 or abs(y - target_y) > 800:
            # only nudge if clearly far from its bar mid
            if abs(y - target_y) > 1500:
                e.dxf.insert = (e.dxf.insert.x, target_y, e.dxf.insert.z)
                moved += 1
    print("nudged dim texts", moved)
    return moved


def to_dwg(dxf: Path, dwg: Path) -> None:
    inp, outp = Path("/tmp/oda_clean88_in"), Path("/tmp/oda_clean88_out")
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
    titles = [
        (e.text[:40], round(e.dxf.insert.x))
        for e in msp.query("MTEXT")
        if "Схема расположения" in e.text
    ]
    print("schema titles:", titles)
    has88 = any(e.dxftype() == "MTEXT" and e.text.strip() == "8-8" for e in msp.query("MTEXT"))
    bars_88 = 0
    bars_right = 0
    for e in msp.query("LWPOLYLINE"):
        pts = list(e.get_points("xy"))
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        mx = sum(xs) / len(xs)
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        if 30000 < mx < 40000 and 15 < w < 50 and h > 1000:
            if is_88_bar_x(mx):
                bars_88 += 1
            else:
                bars_right += 1
    main_dim_txt = sum(
        1
        for e in msp.query("MTEXT")
        if 6000 < e.dxf.insert.x < 18000
        and -102000 < e.dxf.insert.y < -68000
        and re.match(r"^(%%C)?\d", e.text.replace("\\A1;", "").strip())
    )
    print(f"8-8={has88} bars88={bars_88} leftover_right_bars={bars_right} main_dim_txt={main_dim_txt}")


def main() -> None:
    doc = ezdxf.readfile(SRC)
    remove_right_schema(doc)
    snap_main_schema_dims(doc.modelspace())
    verify(doc)
    doc.saveas(OUT_DXF)
    shutil.copy(OUT_DXF, OUT_SHEET)
    to_dwg(OUT_DXF, OUT_DWG)
    with zipfile.ZipFile(ROOT / "drawings" / "KP17.zip", "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(OUT_DWG, "KP17.dwg")
        zf.write(OUT_SHEET, "KP17.dxf")
    print("done")


if __name__ == "__main__":
    main()
