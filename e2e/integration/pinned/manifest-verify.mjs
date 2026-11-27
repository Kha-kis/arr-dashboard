import assert from "node:assert/strict";

const digestPattern = /^sha256:[a-f0-9]{64}$/;

/** Resolve and validate the descriptor selected from a pinned index or manifest. */
export function selectPlatformManifestDigest(indexRaw, expected, platform = "linux/amd64") {
	assert.ok(digestPattern.test(expected.manifestDigest), "invalid top-level digest");
	assert.ok(digestPattern.test(expected.selectedPlatformManifestDigest), "invalid selected digest");
	const index = JSON.parse(indexRaw);
	let selected;
	if (Array.isArray(index.manifests)) {
		const matches = index.manifests.filter(
			(entry) => `${entry.platform?.os}/${entry.platform?.architecture}` === platform,
		);
		assert.equal(matches.length, 1, "expected exactly one descriptor for target platform");
		selected = matches[0];
		assert.equal(selected.digest, expected.selectedPlatformManifestDigest, "platform manifest digest mismatch");
	} else {
		assert.equal(expected.manifestDigest, expected.selectedPlatformManifestDigest, "single manifest must be its selected platform manifest");
		selected = { digest: expected.selectedPlatformManifestDigest };
	}
	assert.equal(expected.manifestDigest, expected.referenceDigest, "top-level reference digest mismatch");
	return selected.digest;
}

/** Validate a registry manifest against its declared top-level, platform, and config identities. */
export function verifyRegistryIdentity({ indexRaw, childRaw, expected, platform = "linux/amd64" }) {
	assert.ok(digestPattern.test(expected.manifestDigest), "invalid top-level digest");
	assert.ok(digestPattern.test(expected.selectedPlatformManifestDigest), "invalid selected digest");
	assert.ok(digestPattern.test(expected.configDigest), "invalid config digest");
	const selectedDigest = selectPlatformManifestDigest(indexRaw, expected, platform);
	const child = JSON.parse(childRaw ?? indexRaw);
	assert.equal(child.config?.digest, expected.configDigest, "manifest config digest mismatch");
	return selectedDigest;
}

