#!/usr/bin/env bash
# Download Belomor canal OSM relation 9909116 (full: relation + members + nodes).
# Official OSM API only — no Overpass. Does not commit the file to git.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${ROOT}/data"
OUT_FILE="${OUT_DIR}/belomor-relation-9909116-full.osm"
URL="https://api.openstreetmap.org/api/0.6/relation/9909116/full"
FORCE=0

usage() {
  cat <<'EOF'
Usage: download_belomor.sh [--force]

Downloads OSM API relation/9909116/full into:
  water-data/data/belomor-relation-9909116-full.osm

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

TMP="$(mktemp "${OUT_DIR}/.belomor-XXXXXX.osm")"
cleanup() { rm -f "${TMP}"; }
trap cleanup EXIT

echo "GET ${URL}"
HTTP_CODE="$(curl -sS -L --fail-with-body \
  -A "AquaRoute-water-data-e33/1.0 (local offline test; +https://github.com/advharvest-arch/my-first-project)" \
  -o "${TMP}" -w "%{http_code}" "${URL}")" || {
  echo "Download failed (curl exit $?)." >&2
  exit 1
}

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "HTTP ${HTTP_CODE} from OSM API" >&2
  head -c 500 "${TMP}" >&2 || true
  echo >&2
  exit 1
fi

# Basic sanity: OSM XML should mention the relation id
if ! grep -q 'relation id=.9909116' "${TMP}" && ! grep -q 'relation id="9909116"' "${TMP}"; then
  echo "Downloaded file does not look like relation 9909116" >&2
  exit 1
fi

mv -f "${TMP}" "${OUT_FILE}"
trap - EXIT
BYTES="$(wc -c < "${OUT_FILE}" | tr -d ' ')"
echo "Wrote ${OUT_FILE} (${BYTES} bytes)"
