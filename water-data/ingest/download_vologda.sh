#!/usr/bin/env bash
# Download Vologda Oblast OSM PBF (Volga–Baltic eastern corridor).
# Source: download.openstreetmap.fr extracts. Do not commit the PBF.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${ROOT}/data"
OUT_FILE="${OUT_DIR}/vologda_oblast-latest.osm.pbf"
META_FILE="${OUT_DIR}/vologda_oblast-latest.osm.pbf.meta.txt"
URL="https://download.openstreetmap.fr/extracts/russia/northwestern_federal_district/vologda_oblast-latest.osm.pbf"
FORCE=0

usage() {
  cat <<'EOF'
Usage: download_vologda.sh [--force]

Downloads Vologda Oblast OSM PBF (~52MB) into:
  water-data/data/vologda_oblast-latest.osm.pbf

Why this extract (E3.13):
  - Targeted coverage for Volga–Baltic relation 16738852 missing tail
  - ~52MB — small enough for a single-relation coverage experiment
  - Reproducible public URL (openstreetmap.fr)

Options:
  --force   Overwrite an existing local file
  -h, --help

Requires: curl, sha256sum
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

TMP="$(mktemp "${OUT_DIR}/.vologda-XXXXXX.osm.pbf")"
cleanup() { rm -f "${TMP}"; }
trap cleanup EXIT

echo "GET ${URL}"
START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_EPOCH="$(date +%s)"
HTTP_CODE="$(curl -sS -L --fail-with-body \
  -A "AquaRoute-water-data-e313/1.0 (local offline test; +https://github.com/advharvest-arch/my-first-project)" \
  -o "${TMP}" -w "%{http_code}" "${URL}")" || {
  echo "Download failed (curl exit $?)." >&2
  exit 1
}
END_EPOCH="$(date +%s)"
END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "HTTP ${HTTP_CODE}" >&2
  exit 1
fi

BYTES="$(wc -c < "${TMP}" | tr -d ' ')"
if [[ "${BYTES}" -lt 1000000 ]]; then
  echo "Downloaded file too small (${BYTES} bytes); aborting" >&2
  exit 1
fi

SHA256="$(sha256sum "${TMP}" | awk '{print $1}')"
mv -f "${TMP}" "${OUT_FILE}"
trap - EXIT

cat > "${META_FILE}" <<EOF
source_url=${URL}
local_path=${OUT_FILE}
bytes=${BYTES}
sha256=${SHA256}
http_code=${HTTP_CODE}
download_started_utc=${START}
download_finished_utc=${END}
download_seconds=$((END_EPOCH - START_EPOCH))
EOF

echo "Wrote ${OUT_FILE}"
echo "Wrote ${META_FILE}"
echo "bytes=${BYTES}"
echo "sha256=${SHA256}"
echo "download_seconds=$((END_EPOCH - START_EPOCH))"
