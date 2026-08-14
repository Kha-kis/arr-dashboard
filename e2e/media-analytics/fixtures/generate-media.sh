#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
HARNESS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
COMPOSE_PROJECT="arr-dashboard-media-analytics-e2e"
COMPOSE_FILE="${HARNESS_DIR}/docker-compose.yml"
MEDIA_ROOT="$(realpath -m "${HARNESS_DIR}/.state/media")"

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 OUTPUT_DIR" >&2
  exit 2
fi

output_dir="$(realpath -m "$1")"
case "${output_dir}/" in
  "${MEDIA_ROOT}/"*) ;;
  *)
    echo "refusing to generate media outside ${MEDIA_ROOT}" >&2
    exit 1
    ;;
esac

mkdir -p "$output_dir"
target_dir="${output_dir}/Synthetic Test"
rm -rf -- "$target_dir"

relative_output_dir="${output_dir#"${MEDIA_ROOT}"}"
relative_output_dir="${relative_output_dir#/}"
container_output_dir="/data"
if [[ -n "$relative_output_dir" ]]; then
  container_output_dir="${container_output_dir}/${relative_output_dir}"
fi

generator_uid="$(id -u)"
generator_gid="$(id -g)"

MEDIA_GENERATOR_UID="$generator_uid" MEDIA_GENERATOR_GID="$generator_gid" docker compose \
  --project-name "$COMPOSE_PROJECT" \
  --file "$COMPOSE_FILE" \
  --profile media-generator \
  run --rm --no-deps \
  --env "MEDIA_OUTPUT_DIR=${container_output_dir}" \
  media-generator \
  'mkdir -p "$MEDIA_OUTPUT_DIR/Synthetic Test"; ffmpeg -hide_banner -loglevel error -y -f lavfi -i smptebars=size=1280x720:rate=30 -t 2 -c:v libx264 -pix_fmt yuv420p "$MEDIA_OUTPUT_DIR/Synthetic Test/Synthetic Test.mp4"'
