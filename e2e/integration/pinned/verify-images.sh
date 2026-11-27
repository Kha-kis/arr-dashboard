#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TMP=$(mktemp -d)
chmod 700 "$TMP"
cleanup() { rm -rf -- "$TMP"; }
trap cleanup 0
verify() {
  ref=$1 top=$2 selected=$3 config=$4 version=$5
  docker buildx imagetools inspect --raw "$ref" > "$TMP/index.json"
  child=$(node --input-type=module -e '
    import fs from "node:fs";
    const { selectPlatformManifestDigest } = await import(process.argv[1]);
    const expected = { manifestDigest: process.argv[2], selectedPlatformManifestDigest: process.argv[3], referenceDigest: process.argv[2] };
    process.stdout.write(selectPlatformManifestDigest(fs.readFileSync(process.argv[4], "utf8"), expected));
  ' "$HERE/manifest-verify.mjs" "$top" "$selected" "$TMP/index.json")
  docker buildx imagetools inspect --raw "${ref%@*}@$child" > "$TMP/child.json"
  printf '{"manifestDigest":"%s","selectedPlatformManifestDigest":"%s","configDigest":"%s","referenceDigest":"%s"}\n' "$top" "$selected" "$config" "$top" > "$TMP/expected.json"
  node --input-type=module -e '
    import fs from "node:fs";
    const { verifyRegistryIdentity } = await import(process.argv[1]);
    verifyRegistryIdentity({ indexRaw: fs.readFileSync(process.argv[2], "utf8"), childRaw: fs.readFileSync(process.argv[3], "utf8"), expected: JSON.parse(fs.readFileSync(process.argv[4], "utf8")) });
  ' "$HERE/manifest-verify.mjs" "$TMP/index.json" "$TMP/child.json" "$TMP/expected.json"
  docker pull --platform linux/amd64 "$ref" >/dev/null
  [ "$(docker image inspect "$ref" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64 ] || { echo "platform mismatch" >&2; exit 1; }
  [ "$(docker image inspect "$ref" --format '{{.Id}}')" = "$config" ] || { echo "image config digest mismatch" >&2; exit 1; }
  if [ -n "$version" ]; then
    actual=$(docker image inspect "$ref" --format '{{ index .Config.Labels "org.opencontainers.image.version" }}')
    [ "$actual" = "$version" ] || { echo "image version label mismatch" >&2; exit 1; }
  fi
}
verify linuxserver/lidarr@sha256:c4285344c994b34e1ae7db8d57c1702dcfe88b8e10c98a0cdf0f74aba8b58b9c sha256:c4285344c994b34e1ae7db8d57c1702dcfe88b8e10c98a0cdf0f74aba8b58b9c sha256:019985f4289fcd04d830febac4120c4849be7787e8539ec5f1a38d101dbe5434 sha256:4d45a5a7a6cef67ee1ffd779074a715a621782762d0b858f24fac616582e603d 3.1.6.5079-ls50
verify jellyfin/jellyfin@sha256:0b901391a662862eddb5dc55d244d7883cbb6236ef5b9a6ea82abc78a89819f0 sha256:0b901391a662862eddb5dc55d244d7883cbb6236ef5b9a6ea82abc78a89819f0 sha256:0b901391a662862eddb5dc55d244d7883cbb6236ef5b9a6ea82abc78a89819f0 sha256:d57d4a0c18b3e51b913bd2f8f0f122eb7c7150ea37bb0e352df9cb329de11d24 ""
printf 'pinned top-level/platform/config identities and available build version verified\n'
