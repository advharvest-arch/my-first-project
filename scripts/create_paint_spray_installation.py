#!/usr/bin/env python3
"""Компактная установка для распыления краски — чертёж для ППР."""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import ezdxf
from ezdxf import colors
from ezdxf.enums import TextEntityAlignment

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "docs" / "files"
DXF_PATH = OUTPUT_DIR / "ustanovka-raspyleniya-kraski-kompakt.dxf"
DWG_PATH = OUTPUT_DIR / "ustanovka-raspyleniya-kraski-kompakt.dwg"
ODA_CONVERTER = Path("/tmp/squashfs-root/usr/bin/ODAFileConverter")

SCALE = 0.1  # масштаб 1:10

# Габариты установки, мм
FRAME_W = 1200
FRAME_D = 700
FRAME_H = 1300
WHEEL_D = 160
PROFILE = 40


def s(v: float) -> float:
    return v * SCALE


def add_text(msp, text, pos, height=2.5, align=TextEntityAlignment.MIDDLE_CENTER):
    t = msp.add_text(text, dxfattribs={"height": height, "style": "Standard"})
    t.set_placement(pos, align=align)
    return t


def rect(msp, x, y, w, h, lw=25):
    msp.add_lwpolyline(
        [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)],
        dxfattribs={"color": colors.WHITE, "lineweight": lw},
    )


def callout(msp, cx, cy, num: str, label: str, dx: float, dy: float):
    """Позиция с выноской — номер снаружи, без наложения на деталь."""
    tx, ty = cx + dx, cy + dy
    msp.add_line((cx, cy), (tx, ty), dxfattribs={"color": colors.GREEN})
    add_text(msp, num, (tx, ty), height=3.0)


def dim_h(msp, x1, x2, y, offset, label):
    yo = y + offset
    gap = 3
    for x in (x1, x2):
        msp.add_line((x, y), (x, yo), dxfattribs={"color": colors.CYAN})
    msp.add_line((x1, yo), (x2, yo), dxfattribs={"color": colors.CYAN})
    for x, sign in ((x1, 1), (x2, -1)):
        msp.add_line((x, yo), (x + sign * gap, yo + 1.2), dxfattribs={"color": colors.CYAN})
        msp.add_line((x, yo), (x + sign * gap, yo - 1.2), dxfattribs={"color": colors.CYAN})
    add_text(msp, label, ((x1 + x2) / 2, yo + 2.5), height=2.0)


def dim_v(msp, x, y1, y2, offset, label):
    xo = x + offset
    gap = 3
    for y in (y1, y2):
        msp.add_line((x, y), (xo, y), dxfattribs={"color": colors.CYAN})
    msp.add_line((xo, y1), (xo, y2), dxfattribs={"color": colors.CYAN})
    for y, sign in ((y1, -1), (y2, 1)):
        msp.add_line((xo, y), (xo + 1.2, y + sign * gap), dxfattribs={"color": colors.CYAN})
        msp.add_line((xo, y), (xo - 1.2, y + sign * gap), dxfattribs={"color": colors.CYAN})
    add_text(msp, label, (xo + 3, (y1 + y2) / 2), height=2.0, align=TextEntityAlignment.MIDDLE_LEFT)


def draw_front_view(msp, ox: float, oy: float):
    """Вид спереди — все координаты в мм, масштабируются внутри."""
    fw, fh, pw = FRAME_W, FRAME_H, PROFILE

    # --- Рама ---
    rect(msp, ox + s(0), oy + s(0), s(fw), s(pw))                          # нижняя балка
    rect(msp, ox + s(0), oy + s(pw), s(pw), s(fh - 2 * pw))                 # левая стойка
    rect(msp, ox + s(fw - pw), oy + s(pw), s(pw), s(fh - 2 * pw))           # правая стойка
    rect(msp, ox + s(0), oy + s(fh - pw), s(fw), s(pw))                     # верхняя балка
    # Средняя полка
    rect(msp, ox + s(pw), oy + s(480), s(fw - 2 * pw), s(20))

    # Колёса
    for wx in (160, fw - 160):
        cx = ox + s(wx)
        cy = oy + s(0) - s(WHEEL_D) / 2 + s(10)
        msp.add_circle((cx, cy), s(WHEEL_D / 2), dxfattribs={"color": colors.WHITE})
        msp.add_circle((cx, cy), s(20), dxfattribs={"color": colors.WHITE})

    # --- Оборудование (разнесено, без пересечений) ---
    # 1. Компрессор — нижний левый угол
    c1x, c1y, c1w, c1h = 70, 60, 340, 300
    rect(msp, ox + s(c1x), oy + s(c1y), s(c1w), s(c1h))
    callout(msp, ox + s(c1x + c1w), oy + s(c1y + c1h / 2), "1", "Компрессор", s(12), 0)

    # 2. Ресивер — центр, на полке
    c2x, c2y, c2w, c2h = 460, 520, 180, 480
    rect(msp, ox + s(c2x), oy + s(c2y), s(c2w), s(c2h))
    callout(msp, ox + s(c2x + c2w / 2), oy + s(c2y + c2h), "2", "Ресивер", 0, s(14))

    # 3. Фильтр — правее ресивера
    c3x, c3y, c3w, c3h = 700, 580, 130, 200
    rect(msp, ox + s(c3x), oy + s(c3y), s(c3w), s(c3h))
    callout(msp, ox + s(c3x + c3w), oy + s(c3y + c3h / 2), "3", "Фильтр", s(10), 0)

    # 4. Бак с краской — правый край
    c4x, c4y, c4w, c4h = 900, 540, 150, 260
    rect(msp, ox + s(c4x), oy + s(c4y), s(c4w), s(c4h))
    callout(msp, ox + s(c4x + c4w / 2), oy + s(c4y + c4h), "4", "Бак", 0, s(14))

    # 5. Пульт — под компрессором
    c5x, c5y, c5w, c5h = 70, 400, 160, 60
    rect(msp, ox + s(c5x), oy + s(c5y), s(c5w), s(c5h))
    callout(msp, ox + s(c5x), oy + s(c5y + c5h / 2), "5", "Пульт", s(-14), 0)

    # 6. Катушка — между компрессором и ресивером, на полке
    c6x, c6y, c6r = 300, 560, 80
    msp.add_circle((ox + s(c6x), oy + s(c6y)), s(c6r), dxfattribs={"color": colors.WHITE})
    msp.add_circle((ox + s(c6x), oy + s(c6y)), s(25), dxfattribs={"color": colors.WHITE})
    callout(msp, ox + s(c6x), oy + s(c6y + c6r), "6", "Катушка", 0, s(12))

    # 7. Краскопульт — держатель на правой стойке
    c7x, c7y, c7w, c7h = 1100, 700, 35, 100
    rect(msp, ox + s(c7x), oy + s(c7y), s(c7w), s(c7h))
    # Сопло
    nx = ox + s(c7x + c7w / 2)
    ny = oy + s(c7y + c7h)
    msp.add_line((nx, ny), (nx, ny + s(50)), dxfattribs={"color": colors.WHITE})
    msp.add_line((nx, ny + s(50)), (nx - s(15), ny + s(75)), dxfattribs={"color": colors.WHITE})
    msp.add_line((nx, ny + s(50)), (nx + s(15), ny + s(75)), dxfattribs={"color": colors.WHITE})
    callout(msp, ox + s(c7x + c7w), oy + s(c7y + c7h / 2), "7", "Краскопульт", s(14), 0)

    # Размерные линии — снаружи рамы, с зазором
    bottom = oy + s(0) - s(WHEEL_D / 2) - s(10)
    top = oy + s(fh)
    right = ox + s(fw)
    dim_h(msp, ox, right, bottom, -18, str(fw))
    dim_v(msp, right, bottom, top, 18, str(fh))

    add_text(msp, "Вид спереди", (ox + s(fw / 2), top + s(30)), height=3.5)
    return ox, oy, s(fw), top - bottom + s(30)


def draw_top_view(msp, ox: float, oy: float):
    """Вид сверху."""
    fw, fd, pw = FRAME_W, FRAME_D, PROFILE

    # Рама
    rect(msp, ox + s(0), oy + s(0), s(fw), s(fd))
    # Продольные балки
    for dy in (pw, fd - pw):
        msp.add_line(
            (ox + s(pw), oy + s(dy)),
            (ox + s(fw - pw), oy + s(dy)),
            dxfattribs={"color": colors.WHITE},
        )
    # Поперечные
    for dx in (380, 760):
        msp.add_line(
            (ox + s(dx), oy + s(pw)),
            (ox + s(dx), oy + s(fd - pw)),
            dxfattribs={"color": colors.WHITE},
        )

    # Колёса
    for wx, wy in ((160, 120), (fw - 160, 120), (160, fd - 120), (fw - 160, fd - 120)):
        msp.add_circle((ox + s(wx), oy + s(wy)), s(55), dxfattribs={"color": colors.WHITE})

    # Оборудование — вид сверху
    # 1. Компрессор
    rect(msp, ox + s(70), oy + s(100), s(340), s(300))
    add_text(msp, "1", (ox + s(240), oy + s(250)), height=3.0)

    # 2. Ресивер
    msp.add_circle((ox + s(550), oy + s(350)), s(90), dxfattribs={"color": colors.WHITE})
    add_text(msp, "2", (ox + s(550), oy + s(350)), height=3.0)

    # 3. Фильтр
    rect(msp, ox + s(700), oy + s(260), s(130), s(180))
    add_text(msp, "3", (ox + s(765), oy + s(350)), height=3.0)

    # 4. Бак
    msp.add_circle((ox + s(960), oy + s(350)), s(75), dxfattribs={"color": colors.WHITE})
    add_text(msp, "4", (ox + s(960), oy + s(350)), height=3.0)

    # 5. Пульт
    rect(msp, ox + s(70), oy + s(480), s(160), s(120))
    add_text(msp, "5", (ox + s(150), oy + s(540)), height=3.0)

    # 6. Катушка
    msp.add_circle((ox + s(380), oy + s(520)), s(70), dxfattribs={"color": colors.WHITE})
    add_text(msp, "6", (ox + s(380), oy + s(520)), height=3.0)

    # 7. Краскопульт (точка)
    msp.add_circle((ox + s(1110), oy + s(350)), s(12), dxfattribs={"color": colors.WHITE})
    add_text(msp, "7", (ox + s(1110), oy + s(330)), height=2.5)

    bottom = oy + s(0)
    right = ox + s(fw)
    dim_h(msp, ox, right, bottom, -14, str(fw))
    dim_v(msp, right, bottom, oy + s(fd), 14, str(fd))

    add_text(msp, "Вид сверху", (ox + s(fw / 2), oy + s(fd) + s(22)), height=3.5)
    return ox, oy, s(fw), s(fd) + s(30)


def draw_spec_table(msp, ox: float, oy: float):
    rows = [
        ("Поз.", "Наименование", "Кол."),
        ("1", "Компрессор 2,2 кВт", "1"),
        ("2", "Ресивер 50 л", "1"),
        ("3", "Фильтр-осушитель", "1"),
        ("4", "Бак для краски 10 л", "1"),
        ("5", "Пульт управления", "1"),
        ("6", "Катушка шланга 15 м", "1"),
        ("7", "Краскопульт", "1"),
        ("8", f"Рама {FRAME_W}×{FRAME_D} мм", "1"),
    ]
    col_w = [12, 72, 12]
    row_h = 7
    for ri, row in enumerate(rows):
        x = ox
        y = oy - ri * row_h
        for cell, cw in zip(row, col_w):
            rect(msp, x, y - row_h, cw, row_h, lw=15)
            add_text(msp, cell, (x + cw / 2, y - row_h / 2), height=1.8 if ri else 2.0)
            x += cw


def create_installation_drawing() -> ezdxf.document.Drawing:
    doc = ezdxf.new("R2010")
    doc.units = ezdxf.units.MM
    msp = doc.modelspace()

    sheet_w, sheet_h = 420, 297
    rect(msp, 0, 0, sheet_w, sheet_h, lw=15)

    # Заголовок
    add_text(msp, "УСТАНОВКА ОКРАСОЧНАЯ КОМПАКТНАЯ", (sheet_w / 2, sheet_h - 10), height=4.0)
    add_text(msp, "Масштаб 1:10   |   Размеры в мм", (sheet_w / 2, sheet_h - 18), height=2.2)

    # Вид спереди — левая нижняя часть листа
    draw_front_view(msp, 20, 115)

    # Вид сверху — правая верхняя часть, без пересечения
    draw_top_view(msp, 185, 50)

    # Спецификация — нижний левый угол
    add_text(msp, "Спецификация", (15, 100), height=2.5, align=TextEntityAlignment.MIDDLE_LEFT)
    draw_spec_table(msp, 15, 97)

    # Примечания — нижний центр
    notes_x = 185
    add_text(msp, "Примечания:", (notes_x, 38), height=2.2, align=TextEntityAlignment.MIDDLE_LEFT)
    for i, note in enumerate([
        "1. Для нанесения ЛКМ распылением на стройплощадке.",
        "2. Давление воздуха 0,5–0,6 МПа.",
        "3. Перед перемещением отключить оборудование.",
    ]):
        add_text(msp, note, (notes_x, 32 - i * 5), height=1.7, align=TextEntityAlignment.MIDDLE_LEFT)

    return doc


def convert_to_dwg(dxf_path: Path, dwg_path: Path) -> bool:
    if not ODA_CONVERTER.exists():
        return False
    tmp = Path(tempfile.mkdtemp(prefix="dwg_"))
    env = {"DISPLAY": ":99", **dict(__import__("os").environ)}
    subprocess.run(
        [str(ODA_CONVERTER), str(dxf_path.parent), str(tmp), "ACAD2010", "DWG", "0", "1", dxf_path.name],
        env=env, capture_output=True, check=False,
    )
    result = tmp / dxf_path.with_suffix(".dwg").name
    if result.exists():
        result.replace(dwg_path)
        return True
    return False


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    doc = create_installation_drawing()
    doc.saveas(DXF_PATH)
    print(f"DXF: {DXF_PATH}")
    if convert_to_dwg(DXF_PATH, DWG_PATH):
        print(f"DWG: {DWG_PATH}")
    else:
        try:
            from ezdxf.addons import odafc
            odafc.convert(str(DXF_PATH), str(DWG_PATH), version="R2010", replace=True)
            print(f"DWG: {DWG_PATH}")
        except Exception as exc:
            print(f"DWG conversion failed: {exc}")


if __name__ == "__main__":
    main()
