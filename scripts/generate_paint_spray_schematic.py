#!/usr/bin/env python3
"""Generate a conceptual pneumatic paint-spray installation schematic."""

from pathlib import Path

import ezdxf
from ezdxf.addons.drawing import Frontend, RenderContext, layout, svg
from ezdxf.enums import MTextEntityAlignment, TextEntityAlignment


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "downloads" / "paint_spray_system_schematic.dxf"
SVG_OUTPUT = ROOT / "docs" / "downloads" / "paint_spray_system_schematic.svg"

doc = ezdxf.new("R2000")
doc.encoding = "cp1251"
doc.header["$INSUNITS"] = 4  # millimetres
doc.header["$LIMMIN"] = (0, 0)
doc.header["$LIMMAX"] = (420, 297)
doc.header["$DWGCODEPAGE"] = "ANSI_1251"
doc.styles.add("Schematic", font="Arial.ttf")

for name, color, lineweight in (
    ("FRAME", 7, 35),
    ("EQUIPMENT", 7, 35),
    ("AIR", 5, 40),
    ("PAINT", 1, 50),
    ("EXHAUST", 3, 40),
    ("GROUND", 2, 25),
    ("TEXT", 7, 18),
):
    doc.layers.add(name, color=color, lineweight=lineweight)

msp = doc.modelspace()


def line(a, b, layer="EQUIPMENT", linetype="CONTINUOUS"):
    return msp.add_line(a, b, dxfattribs={"layer": layer, "linetype": linetype})


def poly(points, layer="EQUIPMENT", close=False):
    return msp.add_lwpolyline(
        points, close=close, dxfattribs={"layer": layer}
    )


def circle(center, radius, layer="EQUIPMENT"):
    return msp.add_circle(center, radius, dxfattribs={"layer": layer})


def arc(center, radius, start, end, layer="EQUIPMENT"):
    return msp.add_arc(
        center, radius, start, end, dxfattribs={"layer": layer}
    )


def text(value, point, height=3.0, layer="TEXT", align=TextEntityAlignment.MIDDLE_CENTER):
    if "\n" in value:
        attachment = (
            MTextEntityAlignment.MIDDLE_LEFT
            if align == TextEntityAlignment.MIDDLE_LEFT
            else MTextEntityAlignment.MIDDLE_CENTER
        )
        entity = msp.add_mtext(
            value.replace("\n", r"\P"),
            dxfattribs={
                "char_height": height,
                "layer": layer,
                "style": "Schematic",
                "attachment_point": attachment,
            },
        )
        entity.set_location(point, attachment_point=attachment)
        return entity
    entity = msp.add_text(
        value,
        dxfattribs={
            "height": height,
            "layer": layer,
            "style": "Schematic",
        },
    )
    entity.set_placement(point, align=align)
    return entity


def arrow(start, end, layer):
    line(start, end, layer)
    x1, y1 = start
    x2, y2 = end
    dx, dy = x2 - x1, y2 - y1
    length = max((dx * dx + dy * dy) ** 0.5, 0.001)
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    size = 3.2
    left = (x2 - size * ux + 1.4 * px, y2 - size * uy + 1.4 * py)
    right = (x2 - size * ux - 1.4 * px, y2 - size * uy - 1.4 * py)
    poly([left, (x2, y2), right], layer)


def label(number, name, x, name_y=145):
    circle((x, 222), 4, "TEXT")
    text(str(number), (x, 222), 2.8)
    text(name, (x, name_y), 2.2)


# A3 landscape sheet and title block.
poly([(5, 5), (415, 5), (415, 292), (5, 292)], "FRAME", True)
poly([(10, 10), (410, 10), (410, 287), (10, 287)], "FRAME", True)
line((10, 42), (410, 42), "FRAME")
line((280, 10), (280, 42), "FRAME")
line((350, 10), (350, 42), "FRAME")
line((280, 27), (410, 27), "FRAME")
text("ПРИНЦИПИАЛЬНАЯ СХЕМА УСТАНОВКИ ДЛЯ РАСПЫЛЕНИЯ КРАСКИ", (210, 277), 5)
text("Пневматическое распыление из красконагнетательного бака", (210, 269), 3.2)
text("Формат A3 | единицы: мм | схема без масштаба", (145, 19), 2.8)
text("Лист 1 / 1", (315, 34), 3)
text("Версия 1.0", (380, 34), 3)
text("Обозначение: PS-01", (315, 18), 2.7)
text("31.07.2026", (380, 18), 2.7)

# Compressor.
circle((35, 185), 15)
poly([(28, 177), (28, 193), (43, 185)], "EQUIPMENT", True)
line((20, 173), (15, 168))
line((50, 173), (55, 168))
line((15, 168), (55, 168))
line((50, 185), (59, 185), "AIR")
label(1, "КОМПРЕССОР", 35, 147)

# Air receiver.
line((63, 185), (67, 185), "AIR")
line((67, 166), (67, 204))
line((83, 166), (83, 204))
arc((75, 166), 8, 180, 360)
arc((75, 204), 8, 0, 180)
line((75, 158), (75, 153))
poly([(72, 153), (78, 153), (75, 148)], "EQUIPMENT", True)
line((83, 185), (93, 185), "AIR")
label(2, "РЕСИВЕР", 75, 146)

# Filter / moisture separator.
poly([(93, 174), (113, 174), (113, 196), (93, 196)], "EQUIPMENT", True)
line((94, 175), (112, 195))
line((103, 174), (103, 166))
poly([(100, 166), (106, 166), (103, 162)], "EQUIPMENT", True)
line((113, 185), (123, 185), "AIR")
label(3, "ФИЛЬТР-\nВЛАГООТДЕЛИТЕЛЬ", 103, 143)

# Pressure regulator and gauge.
circle((133, 185), 10)
line((123, 185), (143, 185), "AIR")
poly([(128, 180), (133, 190), (138, 180)], "EQUIPMENT")
line((133, 195), (133, 202))
circle((133, 208), 6)
line((133, 208), (136, 211))
line((143, 185), (158, 185), "AIR")
label(4, "РЕДУКТОР\nС МАНОМЕТРОМ", 133, 143)

# Main air header and split.
arrow((158, 185), (299, 185), "AIR")
circle((177, 185), 1.3, "AIR")
line((177, 185), (177, 132), "AIR")
arrow((177, 132), (207, 132), "AIR")
text("ВОЗДУХ 0,4–0,6 МПа", (225, 191), 2.8, "AIR")
text("ДАВЛЕНИЕ В БАКЕ 0,2–0,5 МПа", (191, 137), 2.4, "AIR")

# Pressure paint pot.
line((207, 105), (207, 128))
line((237, 105), (237, 128))
arc((222, 105), 15, 180, 360)
arc((222, 128), 15, 0, 180)
line((203, 128), (241, 128))
line((209, 124), (235, 124))
circle((222, 139), 5)
line((222, 139), (225, 141))
line((207, 114), (237, 114), "PAINT")
text("КРАСКА", (222, 109), 2.5, "PAINT")
line((214, 90), (214, 84))
line((230, 90), (230, 84))
line((210, 84), (218, 84))
line((226, 84), (234, 84))
label(5, "КРАСКОНАГНЕТАТЕЛЬНЫЙ\nБАК", 222, 78)

# Paint hose from dip tube to gun.
line((228, 124), (228, 119), "PAINT")
line((228, 119), (228, 100), "PAINT")
line((228, 100), (265, 100), "PAINT")
line((265, 100), (265, 171), "PAINT")
arrow((265, 171), (299, 171), "PAINT")
text("КРАСКОПРОВОД", (266, 96), 2.7, "PAINT")

# Spray gun.
poly([(299, 168), (319, 168), (325, 174), (319, 180), (299, 180)], "EQUIPMENT", True)
line((307, 168), (303, 155))
line((303, 155), (311, 155))
line((311, 155), (315, 168))
line((325, 174), (333, 174))
circle((303, 185), 2, "AIR")
line((303, 183), (303, 180), "AIR")
label(6, "КРАСКОПУЛЬТ", 312, 146)

# Spray cone and ventilated booth.
line((333, 174), (350, 166), "PAINT")
line((333, 174), (350, 182), "PAINT")
for y in (168, 172, 176, 180):
    line((337, 174), (349, y), "PAINT")
poly([(350, 88), (400, 88), (400, 214), (350, 214)], "EQUIPMENT")
line((350, 88), (342, 80))
line((400, 88), (408, 80))
line((342, 80), (408, 80))
text("ОКРАШИВАЕМОЕ\nИЗДЕЛИЕ", (377, 145), 3)
poly([(366, 120), (388, 120), (388, 167), (366, 167)], "EQUIPMENT", True)
label(7, "ОКРАСОЧНАЯ КАМЕРА", 375, 98)

# Exhaust fan and discharge.
line((375, 214), (375, 225), "EXHAUST")
circle((375, 236), 11, "EXHAUST")
poly([(375, 236), (369, 228), (380, 231)], "EXHAUST", True)
poly([(375, 236), (383, 230), (380, 241)], "EXHAUST", True)
poly([(375, 236), (381, 244), (370, 241)], "EXHAUST", True)
arrow((386, 236), (405, 236), "EXHAUST")
text("ВЫБРОС НАРУЖУ", (385, 254), 2.7, "EXHAUST")
text(
    "ВЫТЯЖНОЙ ВЕНТИЛЯТОР",
    (358, 236),
    2.2,
    "EXHAUST",
    TextEntityAlignment.MIDDLE_RIGHT,
)

# Protective grounding.
line((222, 90), (222, 68), "GROUND")
line((312, 155), (312, 68), "GROUND")
line((205, 68), (325, 68), "GROUND")
for x in (222, 312):
    line((x, 68), (x, 64), "GROUND")
    line((x - 5, 64), (x + 5, 64), "GROUND")
    line((x - 3.5, 61), (x + 3.5, 61), "GROUND")
    line((x - 2, 58), (x + 2, 58), "GROUND")
text("ЗАЩИТНОЕ ЗАЗЕМЛЕНИЕ И УРАВНИВАНИЕ ПОТЕНЦИАЛОВ", (265, 53), 2.5, "GROUND")

# Legend and design note.
line((22, 251), (47, 251), "AIR")
text("сжатый воздух", (51, 251), 2.7, align=TextEntityAlignment.MIDDLE_LEFT)
line((112, 251), (137, 251), "PAINT")
text("краска", (141, 251), 2.7, align=TextEntityAlignment.MIDDLE_LEFT)
line((188, 251), (213, 251), "EXHAUST")
text("вытяжной воздух", (217, 251), 2.7, align=TextEntityAlignment.MIDDLE_LEFT)
line((312, 251), (337, 251), "GROUND")
text("заземление", (341, 251), 2.7, align=TextEntityAlignment.MIDDLE_LEFT)
text(
    "ПРИМЕЧАНИЕ: концептуальная схема. Подбор оборудования, диаметров, "
    "взрывозащиты и вентиляции выполнять по проекту и паспорту ЛКМ.",
    (210, 48),
    2.25,
)

# Numbered equipment key.
text(
    "1 — компрессор; 2 — ресивер; 3 — фильтр; 4 — редуктор; "
    "5 — бак; 6 — краскопульт; 7 — окрасочная камера.",
    (210, 236),
    2.45,
)

doc.set_modelspace_vport(height=310, center=(210, 148.5))
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
doc.saveas(OUTPUT)
backend = svg.SVGBackend()
Frontend(RenderContext(doc), backend).draw_layout(msp)
page = layout.Page(420, 297, units=layout.Units.mm, margins=layout.Margins.all(5))
SVG_OUTPUT.write_text(backend.get_string(page), encoding="utf-8")
print(OUTPUT)
