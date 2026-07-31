#!/usr/bin/env python3
"""Схема установки для распыления краски (P&ID)."""

from __future__ import annotations

import math
from pathlib import Path

import ezdxf
from ezdxf import colors
from ezdxf.enums import TextEntityAlignment

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "docs" / "files"
DXF_PATH = OUTPUT_DIR / "ustanovka-raspyleniya-kraski.dxf"
DWG_PATH = OUTPUT_DIR / "ustanovka-raspyleniya-kraski.dwg"


def add_text(msp, text: str, pos: tuple[float, float], height: float = 2.5, align=TextEntityAlignment.MIDDLE_CENTER):
    t = msp.add_text(text, dxfattribs={"height": height, "style": "Standard"})
    t.set_placement(pos, align=align)
    return t


def draw_tank(msp, cx: float, cy: float, w: float, h: float, label: str, sublabel: str = ""):
    """Цилиндрический бак."""
    x0, y0 = cx - w / 2, cy - h / 2
    msp.add_lwpolyline(
        [
            (x0, y0),
            (x0 + w, y0),
            (x0 + w, y0 + h),
            (x0, y0 + h),
            (x0, y0),
        ],
        dxfattribs={"color": colors.BLUE},
    )
    # Крышка
    arc_r = w / 2
    msp.add_arc((cx, y0 + h), arc_r, 0, 180, dxfattribs={"color": colors.BLUE})
    add_text(msp, label, (cx, cy + 1), height=2.2)
    if sublabel:
        add_text(msp, sublabel, (cx, cy - 2), height=1.6)


def draw_compressor(msp, cx: float, cy: float, size: float = 8):
    """Компрессор — круг с мотором."""
    msp.add_circle((cx, cy), size / 2, dxfattribs={"color": colors.GREEN})
    msp.add_circle((cx, cy), size / 4, dxfattribs={"color": colors.GREEN})
    for angle in range(0, 360, 45):
        rad = math.radians(angle)
        x1 = cx + (size / 4) * math.cos(rad)
        y1 = cy + (size / 4) * math.sin(rad)
        x2 = cx + (size / 2 - 0.5) * math.cos(rad)
        y2 = cy + (size / 2 - 0.5) * math.sin(rad)
        msp.add_line((x1, y1), (x2, y2), dxfattribs={"color": colors.GREEN})
    add_text(msp, "Компрессор", (cx, cy - size / 2 - 3), height=2.2)


def draw_filter(msp, cx: float, cy: float, w: float = 6, h: float = 10, label: str = "Фильтр"):
    """Фильтр/осушитель — ромб."""
    pts = [(cx, cy + h / 2), (cx + w / 2, cy), (cx, cy - h / 2), (cx - w / 2, cy), (cx, cy + h / 2)]
    msp.add_lwpolyline(pts, dxfattribs={"color": colors.CYAN})
    add_text(msp, label, (cx, cy), height=1.8)


def draw_regulator(msp, cx: float, cy: float, label: str = "Регулятор"):
    """Регулятор давления."""
    msp.add_circle((cx, cy), 3, dxfattribs={"color": colors.YELLOW})
    msp.add_line((cx - 4, cy), (cx + 4, cy), dxfattribs={"color": colors.YELLOW})
    msp.add_line((cx, cy - 4), (cx, cy + 4), dxfattribs={"color": colors.YELLOW})
    add_text(msp, label, (cx, cy - 6), height=1.6)


def draw_valve(msp, cx: float, cy: float, vertical: bool = True):
    """Задвижка/клапан."""
    if vertical:
        msp.add_line((cx - 2, cy - 2), (cx + 2, cy + 2), dxfattribs={"color": colors.RED})
        msp.add_line((cx - 2, cy + 2), (cx + 2, cy - 2), dxfattribs={"color": colors.RED})
        msp.add_line((cx, cy - 3), (cx, cy + 3), dxfattribs={"color": colors.RED})
    else:
        msp.add_line((cx - 2, cy - 2), (cx + 2, cy + 2), dxfattribs={"color": colors.RED})
        msp.add_line((cx - 2, cy + 2), (cx + 2, cy - 2), dxfattribs={"color": colors.RED})
        msp.add_line((cx - 3, cy), (cx + 3, cy), dxfattribs={"color": colors.RED})


def draw_spray_gun(msp, cx: float, cy: float):
    """Краскопульт."""
    msp.add_lwpolyline(
        [(cx - 1, cy + 4), (cx - 1, cy - 2), (cx + 1, cy - 2), (cx + 1, cy + 4), (cx - 1, cy + 4)],
        dxfattribs={"color": colors.MAGENTA},
    )
    msp.add_line((cx, cy - 2), (cx - 3, cy - 6), dxfattribs={"color": colors.MAGENTA})
    msp.add_line((cx, cy - 2), (cx + 3, cy - 6), dxfattribs={"color": colors.MAGENTA})
    msp.add_line((cx - 3, cy - 6), (cx + 3, cy - 6), dxfattribs={"color": colors.MAGENTA})
    # Распыл
    for dx in (-4, 0, 4):
        msp.add_line((cx + dx, cy - 6), (cx + dx * 1.5, cy - 10), dxfattribs={"color": colors.MAGENTA, "linetype": "DASHED"})
    add_text(msp, "Краскопульт", (cx, cy - 13), height=2.0)


def draw_pipe(msp, points: list[tuple[float, float]], color=colors.WHITE, label: str = "", label_pos=None):
    for i in range(len(points) - 1):
        msp.add_line(points[i], points[i + 1], dxfattribs={"color": color, "lineweight": 25})
    if label and label_pos:
        add_text(msp, label, label_pos, height=1.5, align=TextEntityAlignment.BOTTOM_CENTER)


def draw_workpiece(msp, cx: float, cy: float):
    """Деталь для окраски."""
    msp.add_lwpolyline(
        [(cx - 8, cy), (cx + 8, cy), (cx + 8, cy + 12), (cx - 8, cy + 12), (cx - 8, cy)],
        dxfattribs={"color": colors.GRAY},
    )
    add_text(msp, "Изделие", (cx, cy + 6), height=2.0)


def create_schematic() -> ezdxf.document.Drawing:
    doc = ezdxf.new("R2010")
    doc.units = ezdxf.units.M
    msp = doc.modelspace()

    # Рамка и заголовок
    msp.add_lwpolyline([(0, 0), (220, 0), (220, 150), (0, 150), (0, 0)], dxfattribs={"color": colors.WHITE})
    add_text(msp, "СХЕМА УСТАНОВКИ ДЛЯ РАСПЫЛЕНИЯ КРАСКИ", (110, 142), height=4.0)
    add_text(msp, "Пневматическая окрасочная установка", (110, 136), height=2.5)
    add_text(msp, "Масштаб: схематично  |  Формат: A3", (110, 131), height=1.8)

    # Компоненты (слева направо, снизу вверх)
    draw_compressor(msp, 25, 45, size=14)
    draw_tank(msp, 55, 50, 12, 18, "Ресивер", "воздух")
    draw_filter(msp, 80, 50, label="Осушитель")
    draw_regulator(msp, 100, 50, label="Рег. давл.")
    draw_tank(msp, 130, 55, 14, 22, "Бак с краской", "агитатор")
    draw_regulator(msp, 155, 50, label="Рег. краски")
    draw_spray_gun(msp, 185, 70)
    draw_workpiece(msp, 185, 95)

    # Клапаны
    draw_valve(msp, 40, 50, vertical=False)
    draw_valve(msp, 68, 50, vertical=False)
    draw_valve(msp, 118, 50, vertical=False)
    draw_valve(msp, 170, 62, vertical=True)

    # Воздушная магистраль (зелёная)
    air_line = [(32, 50), (40, 50), (49, 50), (68, 50), (74, 50), (94, 50), (100, 50), (106, 50), (170, 50), (170, 62), (185, 62), (185, 66)]
    draw_pipe(msp, air_line, color=colors.GREEN, label="Воздух 0,6 МПа", label_pos=(75, 54))

    # Краска (синяя)
    paint_line = [(130, 44), (130, 35), (155, 35), (155, 44), (170, 44), (170, 62)]
    draw_pipe(msp, paint_line, color=colors.BLUE, label="Краска", label_pos=(142, 38))

    # Легенда
    leg_x, leg_y = 8, 115
    add_text(msp, "УСЛОВНЫЕ ОБОЗНАЧЕНИЯ:", (leg_x + 25, leg_y + 12), height=2.2, align=TextEntityAlignment.MIDDLE_LEFT)
    msp.add_line((leg_x, leg_y + 8), (leg_x + 15, leg_y + 8), dxfattribs={"color": colors.GREEN, "lineweight": 25})
    add_text(msp, "— воздушная линия", (leg_x + 18, leg_y + 8), height=1.6, align=TextEntityAlignment.MIDDLE_LEFT)
    msp.add_line((leg_x, leg_y + 4), (leg_x + 15, leg_y + 4), dxfattribs={"color": colors.BLUE, "lineweight": 25})
    add_text(msp, "— линия подачи краски", (leg_x + 18, leg_y + 4), height=1.6, align=TextEntityAlignment.MIDDLE_LEFT)
    draw_valve(msp, leg_x + 7, leg_y, vertical=False)
    add_text(msp, "— запорный клапан", (leg_x + 18, leg_y), height=1.6, align=TextEntityAlignment.MIDDLE_LEFT)

    # Примечания
    notes = [
        "1. Компрессор обеспечивает сжатый воздух 0,5–0,7 МПа.",
        "2. Осушитель удаляет влагу и масло из воздуха.",
        "3. Краска подаётся из бака под давлением воздуха (сифонный или безвоздушный режим).",
        "4. Регуляторы задают давление воздуха и расход краски.",
        "5. Краскопульт распыляет смесь на изделие.",
    ]
    for i, note in enumerate(notes):
        add_text(msp, note, (8, 108 - i * 4), height=1.5, align=TextEntityAlignment.MIDDLE_LEFT)

    # Штамп
    msp.add_lwpolyline([(150, 5), (218, 5), (218, 25), (150, 25), (150, 5)], dxfattribs={"color": colors.WHITE})
    add_text(msp, "Лист 1", (184, 20), height=1.6)
    add_text(msp, "Установка распыления краски", (184, 15), height=1.4)
    add_text(msp, "31.07.2026", (184, 10), height=1.4)

    return doc


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    doc = create_schematic()
    doc.saveas(DXF_PATH)
    print(f"DXF saved: {DXF_PATH}")

    try:
        from ezdxf.addons import odafc

        odafc.convert(str(DXF_PATH), str(DWG_PATH), version="R2010", replace=True)
        print(f"DWG saved: {DWG_PATH}")
    except Exception as exc:
        print(f"DWG conversion skipped: {exc}")
        print("Install ODA File Converter for DWG export.")


if __name__ == "__main__":
    main()
