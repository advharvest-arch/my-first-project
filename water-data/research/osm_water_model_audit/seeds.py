"""Reference OSM seeds for the water-model audit.

Names are search labels only. Classification never reads them.
IDs were looked up in OSM (Overpass / OSM website) and then frozen.
"""

from __future__ import annotations

from typing import TypedDict


class Seed(TypedDict):
    key: str
    label: str
    osm_type: str
    osm_id: int
    lookup_note: str


SEEDS: list[Seed] = [
    {
        "key": "seliger",
        "label": "Селигер",
        "osm_type": "relation",
        "osm_id": 399081,
        "lookup_note": "type=multipolygon natural=water water=lake; MP with inner islands",
    },
    {
        "key": "selizharovka",
        "label": "Селижаровка",
        "osm_type": "relation",
        "osm_id": 379295,
        "lookup_note": "type=waterway waterway=river; main_stream members",
    },
    {
        "key": "river_area_mouth",
        "label": "river area (устьевой участок)",
        "osm_type": "relation",
        "osm_id": 2406778,
        "lookup_note": "type=multipolygon natural=water water=river; contains way/180396592",
    },
    {
        "key": "river_area_large",
        "label": "river area (крупный участок)",
        "osm_type": "relation",
        "osm_id": 2580469,
        "lookup_note": "type=multipolygon natural=water water=river",
    },
    {
        "key": "ladoga",
        "label": "Ладожское озеро",
        "osm_type": "relation",
        "osm_id": 21149039,
        "lookup_note": "type=multipolygon natural=water water=lake",
    },
    {
        "key": "onega",
        "label": "Онежское озеро",
        "osm_type": "relation",
        "osm_id": 1308279,
        "lookup_note": "type=multipolygon natural=water water=lake",
    },
    {
        "key": "beloe",
        "label": "Белое озеро",
        "osm_type": "relation",
        "osm_id": 1603199,
        "lookup_note": "type=multipolygon natural=water water=lake (Вологодская обл.)",
    },
    {
        "key": "rybinsk",
        "label": "Рыбинское водохранилище",
        "osm_type": "relation",
        "osm_id": 1521563,
        "lookup_note": "type=multipolygon natural=water water=reservoir",
    },
    {
        "key": "volga",
        "label": "Волга (крупный waterway)",
        "osm_type": "relation",
        "osm_id": 1730417,
        "lookup_note": "type=waterway waterway=river",
    },
    {
        "key": "neva",
        "label": "Нева",
        "osm_type": "relation",
        "osm_id": 2811903,
        "lookup_note": "type=waterway waterway=river",
    },
    {
        "key": "river_way",
        "label": "обычный waterway=river way",
        "osm_type": "way",
        "osm_id": 28237778,
        "lookup_note": "waterway=river; also a main_stream member of relation/379295",
    },
    {
        "key": "lake_way",
        "label": "natural=water озеро без relation",
        "osm_type": "way",
        "osm_id": 20542587,
        "lookup_note": "closed way natural=water; membership checked via rel(bw), not names",
    },
]

MEMBER_PARENT_FETCH_MAX_WAYS = 400
