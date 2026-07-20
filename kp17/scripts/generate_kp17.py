#!/usr/bin/env python3
"""Генерация полного листа КП17 (формат А0) в DXF.

Редактирование:
  1) правьте kp17/data/kp17_data.py
  2) python3 -m kp17.scripts.generate_kp17
  3) либо правьте слои в drawings/KP17.dxf через ezdxf / AutoCAD

Слои:
  FRAME, TITLE, GEOMETRY, REBAR, TRANSVERSE, EMBEDDED, SECTIONS,
  DETAILS, DIMS, TEXT, TABLE, NOTES, SCHEME, HATCH
"""
from __future__ import annotations

import sys
from pathlib import Path

import ezdxf
from ezdxf import units

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from kp17.data.kp17_data import (  # noqa: E402
    BAR_MASS,
    CAGE,
    DETAILS,
    EMBEDDED,
    FIXATORS,
    FRAME_R17,
    LAYOUT_EXTRA,
    LAYOUT_GROUND,
    LAYOUT_PIT,
    NOTES,
    SECTIONS,
    STEEL_CONSUMPTION,
    TITLE,
    WELDS,
    WORKING_BARS,
)
from kp17.scripts.draw_utils import (  # noqa: E402
    circle,
    dim_h,
    dim_v,
    line,
    lines,
    mtext,
    rect,
    table,
    text,
)

# Формат А0, мм (альбомная ориентация как на исходном PDF)
SHEET_W = 1189.0
SHEET_H = 841.0
MARGIN = 20.0
INNER = 5.0

# Масштаб видов каркаса на листе (1:50)
VIEW_SCALE = 1 / 50.0


def setup_doc():
    doc = ezdxf.new("R2010", setup=True)
    doc.units = units.MM
    doc.header["$INSUNITS"] = units.MM
    doc.header["$MEASUREMENT"] = 1

    layers = {
        "FRAME": 7,
        "TITLE": 7,
        "GEOMETRY": 7,
        "REBAR": 1,  # red
        "TRANSVERSE": 4,  # cyan
        "EMBEDDED": 2,  # yellow
        "SECTIONS": 3,  # green
        "DETAILS": 6,  # magenta
        "DIMS": 8,  # gray
        "TEXT": 7,
        "TABLE": 7,
        "NOTES": 7,
        "SCHEME": 5,  # blue
        "HATCH": 8,
        "CENTER": 8,
    }
    for name, color in layers.items():
        if name not in doc.layers:
            doc.layers.add(name, color=color)

    # Шрифт с кириллицей
    font = "DejaVuSans.ttf"
    if "GOST" not in doc.styles:
        doc.styles.new("GOST", dxfattribs={"font": font})
    else:
        doc.styles.get("GOST").dxf.font = font
    if "GOST_BOLD" not in doc.styles:
        doc.styles.new("GOST_BOLD", dxfattribs={"font": "DejaVuSans-Bold.ttf"})

    return doc


def draw_sheet_frame(msp):
    # внешняя / внутренняя рамка
    rect(msp, 0, 0, SHEET_W, SHEET_H, layer="FRAME")
    rect(msp, MARGIN, MARGIN, SHEET_W - 2 * MARGIN, SHEET_H - 2 * MARGIN, layer="FRAME")
    # левая графа инвентарных
    lx = MARGIN - 0.5
    inventory = ["Инв. № подл.", "Подп. и дата", "Взам. инв. №"]
    for i, t in enumerate(inventory):
        y0 = MARGIN + 55 + i * 45
        rect(msp, 5, y0, 14, 40, layer="FRAME")
        text(msp, t, 12, y0 + 8, h=2.0, layer="TEXT", rotation=90)

    # основная надпись (упрощённый штамп ГОСТ)
    tw, th = 185, 55
    tx = SHEET_W - MARGIN - tw
    ty = MARGIN
    rect(msp, tx, ty, tw, th, layer="TITLE")
    # сетка штампа
    for dx in (10, 25, 70, 130, 155):
        line(msp, (tx + dx, ty), (tx + dx, ty + th), layer="TITLE")
    for dy in (15, 30, 40):
        line(msp, (tx, ty + dy), (tx + tw, ty + dy), layer="TITLE")
    text(msp, TITLE["mark"], tx + 100, ty + 42, h=5, layer="TEXT", align="CENTER")
    text(msp, TITLE["name"], tx + 100, ty + 33, h=2.5, layer="TEXT", align="CENTER")
    text(msp, f"Масса {TITLE['mass']} кг", tx + 100, ty + 20, h=2.0, layer="TEXT", align="CENTER")
    text(msp, f"Лист {TITLE['sheet']}", tx + 142, ty + 5, h=2.0, layer="TEXT")
    text(msp, f"Листов {TITLE['sheets']}", tx + 160, ty + 5, h=2.0, layer="TEXT")
    text(msp, f"Формат {TITLE['format']}", SHEET_W - 35, 8, h=2.5, layer="TEXT", align="RIGHT")


def scale_y(real_mm: float) -> float:
    return real_mm * VIEW_SCALE


def draw_working_scheme(msp, origin):
    """Схема расположения рабочей арматуры — слева."""
    ox, oy = origin
    text(
        msp,
        "Схема расположения рабочей арматуры каркаса КП17",
        ox,
        oy + scale_y(CAGE["length"]) + 8,
        h=2.5,
        layer="TEXT",
    )
    # ось / стороны
    H = scale_y(CAGE["length"])
    mid = ox + 28
    line(msp, (mid, oy), (mid, oy + H), layer="CENTER")
    text(msp, "Сторона\nгрунта", ox + 2, oy + H - 10, h=1.8, layer="TEXT")
    # mtext for multiline
    mtext(msp, "Сторона\\Pгрунта", ox + 2, oy + H - 2, h=1.8, w=20, layer="TEXT")
    mtext(msp, "Сторона\\Pкотлована", mid + 8, oy + H - 2, h=1.8, w=25, layer="TEXT")

    def draw_stack(segments, x, color_layer="SCHEME"):
        y = oy
        for seg in segments:
            L = scale_y(seg["L"])
            # толщина линии условно по диаметру
            line(msp, (x, y), (x, y + L), layer=color_layer)
            # подпись диаметра
            text(msp, f"Ø{seg['d']}", x + 2, y + L / 2, h=1.6, layer="TEXT")
            text(msp, str(seg["pos"]), x - 4, y + L / 2, h=2.0, layer="TEXT")
            if seg.get("splice_after"):
                s = scale_y(CAGE["splice"])
                circle(msp, (x, y + L), 2.2, layer="SCHEME")
                text(msp, "стык 450", x + 3, y + L - 1, h=1.4, layer="DIMS")
                y += L  # стык входит в нахлёст визуально
            else:
                y += L
            # размер длины
            dim_v(msp, y - L if not seg.get("splice_after") else y - L, y, x - 8, text_override=str(seg["L"]), h=1.5)

        return y

    # упрощённо: две колонны стержней
    y1 = oy
    for seg in LAYOUT_GROUND:
        L = scale_y(seg["L"])
        line(msp, (mid - 10, y1), (mid - 10, y1 + L), layer="REBAR")
        text(msp, f"{seg['pos']}", mid - 14, y1 + L / 2, h=1.8, layer="TEXT")
        text(msp, f"Ø{seg['d']}", mid - 22, y1 + L / 2, h=1.5, layer="TEXT")
        dim_v(msp, y1, y1 + L, mid - 26, text_override=str(seg["L"]), h=1.4)
        if seg.get("splice_after"):
            circle(msp, (mid - 10, y1 + L), 2.0, layer="SCHEME")
        y1 += L

    y2 = oy
    for seg in LAYOUT_PIT:
        L = scale_y(seg["L"])
        line(msp, (mid + 10, y2), (mid + 10, y2 + L), layer="REBAR")
        text(msp, f"{seg['pos']}", mid + 14, y2 + L / 2, h=1.8, layer="TEXT")
        text(msp, f"Ø{seg['d']}", mid + 18, y2 + L / 2, h=1.5, layer="TEXT")
        dim_v(msp, y2, y2 + L, mid + 30, text_override=str(seg["L"]), h=1.4)
        if seg.get("splice_after"):
            circle(msp, (mid + 10, y2 + L), 2.0, layer="SCHEME")
        y2 += L

    # общая высота
    dim_v(msp, oy, oy + H, mid - 35, text_override=str(CAGE["length"]), h=2.0)
    text(msp, "Отм. низа каркаса", mid - 5, oy - 4, h=1.5, layer="TEXT", align="CENTER")
    text(msp, "Отм. верха каркаса", mid - 5, oy + H + 3, h=1.5, layer="TEXT", align="CENTER")

    # легенда диаметров
    labels = [
        ("1", 22),
        ("2", 22),
        ("4", 32),
        ("8", 22),
        ("7", 25),
        ("5", 36),
        ("3", 36),
    ]
    ly = oy - 25
    text(msp, "Поз. / Ø", ox, ly + 12, h=1.8, layer="TEXT")
    for i, (p, d) in enumerate(labels):
        text(msp, f"{p}  A500C  Ø{d}  шаг 140 мм", ox, ly - i * 4, h=1.5, layer="TEXT")


def draw_elevation(msp, origin, title: str, side: str):
    """Вид каркаса (котлован / грунт), масштаб 1:50."""
    ox, oy = origin
    L = scale_y(CAGE["length"])  # высота вида
    W = CAGE["width"] * VIEW_SCALE  # ширина вида ~38 мм
    text(msp, title, ox, oy + L + 6, h=2.5, layer="TEXT")

    # контур
    rect(msp, ox, oy, W, L, layer="GEOMETRY")

    # продольные стержни (14 шт, шаг 140 → 13*140=1820)
    n_long = 14
    pitch = 140 * VIEW_SCALE
    margin = (W - 13 * pitch) / 2
    for i in range(n_long):
        x = ox + margin + i * pitch
        line(msp, (x, oy + 1), (x, oy + L - 1), layer="REBAR")

    # поперечная арматура поз.9 шаг 300
    t_pitch = CAGE["transverse_pitch"] * VIEW_SCALE
    n_t = int(CAGE["length"] / CAGE["transverse_pitch"])  # 99
    # рисуем каждую 3-ю для читаемости на листе, но подписываем 99x300
    step_draw = 3
    for i in range(0, n_t + 1, step_draw):
        y = oy + i * t_pitch
        if y > oy + L:
            break
        line(msp, (ox, y), (ox + W, y), layer="TRANSVERSE")

    # рамы Р17 шаг 2100
    f_pitch = CAGE["frame_pitch"] * VIEW_SCALE
    for i in range(15):
        y = oy + 10 * VIEW_SCALE + i * f_pitch
        if y > oy + L - 5:
            break
        line(msp, (ox - 1, y), (ox + W + 1, y), layer="EMBEDDED")
        if i % 2 == 0:
            text(msp, "Р17", ox + W + 2, y, h=1.3, layer="TEXT")

    # размер ширины
    dim_h(msp, ox, ox + W, oy - 4, text_override=str(CAGE["width"]), h=1.6)
    dim_v(msp, oy, oy + L, ox - 6, text_override=str(CAGE["length"]), h=1.6)
    text(msp, "99х300=29700 (поз. 9)", ox + W + 2, oy + L / 2, h=1.4, layer="DIMS", rotation=90)
    text(msp, "14х2100=29400 (поз. Р17)", ox - 10, oy + L / 2, h=1.4, layer="DIMS", rotation=90)

    # метки сечений
    sec_positions = {
        "1-1": 0.05,
        "2-2": 0.15,
        "3-3": 0.28,
        "4-4": 0.40,
        "5-5": 0.55,
        "6-6": 0.70,
        "7-7": 0.85,
        "8-8": 0.95,
    }
    for name, t in sec_positions.items():
        y = oy + t * L
        line(msp, (ox - 3, y), (ox, y), layer="SECTIONS")
        text(msp, name, ox - 12, y - 1, h=1.5, layer="TEXT")

    # верх: петли 12, 13
    text(msp, "12  13", ox + W / 2, oy + L + 2, h=1.5, layer="TEXT", align="CENTER")
    # фиксаторы по высоте
    text(msp, "Ф1,Ф2,Ф3,Ф4", ox + W / 2, oy - 8, h=1.4, layer="TEXT", align="CENTER")


def draw_section_8_8(msp, origin):
    """Сечение 8-8 — профиль с диагональными связями."""
    ox, oy = origin
    text(msp, "8-8", ox, oy + scale_y(CAGE["length"]) + 6, h=2.5, layer="TEXT")
    L = scale_y(CAGE["length"])
    D = CAGE["depth"] * VIEW_SCALE  # ~16 мм
    rect(msp, ox, oy, D, L, layer="GEOMETRY")
    # зигзаг связей
    amp = D * 0.85
    step = 25 * VIEW_SCALE * 10
    y = oy
    pts = [(ox + 1, y)]
    left = True
    while y < oy + L:
        y2 = min(y + step, oy + L)
        pts.append((ox + amp if left else ox + 1, y2))
        left = not left
        y = y2
    lines(msp, pts, layer="REBAR")
    text(msp, "Сторона грунта", ox + D + 2, oy + L - 5, h=1.4, layer="TEXT")
    text(msp, "Сторона котлована", ox + D + 2, oy + 2, h=1.4, layer="TEXT")


def draw_cross_section(msp, origin, name: str, fixators, width=70):
    """Поперечное сечение каркаса 1900×~800."""
    ox, oy = origin
    # на листе сечение крупнее: 1:25
    s = 1 / 25.0
    W = CAGE["width"] * s
    H = 800 * s
    text(msp, name, ox + W / 2, oy + H + 4, h=2.2, layer="TEXT", align="CENTER")
    rect(msp, ox, oy, W, H, layer="SECTIONS")

    # продольные точки (14 стержней)
    pitch = 140 * s
    m = (W - 13 * pitch) / 2
    for i in range(14):
        x = ox + m + i * pitch
        # два ряда
        circle(msp, (x, oy + 8 * s), 0.9, layer="REBAR")
        circle(msp, (x, oy + H - 8 * s), 0.9, layer="REBAR")

    # контур бетонолитной трубы
    circle(msp, (ox + W / 2, oy + H / 2), 225 * s, layer="CENTER")
    text(msp, "Контур бетонолитной трубы", ox + W / 2, oy + H / 2 - 6, h=1.3, layer="TEXT", align="CENTER")

    # подписи грунт / котлован
    text(msp, "Грунт", ox - 2, oy + H / 2, h=1.5, layer="TEXT", rotation=90)
    text(msp, "Котлован", ox + W + 3, oy + H / 2, h=1.5, layer="TEXT", rotation=90)

    dim_h(msp, ox, ox + W, oy - 3, text_override="1900", h=1.4)
    text(msp, "13х140=1820", ox + W / 2, oy - 7, h=1.3, layer="DIMS", align="CENTER")

    # фиксаторы
    fx = ox + 4
    for i, f in enumerate(fixators):
        line(msp, (fx + i * 8, oy + 2), (fx + i * 8, oy + H - 2), layer="EMBEDDED")
        text(msp, f, fx + i * 8 - 1, oy + H + 1.5, h=1.3, layer="TEXT")

    # размеры по высоте сечения (типовые)
    dim_v(msp, oy, oy + H, ox + W + 8, text_override="800", h=1.3)


def draw_frame_r17(msp, origin):
    ox, oy = origin
    s = 1 / 10.0
    L = FRAME_R17["L"] * s
    H = FRAME_R17["H"] * s
    text(msp, "Рама Р17", ox, oy + H + 6, h=2.5, layer="TEXT")
    rect(msp, ox, oy, L, H, layer="EMBEDDED")
    # средняя полка
    line(msp, (ox, oy + H / 2), (ox + L, oy + H / 2), layer="EMBEDDED")
    # стойки по dims
    x = ox
    for i, d in enumerate(FRAME_R17["dims"][:-1]):
        x += d * s
        line(msp, (x, oy), (x, oy + H), layer="EMBEDDED")
    dim_h(msp, ox, ox + L, oy - 4, text_override="1900", h=1.5)
    dim_v(msp, oy, oy + H, ox - 4, text_override="590", h=1.5)
    text(msp, "16", ox + 5, oy + H + 1, h=1.5, layer="TEXT")
    text(msp, "17", ox + L / 2, oy + H / 4, h=1.5, layer="TEXT")
    # разметка 100-500-700-500-100
    x = ox
    for d in FRAME_R17["dims"]:
        dim_h(msp, x, x + d * s, oy - 9, text_override=str(d), h=1.2)
        x += d * s


def draw_fixator_sketch(msp, origin, name, segs):
    ox, oy = origin
    s = 1 / 5.0
    text(msp, name, ox, oy + 18, h=2.0, layer="TEXT")
    x = ox
    y = oy + 8
    # ломаная полоса с крюками
    pts = [(x, y)]
    total = sum(segs) * s
    # упрощённый профиль: крюк-полка-крюк
    h_hook = 8
    pts = [
        (ox, oy + h_hook),
        (ox, oy),
        (ox + total, oy),
        (ox + total, oy + h_hook),
    ]
    lines(msp, pts, layer="DETAILS")
    dim_h(msp, ox, ox + total, oy - 3, text_override="500", h=1.2)
    x = ox
    for seg in segs:
        dim_h(msp, x, x + seg * s, oy - 7, text_override=str(seg), h=1.0)
        x += seg * s


def draw_detail_bent(msp, origin, pos, kind="trapezoid"):
    ox, oy = origin
    text(msp, f"Поз. {pos}", ox, oy + 35, h=2.0, layer="TEXT")
    if pos == 11:
        # трапеция/хомут
        pts = [(ox, oy), (ox + 40, oy), (ox + 35, oy + 28), (ox + 5, oy + 28)]
        lines(msp, pts, layer="DETAILS", close=True)
        dim_h(msp, ox, ox + 40, oy - 3, text_override="968", h=1.2)
        dim_v(msp, oy, oy + 28, ox - 3, text_override="548", h=1.2)
    elif pos == 12:
        # П-образный
        pts = [(ox, oy), (ox, oy + 28), (ox + 22, oy + 28), (ox + 22, oy)]
        lines(msp, pts, layer="DETAILS")
        dim_h(msp, ox, ox + 22, oy + 30, text_override="700", h=1.2)
        text(msp, "R153", ox + 8, oy + 14, h=1.2, layer="TEXT")
    elif pos == 13:
        pts = [(ox, oy), (ox + 26, oy), (ox + 13, oy + 32)]
        lines(msp, pts, layer="DETAILS", close=True)
        dim_h(msp, ox, ox + 26, oy - 3, text_override="642", h=1.2)
        dim_v(msp, oy, oy + 32, ox - 3, text_override="818", h=1.2)
    elif pos == 14:
        pts = [(ox, oy + 10), (ox + 8, oy), (ox + 18, oy), (ox + 26, oy + 10)]
        lines(msp, pts, layer="DETAILS")
        dim_h(msp, ox, ox + 26, oy - 3, text_override="467", h=1.2)
    elif pos == 15:
        pts = [(ox, oy + 8), (ox + 10, oy), (ox + 24, oy), (ox + 34, oy + 8)]
        lines(msp, pts, layer="DETAILS")
        dim_h(msp, ox, ox + 34, oy - 3, text_override="592", h=1.2)


def draw_nodes(msp, origin):
    """Узлы А, Б, В, Г."""
    ox, oy = origin
    text(msp, "Узел А", ox, oy + 40, h=2.2, layer="TEXT")
    # нахлёст рабочей арматуры
    line(msp, (ox, oy + 20), (ox + 50, oy + 20), layer="REBAR")
    line(msp, (ox + 15, oy + 24), (ox + 65, oy + 24), layer="REBAR")
    text(msp, "Рабочая арматура", ox, oy + 28, h=1.3, layer="TEXT")
    text(msp, "С15-Рс", ox + 25, oy + 12, h=1.3, layer="TEXT")
    text(msp, "lш=10...20", ox + 20, oy + 6, h=1.2, layer="TEXT")

    ox2 = ox + 90
    text(msp, "Узел Б", ox2, oy + 40, h=2.2, layer="TEXT")
    line(msp, (ox2, oy + 5), (ox2, oy + 35), layer="REBAR")
    line(msp, (ox2 + 6, oy + 5), (ox2 + 6, oy + 35), layer="REBAR")
    text(msp, "Стыковка", ox2 + 10, oy + 20, h=1.3, layer="TEXT")
    text(msp, "С23-Рэ  lш=8d", ox2 + 10, oy + 12, h=1.2, layer="TEXT")

    ox3 = ox + 180
    text(msp, "Узел В", ox3, oy + 40, h=2.2, layer="TEXT")
    for i in range(4):
        line(msp, (ox3 + i * 5, oy + 8), (ox3 + i * 5, oy + 32), layer="REBAR")
    text(msp, "В шахматном порядке", ox3 + 22, oy + 20, h=1.2, layer="TEXT")
    text(msp, "через стержень", ox3 + 22, oy + 15, h=1.2, layer="TEXT")

    ox4 = ox + 290
    text(msp, "Узел Г", ox4, oy + 40, h=2.2, layer="TEXT")
    pts = [(ox4, oy + 5), (ox4, oy + 30), (ox4 + 12, oy + 30), (ox4 + 12, oy + 5)]
    lines(msp, pts, layer="REBAR")
    text(msp, "lш=300", ox4 + 16, oy + 20, h=1.2, layer="TEXT")


def draw_splice_scheme(msp, origin):
    ox, oy = origin
    text(msp, "Схема стыковки сдвоенной арматуры", ox, oy + 35, h=2.2, layer="TEXT")
    line(msp, (ox, oy + 10), (ox, oy + 30), layer="REBAR")
    line(msp, (ox + 8, oy + 5), (ox + 8, oy + 25), layer="REBAR")
    for y in (oy + 12, oy + 18, oy + 24):
        text(msp, "По типу №1", ox + 12, y, h=1.2, layer="TEXT")
        circle(msp, (ox + 4, y), 1.5, layer="SCHEME")
    text(msp, "Рабочая / дополнительная", ox, oy, h=1.3, layer="TEXT")


def draw_spec_table(msp, origin):
    ox, oy = origin
    text(msp, "Спецификация пространственного каркаса КП17", ox, oy + 6, h=2.5, layer="TEXT")
    rows = [["Поз.", "Обозначение", "Наименование", "Кол.", "Масса ед.", "Масса"]]
    rows.append(["", "", "Стержни", "", "", ""])
    for b in WORKING_BARS:
        mu, mt = BAR_MASS[b["pos"]]
        name = f"Пруток {b['d']}x{b['L']}-{b['grade']} ГОСТ 34028-2016"
        rows.append([str(b["pos"]), "", name, str(b["qty"]), f"{mu:.2f}", f"{mt:.2f}"])
    rows.append(["", "", "Детали", "", "", ""])
    for d in DETAILS:
        name = f"Пруток {d['d']}x{d['L']}-{d['grade']} ГОСТ 34028-2016"
        rows.append([str(d["pos"]), "", name, str(d["qty"]), f"{d['mass_unit']:.2f}", f"{d['mass_total']:.2f}"])
    rows.append(["", "", "Закладные изделия", "", "", ""])
    for e in EMBEDDED:
        rows.append([e["pos"], "", e["name"], str(e["qty"]), f"{e['mass_unit']:.2f}", f"{e['mass_total']:.2f}"])
    rows.append(["", "", "Итого:", "", "", f"{TITLE['mass']:.2f}"])

    table(
        msp,
        ox,
        oy,
        [10, 12, 95, 12, 16, 16],
        rows,
        row_h=3.6,
        text_h=1.35,
    )


def draw_embedded_spec(msp, origin):
    ox, oy = origin
    text(msp, "Спецификация закладных изделий", ox, oy + 6, h=2.3, layer="TEXT")
    rows = [["Поз.", "Обозначение / Наименование", "Кол.", "Масса ед.", "Масса"]]
    rows.append(["", "Рама Р17", "", "", ""])
    for p in FRAME_R17["parts"]:
        rows.append([str(p["pos"]), f"{p['name']} L={p['L']}", str(p["qty"]), f"{p['mass_unit']:.2f}", f"{p['mass_total']:.2f}"])
    rows.append(["", f"Масса изделия: {FRAME_R17['mass']}", "", "", ""])
    rows.append(["", "Фиксаторы", "", "", ""])
    for name, f in FIXATORS.items():
        rows.append([name, f"Полоса {f['strip']} ГОСТ 103-2006 С245", "1", f"{f['mass']:.2f}", f"{f['mass']:.2f}"])
    table(msp, ox, oy, [10, 110, 12, 16, 16], rows, row_h=3.6, text_h=1.35)


def draw_steel_table(msp, origin):
    ox, oy = origin
    text(msp, "Ведомость расхода стали, кг", ox, oy + 6, h=2.3, layer="TEXT")
    sc = STEEL_CONSUMPTION
    rows = [
        ["Марка", "А240 Ø25", "А500С Ø12", "Ø22", "Ø25", "Ø32", "Ø36", "Итого А500С", "С245", "Всего"],
        [
            "КП17",
            f"{sc['A240_d25']:.2f}",
            f"{sc['A500C']['12']:.2f}",
            f"{sc['A500C']['22']:.2f}",
            f"{sc['A500C']['25']:.2f}",
            f"{sc['A500C']['32']:.2f}",
            f"{sc['A500C']['36']:.2f}",
            f"{sc['A500C']['total']:.2f}",
            f"{sc['embedded_total']:.2f}",
            f"{sc['grand_total']:.2f}",
        ],
    ]
    table(msp, ox, oy, [12, 16, 16, 16, 14, 14, 14, 18, 14, 16], rows, row_h=4.0, text_h=1.3)


def draw_weld_table(msp, origin):
    ox, oy = origin
    text(msp, "Таблица сварных швов", ox, oy + 6, h=2.3, layer="TEXT")
    rows = [["№", "Обозначение стандарта", "Условное обозначение", "Примечание"]]
    for w in WELDS:
        rows.append([str(w["n"]), w["std"], w["symbol"], w["note"]])
    table(msp, ox, oy, [8, 40, 35, 25], rows, row_h=4.0, text_h=1.4)


def draw_notes(msp, origin):
    ox, oy = origin
    text(msp, "Примечания", ox, oy + 4, h=2.5, layer="TEXT")
    col_w = 220
    y = oy
    for i, note in enumerate(NOTES):
        # длинные примечания — MTEXT с переносом
        mtext(msp, note.replace("\n", " "), ox, y, h=1.25, w=col_w, layer="NOTES")
        # оценка высоты блока
        lines_est = max(1, (len(note) // 95) + 1)
        y -= 3.2 * lines_est + 0.8


def draw_details_vedomost(msp, origin):
    ox, oy = origin
    text(msp, "Ведомость деталей", ox, oy + 8, h=2.5, layer="TEXT")
    # эскизы 11-15 и Ф1-Ф4
    draw_detail_bent(msp, (ox, oy - 50), 11)
    draw_detail_bent(msp, (ox + 55, oy - 50), 12)
    draw_detail_bent(msp, (ox + 100, oy - 50), 13)
    draw_detail_bent(msp, (ox, oy - 110), 14)
    draw_detail_bent(msp, (ox + 55, oy - 110), 15)
    draw_fixator_sketch(msp, (ox, oy - 150), "Ф1", FIXATORS["Ф1"]["sketch"])
    draw_fixator_sketch(msp, (ox + 55, oy - 150), "Ф2", FIXATORS["Ф2"]["sketch"])
    draw_fixator_sketch(msp, (ox, oy - 185), "Ф3", FIXATORS["Ф3"]["sketch"])
    draw_fixator_sketch(msp, (ox + 55, oy - 185), "Ф4", FIXATORS["Ф4"]["sketch"])


def layout_sheet(msp):
    """Компоновка всего листа А0."""
    draw_sheet_frame(msp)

    # Колонка 1: схема рабочей арматуры
    draw_working_scheme(msp, (30, 100))

    # Колонка 2-3: виды каркаса
    elev_y = 100
    draw_elevation(
        msp,
        (100, elev_y),
        "Арматурный каркас КП17 (вид со стороны котлована)",
        "pit",
    )
    draw_elevation(
        msp,
        (160, elev_y),
        "Арматурный каркас КП17 (вид со стороны грунта)",
        "ground",
    )
    draw_section_8_8(msp, (220, elev_y))

    # Сечения 1-1 … 7-7 справа от видов / ниже
    sec_x0 = 280
    sec_y0 = 520
    for i, sec in enumerate(SECTIONS):
        row = i // 2
        col = i % 2
        draw_cross_section(
            msp,
            (sec_x0 + col * 95, sec_y0 - row * 55),
            sec["name"],
            sec["fixators"],
        )

    # Рама Р17
    draw_frame_r17(msp, (480, 620))

    # Ведомость деталей
    draw_details_vedomost(msp, (480, 560))

    # Узлы
    draw_nodes(msp, (30, 40))
    draw_splice_scheme(msp, (380, 40))

    # Таблицы справа
    draw_spec_table(msp, (700, 780))
    draw_embedded_spec(msp, (700, 560))
    draw_steel_table(msp, (700, 470))
    draw_weld_table(msp, (700, 420))

    # Примечания
    draw_notes(msp, (700, 360))


def maybe_merge_underlay(doc, path: Path):
    """Опционально добавить геометрию из PDF-подложки на слой UNDERLAY (выкл. по умолчанию)."""
    if not path.exists():
        return
    # Не вставляем автоматически — файл большой; доступен отдельно.
    return


def main():
    # Параметрическая пересборка — отдельный файл, чтобы не затирать 1:1 PDF→DWG
    out = ROOT / "drawings" / "KP17_parametric.dxf"
    out.parent.mkdir(parents=True, exist_ok=True)

    doc = setup_doc()
    msp = doc.modelspace()
    layout_sheet(msp)

    # paperspace layout A0
    if "A0" not in doc.layouts:
        layout = doc.layouts.new("A0")
    else:
        layout = doc.layouts.get("A0")
    layout.page_setup(size=(SHEET_W, SHEET_H), margins=(0, 0, 0, 0), units="mm")

    doc.saveas(out)
    print(f"Saved: {out}")
    print(f"Entities: {len(msp)}")
    print("Layers:", ", ".join(sorted(l.dxf.name for l in doc.layers if not l.dxf.name.startswith("*"))))
    return out


if __name__ == "__main__":
    main()
