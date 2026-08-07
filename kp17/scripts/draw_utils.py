"""Утилиты черчения для листа КП17."""
from __future__ import annotations

from typing import Iterable, Sequence, Tuple

Point = Tuple[float, float]


def rect(msp, x, y, w, h, layer="FRAME", **kw):
    msp.add_lwpolyline(
        [(x, y), (x + w, y), (x + w, y + h), (x, y + h)],
        close=True,
        dxfattribs={"layer": layer, **kw},
    )


def line(msp, a: Point, b: Point, layer="GEOMETRY", **kw):
    msp.add_line(a, b, dxfattribs={"layer": layer, **kw})


def lines(msp, pts: Sequence[Point], layer="GEOMETRY", close=False, **kw):
    pl = list(pts)
    if close and pl and pl[0] != pl[-1]:
        pl = pl + [pl[0]]
    msp.add_lwpolyline(pl, close=close, dxfattribs={"layer": layer, **kw})


def text(msp, s, x, y, h=2.5, layer="TEXT", align="LEFT", style="GOST", rotation=0, width=0.8):
    if not s:
        return
    attribs = {"layer": layer, "height": h, "style": style, "rotation": rotation, "width": width}
    if align == "CENTER":
        msp.add_text(str(s), dxfattribs=attribs).set_placement(
            (x, y), align=ezdxf_align("MIDDLE_CENTER")
        )
    elif align == "RIGHT":
        msp.add_text(str(s), dxfattribs=attribs).set_placement(
            (x, y), align=ezdxf_align("MIDDLE_RIGHT")
        )
    else:
        msp.add_text(str(s), dxfattribs=attribs).set_placement(
            (x, y), align=ezdxf_align("LEFT")
        )


def ezdxf_align(name: str):
    from ezdxf.enums import TextEntityAlignment

    return getattr(TextEntityAlignment, name)


def mtext(msp, s, x, y, h=2.0, w=80, layer="TEXT", style="GOST"):
    t = msp.add_mtext(
        str(s),
        dxfattribs={"layer": layer, "char_height": h, "style": style, "width": w},
    )
    t.set_location((x, y))
    return t


def dim_h(msp, x1, x2, y, text_override=None, layer="DIMS", h=2.0):
    """Простая размерная цепочка горизонтальная (без DIM-стиля — линиями)."""
    tick = 1.5
    line(msp, (x1, y), (x2, y), layer=layer)
    line(msp, (x1, y - tick), (x1, y + tick), layer=layer)
    line(msp, (x2, y - tick), (x2, y + tick), layer=layer)
    label = text_override if text_override is not None else str(int(round(abs(x2 - x1))))
    text(msp, label, (x1 + x2) / 2, y + 0.8, h=h, layer=layer, align="CENTER")


def dim_v(msp, y1, y2, x, text_override=None, layer="DIMS", h=2.0, rot=90):
    tick = 1.5
    line(msp, (x, y1), (x, y2), layer=layer)
    line(msp, (x - tick, y1), (x + tick, y1), layer=layer)
    line(msp, (x - tick, y2), (x + tick, y2), layer=layer)
    label = text_override if text_override is not None else str(int(round(abs(y2 - y1))))
    text(msp, label, x + 1.2, (y1 + y2) / 2, h=h, layer=layer, align="CENTER", rotation=rot)


def circle(msp, c: Point, r: float, layer="GEOMETRY", **kw):
    msp.add_circle(c, r, dxfattribs={"layer": layer, **kw})


def hatch_rect(msp, x, y, w, h, layer="HATCH"):
    # лёгкая штриховка рамкой — без solid hatch для совместимости
    step = 4
    for i in range(0, int(w + h), step):
        x0 = x + i
        if x0 < x + w:
            x1 = min(x + w, x0)
            # diagonal fragments
            pass
    rect(msp, x, y, w, h, layer=layer)


def table(
    msp,
    x,
    y,
    col_widths: Sequence[float],
    rows: Sequence[Sequence[str]],
    row_h=4.5,
    header=True,
    layer="TABLE",
    text_h=1.8,
):
    """Рисует таблицу; y — верхний левый угол."""
    total_w = sum(col_widths)
    n = len(rows)
    # рамка и линии
    for i in range(n + 1):
        yy = y - i * row_h
        line(msp, (x, yy), (x + total_w, yy), layer=layer)
    line(msp, (x, y), (x, y - n * row_h), layer=layer)
    xx = x
    for w in col_widths:
        xx += w
        line(msp, (xx, y), (xx, y - n * row_h), layer=layer)
    for ri, row in enumerate(rows):
        yy = y - (ri + 1) * row_h + row_h * 0.28
        xx = x
        for ci, (cell, w) in enumerate(zip(row, col_widths)):
            text(msp, cell, xx + 0.8, yy, h=text_h, layer="TEXT")
            xx += w
    return total_w, n * row_h
