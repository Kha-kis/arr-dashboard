import { describe, expect, it } from "vitest";
import {
	createArrServiceFingerprint,
	createSanitizedProviderEvidence,
	parseExecutableSafetyPlan,
	serializeExecutableSafetyPlan,
} from "../shared-plex-safety.js";

describe("cleanup provider-evidence snapshots", () => {
	const providerEvidence = () =>
		createSanitizedProviderEvidence(
			["plex"],
			[
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
					statusFingerprint: "c".repeat(64),
					rowFingerprint: "d".repeat(64),
				},
			],
		);

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

		const snapshot = JSON.parse(serializeExecutableSafetyPlan(plan, providerEvidence())) as Record<
			string,
			unknown
		>;

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

	it.each([
		[
			"evidence fingerprint",
			(evidence: Record<string, unknown>) => (evidence.fingerprint = "c".repeat(64)),
		],
		[
			"source count",
			(evidence: Record<string, unknown>) => {
				(evidence.sources as Array<Record<string, unknown>>)[0]!.itemCount = 2;
			},
		],
	])("rejects a tampered %s", (_label, tamper) => {
		const plan = {
			kind: "verified_arr_target" as const,
			target: {
				serviceFingerprint: "a".repeat(64),
				externalId: 42,
				mediaPath: { value: "/movies/Example", windows: false },
			},
		};
		const serialized = serializeExecutableSafetyPlan(plan, providerEvidence());
		const snapshot = JSON.parse(serialized) as Record<string, unknown>;
		tamper(snapshot.providerEvidence as Record<string, unknown>);

		expect(parseExecutableSafetyPlan(JSON.stringify(snapshot))).toBeNull();
	});

	it("rejects an envelope with dropped provider evidence", () => {
		const serialized = serializeExecutableSafetyPlan(
			{
				kind: "verified_arr_target",
				target: {
					serviceFingerprint: "a".repeat(64),
					externalId: 42,
					mediaPath: { value: "/movies/Example", windows: false },
				},
			},
			providerEvidence(),
		);
		const snapshot = JSON.parse(serialized) as Record<string, unknown>;
		delete snapshot.providerEvidence;

		expect(parseExecutableSafetyPlan(JSON.stringify(snapshot))).toBeNull();
	});
});
