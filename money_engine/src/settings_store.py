import os
import re
from pathlib import Path

from config import BASE_DIR, settings

ENV_FILE = BASE_DIR / ".env"


def _read_env() -> dict[str, str]:
    result: dict[str, str] = {}
    if not ENV_FILE.exists():
        return result
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        result[key.strip()] = value.strip()
    return result


def _write_env(updates: dict[str, str]) -> None:
    lines: list[str] = []
    seen: set[str] = set()

    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                key = stripped.split("=", 1)[0].strip()
                if key in updates:
                    lines.append(f"{key}={updates[key]}")
                    seen.add(key)
                    continue
            lines.append(line)

    for key, value in updates.items():
        if key not in seen:
            lines.append(f"{key}={value}")

    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def detect_ad_network(ad_id: str) -> str:
    ad_id = ad_id.strip()
    if ad_id.startswith("ca-pub-"):
        return "adsense"
    if ad_id.startswith("R-A-") or ad_id.startswith("R-M-"):
        return "yandex"
    if re.match(r"^\d{10,}$", ad_id):
        return "adsense"
    return "yandex"


def get_ad_settings() -> dict:
    env = _read_env()
    yandex = env.get("AD_SLOT_YANDEX", settings.ad_slot_yandex)
    adsense = env.get("AD_SLOT_ADSENSE", settings.ad_slot_adsense)
    configured = bool(yandex or adsense)
    return {
        "configured": configured,
        "ad_slot_yandex": yandex,
        "ad_slot_adsense": adsense,
        "active_id": yandex or adsense or "",
        "network": "yandex" if yandex else ("adsense" if adsense else ""),
    }


def save_ad_id(ad_id: str) -> dict:
    ad_id = ad_id.strip()
    if not ad_id:
        return {"ok": False, "error": "Введите ID рекламы"}

    network = detect_ad_network(ad_id)
    updates = {
        "AD_SLOT_YANDEX": ad_id if network == "yandex" else "",
        "AD_SLOT_ADSENSE": ad_id if network == "adsense" else "",
    }
    _write_env(updates)

    os.environ["AD_SLOT_YANDEX"] = updates["AD_SLOT_YANDEX"]
    os.environ["AD_SLOT_ADSENSE"] = updates["AD_SLOT_ADSENSE"]
    settings.ad_slot_yandex = updates["AD_SLOT_YANDEX"]
    settings.ad_slot_adsense = updates["AD_SLOT_ADSENSE"]

    from src.fleet.scaler import redeploy_fleet
    from src.turnkey.export import export_static_site

    redeploy = redeploy_fleet()
    export_static_site()

    return {
        "ok": True,
        "network": network,
        "ad_id": ad_id,
        "projects_updated": redeploy.get("updated", 0),
    }
