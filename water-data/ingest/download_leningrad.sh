#!/usr/bin/env bash
# Download Leningrad Oblast OSM PBF (overlaps southern Karelia / Lake Ladoga).
# Source: download.openstreetmap.fr extracts. Do not commit the PBF.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${ROOT}/data"
OUT_FILE="${OUT_DIR}/leningrad_oblast-latest.osm.pbf"
URL="https://download.openstreetmap.fr/extracts/russia/northwestern_federal_district/leningrad_oblast-latest.osm.pbf"
FORCE=0

usage() {
  cat <<'EOF'
Usage: download_leningrad.sh [--force]

Downloads Leningrad Oblast OSM PBF (~189MB) into:
  water-data/data/leningrad_oblast-latest.osm.pbf

Why this extract (E3.8):
  - Real OSM data overlapping Karelia (esp. Lake Ladoga corridor)
  - ~189MB — larger than Karelia (~102MB), far smaller than NW FD (~620MB)
  - Reproducible public URL (openstreetmap.fr)

Approximate coverage: Leningrad Oblast (~27.5–35.9E, ~58.4–61.3N)

Options:
  --force   Overwrite an existing local file
  -h, --help

Requires: curl
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

mkdir -p "${OUT_DIR}"

if [[ -e "${OUT_FILE}" && "${FORCE}" -ne 1 ]]; then
  echo "Refusing to overwrite existing file: ${OUT_FILE}" >&2
  echo "Re-run with --force to replace it." >&2
  exit 1
fi

TMP="$(mktemp "${OUT_DIR}/.leningrad-XXXXXX.osm.pbf")"
cleanup() { rm -f "${TMP}"; }
trap cleanup EXIT

echo "GET ${URL}"
START="$(date +%s)"
HTTP_CODE="$(curl -sS -L --fail-with-body \
  -A "AquaRoute-water-data-e38/1.0 (local offline test; +https://github.com/advharvest-arch/my-first-project)" \
  -o "${TMP}" -w "%{http_code}" "${URL}")" || {
  echo "Download failed (curl exit $?)." >&2
  exit 1
}
END="$(date +%s)"

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "HTTP ${HTTP_CODE}" >&2
  exit 1
fi

BYTES="$(wc -c < "${TMP}" | tr -d ' ')"
if [[ "${BYTES}" -lt 1000000 ]]; then
  echo "Downloaded file too small (${BYTES} bytes); aborting" >&2
  exit 1
fi

mv -f "${TMP}" "${OUT_FILE}"
trap - EXIT
echo "Wrote ${OUT_FILE}"
echo "bytes=${BYTES}"
echo "download_seconds=$((END - START))"
