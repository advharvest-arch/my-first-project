#!/usr/bin/env python3
"""Редактирование КП17 через данные + перегенерация.

Примеры:
  python3 -m kp17.scripts.edit_kp17 --set-mass 6500
  python3 -m kp17.scripts.edit_kp17 --set-bar-qty 3 16
  python3 -m kp17.scripts.edit_kp17 --set-length 32000
  python3 -m kp17.scripts.edit_kp17 --regen
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "kp17" / "data" / "kp17_data.py"


def patch_cage_length(new_len: int):
    text = DATA.read_text(encoding="utf-8")
    text2, n = re.subn(
        r'("length":\s*)\d+',
        rf"\g<1>{new_len}",
        text,
        count=1,
    )
    if not n:
        raise SystemExit("length field not found")
    DATA.write_text(text2, encoding="utf-8")
    print(f"CAGE.length = {new_len}")


def patch_mass(new_mass: float):
    text = DATA.read_text(encoding="utf-8")
    text2, n = re.subn(
        r'("mass":\s*)[0-9.]+',
        rf"\g<1>{new_mass}",
        text,
        count=1,
    )
    if not n:
        raise SystemExit("TITLE mass not found")
    # also grand_total
    text2, n2 = re.subn(
        r'("grand_total":\s*)[0-9.]+',
        rf"\g<1>{new_mass}",
        text2,
        count=1,
    )
    DATA.write_text(text2, encoding="utf-8")
    print(f"TITLE.mass / grand_total = {new_mass}")


def patch_bar_qty(pos: int, qty: int):
    text = DATA.read_text(encoding="utf-8")
    # match dict with "pos": N ... "qty": M within WORKING_BARS / DETAILS
    pattern = rf'({{"pos":\s*{pos},.*?\"qty\":\s*)\d+'
    text2, n = re.subn(pattern, rf"\g<1>{qty}", text, count=1, flags=re.S)
    if not n:
        raise SystemExit(f"pos {pos} not found")
    DATA.write_text(text2, encoding="utf-8")
    print(f"pos {pos} qty = {qty}")


def regen():
    from kp17.scripts.generate_kp17 import main as gen
    from kp17.scripts.merge_and_dwg import to_dwg

    out = gen()
    to_dwg(Path(out))
    print("Regenerated DXF/DWG")


def main():
    p = argparse.ArgumentParser(description="Edit KP17 sheet data and regenerate")
    p.add_argument("--set-length", type=int, help="CAGE.length mm")
    p.add_argument("--set-mass", type=float, help="Total mass kg")
    p.add_argument("--set-bar-qty", nargs=2, type=int, metavar=("POS", "QTY"))
    p.add_argument("--regen", action="store_true", help="Regenerate DXF/DWG from data")
    args = p.parse_args()

    changed = False
    if args.set_length is not None:
        patch_cage_length(args.set_length)
        changed = True
    if args.set_mass is not None:
        patch_mass(args.set_mass)
        changed = True
    if args.set_bar_qty is not None:
        patch_bar_qty(args.set_bar_qty[0], args.set_bar_qty[1])
        changed = True
    if args.regen or changed:
        regen()
    elif not any([args.set_length, args.set_mass, args.set_bar_qty, args.regen]):
        p.print_help()


if __name__ == "__main__":
    main()
