#!/usr/bin/env bash
set -euo pipefail

source ./scripts/common.sh

case "${1:-}" in
  hold)
    marker="${2:?marker path is required}"
    acquire_lifecycle_lock
    : > "$marker"
    sleep 1
    ;;
  nested-parent)
    acquire_lifecycle_lock
    bash "$0" nested-child
    ;;
  nested-child)
    acquire_lifecycle_lock
    ;;
  *)
    printf 'unknown lifecycle lock fixture mode\n' >&2
    exit 64
    ;;
esac
