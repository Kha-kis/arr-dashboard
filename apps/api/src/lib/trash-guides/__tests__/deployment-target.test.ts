import { describe, expect, it } from "vitest";
import { ConflictError } from "../../errors.js";
import {
	assertDeploymentTargetOwnership,
	assertNoLegacyDeploymentConnectionMappings,
	createDeploymentConnectionBinding,
	createDeploymentConnectionBindingCandidates,
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
	createDeploymentStateToken,
	createLegacyDeploymentConnectionBindings,
	createQualityProfileStateToken,
	getEquivalentServiceInstanceIds,
	resolveDeploymentTarget,
	type DeploymentProfileMapping,
} from "../deployment-target.js";

const profiles = [
	{ id: 1, name: "Any", formatItems: [{ format: 42, score: -10_000 }] },
	{ id: 2, name: "Unrelated", formatItems: [] },
];

describe("resolveDeploymentTarget", () => {
	it("uses a stored mapping as the authoritative identity", () => {
		const result = resolveDeploymentTarget({
			profiles,
			mapping: {
				qualityProfileId: 2,
				qualityProfileName: "Unrelated",
				connectionGeneration: 3,
				connectionStateToken: "bound-connection",
			},
			sourceProfileName: "Any",
			templateName: "Renamed template",
		});

		expect(result.profile?.id).toBe(2);
		expect(result.matchedBy).toBe("mapping_id");
	});

	it("targets the cloned source profile when the template was renamed", () => {
		const result = resolveDeploymentTarget({
			profiles,
			sourceProfileName: "Any",
			templateName: "Radarr - Any",
		});

		expect(result.profile?.id).toBe(1);
		expect(result.profileName).toBe("Any");
		expect(result.matchedBy).toBe("source_name");
	});

	it("recovers a stale mapping only by its last known name", () => {
		const result = resolveDeploymentTarget({
			profiles,
			mapping: {
				qualityProfileId: 99,
				qualityProfileName: "Unrelated",
				connectionGeneration: 0,
				connectionStateToken: null,
			},
			sourceProfileName: "Any",
			templateName: "Renamed template",
		});

		expect(result.profile?.id).toBe(2);
		expect(result.matchedBy).toBe("mapping_name");
	});

	it("fails closed when a bound mapping ID is reused by a differently named profile", () => {
		expect(() =>
			resolveDeploymentTarget({
				profiles,
				mapping: {
					qualityProfileId: 2,
					qualityProfileName: "Any",
					connectionGeneration: 3,
					connectionStateToken: "bound-connection",
				},
			}),
		).toThrow("identity no longer matches");
	});

	it("fails closed when a bound mapping ID was deleted and its name was recreated", () => {
		expect(() =>
			resolveDeploymentTarget({
				profiles: [{ id: 99, name: "Any", formatItems: [] }],
				mapping: {
					qualityProfileId: 1,
					qualityProfileName: "Any",
					connectionGeneration: 3,
					connectionStateToken: "bound-connection",
				},
			}),
		).toThrow(ConflictError);
	});

	it("fails closed when neither a stale mapping ID nor its recorded name exists", () => {
		expect(() =>
			resolveDeploymentTarget({
				profiles,
				mapping: {
					qualityProfileId: 99,
					qualityProfileName: "Deleted profile",
					connectionGeneration: 0,
					connectionStateToken: null,
				},
				sourceProfileName: "Any",
				templateName: "Radarr - Any",
			}),
		).toThrow(ConflictError);
	});

	it("uses the authoritative profile ID when deploying back to the source instance", () => {
		const result = resolveDeploymentTarget({
			profiles,
			sourceProfileId: 1,
			isSourceInstance: true,
			sourceProfileName: "Any",
			templateName: "Radarr - Any",
		});

		expect(result.profile?.id).toBe(1);
		expect(result.matchedBy).toBe("source_id");
	});

	it("fails closed when a name fallback is ambiguous", () => {
		expect(() =>
			resolveDeploymentTarget({
				profiles: [...profiles, { id: 3, name: "Any", formatItems: [] }],
				sourceProfileName: "Any",
				templateName: "Radarr - Any",
			}),
		).toThrow(ConflictError);
	});

	it("rejects taking ownership of a profile managed by another template", () => {
		const target = resolveDeploymentTarget({ profiles, sourceProfileName: "Any" });

		expect(() =>
			assertDeploymentTargetOwnership({
				target,
				templateId: "template-1",
				existingMappings: [
					{
						templateId: "template-2",
						qualityProfileId: 1,
						qualityProfileName: "Any",
						connectionGeneration: 0,
						connectionStateToken: null,
					},
				],
			}),
		).toThrow(ConflictError);
	});

	it("treats another template's stale same-name mapping as ownership", () => {
		const target = resolveDeploymentTarget({
			profiles: [{ id: 9, name: "Any", formatItems: [] }],
			sourceProfileName: "Any",
		});

		expect(() =>
			assertDeploymentTargetOwnership({
				target,
				templateId: "template-2",
				existingMappings: [
					{
						templateId: "template-1",
						qualityProfileId: 1,
						qualityProfileName: "Any",
						connectionGeneration: 0,
						connectionStateToken: null,
					},
				],
			}),
		).toThrow(ConflictError);
	});

	it("rejects another owner even when the requesting template mapping is listed first", () => {
		const target = resolveDeploymentTarget({ profiles, sourceProfileName: "Any" });

		expect(() =>
			assertDeploymentTargetOwnership({
				target,
				templateId: "template-1",
				existingMappings: [
					{
						templateId: "template-1",
						qualityProfileId: 1,
						qualityProfileName: "Any",
						connectionGeneration: 0,
						connectionStateToken: null,
					},
					{
						templateId: "template-2",
						qualityProfileId: 99,
						qualityProfileName: "Any",
						connectionGeneration: 0,
						connectionStateToken: null,
					},
				],
			}),
		).toThrow(ConflictError);
	});

	it("rejects creation under a profile name claimed by another template", () => {
		expect(() =>
			assertDeploymentTargetOwnership({
				target: { profile: undefined, profileName: "Any", matchedBy: "new" },
				templateId: "template-1",
				existingMappings: [
					{
						templateId: "template-2",
						qualityProfileId: 99,
						qualityProfileName: "Any",
						connectionGeneration: 0,
						connectionStateToken: null,
					},
				],
			}),
		).toThrow(ConflictError);
	});
});

describe("legacy deployment connection mappings", () => {
	it("rejects a legacy mapping when its numeric ID was reused by a differently named profile", () => {
		expect(() =>
			resolveDeploymentTarget({
				profiles,
				mapping: {
					qualityProfileId: 2,
					qualityProfileName: "Any",
					connectionGeneration: 0,
					connectionStateToken: null,
				},
			}),
		).toThrow("identity no longer matches");
	});

	it("queries legacy generation-zero mappings only as a conflict signal", () => {
		expect(createLegacyDeploymentConnectionBindings(["instance-1", "instance-alias"])).toEqual([
			{ instanceId: "instance-1", connectionGeneration: 0, connectionStateToken: null },
			{ instanceId: "instance-alias", connectionGeneration: 0, connectionStateToken: null },
		]);
	});

	it("fails closed instead of treating an unbound legacy mapping as ownership", () => {
		expect(() =>
			assertNoLegacyDeploymentConnectionMappings([
				{ connectionGeneration: 0, connectionStateToken: null },
			]),
		).toThrow("predates connection identity verification");
	});

	it("fails closed when persisted connection fields are omitted", () => {
		const mapping = {
			qualityProfileId: 1,
			qualityProfileName: "Any",
		} as unknown as DeploymentProfileMapping;

		expect(() => assertNoLegacyDeploymentConnectionMappings([mapping])).toThrow(
			"predates connection identity verification",
		);
	});

	it.each([
		{ connectionGeneration: 4, connectionStateToken: null },
		{ connectionGeneration: 4, connectionStateToken: "" },
		{ connectionGeneration: 4, connectionStateToken: "   " },
		{ connectionGeneration: -1, connectionStateToken: "bound-token" },
		{ connectionGeneration: 1.5, connectionStateToken: "bound-token" },
	])("fails closed for malformed persisted connection identity %#", (mapping) => {
		expect(() => assertNoLegacyDeploymentConnectionMappings([mapping])).toThrow(
			"predates connection identity verification",
		);
	});

	it("accepts a generation-zero mapping with an exact connection token", () => {
		expect(() =>
			assertNoLegacyDeploymentConnectionMappings([
				{ connectionGeneration: 0, connectionStateToken: "exact-token" },
			]),
		).not.toThrow();
	});

	it("accepts mappings bound to an exact connection state", () => {
		expect(() =>
			assertNoLegacyDeploymentConnectionMappings([
				{ connectionGeneration: 1, connectionStateToken: "exact-token" },
			]),
		).not.toThrow();
	});
});

describe("createDeploymentStateToken", () => {
	const template = {
		id: "template-1",
		name: "Radarr - Any",
		configData: '{"customFormats":[]}',
		sourceQualityProfileName: "Any",
	};
	const connection = {
		service: "RADARR",
		baseUrl: "http://radarr",
		credentialIdentity: "encrypted:iv",
	};

	it("is stable when object key order differs", () => {
		const target = resolveDeploymentTarget({ profiles, sourceProfileName: "Any" });
		const first = createDeploymentStateToken({
			template,
			instanceId: "instance-1",
			connection,
			target,
			customFormats: [{ id: 42, name: "CF" }],
		});
		const second = createDeploymentStateToken({
			template,
			instanceId: "instance-1",
			connection,
			target,
			customFormats: [{ name: "CF", id: 42 }],
		});

		expect(first).toBe(second);
	});

	it("changes when the reviewed upstream score changes", () => {
		const originalTarget = resolveDeploymentTarget({ profiles, sourceProfileName: "Any" });
		const changedTarget = resolveDeploymentTarget({
			profiles: [{ id: 1, name: "Any", formatItems: [{ format: 42, score: 0 }] }, profiles[1]!],
			sourceProfileName: "Any",
		});

		expect(
			createDeploymentStateToken({
				template,
				instanceId: "instance-1",
				connection,
				target: originalTarget,
				customFormats: [],
			}),
		).not.toBe(
			createDeploymentStateToken({
				template,
				instanceId: "instance-1",
				connection,
				target: changedTarget,
				customFormats: [],
			}),
		);
	});

	it("changes when the reviewed service connection changes", () => {
		const target = resolveDeploymentTarget({ profiles, sourceProfileName: "Any" });
		const original = createDeploymentStateToken({
			template,
			instanceId: "instance-1",
			connection,
			target,
			customFormats: [],
		});
		const changed = createDeploymentStateToken({
			template,
			instanceId: "instance-1",
			connection: { ...connection, baseUrl: "http://different-radarr" },
			target,
			customFormats: [],
		});

		expect(changed).not.toBe(original);
	});

	it("normalizes equivalent connection URLs", () => {
		const target = resolveDeploymentTarget({ profiles, sourceProfileName: "Any" });
		const first = createDeploymentStateToken({
			template,
			instanceId: "instance-1",
			connection: { ...connection, baseUrl: "HTTP://RADARR:80/" },
			target,
			customFormats: [],
		});
		const second = createDeploymentStateToken({
			template,
			instanceId: "instance-1",
			connection: { ...connection, baseUrl: "http://radarr/" },
			target,
			customFormats: [],
		});

		expect(first).toBe(second);
	});

	it("changes when the resolved naming payload changes", () => {
		const target = resolveDeploymentTarget({ profiles, sourceProfileName: "Any" });
		const original = createDeploymentStateToken({
			template,
			instanceId: "instance-1",
			connection,
			target,
			customFormats: [],
			namingConfig: { id: 1, standardMovieFormat: "Current" },
			namingPayload: { id: 1, standardMovieFormat: "First payload" },
		});
		const changed = createDeploymentStateToken({
			template,
			instanceId: "instance-1",
			connection,
			target,
			customFormats: [],
			namingConfig: { id: 1, standardMovieFormat: "Current" },
			namingPayload: { id: 1, standardMovieFormat: "Changed payload" },
		});

		expect(changed).not.toBe(original);
	});

	it("changes when saved instance score overrides change", () => {
		const target = resolveDeploymentTarget({ profiles, sourceProfileName: "Any" });
		const original = createDeploymentStateToken({
			template,
			instanceId: "instance-1",
			connection,
			target,
			customFormats: [],
			savedScoreOverrides: [[42, -10_000]],
		});
		const changed = createDeploymentStateToken({
			template,
			instanceId: "instance-1",
			connection,
			target,
			customFormats: [],
			savedScoreOverrides: [[42, 0]],
		});

		expect(changed).not.toBe(original);
	});
});

describe("getEquivalentServiceInstanceIds", () => {
	it("groups duplicate local records for the same normalized ARR endpoint across credentials", () => {
		const target = {
			id: "radarr-1",
			service: "RADARR",
			baseUrl: "HTTP://RADARR:80/",
			credentialIdentity: "same-credentials",
		};

		expect(
			getEquivalentServiceInstanceIds(
				[
					target,
					{
						id: "radarr-2",
						service: "radarr",
						baseUrl: "http://radarr",
						credentialIdentity: "same-credentials",
					},
					{
						id: "radarr-other-credentials",
						service: "radarr",
						baseUrl: "http://radarr",
						credentialIdentity: "other-credentials",
					},
					{ id: "sonarr-1", service: "SONARR", baseUrl: "http://radarr" },
					{ id: "radarr-other", service: "RADARR", baseUrl: "http://other" },
				],
				target,
			),
		).toEqual(["radarr-1", "radarr-2", "radarr-other-credentials"]);
	});

	it("uses the same lock identity for normalized duplicate records", () => {
		expect(
			createDeploymentEndpointKey("user-1", {
				service: "RADARR",
				baseUrl: "HTTP://RADARR:80/",
			}),
		).toBe(
			createDeploymentEndpointKey("user-1", {
				service: "radarr",
				baseUrl: "http://radarr",
			}),
		);
	});

	it("binds rollback identity to normalized endpoint and credentials", () => {
		const connection = {
			service: "RADARR",
			baseUrl: "HTTP://RADARR:80/",
			encryptedApiKey: "encrypted-key",
			encryptionIv: "iv",
		};
		expect(createDeploymentConnectionStateToken(connection)).toBe(
			createDeploymentConnectionStateToken({
				...connection,
				service: "radarr",
				baseUrl: "http://radarr",
			}),
		);
		expect(createDeploymentConnectionStateToken(connection)).not.toBe(
			createDeploymentConnectionStateToken({
				...connection,
				encryptedApiKey: "rotated-key",
			}),
		);
	});

	it("requires an exact token even on a generation-zero connection", () => {
		const connection = {
			id: "radarr-1",
			service: "RADARR",
			baseUrl: "http://radarr",
			encryptedApiKey: "encrypted-key",
			encryptionIv: "iv",
			connectionGeneration: 0,
		};

		expect(createDeploymentConnectionBindingCandidates(connection)).toEqual([
			createDeploymentConnectionBinding(connection),
		]);
	});

	it("does not target a reused numeric ID from an unbound mapping after an upgraded endpoint was repointed", () => {
		const connection = {
			id: "radarr-1",
			service: "RADARR",
			baseUrl: "http://replacement-radarr",
			encryptedApiKey: "replacement-key",
			encryptionIv: "replacement-iv",
			connectionGeneration: 0,
		};
		const legacyMapping = {
			templateId: "template-1",
			instanceId: "radarr-1",
			connectionGeneration: 0,
			connectionStateToken: null,
			qualityProfileId: 2,
			qualityProfileName: "Old endpoint profile",
		};
		const eligibleMapping = createDeploymentConnectionBindingCandidates(connection).some(
			(binding) =>
				binding.instanceId === legacyMapping.instanceId &&
				binding.connectionGeneration === legacyMapping.connectionGeneration &&
				binding.connectionStateToken === legacyMapping.connectionStateToken,
		)
			? legacyMapping
			: undefined;

		const result = resolveDeploymentTarget({
			profiles: [
				{ id: 2, name: "Unrelated replacement profile" },
				{ id: 3, name: "Intended profile" },
			],
			mapping: eligibleMapping,
			sourceProfileName: "Intended profile",
		});

		expect(result.profile?.id).toBe(3);
		expect(result.matchedBy).toBe("source_name");
	});

	it("does not recognize a legacy binding after the connection generation changes", () => {
		const connection = {
			id: "radarr-1",
			service: "RADARR",
			baseUrl: "http://radarr",
			encryptedApiKey: "encrypted-key",
			encryptionIv: "iv",
			connectionGeneration: 1,
		};

		expect(createDeploymentConnectionBindingCandidates(connection)).toEqual([
			createDeploymentConnectionBinding(connection),
		]);
	});
});

describe("createQualityProfileStateToken", () => {
	it("detects score and quality-setting drift before a full-profile PUT", () => {
		const original = createQualityProfileStateToken({
			id: 1,
			name: "Any",
			cutoff: 1,
			formatItems: [{ format: 42, score: -10_000 }],
		});
		const changedScore = createQualityProfileStateToken({
			id: 1,
			name: "Any",
			cutoff: 1,
			formatItems: [{ format: 42, score: 0 }],
		});
		const changedCutoff = createQualityProfileStateToken({
			id: 1,
			name: "Any",
			cutoff: 2,
			formatItems: [{ format: 42, score: -10_000 }],
		});

		expect(changedScore).not.toBe(original);
		expect(changedCutoff).not.toBe(original);
	});
});
