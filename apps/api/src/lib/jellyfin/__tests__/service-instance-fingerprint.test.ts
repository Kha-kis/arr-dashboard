import { describe, expect, it } from "vitest";
import { jellyfinConnectionFingerprint } from "../service-instance-fingerprint.js";

const connection = {
	service: "JELLYFIN",
	baseUrl: "https://jellyfin.example.com",
	encryptedApiKey: "encrypted-key",
	encryptionIv: "key-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	connectionGeneration: 7,
} as const;

describe("jellyfinConnectionFingerprint", () => {
	it("is stable for an unchanged connection", () => {
		expect(jellyfinConnectionFingerprint(connection as never)).toBe(
			jellyfinConnectionFingerprint({ ...connection } as never),
		);
	});

	it.each([
		["service", "EMBY"],
		["baseUrl", "https://emby.example.com"],
		["encryptedApiKey", "different-key"],
		["encryptionIv", "different-iv"],
		["encryptedHttpAuthCredentials", "proxy-auth"],
		["httpAuthEncryptionIv", "proxy-iv"],
		["connectionGeneration", 8],
	] as const)("changes when %s changes", (field, value) => {
		expect(jellyfinConnectionFingerprint({ ...connection, [field]: value } as never)).not.toBe(
			jellyfinConnectionFingerprint(connection as never),
		);
	});
});
