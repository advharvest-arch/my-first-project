#!/usr/bin/env bash
# Download Republic of Karelia OSM PBF (covers Belomor + surrounding water network).
# Source: download.openstreetmap.fr extracts (real OSM data). Do not commit the PBF.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${ROOT}/data"
OUT_FILE="${OUT_DIR}/karelia_republic-latest.osm.pbf"
URL="https://download.openstreetmap.fr/extracts/russia/northwestern_federal_district/karelia_republic-latest.osm.pbf"
FORCE=0

usage() {
  cat <<'EOF'
Usage: download_karelia.sh [--force]

Downloads Republic of Karelia OSM PBF (~100MB class) into:
  water-data/data/karelia_republic-latest.osm.pbf

Why this extract (E3.4):
  - Real OSM data (not hand-drawn)
  - Includes Belomor relation 9909116 and surrounding water network
  - ~102MB — much larger than relation-only (~105KB), far smaller than all-Russia
  - Reproducible public URL

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

TMP="$(mktemp "${OUT_DIR}/.karelia-XXXXXX.osm.pbf")"
cleanup() { rm -f "${TMP}"; }
trap cleanup EXIT

echo "GET ${URL}"
START="$(date +%s)"
HTTP_CODE="$(curl -sS -L --fail-with-body \
  -A "AquaRoute-water-data-e34/1.0 (local offline test; +https://github.com/advharvest-arch/my-first-project)" \
  -o "${TMP}" -w "%{http_code}" "${URL}")" || {
  echo "Download failed (curl exit $?)." >&2
  exit 1
}
END="$(date +%s)"

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "HTTP ${HTTP_CODE}" >&2
  exit 1
fi

# Basic PBF magic / size sanity
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
