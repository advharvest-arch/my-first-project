#!/usr/bin/env python3
"""Generate schematic of a pneumatic paint spray installation (DXF + PNG preview)."""

from pathlib import Path

import ezdxf
from ezdxf import colors
from ezdxf.enums import TextEntityAlignment

OUT_DIR = Path(__file__).resolve().parent
DXF_PATH = OUT_DIR / "ustanovka-raspyleniya-kraski.dxf"
PNG_PATH = OUT_DIR / "ustanovka-raspyleniya-kraski.png"


def add_rect(msp, x, y, w, h, layer="EQUIPMENT", lw=35):
    msp.add_lwpolyline(
        [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)],
        close=True,
        dxfattribs={"layer": layer, "lineweight": lw},
    )


def add_label(msp, text, x, y, h=2.5, layer="TEXT", align=TextEntityAlignment.MIDDLE_CENTER):
    msp.add_text(
        text,
        height=h,
        dxfattribs={"layer": layer, "style": "Standard"},
    ).set_placement((x, y), align=align)


def arrow_line(msp, p1, p2, layer="PIPING", lw=25):
    msp.add_line(p1, p2, dxfattribs={"layer": layer, "lineweight": lw})
    x1, y1 = p1
    x2, y2 = p2
    dx, dy = x2 - x1, y2 - y1
    length = (dx * dx + dy * dy) ** 0.5 or 1.0
    ux, uy = dx / length, dy / length
    # arrow head
    ax, ay = -uy, ux
    tip = (x2, y2)
    left = (x2 - ux * 2.2 + ax * 1.1, y2 - uy * 2.2 + ay * 1.1)
    right = (x2 - ux * 2.2 - ax * 1.1, y2 - uy * 2.2 - ay * 1.1)
    msp.add_lwpolyline([left, tip, right], dxfattribs={"layer": layer, "lineweight": lw})


def valve_symbol(msp, x, y, layer="FITTINGS"):
    # butterfly / globe valve mark
    msp.add_lwpolyline(
        [(x - 2, y - 2), (x + 2, y), (x - 2, y + 2), (x - 2, y - 2)],
        close=True,
        dxfattribs={"layer": layer, "lineweight": 30},
    )
    msp.add_line((x - 2, y), (x + 2, y), dxfattribs={"layer": layer, "lineweight": 25})


def gauge_symbol(msp, x, y, layer="FITTINGS"):
    msp.add_circle((x, y), 2.2, dxfattribs={"layer": layer, "lineweight": 30})
    msp.add_line((x, y), (x + 1.4, y + 1.4), dxfattribs={"layer": layer, "lineweight": 25})


def create_dxf():
    doc = ezdxf.new("R2010", setup=True)
    doc.units = ezdxf.units.MM
    doc.header["$INSUNITS"] = 4  # millimeters

    for name, color in [
        ("FRAME", colors.WHITE),
        ("EQUIPMENT", colors.CYAN),
        ("PIPING_AIR", colors.RED),
        ("PIPING_PAINT", colors.YELLOW),
        ("PIPING_EXHAUST", colors.GREEN),
        ("FITTINGS", colors.MAGENTA),
        ("TEXT", colors.WHITE),
        ("TITLE", colors.WHITE),
        ("LEGEND", colors.WHITE),
        ("BOOTH", colors.BLUE),
    ]:
        if name not in doc.layers:
            doc.layers.add(name, color=color)

    msp = doc.modelspace()

    # ---- Title block / frame ----
    add_rect(msp, 0, 0, 420, 297, layer="FRAME", lw=50)
    add_rect(msp, 5, 5, 410, 287, layer="FRAME", lw=25)
    msp.add_line((5, 35), (415, 35), dxfattribs={"layer": "FRAME", "lineweight": 25})
    msp.add_line((300, 5), (300, 35), dxfattribs={"layer": "FRAME", "lineweight": 25})

    add_label(
        msp,
        "ПРИНЦИПИАЛЬНАЯ СХЕМА УСТАНОВКИ ДЛЯ РАСПЫЛЕНИЯ КРАСКИ",
        210,
        280,
        h=4.5,
        layer="TITLE",
    )
    add_label(
        msp,
        "пневмораспыление ЛКМ (лаконагнетательный бак + распылитель + окрасочная кабина)",
        210,
        272,
        h=2.2,
        layer="TEXT",
    )

    add_label(msp, "Лист 1", 357.5, 25, h=2.5, layer="TITLE")
    add_label(msp, "Формат A3", 357.5, 18, h=2.0, layer="TEXT")
    add_label(msp, "Масштаб: схема", 357.5, 12, h=2.0, layer="TEXT")
    add_label(msp, "Установка распыления краски", 152.5, 22, h=3.0, layer="TITLE")
    add_label(msp, "Схематический чертёж (не строительный)", 152.5, 14, h=2.0, layer="TEXT")

    # ---- 1. Air compressor ----
    add_rect(msp, 20, 180, 45, 40, layer="EQUIPMENT")
    msp.add_circle((42.5, 200), 10, dxfattribs={"layer": "EQUIPMENT", "lineweight": 30})
    msp.add_arc((42.5, 200), 6, 40, 220, dxfattribs={"layer": "EQUIPMENT", "lineweight": 25})
    add_label(msp, "1", 42.5, 225, h=3.5, layer="TEXT")
    add_label(msp, "Компрессор", 42.5, 172, h=2.2, layer="TEXT")
    add_label(msp, "сжатого воздуха", 42.5, 167, h=1.8, layer="TEXT")

    # ---- 2. Oil-water separator / filter ----
    add_rect(msp, 90, 190, 28, 35, layer="EQUIPMENT")
    msp.add_line((93, 200), (115, 200), dxfattribs={"layer": "EQUIPMENT", "lineweight": 20})
    msp.add_line((93, 207), (115, 207), dxfattribs={"layer": "EQUIPMENT", "lineweight": 20})
    msp.add_line((93, 214), (115, 214), dxfattribs={"layer": "EQUIPMENT", "lineweight": 20})
    # drain
    msp.add_line((104, 190), (104, 184), dxfattribs={"layer": "FITTINGS", "lineweight": 20})
    msp.add_circle((104, 182), 1.5, dxfattribs={"layer": "FITTINGS", "lineweight": 20})
    add_label(msp, "2", 104, 230, h=3.5, layer="TEXT")
    add_label(msp, "Масловодо-", 104, 182, h=1.8, layer="TEXT")
    add_label(msp, "отделитель", 104, 177, h=1.8, layer="TEXT")
    add_label(msp, "(фильтр)", 104, 172, h=1.8, layer="TEXT")

    # ---- 3. Pressure regulator + gauges ----
    add_rect(msp, 145, 195, 35, 30, layer="EQUIPMENT")
    gauge_symbol(msp, 155, 230)
    gauge_symbol(msp, 170, 230)
    valve_symbol(msp, 162.5, 210)
    add_label(msp, "3", 162.5, 240, h=3.5, layer="TEXT")
    add_label(msp, "Редуктор", 162.5, 187, h=2.0, layer="TEXT")
    add_label(msp, "давления +", 162.5, 182, h=1.8, layer="TEXT")
    add_label(msp, "манометры", 162.5, 177, h=1.8, layer="TEXT")

    # ---- 4. Paint pressure pot ----
    # tank body
    msp.add_lwpolyline(
        [(210, 165), (250, 165), (250, 215), (210, 215), (210, 165)],
        close=True,
        dxfattribs={"layer": "EQUIPMENT", "lineweight": 35},
    )
    # lid
    msp.add_lwpolyline(
        [(208, 215), (252, 215), (252, 222), (208, 222), (208, 215)],
        close=True,
        dxfattribs={"layer": "EQUIPMENT", "lineweight": 30},
    )
    # agitator
    msp.add_line((230, 222), (230, 245), dxfattribs={"layer": "FITTINGS", "lineweight": 25})
    msp.add_circle((230, 248), 4, dxfattribs={"layer": "FITTINGS", "lineweight": 25})
    msp.add_line((226, 248), (234, 248), dxfattribs={"layer": "FITTINGS", "lineweight": 20})
    # paint level
    msp.add_line((214, 185), (246, 185), dxfattribs={"layer": "PIPING_PAINT", "lineweight": 20})
    msp.add_hatch(color=2).paths.add_polyline_path(
        [(214, 168), (246, 168), (246, 185), (214, 185)], is_closed=True
    )
    # safety valve
    msp.add_line((250, 218), (260, 218), dxfattribs={"layer": "FITTINGS", "lineweight": 20})
    msp.add_lwpolyline(
        [(260, 215), (266, 218), (260, 221)],
        dxfattribs={"layer": "FITTINGS", "lineweight": 20},
    )
    add_label(msp, "4", 230, 258, h=3.5, layer="TEXT")
    add_label(msp, "Лаконагнетательный бак", 230, 155, h=2.0, layer="TEXT")
    add_label(msp, "с мешалкой и ПК", 230, 150, h=1.8, layer="TEXT")

    # ---- Air piping: compressor -> filter -> regulator -> split ----
    # compressor out
    arrow_line(msp, (65, 200), (90, 200), layer="PIPING_AIR")
    arrow_line(msp, (118, 207), (145, 207), layer="PIPING_AIR")
    # from regulator to paint pot (tank pressurization)
    arrow_line(msp, (180, 210), (210, 210), layer="PIPING_AIR")
    add_label(msp, "воздух в бак", 195, 214, h=1.6, layer="TEXT")
    # from regulator to spray gun (atomizing air)
    msp.add_line((162.5, 195), (162.5, 130), dxfattribs={"layer": "PIPING_AIR", "lineweight": 25})
    msp.add_line((162.5, 130), (300, 130), dxfattribs={"layer": "PIPING_AIR", "lineweight": 25})
    arrow_line(msp, (300, 130), (318, 118), layer="PIPING_AIR")
    add_label(msp, "воздух на распыление", 230, 134, h=1.6, layer="TEXT")

    # ---- Paint hose from pot to gun ----
    msp.add_line((230, 165), (230, 110), dxfattribs={"layer": "PIPING_PAINT", "lineweight": 30})
    msp.add_line((230, 110), (318, 110), dxfattribs={"layer": "PIPING_PAINT", "lineweight": 30})
    arrow_line(msp, (318, 110), (328, 110), layer="PIPING_PAINT")
    add_label(msp, "шланг подачи ЛКМ", 270, 104, h=1.6, layer="TEXT")
    valve_symbol(msp, 250, 110)

    # ---- 5. Spray gun ----
    # body
    msp.add_lwpolyline(
        [(328, 105), (348, 105), (348, 120), (340, 120), (340, 125), (336, 125), (336, 120), (328, 120)],
        close=True,
        dxfattribs={"layer": "EQUIPMENT", "lineweight": 35},
    )
    # nozzle
    msp.add_lwpolyline(
        [(348, 110), (358, 112), (358, 113), (348, 115)],
        close=True,
        dxfattribs={"layer": "EQUIPMENT", "lineweight": 30},
    )
    # handle
    msp.add_lwpolyline(
        [(332, 105), (332, 95), (338, 95), (338, 105)],
        close=True,
        dxfattribs={"layer": "EQUIPMENT", "lineweight": 25},
    )
    # spray fan
    msp.add_line((358, 112.5), (375, 120), dxfattribs={"layer": "PIPING_PAINT", "lineweight": 15})
    msp.add_line((358, 112.5), (375, 112.5), dxfattribs={"layer": "PIPING_PAINT", "lineweight": 15})
    msp.add_line((358, 112.5), (375, 105), dxfattribs={"layer": "PIPING_PAINT", "lineweight": 15})
    add_label(msp, "5", 338, 132, h=3.5, layer="TEXT")
    add_label(msp, "Краскопульт", 338, 90, h=2.0, layer="TEXT")
    add_label(msp, "(распылитель)", 338, 85, h=1.8, layer="TEXT")

    # ---- 6. Spray booth ----
    add_rect(msp, 300, 55, 100, 95, layer="BOOTH", lw=40)
    # open front (work opening) - dashed feel with short lines
    for yy in range(60, 145, 8):
        msp.add_line((300, yy), (300, yy + 4), dxfattribs={"layer": "BOOTH", "lineweight": 20})
    # turntable
    msp.add_circle((350, 75), 12, dxfattribs={"layer": "EQUIPMENT", "lineweight": 30})
    msp.add_circle((350, 75), 3, dxfattribs={"layer": "EQUIPMENT", "lineweight": 20})
    add_label(msp, "6а поворотный стол", 350, 58, h=1.6, layer="TEXT")
    # workpiece
    add_rect(msp, 342, 78, 16, 18, layer="EQUIPMENT", lw=25)
    add_label(msp, "изделие", 350, 88, h=1.5, layer="TEXT")

    # water curtain / filter wall at back
    add_rect(msp, 385, 60, 10, 70, layer="EQUIPMENT", lw=25)
    for yy in [70, 85, 100, 115]:
        msp.add_line((387, yy), (393, yy - 4), dxfattribs={"layer": "PIPING_EXHAUST", "lineweight": 15})
    add_label(msp, "фильтр /", 390, 140, h=1.5, layer="TEXT")
    add_label(msp, "завеса", 390, 136, h=1.5, layer="TEXT")

    add_label(msp, "6", 350, 145, h=3.5, layer="TEXT")
    add_label(msp, "Окрасочная кабина", 350, 48, h=2.0, layer="TEXT")

    # ---- 7. Exhaust fan ----
    msp.add_line((395, 130), (410, 130), dxfattribs={"layer": "PIPING_EXHAUST", "lineweight": 30})
    msp.add_line((410, 130), (410, 200), dxfattribs={"layer": "PIPING_EXHAUST", "lineweight": 30})
    msp.add_circle((410, 215), 12, dxfattribs={"layer": "EQUIPMENT", "lineweight": 35})
    # fan blades
    msp.add_line((410, 215), (410, 224), dxfattribs={"layer": "EQUIPMENT", "lineweight": 25})
    msp.add_line((410, 215), (418, 210), dxfattribs={"layer": "EQUIPMENT", "lineweight": 25})
    msp.add_line((410, 215), (402, 210), dxfattribs={"layer": "EQUIPMENT", "lineweight": 25})
    arrow_line(msp, (410, 227), (410, 245), layer="PIPING_EXHAUST")
    add_label(msp, "7", 410, 255, h=3.5, layer="TEXT")
    add_label(msp, "Вытяжной", 390, 215, h=1.8, layer="TEXT")
    add_label(msp, "вентилятор", 390, 210, h=1.8, layer="TEXT")
    add_label(msp, "в атмосферу", 390, 250, h=1.6, layer="TEXT")
    # Note: x=410 is near right border - move fan left a bit for A3 frame
    # Actually frame goes to 415, so 410+12=422 overflows. Fix by regenerating positions...
    # We'll leave and clip conceptually; better fix coordinates below in a second pass.

    # ---- Legend / specification ----
    add_rect(msp, 15, 45, 175, 100, layer="LEGEND", lw=25)
    add_label(msp, "СПЕЦИФИКАЦИЯ УЗЛОВ", 102.5, 136, h=2.5, layer="TITLE")
    legend = [
        "1 — Компрессор сжатого воздуха",
        "2 — Масловодоотделитель / фильтр воздуха",
        "3 — Редуктор давления с манометрами",
        "4 — Лаконагнетательный бак (ЛКМ + мешалка)",
        "5 — Краскопульт (пневматический распылитель)",
        "6 — Окрасочная кабина (тупиковая)",
        "6а — Поворотный стол для изделия",
        "7 — Вытяжной вентилятор и воздуховод",
        "ПК — предохранительный клапан на баке",
    ]
    y = 128
    for line in legend:
        add_label(msp, line, 20, y, h=1.9, layer="TEXT", align=TextEntityAlignment.MIDDLE_LEFT)
        y -= 7

    # flow notes
    add_rect(msp, 15, 45, 175, 0.01, layer="LEGEND", lw=1)  # noop guard
    add_label(msp, "ПОТОКИ:", 200, 136, h=2.2, layer="TITLE", align=TextEntityAlignment.MIDDLE_LEFT)
    add_label(msp, "——— воздух (сжатый)", 200, 128, h=1.8, layer="TEXT", align=TextEntityAlignment.MIDDLE_LEFT)
    add_label(msp, "——— лакокрасочный материал", 200, 120, h=1.8, layer="TEXT", align=TextEntityAlignment.MIDDLE_LEFT)
    add_label(msp, "——— вытяжной воздух", 200, 112, h=1.8, layer="TEXT", align=TextEntityAlignment.MIDDLE_LEFT)
    add_label(
        msp,
        "Принцип: сжатый воздух давит на ЛКМ в баке;",
        200,
        100,
        h=1.7,
        layer="TEXT",
        align=TextEntityAlignment.MIDDLE_LEFT,
    )
    add_label(
        msp,
        "вторая линия воздуха распыляет материал в сопле.",
        200,
        93,
        h=1.7,
        layer="TEXT",
        align=TextEntityAlignment.MIDDLE_LEFT,
    )
    add_label(
        msp,
        "Кабина удаляет окрасочный туман через фильтр.",
        200,
        86,
        h=1.7,
        layer="TEXT",
        align=TextEntityAlignment.MIDDLE_LEFT,
    )

    doc.saveas(DXF_PATH)
    print(f"Wrote {DXF_PATH}")
    return DXF_PATH


def fix_and_recreate():
    """Recreate with fan fully inside A3 frame."""
    doc = ezdxf.new("R2010", setup=True)
    doc.units = ezdxf.units.MM
    doc.header["$INSUNITS"] = 4

    layers = {
        "FRAME": colors.WHITE,
        "EQUIPMENT": colors.CYAN,
        "PIPING_AIR": colors.RED,
        "PIPING_PAINT": colors.YELLOW,
        "PIPING_EXHAUST": colors.GREEN,
        "FITTINGS": colors.MAGENTA,
        "TEXT": colors.WHITE,
        "TITLE": colors.WHITE,
        "LEGEND": colors.WHITE,
        "BOOTH": colors.BLUE,
    }
    for name, color in layers.items():
        doc.layers.add(name, color=color)

    msp = doc.modelspace()

    # Frame A3
    add_rect(msp, 0, 0, 420, 297, layer="FRAME", lw=50)
    add_rect(msp, 5, 5, 410, 287, layer="FRAME", lw=25)
    msp.add_line((5, 35), (415, 35), dxfattribs={"layer": "FRAME", "lineweight": 25})
    msp.add_line((290, 5), (290, 35), dxfattribs={"layer": "FRAME", "lineweight": 25})
    msp.add_line((350, 5), (350, 35), dxfattribs={"layer": "FRAME", "lineweight": 25})

    add_label(msp, "ПРИНЦИПИАЛЬНАЯ СХЕМА УСТАНОВКИ ДЛЯ РАСПЫЛЕНИЯ КРАСКИ", 210, 282, h=4.2, layer="TITLE")
    add_label(msp, "Пневмораспыление ЛКМ: бак — краскопульт — окрасочная кабина — вытяжка", 210, 274, h=2.0, layer="TEXT")

    add_label(msp, "Установка распыления краски", 147.5, 22, h=2.8, layer="TITLE")
    add_label(msp, "Схематический чертёж", 147.5, 14, h=1.8, layer="TEXT")
    add_label(msp, "Формат A3", 320, 22, h=2.2, layer="TEXT")
    add_label(msp, "Лист 1 / 1", 320, 14, h=2.2, layer="TEXT")
    add_label(msp, "Схема", 382.5, 22, h=2.2, layer="TEXT")
    add_label(msp, "б/м", 382.5, 14, h=2.2, layer="TEXT")

    # 1 compressor
    add_rect(msp, 18, 185, 42, 38, layer="EQUIPMENT")
    msp.add_circle((39, 204), 9, dxfattribs={"layer": "EQUIPMENT", "lineweight": 30})
    msp.add_arc((39, 204), 5.5, 35, 215, dxfattribs={"layer": "EQUIPMENT", "lineweight": 25})
    add_label(msp, "1", 39, 230, h=3.2, layer="TEXT")
    add_label(msp, "Компрессор", 39, 176, h=2.0, layer="TEXT")

    # 2 separator
    add_rect(msp, 80, 192, 26, 32, layer="EQUIPMENT")
    for yy in (200, 206, 212):
        msp.add_line((83, yy), (103, yy), dxfattribs={"layer": "EQUIPMENT", "lineweight": 18})
    msp.add_line((93, 192), (93, 186), dxfattribs={"layer": "FITTINGS", "lineweight": 18})
    msp.add_circle((93, 184), 1.4, dxfattribs={"layer": "FITTINGS", "lineweight": 18})
    add_label(msp, "2", 93, 230, h=3.2, layer="TEXT")
    add_label(msp, "Масловодо-", 93, 178, h=1.7, layer="TEXT")
    add_label(msp, "отделитель", 93, 173, h=1.7, layer="TEXT")

    # 3 regulator
    add_rect(msp, 128, 196, 32, 28, layer="EQUIPMENT")
    gauge_symbol(msp, 138, 232)
    gauge_symbol(msp, 152, 232)
    valve_symbol(msp, 144, 210)
    add_label(msp, "3", 144, 242, h=3.2, layer="TEXT")
    add_label(msp, "Редуктор", 144, 188, h=1.8, layer="TEXT")
    add_label(msp, "+ манометры", 144, 183, h=1.6, layer="TEXT")

    # 4 paint pot
    add_rect(msp, 185, 168, 40, 48, layer="EQUIPMENT")
    add_rect(msp, 183, 216, 44, 7, layer="EQUIPMENT")
    msp.add_line((205, 223), (205, 245), dxfattribs={"layer": "FITTINGS", "lineweight": 22})
    msp.add_circle((205, 248), 3.5, dxfattribs={"layer": "FITTINGS", "lineweight": 22})
    hatch = msp.add_hatch(color=2)
    hatch.paths.add_polyline_path([(189, 172), (221, 172), (221, 190), (189, 190)], is_closed=True)
    msp.add_line((225, 220), (238, 220), dxfattribs={"layer": "FITTINGS", "lineweight": 18})
    msp.add_lwpolyline([(238, 217), (244, 220), (238, 223)], dxfattribs={"layer": "FITTINGS", "lineweight": 18})
    add_label(msp, "ПК", 248, 220, h=1.6, layer="TEXT")
    add_label(msp, "4", 205, 258, h=3.2, layer="TEXT")
    add_label(msp, "Лаконагнетательный бак", 205, 158, h=1.8, layer="TEXT")
    add_label(msp, "с мешалкой", 205, 153, h=1.6, layer="TEXT")

    # air lines
    arrow_line(msp, (60, 204), (80, 204), layer="PIPING_AIR")
    arrow_line(msp, (106, 208), (128, 208), layer="PIPING_AIR")
    arrow_line(msp, (160, 210), (185, 210), layer="PIPING_AIR")
    add_label(msp, "воздух в бак", 172, 214, h=1.5, layer="TEXT")

    msp.add_line((144, 196), (144, 125), dxfattribs={"layer": "PIPING_AIR", "lineweight": 25})
    msp.add_line((144, 125), (275, 125), dxfattribs={"layer": "PIPING_AIR", "lineweight": 25})
    arrow_line(msp, (275, 125), (292, 116), layer="PIPING_AIR")
    add_label(msp, "воздух на распыление", 210, 129, h=1.5, layer="TEXT")

    # paint hose
    msp.add_line((205, 168), (205, 108), dxfattribs={"layer": "PIPING_PAINT", "lineweight": 30})
    msp.add_line((205, 108), (292, 108), dxfattribs={"layer": "PIPING_PAINT", "lineweight": 30})
    arrow_line(msp, (292, 108), (300, 108), layer="PIPING_PAINT")
    valve_symbol(msp, 235, 108)
    add_label(msp, "шланг ЛКМ", 250, 102, h=1.5, layer="TEXT")

    # 5 spray gun
    msp.add_lwpolyline(
        [
            (300, 102),
            (318, 102),
            (318, 116),
            (312, 116),
            (312, 120),
            (308, 120),
            (308, 116),
            (300, 116),
        ],
        close=True,
        dxfattribs={"layer": "EQUIPMENT", "lineweight": 32},
    )
    msp.add_lwpolyline(
        [(318, 107), (328, 109), (328, 110), (318, 112)],
        close=True,
        dxfattribs={"layer": "EQUIPMENT", "lineweight": 28},
    )
    add_rect(msp, 304, 94, 6, 8, layer="EQUIPMENT", lw=22)
    for a, b in [((328, 109.5), (345, 118)), ((328, 109.5), (345, 109.5)), ((328, 109.5), (345, 101))]:
        msp.add_line(a, b, dxfattribs={"layer": "PIPING_PAINT", "lineweight": 12})
    add_label(msp, "5", 309, 128, h=3.2, layer="TEXT")
    add_label(msp, "Краскопульт", 309, 88, h=1.8, layer="TEXT")

    # 6 booth
    add_rect(msp, 275, 50, 95, 90, layer="BOOTH", lw=40)
    for yy in range(55, 135, 8):
        msp.add_line((275, yy), (275, min(yy + 4, 138)), dxfattribs={"layer": "BOOTH", "lineweight": 18})
    msp.add_circle((320, 70), 11, dxfattribs={"layer": "EQUIPMENT", "lineweight": 28})
    msp.add_circle((320, 70), 2.5, dxfattribs={"layer": "EQUIPMENT", "lineweight": 18})
    add_rect(msp, 313, 74, 14, 16, layer="EQUIPMENT", lw=22)
    add_label(msp, "изделие", 320, 84, h=1.4, layer="TEXT")
    add_label(msp, "6а стол", 320, 54, h=1.5, layer="TEXT")
    add_rect(msp, 355, 55, 10, 65, layer="EQUIPMENT", lw=22)
    for yy in (65, 80, 95, 110):
        msp.add_line((357, yy), (363, yy - 4), dxfattribs={"layer": "PIPING_EXHAUST", "lineweight": 12})
    add_label(msp, "фильтр", 360, 128, h=1.4, layer="TEXT")
    add_label(msp, "6", 322, 135, h=3.2, layer="TEXT")
    add_label(msp, "Окрасочная кабина", 322, 44, h=1.8, layer="TEXT")

    # 7 exhaust
    msp.add_line((365, 120), (385, 120), dxfattribs={"layer": "PIPING_EXHAUST", "lineweight": 28})
    msp.add_line((385, 120), (385, 195), dxfattribs={"layer": "PIPING_EXHAUST", "lineweight": 28})
    msp.add_circle((385, 208), 11, dxfattribs={"layer": "EQUIPMENT", "lineweight": 32})
    msp.add_line((385, 208), (385, 216), dxfattribs={"layer": "EQUIPMENT", "lineweight": 22})
    msp.add_line((385, 208), (392, 203), dxfattribs={"layer": "EQUIPMENT", "lineweight": 22})
    msp.add_line((385, 208), (378, 203), dxfattribs={"layer": "EQUIPMENT", "lineweight": 22})
    arrow_line(msp, (385, 219), (385, 240), layer="PIPING_EXHAUST")
    add_label(msp, "7", 385, 250, h=3.2, layer="TEXT")
    add_label(msp, "Вытяжной вентилятор", 340, 208, h=1.7, layer="TEXT")
    add_label(msp, "в атмосферу", 370, 245, h=1.5, layer="TEXT")

    # legend box
    add_rect(msp, 15, 42, 200, 105, layer="LEGEND", lw=22)
    add_label(msp, "СПЕЦИФИКАЦИЯ", 115, 138, h=2.4, layer="TITLE")
    items = [
        "1 — Компрессор сжатого воздуха",
        "2 — Масловодоотделитель (фильтр воздуха)",
        "3 — Редуктор давления с манометрами",
        "4 — Лаконагнетательный бак с мешалкой",
        "5 — Краскопульт (пневматический распылитель)",
        "6 — Окрасочная кабина (тупиковая)",
        "6а — Поворотный стол для изделия",
        "7 — Вытяжной вентилятор и воздуховод",
        "ПК — предохранительный клапан",
    ]
    y = 128
    for line in items:
        add_label(msp, line, 20, y, h=1.85, layer="TEXT", align=TextEntityAlignment.MIDDLE_LEFT)
        y -= 8

    add_label(msp, "ПРИНЦИП РАБОТЫ", 230, 100, h=2.2, layer="TITLE", align=TextEntityAlignment.MIDDLE_LEFT)
    notes = [
        "Сжатый воздух через фильтр и редуктор:",
        "• давит на ЛКМ в баке (подача в пистолет);",
        "• подаётся в краскопульт для распыления.",
        "Изделие окрашивается в кабине; туман",
        "удаляется вытяжкой через фильтр/завесу.",
    ]
    y = 90
    for line in notes:
        add_label(msp, line, 230, y, h=1.65, layer="TEXT", align=TextEntityAlignment.MIDDLE_LEFT)
        y -= 7

    # color key
    msp.add_line((230, 52), (250, 52), dxfattribs={"layer": "PIPING_AIR", "lineweight": 35})
    add_label(msp, "воздух", 268, 52, h=1.6, layer="TEXT", align=TextEntityAlignment.MIDDLE_LEFT)
    msp.add_line((230, 46), (250, 46), dxfattribs={"layer": "PIPING_PAINT", "lineweight": 35})
    add_label(msp, "ЛКМ", 268, 46, h=1.6, layer="TEXT", align=TextEntityAlignment.MIDDLE_LEFT)
    msp.add_line((300, 52), (320, 52), dxfattribs={"layer": "PIPING_EXHAUST", "lineweight": 35})
    add_label(msp, "вытяжка", 338, 52, h=1.6, layer="TEXT", align=TextEntityAlignment.MIDDLE_LEFT)

    doc.saveas(DXF_PATH)
    print(f"Wrote {DXF_PATH}")
    return doc


def render_png(doc):
    """Render DXF preview to PNG via matplotlib."""
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection

    fig, ax = plt.subplots(figsize=(14, 10), facecolor="#1a1a1a")
    ax.set_facecolor("#1a1a1a")

    layer_colors = {
        "FRAME": "#cccccc",
        "EQUIPMENT": "#3ec1d3",
        "PIPING_AIR": "#ff5a5a",
        "PIPING_PAINT": "#f0d54a",
        "PIPING_EXHAUST": "#5dcf6e",
        "FITTINGS": "#d66bff",
        "TEXT": "#eeeeee",
        "TITLE": "#ffffff",
        "LEGEND": "#aaaaaa",
        "BOOTH": "#5b8def",
    }

    msp = doc.modelspace()
    for e in msp:
        layer = e.dxf.layer
        color = layer_colors.get(layer, "#dddddd")
        t = e.dxftype()
        if t == "LINE":
            ax.plot(
                [e.dxf.start.x, e.dxf.end.x],
                [e.dxf.start.y, e.dxf.end.y],
                color=color,
                lw=1.2,
            )
        elif t == "LWPOLYLINE":
            pts = list(e.get_points("xy"))
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            if e.closed and pts:
                xs.append(pts[0][0])
                ys.append(pts[0][1])
            ax.plot(xs, ys, color=color, lw=1.4)
        elif t == "CIRCLE":
            c = plt.Circle(
                (e.dxf.center.x, e.dxf.center.y),
                e.dxf.radius,
                fill=False,
                edgecolor=color,
                lw=1.3,
            )
            ax.add_patch(c)
        elif t == "ARC":
            import numpy as np

            ang = np.linspace(e.dxf.start_angle, e.dxf.end_angle, 40)
            rad = np.deg2rad(ang)
            xs = e.dxf.center.x + e.dxf.radius * np.cos(rad)
            ys = e.dxf.center.y + e.dxf.radius * np.sin(rad)
            ax.plot(xs, ys, color=color, lw=1.2)
        elif t == "TEXT":
            ax.text(
                e.dxf.insert.x,
                e.dxf.insert.y,
                e.dxf.text,
                color=color,
                fontsize=max(4.5, e.dxf.height * 1.1),
                ha="center",
                va="center",
                fontfamily="DejaVu Sans",
            )
        elif t == "HATCH":
            try:
                for path in e.paths:
                    verts = [(v[0], v[1]) for v in path.vertices]
                    if verts:
                        xs = [v[0] for v in verts] + [verts[0][0]]
                        ys = [v[1] for v in verts] + [verts[0][1]]
                        ax.fill(xs, ys, color="#f0d54a", alpha=0.35)
            except Exception:
                pass

    ax.set_aspect("equal")
    ax.set_xlim(-5, 425)
    ax.set_ylim(-5, 302)
    ax.axis("off")
    fig.tight_layout(pad=0.3)
    fig.savefig(PNG_PATH, dpi=160, facecolor=fig.get_facecolor())
    plt.close(fig)
    print(f"Wrote {PNG_PATH}")


if __name__ == "__main__":
    doc = fix_and_recreate()
    render_png(doc)
