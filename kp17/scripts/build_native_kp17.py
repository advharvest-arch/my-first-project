#!/usr/bin/env python3
"""Нативный лист КП17 для AutoCAD:

  - DIMENSION — настоящие размеры
  - MTEXT — многострочный текст шрифтом GOSTCommon (из PDF)
  - RECTANG — каркасы/сечения как замкнутые прямоугольники (без лишней сетки)
  - TABLE — спецификация через TablePainter + блок таблицы
  - цвет 7 (как PDF)
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import ezdxf
from ezdxf import units, bbox
from ezdxf.addons.tablepainter import TablePainter
from ezdxf.enums import TextEntityAlignment

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from kp17.data import kp17_data as D  # noqa: E402

DRAW = ROOT / "drawings"
FONT_DIR = ROOT / "fonts"
GOST_FONT = FONT_DIR / "GOSTCommon.ttf"
ODA_BIN = Path("/tmp/squashfs-root/usr/bin/ODAFileConverter")

SHEET_W, SHEET_H = 1189.0, 841.0
MARGIN = 20.0
COLOR = 7
VIEW_SCALE = 1 / 50.0  # виды каркаса


def setup_doc():
    doc = ezdxf.new("R2013", setup=True)
    doc.units = units.MM
    doc.header["$INSUNITS"] = units.MM
    doc.header["$MEASUREMENT"] = 1

    for name in (
        "FRAME",
        "REBAR",
        "SECTION",
        "TEXT",
        "DIMS",
        "TABLE",
        "TABLE_GRID",
        "DETAILS",
        "CENTER",
        "TITLE",
    ):
        doc.layers.add(name, color=COLOR)

    # Шрифт как в PDF
    font_name = "GOSTCommon.ttf"
    # абсолютный путь — чтобы ezdxf/просмотрщики находили файл
    font_path = str(GOST_FONT.resolve()) if GOST_FONT.exists() else font_name
    for style_name in ("GOST", "Standard"):
        if style_name in doc.styles:
            doc.styles.get(style_name).dxf.font = font_name
        else:
            doc.styles.new(style_name, dxfattribs={"font": font_name})
    # дублируем стиль с явным именем файла
    if "GOSTCommon" not in doc.styles:
        doc.styles.new("GOSTCommon", dxfattribs={"font": font_name})

    if "KP17" not in doc.dimstyles:
        doc.dimstyles.new("KP17")
    ds = doc.dimstyles.get("KP17")
    ds.dxf.dimtxsty = "GOST"
    ds.dxf.dimtxt = 2.5
    ds.dxf.dimclrd = COLOR
    ds.dxf.dimclre = COLOR
    ds.dxf.dimclrt = COLOR
    ds.dxf.dimexe = 1.2
    ds.dxf.dimexo = 0.8
    ds.dxf.dimasz = 1.8
    ds.dxf.dimtad = 1
    ds.dxf.dimtofl = 1
    ds.dxf.dimgap = 0.6
    ds.dxf.dimlwd = 13
    ds.dxf.dimlwe = 13
    return doc


def rectang(msp, x, y, w, h, layer="REBAR"):
    """Эквивалент команды RECTANG — замкнутая LWPOLYLINE."""
    return msp.add_lwpolyline(
        [(x, y), (x + w, y), (x + w, y + h), (x, y + h)],
        close=True,
        dxfattribs={"layer": layer, "color": COLOR, "lineweight": 35},
    )


def mtext(msp, text, x, y, h=2.5, width=80, layer="TEXT", rot=0, attach=1):
    """Многострочный текст шрифтом GOST."""
    t = msp.add_mtext(
        text.replace("\n", "\\P"),
        dxfattribs={
            "layer": layer,
            "style": "GOST",
            "char_height": h,
            "width": width,
            "color": COLOR,
            "rotation": rot,
            "attachment_point": attach,
        },
    )
    t.set_location((x, y))
    return t


def hdim(msp, x1, x2, y, override=None, layer="DIMS"):
    """Горизонтальный DIMENSION: p1/p2 на объекте, размерная линия ниже."""
    dim = msp.add_linear_dim(
        base=((x1 + x2) / 2.0, y - 8.0),
        p1=(x1, y),
        p2=(x2, y),
        angle=0,
        dimstyle="KP17",
        dxfattribs={"layer": layer, "color": COLOR},
    )
    if override is not None:
        dim.set_text(str(override))
    dim.render()
    return dim


def vdim(msp, y1, y2, x, override=None, layer="DIMS"):
    """Вертикальный DIMENSION: p1/p2 на объекте, размерная линия слева."""
    dim = msp.add_linear_dim(
        base=(x - 8.0, (y1 + y2) / 2.0),
        p1=(x, y1),
        p2=(x, y2),
        angle=90,
        dimstyle="KP17",
        dxfattribs={"layer": layer, "color": COLOR},
    )
    if override is not None:
        dim.set_text(str(override))
    dim.render()
    return dim


def draw_frame(msp):
    rectang(msp, 0, 0, SHEET_W, SHEET_H, "FRAME")
    rectang(msp, MARGIN, MARGIN, SHEET_W - 2 * MARGIN, SHEET_H - 2 * MARGIN, "FRAME")
    # штамп
    tw, th = 180, 55
    tx, ty = SHEET_W - MARGIN - tw, MARGIN
    rectang(msp, tx, ty, tw, th, "TITLE")
    msp.add_line((tx, ty + 15), (tx + tw, ty + 15), dxfattribs={"layer": "TITLE", "color": COLOR})
    msp.add_line((tx, ty + 35), (tx + tw, ty + 35), dxfattribs={"layer": "TITLE", "color": COLOR})
    msp.add_line((tx + 70, ty), (tx + 70, ty + th), dxfattribs={"layer": "TITLE", "color": COLOR})
    mtext(msp, D.TITLE["mark"], tx + 125, ty + 42, h=6, width=50, layer="TITLE", attach=5)
    mtext(msp, D.TITLE["name"], tx + 125, ty + 28, h=2.5, width=100, layer="TITLE", attach=5)
    mtext(
        msp,
        f"Масса {D.TITLE['mass']} кг\\PЛист {D.TITLE['sheet']}  Листов {D.TITLE['sheets']}",
        tx + 125,
        ty + 8,
        h=2.0,
        width=100,
        layer="TITLE",
        attach=5,
    )
    mtext(msp, f"Формат {D.TITLE['format']}", SHEET_W - 8, 6, h=2.5, width=40, attach=6)


def draw_cage_elevation(msp, x, y, title: str):
    """Вид каркаса = прямоугольник + размер, без сетки лишних линий."""
    L = D.CAGE["length"] * VIEW_SCALE
    W = D.CAGE["width"] * VIEW_SCALE
    rectang(msp, x, y, W, L, "REBAR")
    # одна осевая
    msp.add_line(
        (x + W / 2, y),
        (x + W / 2, y + L),
        dxfattribs={"layer": "CENTER", "color": COLOR, "linetype": "CENTER"},
    )
    mtext(msp, title, x, y + L + 8, h=2.5, width=max(W * 4, 90), attach=1)
    # размеры габарита — настоящие DIMENSION с подписью модели
    hdim(msp, x, x + W, y - 6, override=str(D.CAGE["width"]))
    vdim(msp, y, y + L, x - 10, override=str(D.CAGE["length"]))
    # ключевые уровни стыков
    y_cur = y
    for seg in (3050, 11700, 11700, 4500):  # упрощённая разбивка до ~30950
        pass
    # разбивка по данным раскладки
    return x, y, W, L


def draw_layout_scheme(msp, x, y):
    """Схема рабочей арматуры — прямоугольные зоны стержней + размеры."""
    L = D.CAGE["length"] * VIEW_SCALE
    col_w = 8
    mtext(
        msp,
        "Схема расположения рабочей арматуры\\Pкаркаса КП17",
        x,
        y + L + 8,
        h=2.5,
        width=70,
    )
    # две колонки: грунт / котлован
    rectang(msp, x, y, col_w, L, "REBAR")
    rectang(msp, x + 18, y, col_w, L, "REBAR")
    msp.add_line(
        (x + 13, y),
        (x + 13, y + L),
        dxfattribs={"layer": "CENTER", "color": COLOR, "linetype": "CENTER"},
    )
    mtext(msp, "Сторона\\Pгрунта", x - 2, y + L - 2, h=1.8, width=20)
    mtext(msp, "Сторона\\Pкотлована", x + 20, y + L - 2, h=1.8, width=25)

    def stack(segments, x0):
        yy = y
        for seg in segments:
            hh = seg["L"] * VIEW_SCALE
            # прямоугольник сегмента стержня
            rectang(msp, x0, yy, col_w, hh, "REBAR")
            mtext(
                msp,
                f"{seg['pos']}  Ø{seg['d']}\\P{seg['L']}",
                x0 + col_w + 1,
                yy + hh / 2,
                h=1.6,
                width=22,
                attach=4,
            )
            vdim(msp, yy, yy + hh, x0 - 6, override=str(seg["L"]))
            yy += hh
        return yy

    stack(D.LAYOUT_GROUND, x)
    stack(D.LAYOUT_PIT, x + 18)
    vdim(msp, y, y + L, x - 18, override=str(D.CAGE["length"]))


def draw_section(msp, x, y, name: str, fixators):
    """Сечение = прямоугольник 1900×800 (в масштабе) без лишних линий."""
    s = 1 / 25.0
    W = D.CAGE["width"] * s
    H = 800 * s
    rectang(msp, x, y, W, H, "SECTION")
    # контур трубы — окружность
    msp.add_circle(
        (x + W / 2, y + H / 2),
        225 * s,
        dxfattribs={"layer": "CENTER", "color": COLOR, "linetype": "DASHED"},
    )
    mtext(msp, name, x + W / 2, y + H + 4, h=2.5, width=20, attach=5)
    mtext(msp, "Грунт", x - 1, y + H / 2, h=1.6, width=15, rot=90, attach=5)
    mtext(msp, "Котлован", x + W + 2, y + H / 2, h=1.6, width=18, rot=90, attach=5)
    if fixators:
        mtext(msp, " ".join(fixators), x + W / 2, y - 5, h=1.5, width=40, attach=5)
    hdim(msp, x, x + W, y - 8, override="1900")
    vdim(msp, y, y + H, x + W + 6, override="800")


def draw_frame_r17(msp, x, y):
    s = 1 / 10.0
    L = D.FRAME_R17["L"] * s
    H = D.FRAME_R17["H"] * s
    rectang(msp, x, y, L, H, "DETAILS")
    msp.add_line((x, y + H / 2), (x + L, y + H / 2), dxfattribs={"layer": "DETAILS", "color": COLOR})
    xx = x
    for d in D.FRAME_R17["dims"][:-1]:
        xx += d * s
        msp.add_line((xx, y), (xx, y + H), dxfattribs={"layer": "DETAILS", "color": COLOR})
    mtext(msp, "Рама Р17", x, y + H + 5, h=2.5, width=40)
    hdim(msp, x, x + L, y - 6, override="1900")
    vdim(msp, y, y + H, x - 6, override="590")


def draw_spec_table(msp, doc):
    """Спецификация как табличный объект (TablePainter → нативные ячейки TEXT в сетке)."""
    rows = [["Поз.", "Наименование", "Кол.", "Масса ед., кг", "Масса, кг"]]
    for b in D.WORKING_BARS:
        mu, mt = D.BAR_MASS[b["pos"]]
        name = f"Пруток {b['d']}x{b['L']}-{b['grade']} ГОСТ 34028-2016"
        rows.append([str(b["pos"]), name, str(b["qty"]), f"{mu:.2f}", f"{mt:.2f}"])
    rows.append(["", "Детали", "", "", ""])
    for d in D.DETAILS:
        name = f"Пруток {d['d']}x{d['L']}-{d['grade']} ГОСТ 34028-2016"
        rows.append([str(d["pos"]), name, str(d["qty"]), f"{d['mass_unit']:.2f}", f"{d['mass_total']:.2f}"])
    rows.append(["", "Закладные изделия", "", "", ""])
    for e in D.EMBEDDED:
        rows.append([e["pos"], e["name"], str(e["qty"]), f"{e['mass_unit']:.2f}", f"{e['mass_total']:.2f}"])
    rows.append(["", "Итого", "", "", f"{D.TITLE['mass']:.2f}"])

    ncols = 5
    nrows = len(rows)
    # TablePainter — сетка + текст; кладём в блок TABLE_KP17
    block_name = "TABLE_SPEC_KP17"
    if block_name in doc.blocks:
        del doc.blocks[block_name]
    blk = doc.blocks.new(block_name)

    col_w = [12, 100, 14, 22, 20]
    row_h = 4.0
    tp = TablePainter(
        insert=(0, nrows * row_h),
        nrows=nrows,
        ncols=ncols,
        cell_width=20,
        cell_height=row_h,
        default_grid=True,
    )
    for i, w in enumerate(col_w):
        tp.set_col_width(i, w)
    for r in range(nrows):
        tp.set_row_height(r, row_h)
        for c, val in enumerate(rows[r]):
            style = "header" if r == 0 else "default"
            if style not in tp.styles:
                tp.new_cell_style(
                    style,
                    text_style="GOST",
                    char_height=1.6 if r else 1.8,
                    text_color=COLOR,
                )
            if "default" not in tp.styles:
                tp.new_cell_style("default", text_style="GOST", char_height=1.5, text_color=COLOR)
            tp.text_cell(r, c, val, style=style if r == 0 else "default")

    # слои таблицы
    tp.grid_layer_name = "TABLE_GRID"
    tp.fg_layer_name = "TABLE"
    tp.bg_layer_name = "TABLE"
    tp.render(blk)

    # вставка блока таблицы на лист
    insert = (700, 200)
    msp.add_blockref(block_name, insert, dxfattribs={"layer": "TABLE", "color": COLOR})
    mtext(
        msp,
        "Спецификация пространственного каркаса КП17",
        insert[0],
        insert[1] + nrows * row_h + 6,
        h=3.0,
        width=160,
    )
    return nrows


def draw_notes(msp):
    # одно MTEXT со всеми примечаниями
    body = "\\P".join(D.NOTES)
    mtext(msp, "Примечания\\P" + body, 700, 190, h=1.6, width=220, attach=1)


def draw_steel_and_welds(msp, doc):
    sc = D.STEEL_CONSUMPTION
    rows = [
        ["Марка", "А240 Ø25", "А500С Ø12", "Ø22", "Ø25", "Ø32", "Ø36", "Итого", "Всего"],
        [
            "КП17",
            f"{sc['A240_d25']:.2f}",
            f"{sc['A500C']['12']:.2f}",
            f"{sc['A500C']['22']:.2f}",
            f"{sc['A500C']['25']:.2f}",
            f"{sc['A500C']['32']:.2f}",
            f"{sc['A500C']['36']:.2f}",
            f"{sc['A500C']['total']:.2f}",
            f"{sc['grand_total']:.2f}",
        ],
    ]
    blk_name = "TABLE_STEEL_KP17"
    if blk_name in doc.blocks:
        del doc.blocks[blk_name]
    blk = doc.blocks.new(blk_name)
    tp = TablePainter(insert=(0, 10), nrows=2, ncols=9, cell_width=18, cell_height=5)
    widths = [14, 18, 18, 16, 14, 14, 14, 16, 16]
    for i, w in enumerate(widths):
        tp.set_col_width(i, w)
    tp.new_cell_style("default", text_style="GOST", char_height=1.4, text_color=COLOR)
    for r, row in enumerate(rows):
        for c, val in enumerate(row):
            tp.text_cell(r, c, val)
    tp.grid_layer_name = "TABLE_GRID"
    tp.fg_layer_name = "TABLE"
    tp.render(blk)
    msp.add_blockref(blk_name, (700, 760), dxfattribs={"layer": "TABLE", "color": COLOR})
    mtext(msp, "Ведомость расхода стали, кг", 700, 775, h=2.5, width=120)

    # таблица швов
    wrows = [["№", "Стандарт", "Обозначение"]]
    for w in D.WELDS:
        wrows.append([str(w["n"]), w["std"], w["symbol"]])
    blk2 = "TABLE_WELDS_KP17"
    if blk2 in doc.blocks:
        del doc.blocks[blk2]
    b2 = doc.blocks.new(blk2)
    tp2 = TablePainter(insert=(0, 20), nrows=len(wrows), ncols=3, cell_width=40, cell_height=4.5)
    tp2.set_col_width(0, 10)
    tp2.set_col_width(1, 45)
    tp2.set_col_width(2, 30)
    tp2.new_cell_style("default", text_style="GOST", char_height=1.5, text_color=COLOR)
    for r, row in enumerate(wrows):
        for c, val in enumerate(row):
            tp2.text_cell(r, c, val)
    tp2.grid_layer_name = "TABLE_GRID"
    tp2.fg_layer_name = "TABLE"
    tp2.render(b2)
    msp.add_blockref(blk2, (700, 700), dxfattribs={"layer": "TABLE", "color": COLOR})
    mtext(msp, "Таблица сварных швов", 700, 725, h=2.5, width=80)


def ensure_linetypes(doc):
    if "CENTER" not in doc.linetypes:
        doc.linetypes.add("CENTER", pattern="A,12.5,-2.5,0.5,-2.5", description="Center ____ _ ____ _")
    if "DASHED" not in doc.linetypes:
        doc.linetypes.add("DASHED", pattern="A,5,-2.5", description="Dashed __ __ __")


def dxf_to_dwg(dxf: Path, dwg: Path) -> bool:
    if not ODA_BIN.exists():
        return False
    inp, outp = Path("/tmp/oda_nat_in"), Path("/tmp/oda_nat_out")
    inp.mkdir(exist_ok=True)
    outp.mkdir(exist_ok=True)
    for f in list(inp.glob("*")) + list(outp.glob("*")):
        f.unlink()
    shutil.copy(dxf, inp / dxf.name)
    # fonts alongside for ODA
    for f in FONT_DIR.glob("*.ttf"):
        shutil.copy(f, inp / f.name)
    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = str(ODA_BIN.parent) + ":" + env.get("LD_LIBRARY_PATH", "")
    subprocess.run(
        [str(ODA_BIN), str(inp), str(outp), "ACAD2018", "DWG", "0", "1", "*.DXF"],
        check=False,
        env=env,
        capture_output=True,
    )
    produced = outp / (dxf.stem + ".dwg")
    if produced.exists():
        shutil.copy(produced, dwg)
        # copy fonts next to dwg for AutoCAD
        font_out = dwg.parent / "fonts"
        font_out.mkdir(exist_ok=True)
        for f in FONT_DIR.glob("*.ttf"):
            shutil.copy(f, font_out / f.name)
        print(f"DWG {dwg} ({dwg.stat().st_size} bytes)")
        return True
    return False


def build():
    if not GOST_FONT.exists():
        raise SystemExit(f"Font missing: {GOST_FONT}")

    doc = setup_doc()
    ensure_linetypes(doc)
    msp = doc.modelspace()

    draw_frame(msp)

    # Левая колонка — схема
    draw_layout_scheme(msp, 45, 90)

    # Виды каркаса — прямоугольники
    draw_cage_elevation(
        msp, 130, 90, "Арматурный каркас КП17\\P(вид со стороны котлована)"
    )
    draw_cage_elevation(
        msp, 200, 90, "Арматурный каркас КП17\\P(вид со стороны грунта)"
    )
    # сечение 8-8 — узкий прямоугольник
    L = D.CAGE["length"] * VIEW_SCALE
    Dpth = 800 * VIEW_SCALE
    rectang(msp, 270, 90, Dpth, L, "SECTION")
    mtext(msp, "8-8", 270, 90 + L + 8, h=2.5, width=20)
    mtext(msp, "Сторона грунта", 270 + Dpth + 2, 90 + L - 10, h=1.6, width=30)
    mtext(msp, "Сторона котлована", 270 + Dpth + 2, 95, h=1.6, width=35)
    vdim(msp, 90, 90 + L, 270 - 6, override=str(D.CAGE["length"]))

    # Сечения 1-1 … 7-7
    for i, sec in enumerate(D.SECTIONS):
        row, col = divmod(i, 2)
        draw_section(msp, 320 + col * 100, 520 - row * 70, sec["name"], sec["fixators"])

    draw_frame_r17(msp, 520, 620)

    draw_steel_and_welds(msp, doc)
    draw_spec_table(msp, doc)
    draw_notes(msp)

    # цвет всех сущностей = 7
    for e in msp:
        try:
            e.dxf.color = COLOR
        except Exception:
            pass
    for layer in doc.layers:
        if not layer.dxf.name.startswith("*"):
            layer.dxf.color = COLOR

    dxf = DRAW / "KP17.dxf"
    doc.saveas(dxf)
    print(f"Saved {dxf}")
    from collections import Counter

    print("entities:", Counter(e.dxftype() for e in msp))
    print("extents:", bbox.extents(msp, fast=True))
    dxf_to_dwg(dxf, DRAW / "KP17.dwg")
    return dxf


if __name__ == "__main__":
    build()
