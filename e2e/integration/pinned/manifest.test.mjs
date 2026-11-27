import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { selectPlatformManifestDigest, verifyRegistryIdentity } from "./manifest-verify.mjs";
const manifest = JSON.parse(readFileSync(new URL("./images.json", import.meta.url)));
test("providers are immutable and AMD64 identities are recorded", () => {
  assert.equal(manifest.platform, "linux/amd64");
  for (const image of Object.values(manifest.images)) {
    assert.match(image.reference, /@sha256:[a-f0-9]{64}$/);
    for (const key of ["manifestDigest", "selectedPlatformManifestDigest", "configDigest"])
      assert.match(image[key], /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(manifest.images.lidarr.upstreamVersion, "3.1.6.5079");
  assert.equal(manifest.images.lidarr.manifestDigest, "sha256:c4285344c994b34e1ae7db8d57c1702dcfe88b8e10c98a0cdf0f74aba8b58b9c");
  assert.equal(manifest.images.lidarr.selectedPlatformManifestDigest, "sha256:019985f4289fcd04d830febac4120c4849be7787e8539ec5f1a38d101dbe5434");
  assert.equal(manifest.images.lidarr.configDigest, "sha256:4d45a5a7a6cef67ee1ffd779074a715a621782762d0b858f24fac616582e603d");
  assert.equal(manifest.images.jellyfin.version, "10.11.11");
  assert.match(manifest.scenario.meaning, /not dashboard compatibility|only; dashboard compatibility/i);
});
test("scenario requires real provider assertions", () => {
  assert.deepEqual(manifest.scenario.assertions, ["health-endpoint-200", "public-system-info-version-10.11.11"]);
});

const fakeDigest = (char) => `sha256:${char.repeat(64)}`;
test("AMD64 manifest selection rejects ambiguity and declaration drift", () => {
  const expected = {
    manifestDigest: fakeDigest("a"),
    referenceDigest: fakeDigest("a"),
    selectedPlatformManifestDigest: fakeDigest("b"),
    configDigest: fakeDigest("c"),
  };
  const descriptor = { digest: fakeDigest("b"), platform: { os: "linux", architecture: "amd64" } };
  const indexRaw = JSON.stringify({ manifests: [descriptor, { digest: fakeDigest("d"), platform: { os: "linux", architecture: "arm64" } }] });
  assert.equal(selectPlatformManifestDigest(indexRaw, expected), expected.selectedPlatformManifestDigest);
  assert.throws(() => selectPlatformManifestDigest(JSON.stringify({ manifests: [descriptor, descriptor] }), expected), /exactly one/);
  assert.throws(() => selectPlatformManifestDigest(indexRaw, { ...expected, selectedPlatformManifestDigest: fakeDigest("e") }), /manifest digest mismatch/);
  assert.throws(() => verifyRegistryIdentity({ indexRaw, childRaw: JSON.stringify({ config: { digest: fakeDigest("f") } }), expected }), /config digest mismatch/);
});
