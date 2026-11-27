#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
verify() {
  ref=$1 expected=$2 version=$3
  docker pull --platform linux/amd64 "$ref" >/dev/null
  [ "$(docker image inspect "$ref" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64 ] || { echo "platform mismatch" >&2; exit 1; }
  [ "$(docker image inspect "$ref" --format '{{.Id}}')" = "$expected" ] || { echo "image config digest mismatch" >&2; exit 1; }
  if [ -n "$version" ]; then
    actual=$(docker image inspect "$ref" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}')
    [ "$actual" = "$version" ] || { echo "image version label mismatch" >&2; exit 1; }
  fi
}
verify linuxserver/lidarr@sha256:c4285344c994b34e1ae7db8d57c1702dcfe88b8e10c98a0cdf0f74aba8b58b9c sha256:4d45a5a7a6cef67ee1ffd779074a715a621782762d0b858f24fac616582e603d 3.1.6.5079-ls50
verify jellyfin/jellyfin@sha256:0b901391a662862eddb5dc55d244d7883cbb6236ef5b9a6ea82abc78a89819f0 sha256:d57d4a0c18b3e51b913bd2f8f0f122eb7c7150ea37bb0e352df9cb329de11d24 ""
printf 'pinned image platform, config digests, and available version label verified\n'
