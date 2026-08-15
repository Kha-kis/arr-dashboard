import { describe, expect, it } from "vitest";
import {
	createArrServiceFingerprint,
	serializeExecutableSafetyPlan,
} from "../shared-plex-safety.js";

describe("cleanup provider-evidence snapshots", () => {
	it("versions and sanitizes provider authority without persisting raw identity material", () => {
		const plan = {
			kind: "verified_arr_target" as const,
			target: {
				serviceFingerprint: createArrServiceFingerprint({
					id: "radarr-1",
					service: "RADARR",
					baseUrl: "http://radarr.internal:7878",
					encryptedApiKey: "encrypted-radarr-key",
					encryptionIv: "radarr-iv",
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
				} as never),
				externalId: 42,
				mediaPath: { value: "/movies/Example", windows: false },
			},
		};

		const snapshot = JSON.parse(
			serializeExecutableSafetyPlan(plan, {
				version: 1,
				fingerprint: "a".repeat(64),
				sources: [
					{
						service: "PLEX",
						identityKind: "PLEX_MACHINE_IDENTIFIER",
						identityFingerprint: "b".repeat(64),
						connectionGeneration: 3,
						identityGeneration: 7,
						cacheType: "plex",
						completedAt: "2026-08-15T04:00:00.000Z",
						itemCount: 1,
						verifiedAt: "2026-08-15T03:00:00.000Z",
					},
				],
			}),
		) as Record<string, unknown>;

		expect(snapshot).toMatchObject({
			version: 2,
			providerEvidence: {
				version: 1,
				fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
				sources: [
					{
						service: "PLEX",
						identityFingerprint: "b".repeat(64),
						connectionGeneration: 3,
						identityGeneration: 7,
					},
				],
			},
		});
		expect(JSON.stringify(snapshot)).not.toContain("encrypted-radarr-key");
		expect(JSON.stringify(snapshot)).not.toContain("radarr.internal");
	});
});
