#!/usr/bin/env python3
"""Компактная установка для распыления краски — чертёж для ППР."""

from __future__ import annotations

import math
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

# Габариты установки, мм
FRAME_W = 1200
FRAME_D = 700
FRAME_H = 1450
WHEEL_R = 80


def add_text(
    msp,
    text: str,
    pos: tuple[float, float],
    height: float = 2.5,
    align=TextEntityAlignment.MIDDLE_CENTER,
    rotation: float = 0,
):
    t = msp.add_text(text, dxfattribs={"height": height, "style": "Standard"})
    t.set_placement(pos, align=align)
    if rotation:
        t.dxf.rotation = rotation
    return t


def dim_h(msp, x1: float, y: float, x2: float, offset: float, label: str):
    """Горизонтальный размер."""
    yo = y + offset
    msp.add_line((x1, y), (x1, yo + 2), dxfattribs={"color": colors.CYAN})
    msp.add_line((x2, y), (x2, yo + 2), dxfattribs={"color": colors.CYAN})
    msp.add_line((x1, yo), (x2, yo), dxfattribs={"color": colors.CYAN})
    # Стрелки
    for x, sign in ((x1, 1), (x2, -1)):
        msp.add_line((x, yo), (x + sign * 4, yo + 1.5), dxfattribs={"color": colors.CYAN})
        msp.add_line((x, yo), (x + sign * 4, yo - 1.5), dxfattribs={"color": colors.CYAN})
    add_text(msp, label, ((x1 + x2) / 2, yo + 3), height=2.0)


def dim_v(msp, x: float, y1: float, y2: float, offset: float, label: str):
    """Вертикальный размер."""
    xo = x + offset
    msp.add_line((x, y1), (xo + 2, y1), dxfattribs={"color": colors.CYAN})
    msp.add_line((x, y2), (xo + 2, y2), dxfattribs={"color": colors.CYAN})
    msp.add_line((xo, y1), (xo, y2), dxfattribs={"color": colors.CYAN})
    for y, sign in ((y1, -1), (y2, 1)):
        msp.add_line((xo, y), (xo + 1.5, y + sign * 4), dxfattribs={"color": colors.CYAN})
        msp.add_line((xo, y), (xo - 1.5, y + sign * 4), dxfattribs={"color": colors.CYAN})
    add_text(msp, label, (xo + 4, (y1 + y2) / 2), height=2.0, align=TextEntityAlignment.MIDDLE_LEFT)


def draw_gost_stamp(msp, ox: float, oy: float):
    """Основная надпись по ГОСТ 2.104 (упрощённая)."""
    w, h = 185, 55
    cells = [
        (0, 0, 65, 14, "Обозначение документа"),
        (65, 0, 30, 14, ""),
        (95, 0, 90, 14, "Наименование"),
        (0, 14, 65, 7, "Материал"),
        (65, 14, 30, 7, "Масса"),
        (95, 14, 50, 7, "Масштаб"),
        (145, 14, 40, 7, "Лист"),
        (0, 21, 65, 7, ""),
        (65, 21, 30, 7, ""),
        (95, 21, 50, 7, "1:10"),
        (145, 21, 20, 7, "1"),
        (165, 21, 20, 7, ""),
        (0, 28, 20, 14, "Разраб."),
        (20, 28, 25, 14, ""),
        (45, 28, 20, 14, "Пров."),
        (65, 28, 25, 14, ""),
        (90, 28, 20, 14, "Н.контр."),
        (110, 28, 25, 14, ""),
        (135, 28, 20, 14, "Утв."),
        (155, 28, 30, 14, ""),
        (0, 42, 20, 13, "Изм."),
        (20, 42, 10, 13, "Л."),
        (30, 42, 15, 13, "№ док."),
        (45, 42, 20, 13, "Подп."),
        (65, 42, 25, 13, "Дата"),
        (90, 42, 95, 13, ""),
    ]
    msp.add_lwpolyline(
        [(ox, oy), (ox + w, oy), (ox + w, oy + h), (ox, oy + h), (ox, oy)],
        dxfattribs={"color": colors.WHITE},
    )
    for x, y, cw, ch, _ in cells:
        msp.add_lwpolyline(
            [(ox + x, oy + y), (ox + x + cw, oy + y), (ox + x + cw, oy + y + ch), (ox + x, oy + y + ch), (ox + x, oy + y)],
            dxfattribs={"color": colors.WHITE},
        )

    add_text(msp, "ОКР-01.01.001", (ox + 32, oy + 7), height=2.2)
    add_text(msp, "Установка окрасочная компактная", (ox + 140, oy + 7), height=2.2)
    add_text(msp, "Ст3", (ox + 32, oy + 17), height=1.8)
    add_text(msp, "~180 кг", (ox + 80, oy + 17), height=1.8)
    add_text(msp, "1:10", (ox + 120, oy + 24), height=1.8)
    add_text(msp, "1", (ox + 155, oy + 24), height=1.8)
    add_text(msp, "2", (ox + 175, oy + 24), height=1.8)
    add_text(msp, "31.07.26", (ox + 77, oy + 48), height=1.6)


def draw_frame_front(msp, ox: float, oy: float):
    """Рама установки — вид спереди."""
    # Нижняя балка
    msp.add_lwpolyline(
        [(ox, oy), (ox + FRAME_W, oy), (ox + FRAME_W, oy + 40), (ox, oy + 40), (ox, oy)],
        dxfattribs={"color": colors.WHITE, "lineweight": 35},
    )
    # Вертикальные стойки
    for dx in (0, FRAME_W - 40):
        msp.add_lwpolyline(
            [(ox + dx, oy + 40), (ox + dx + 40, oy + 40), (ox + dx + 40, oy + FRAME_H - 80), (ox + dx, oy + FRAME_H - 80), (ox + dx, oy + 40)],
            dxfattribs={"color": colors.WHITE, "lineweight": 35},
        )
    # Верхняя балка
    msp.add_lwpolyline(
        [(ox, oy + FRAME_H - 80), (ox + FRAME_W, oy + FRAME_H - 80), (ox + FRAME_W, oy + FRAME_H - 40), (ox, oy + FRAME_H - 40), (ox, oy + FRAME_H - 80)],
        dxfattribs={"color": colors.WHITE, "lineweight": 35},
    )
    # Колёса
    for wx in (120, FRAME_W - 120):
        msp.add_circle((ox + wx, oy - WHEEL_R + 20), WHEEL_R, dxfattribs={"color": colors.WHITE})
        msp.add_circle((ox + wx, oy - WHEEL_R + 20), WHEEL_R * 0.3, dxfattribs={"color": colors.WHITE})


def draw_compressor_front(msp, ox: float, oy: float):
    """Компрессор — вид спереди."""
    w, h = 380, 320
    msp.add_lwpolyline(
        [(ox, oy), (ox + w, oy), (ox + w, oy + h), (ox, oy + h), (ox, oy)],
        dxfattribs={"color": colors.WHITE},
    )
    # Охлаждающие рёбра
    for i in range(1, 6):
        y = oy + i * h / 6
        msp.add_line((ox + 10, y), (ox + w - 10, y), dxfattribs={"color": colors.WHITE})
    add_text(msp, "1", (ox + w / 2, oy + h / 2), height=3.5)


def draw_receiver_front(msp, ox: float, oy: float):
    """Ресивер — вертикальный баллон."""
    w, h = 200, 500
    msp.add_lwpolyline(
        [(ox, oy), (ox + w, oy), (ox + w, oy + h), (ox, oy + h), (ox, oy)],
        dxfattribs={"color": colors.WHITE},
    )
    msp.add_arc((ox + w / 2, oy + h), w / 2, 0, 180, dxfattribs={"color": colors.WHITE})
    add_text(msp, "2", (ox + w / 2, oy + h / 2), height=3.5)


def draw_filter_block_front(msp, ox: float, oy: float):
    """Блок фильтра-осушителя."""
    w, h = 160, 200
    msp.add_lwpolyline(
        [(ox, oy), (ox + w, oy), (ox + w, oy + h), (ox, oy + h), (ox, oy)],
        dxfattribs={"color": colors.WHITE},
    )
    msp.add_line((ox + 20, oy + 40), (ox + w - 20, oy + 40), dxfattribs={"color": colors.WHITE})
    msp.add_line((ox + 20, oy + 100), (ox + w - 20, oy + 100), dxfattribs={"color": colors.WHITE})
    add_text(msp, "3", (ox + w / 2, oy + h / 2), height=3.0)


def draw_paint_tank_front(msp, ox: float, oy: float):
    """Бак с краской."""
    w, h = 180, 280
    msp.add_lwpolyline(
        [(ox, oy), (ox + w, oy), (ox + w, oy + h), (ox, oy + h), (ox, oy)],
        dxfattribs={"color": colors.WHITE},
    )
    msp.add_arc((ox + w / 2, oy + h), w / 2, 0, 180, dxfattribs={"color": colors.WHITE})
    # Мешалка
    msp.add_line((ox + w / 2, oy + h + 30), (ox + w / 2, oy + h + 80), dxfattribs={"color": colors.WHITE})
    msp.add_circle((ox + w / 2, oy + h + 80), 25, dxfattribs={"color": colors.WHITE})
    add_text(msp, "4", (ox + w / 2, oy + h / 2), height=3.0)


def draw_panel_front(msp, ox: float, oy: float):
    """Пульт управления."""
    w, h = 200, 160
    msp.add_lwpolyline(
        [(ox, oy), (ox + w, oy), (ox + w, oy + h), (ox, oy + h), (ox, oy)],
        dxfattribs={"color": colors.WHITE},
    )
    for i, dy in enumerate((40, 80, 120)):
        msp.add_circle((ox + 40, oy + dy), 12, dxfattribs={"color": colors.WHITE})
        msp.add_circle((ox + 100, oy + dy), 12, dxfattribs={"color": colors.WHITE})
    add_text(msp, "5", (ox + w / 2, oy + h / 2), height=3.0)


def draw_hose_reel_front(msp, ox: float, oy: float):
    """Катушка для шланга."""
    r = 90
    msp.add_circle((ox, oy), r, dxfattribs={"color": colors.WHITE})
    msp.add_circle((ox, oy), r * 0.35, dxfattribs={"color": colors.WHITE})
    for angle in range(0, 360, 30):
        rad = math.radians(angle)
        msp.add_line(
            (ox + r * 0.35 * math.cos(rad), oy + r * 0.35 * math.sin(rad)),
            (ox + r * 0.85 * math.cos(rad), oy + r * 0.85 * math.sin(rad)),
            dxfattribs={"color": colors.WHITE},
        )
    add_text(msp, "6", (ox, oy), height=3.0)


def draw_gun_holder_front(msp, ox: float, oy: float):
    """Держатель краскопульта."""
    msp.add_lwpolyline(
        [(ox, oy), (ox + 30, oy), (ox + 30, oy + 120), (ox, oy + 120), (ox, oy)],
        dxfattribs={"color": colors.WHITE},
    )
    # Краскопульт (упрощённо)
    msp.add_line((ox + 15, oy + 120), (ox + 15, oy + 200), dxfattribs={"color": colors.WHITE, "lineweight": 25})
    msp.add_line((ox + 15, oy + 200), (ox - 20, oy + 240), dxfattribs={"color": colors.WHITE, "lineweight": 25})
    msp.add_line((ox + 15, oy + 200), (ox + 50, oy + 240), dxfattribs={"color": colors.WHITE, "lineweight": 25})
    add_text(msp, "7", (ox + 15, oy + 60), height=2.5)


def draw_frame_plan(msp, ox: float, oy: float):
    """Рама — вид сверху."""
    msp.add_lwpolyline(
        [(ox, oy), (ox + FRAME_W, oy), (ox + FRAME_W, oy + FRAME_D), (ox, oy + FRAME_D), (ox, oy)],
        dxfattribs={"color": colors.WHITE, "lineweight": 35},
    )
    # Поперечные балки
    for dx in (300, 600, 900):
        msp.add_line((ox + dx, oy + 20), (ox + dx, oy + FRAME_D - 20), dxfattribs={"color": colors.WHITE})
    # Колёса
    for wx, wy in ((120, 80), (FRAME_W - 120, 80), (120, FRAME_D - 80), (FRAME_W - 120, FRAME_D - 80)):
        msp.add_circle((ox + wx, oy + wy), 50, dxfattribs={"color": colors.WHITE})


def draw_equipment_plan(msp, ox: float, oy: float):
    """Оборудование — вид сверху."""
    # Компрессор
    msp.add_lwpolyline(
        [(ox + 60, oy + 80), (ox + 440, oy + 80), (ox + 440, oy + 380), (ox + 60, oy + 380), (ox + 60, oy + 80)],
        dxfattribs={"color": colors.WHITE},
    )
    add_text(msp, "1", (ox + 250, oy + 230), height=3.0)
    # Ресивер
    msp.add_circle((ox + 560, oy + 230), 100, dxfattribs={"color": colors.WHITE})
    add_text(msp, "2", (ox + 560, oy + 230), height=3.0)
    # Фильтр
    msp.add_lwpolyline(
        [(ox + 720, oy + 160), (ox + 880, oy + 160), (ox + 880, oy + 300), (ox + 720, oy + 300), (ox + 720, oy + 160)],
        dxfattribs={"color": colors.WHITE},
    )
    add_text(msp, "3", (ox + 800, oy + 230), height=2.5)
    # Бак с краской
    msp.add_circle((ox + 1000, oy + 230), 90, dxfattribs={"color": colors.WHITE})
    add_text(msp, "4", (ox + 1000, oy + 230), height=2.5)
    # Пульт
    msp.add_lwpolyline(
        [(ox + 60, oy + 440), (ox + 260, oy + 440), (ox + 260, oy + 600), (ox + 60, oy + 600), (ox + 60, oy + 440)],
        dxfattribs={"color": colors.WHITE},
    )
    add_text(msp, "5", (ox + 160, oy + 520), height=2.5)
    # Катушка
    msp.add_circle((ox + 400, oy + 520), 80, dxfattribs={"color": colors.WHITE})
    add_text(msp, "6", (ox + 400, oy + 520), height=2.5)


def draw_specification_table(msp, ox: float, oy: float):
    """Спецификация."""
    rows = [
        ("Поз.", "Наименование", "Кол.", "Примечание"),
        ("1", "Компрессор поршневой 2,2 кВт", "1", "Q=250 л/мин"),
        ("2", "Ресивер 50 л", "1", "Pраб=0,8 МПа"),
        ("3", "Блок подготовки воздуха", "1", "фильтр+осушитель"),
        ("4", "Бак для краски 10 л", "1", "с мешалкой"),
        ("5", "Пульт управления", "1", ""),
        ("6", "Катушка шланговая", "1", "L=15 м"),
        ("7", "Краскопульт + держатель", "1", "сопло Ø1,4"),
        ("8", "Рама сварная на колёсах", "1", f"{FRAME_W}×{FRAME_D} мм"),
    ]
    col_w = [15, 80, 15, 50]
    row_h = 8
    x = ox
    for row_idx, row in enumerate(rows):
        x = ox
        y = oy - row_idx * row_h
        for col_idx, (cell, cw) in enumerate(zip(row, col_w)):
            msp.add_lwpolyline(
                [(x, y), (x + cw, y), (x + cw, y + row_h), (x, y + row_h), (x, y)],
                dxfattribs={"color": colors.WHITE},
            )
            add_text(msp, cell, (x + cw / 2, y + row_h / 2), height=2.0 if row_idx == 0 else 1.8)
            x += cw


def create_installation_drawing() -> ezdxf.document.Drawing:
    doc = ezdxf.new("R2010")
    doc.units = ezdxf.units.MM
    msp = doc.modelspace()

    # Формат A3 альбомный (420×297 мм → в масштабе 1:10 поле рисунка)
    sheet_w, sheet_h = 420, 297
    msp.add_lwpolyline([(0, 0), (sheet_w, 0), (sheet_w, sheet_h), (0, sheet_h), (0, 0)], dxfattribs={"color": colors.WHITE})

    # === ВИД СПЕРЕДИ (масштаб 1:10) ===
    view_ox, view_oy = 30, 60
    scale = 0.1  # 1:10

    add_text(msp, "Вид спереди", (view_ox + FRAME_W * scale / 2, view_oy + FRAME_H * scale + 18), height=3.5)
    add_text(msp, "А", (view_ox - 8, view_oy + FRAME_H * scale / 2), height=4.0)
    add_text(msp, "А", (view_ox + FRAME_W * scale + 8, view_oy + FRAME_H * scale / 2), height=4.0)

    fw, fh = FRAME_W * scale, FRAME_H * scale
    draw_frame_front(msp, view_ox, view_oy)
    draw_compressor_front(msp, view_ox + 60 * scale, view_oy + 50 * scale)
    draw_receiver_front(msp, view_ox + 500 * scale, view_oy + 120 * scale)
    draw_filter_block_front(msp, view_ox + 720 * scale, view_oy + 200 * scale)
    draw_paint_tank_front(msp, view_ox + 920 * scale, view_oy + 180 * scale)
    draw_panel_front(msp, view_ox + 60 * scale, view_oy + 420 * scale)
    draw_hose_reel_front(msp, view_ox + 400 * scale, view_oy + 480 * scale)
    draw_gun_holder_front(msp, view_ox + 1050 * scale, view_oy + 350 * scale)

    # Размеры — вид спереди
    dim_h(msp, view_ox, view_oy - 25, view_ox + fw, -15, f"{FRAME_W}")
    dim_v(msp, view_ox + fw, view_oy, view_oy + fh, 15, f"{FRAME_H}")

    # === ВИД СВЕРХУ ===
    plan_ox, plan_oy = 30, 195
    add_text(msp, "Вид сверху", (plan_ox + FRAME_W * scale / 2, plan_oy + FRAME_D * scale + 14), height=3.0)
    draw_frame_plan(msp, plan_ox, plan_oy)
    draw_equipment_plan(msp, plan_ox, plan_oy)

    dim_h(msp, plan_ox, plan_oy - 12, plan_ox + FRAME_W * scale, -8, f"{FRAME_W}")
    dim_v(msp, plan_ox + FRAME_W * scale, plan_oy, plan_oy + FRAME_D * scale, 10, f"{FRAME_D}")

    # === СПЕЦИФИКАЦИЯ ===
    add_text(msp, "Спецификация", (310, 175), height=3.0, align=TextEntityAlignment.MIDDLE_LEFT)
    draw_specification_table(msp, 260, 170)

    # === ЗАГОЛОВОК ===
    add_text(msp, "УСТАНОВКА ОКРАСОЧНАЯ КОМПАКТНАЯ", (sheet_w / 2, sheet_h - 12), height=4.5)
    add_text(msp, "для распыления краски (мобильная, на раме)", (sheet_w / 2, sheet_h - 20), height=2.8)
    add_text(msp, "Масштаб 1:10. Размеры в мм.", (sheet_w / 2, sheet_h - 27), height=2.2)

    # Штамп
    draw_gost_stamp(msp, sheet_w - 190, 5)

    # Примечания для ППР
    notes = [
        "1. Установка предназначена для нанесения ЛКМ распылением на строительной площадке.",
        "2. Перед пуском проверить герметичность соединений и наличие масла в компрессоре.",
        "3. Рабочее давление воздуха — 0,5–0,6 МПа. Давление краски — по паспорту ЛКМ.",
        "4. Установку перемещать только с отключённым оборудованием.",
    ]
    add_text(msp, "Примечания:", (10, 48), height=2.2, align=TextEntityAlignment.MIDDLE_LEFT)
    for i, note in enumerate(notes):
        add_text(msp, note, (10, 42 - i * 5), height=1.7, align=TextEntityAlignment.MIDDLE_LEFT)

    return doc


def convert_to_dwg(dxf_path: Path, dwg_path: Path) -> bool:
    if not ODA_CONVERTER.exists():
        return False
    tmp = Path(tempfile.mkdtemp(prefix="dwg_"))
    env = {"DISPLAY": ":99", **dict(__import__("os").environ)}
    subprocess.run(
        [str(ODA_CONVERTER), str(dxf_path.parent), str(tmp), "ACAD2010", "DWG", "0", "1", dxf_path.name],
        env=env,
        capture_output=True,
        check=False,
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
