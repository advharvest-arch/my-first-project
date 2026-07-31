"""Generate a schematic pneumatic paint-spraying installation in DXF format."""

from pathlib import Path

import ezdxf
from ezdxf.enums import TextEntityAlignment

OUTPUT = Path(__file__).with_name("spray_paint_installation.dxf")


def add_box(msp, x1, y1, x2, y2, label, layer="EQUIPMENT"):
    msp.add_lwpolyline(
        [(x1, y1), (x2, y1), (x2, y2), (x1, y2), (x1, y1)],
        dxfattribs={"layer": layer, "lineweight": 50},
    )
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    msp.add_mtext(
        label,
        dxfattribs={"layer": "TEXT", "char_height": 4.0, "attachment_point": 5},
    ).set_location((cx, cy))


def add_arrow(msp, start, end, label=None, layer="PAINT"):
    x1, y1 = start
    x2, y2 = end
    msp.add_line(start, end, dxfattribs={"layer": layer, "lineweight": 35})
    msp.add_solid(
        [(x2, y2), (x2 - 4, y2 + 2), (x2 - 4, y2 - 2)],
        dxfattribs={"layer": layer},
    )
    if label:
        msp.add_text(
            label,
            dxfattribs={"layer": "TEXT", "height": 2.8},
        ).set_placement(((x1 + x2) / 2, (y1 + y2) / 2 + 3), align=TextEntityAlignment.MIDDLE_CENTER)


def main():
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4  # millimetres
    doc.layers.new("EQUIPMENT", dxfattribs={"color": 250})
    doc.layers.new("PAINT", dxfattribs={"color": 1})
    doc.layers.new("AIR", dxfattribs={"color": 5})
    doc.layers.new("EXHAUST", dxfattribs={"color": 3})
    doc.layers.new("TEXT", dxfattribs={"color": 250})
    doc.layers.new("FRAME", dxfattribs={"color": 250})
    msp = doc.modelspace()

    # Frame and title
    msp.add_lwpolyline(
        [(0, 0), (300, 0), (300, 180), (0, 180), (0, 0)],
        dxfattribs={"layer": "FRAME", "lineweight": 50},
    )
    msp.add_text(
        "СХЕМА УСТАНОВКИ ДЛЯ ПНЕВМАТИЧЕСКОГО РАСПЫЛЕНИЯ КРАСКИ",
        dxfattribs={"layer": "TEXT", "height": 6},
    ).set_placement((150, 168), align=TextEntityAlignment.MIDDLE_CENTER)
    msp.add_text(
        "Принципиальная схема. Не является монтажным чертежом.",
        dxfattribs={"layer": "TEXT", "height": 3},
    ).set_placement((150, 160), align=TextEntityAlignment.MIDDLE_CENTER)

    # Paint circuit
    add_box(msp, 18, 86, 58, 118, "1\nБАК С КРАСКОЙ")
    msp.add_line((22, 82), (54, 82), dxfattribs={"layer": "EQUIPMENT"})
    add_box(msp, 78, 89, 112, 115, "2\nНАСОС")
    add_box(msp, 132, 91, 168, 113, "3\nФИЛЬТР\nКРАСКИ")
    add_box(msp, 188, 89, 224, 115, "4\nРЕГУЛЯТОР\nДАВЛЕНИЯ")

    # Air circuit
    add_box(msp, 18, 34, 58, 61, "5\nКОМПРЕССОР")
    add_box(msp, 78, 36, 112, 59, "6\nОСУШИТЕЛЬ /\nФИЛЬТР")
    add_box(msp, 132, 36, 168, 59, "7\nРЕДУКТОР\nВОЗДУХА")

    # Spray booth and guns
    add_box(msp, 243, 57, 286, 128, "8\nОКРАСОЧНАЯ\nКАМЕРА")
    msp.add_line((252, 72), (276, 72), dxfattribs={"layer": "EQUIPMENT"})
    msp.add_line((252, 72), (252, 110), dxfattribs={"layer": "EQUIPMENT"})
    msp.add_circle((264, 91), 8, dxfattribs={"layer": "EQUIPMENT"})
    msp.add_text(
        "Деталь",
        dxfattribs={"layer": "TEXT", "height": 2.5},
    ).set_placement((264, 88), align=TextEntityAlignment.MIDDLE_CENTER)
    msp.add_lwpolyline(
        [(230, 99), (240, 99), (240, 92), (235, 92), (235, 87), (240, 87)],
        dxfattribs={"layer": "EQUIPMENT", "lineweight": 35},
    )
    msp.add_text(
        "9 ПИСТОЛЕТ-\nРАСПЫЛИТЕЛЬ",
        dxfattribs={"layer": "TEXT", "height": 2.7},
    ).set_placement((174, 118))
    for y in (88, 92, 96):
        msp.add_line((240, y), (249, y), dxfattribs={"layer": "PAINT"})

    # Exhaust
    add_box(msp, 243, 136, 286, 151, "10 ВЫТЯЖКА /\nФИЛЬТР")
    add_arrow(msp, (264, 128), (264, 136), "воздух", "EXHAUST")

    # Process connections
    add_arrow(msp, (58, 102), (78, 102), "краска")
    add_arrow(msp, (112, 102), (132, 102))
    add_arrow(msp, (168, 102), (188, 102))
    add_arrow(msp, (224, 102), (235, 102), "краска")
    add_arrow(msp, (58, 47), (78, 47), "сжатый воздух", "AIR")
    add_arrow(msp, (112, 47), (132, 47), None, "AIR")
    add_arrow(msp, (168, 47), (218, 47), "сжатый воздух", "AIR")
    msp.add_line((218, 47), (218, 89), dxfattribs={"layer": "AIR", "lineweight": 35})
    add_arrow(msp, (218, 89), (235, 89), None, "AIR")

    # Control panel and electrical/control lines
    add_box(msp, 82, 132, 156, 148, "11 ПАНЕЛЬ УПРАВЛЕНИЯ")
    for x, target in ((96, 95), (119, 102), (142, 102)):
        msp.add_line((x, 132), (x, 124), dxfattribs={"layer": "TEXT", "linetype": "DASHED"})
        msp.add_line((x, 124), (target, 124), dxfattribs={"layer": "TEXT", "linetype": "DASHED"})
        msp.add_line((target, 124), (target, target if target < 115 else 115), dxfattribs={"layer": "TEXT", "linetype": "DASHED"})

    # Legend
    msp.add_text(
        "УСЛОВНЫЕ ОБОЗНАЧЕНИЯ:",
        dxfattribs={"layer": "TEXT", "height": 3.2},
    ).set_placement((18, 18))
    msp.add_line((18, 12), (32, 12), dxfattribs={"layer": "PAINT", "lineweight": 35})
    msp.add_text("линия краски", dxfattribs={"layer": "TEXT", "height": 2.8}).set_placement((36, 10.5))
    msp.add_line((95, 12), (109, 12), dxfattribs={"layer": "AIR", "lineweight": 35})
    msp.add_text("линия сжатого воздуха", dxfattribs={"layer": "TEXT", "height": 2.8}).set_placement((113, 10.5))
    msp.add_line((210, 12), (224, 12), dxfattribs={"layer": "EXHAUST", "lineweight": 35})
    msp.add_text("вытяжной воздух", dxfattribs={"layer": "TEXT", "height": 2.8}).set_placement((228, 10.5))

    doc.saveas(OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    main()
