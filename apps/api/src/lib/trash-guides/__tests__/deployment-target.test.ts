import { describe, expect, it } from "vitest";
import { ConflictError } from "../../errors.js";
import {
	assertDeploymentTargetOwnership,
	createDeploymentEndpointKey,
	createDeploymentStateToken,
	createQualityProfileStateToken,
	getEquivalentServiceInstanceIds,
	resolveDeploymentTarget,
} from "../deployment-target.js";

const profiles = [
	{ id: 1, name: "Any", formatItems: [{ format: 42, score: -10_000 }] },
	{ id: 2, name: "Unrelated", formatItems: [] },
];

describe("resolveDeploymentTarget", () => {
	it("uses a stored mapping as the authoritative identity", () => {
		const result = resolveDeploymentTarget({
			profiles,
			mapping: { qualityProfileId: 2, qualityProfileName: "Old name" },
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
			mapping: { qualityProfileId: 99, qualityProfileName: "Unrelated" },
			sourceProfileName: "Any",
			templateName: "Renamed template",
		});

		expect(result.profile?.id).toBe(2);
		expect(result.matchedBy).toBe("mapping_name");
	});

	it("fails closed when neither a stale mapping ID nor its recorded name exists", () => {
		expect(() =>
			resolveDeploymentTarget({
				profiles,
				mapping: { qualityProfileId: 99, qualityProfileName: "Deleted profile" },
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
					{ templateId: "template-1", qualityProfileId: 1, qualityProfileName: "Any" },
					{ templateId: "template-2", qualityProfileId: 99, qualityProfileName: "Any" },
				],
			}),
		).toThrow(ConflictError);
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
});

describe("getEquivalentServiceInstanceIds", () => {
	it("groups duplicate local records for the same normalized ARR endpoint", () => {
		const target = { id: "radarr-1", service: "RADARR", baseUrl: "HTTP://RADARR:80/" };

		expect(
			getEquivalentServiceInstanceIds(
				[
					target,
					{ id: "radarr-2", service: "radarr", baseUrl: "http://radarr" },
					{ id: "sonarr-1", service: "SONARR", baseUrl: "http://radarr" },
					{ id: "radarr-other", service: "RADARR", baseUrl: "http://other" },
				],
				target,
			),
		).toEqual(["radarr-1", "radarr-2"]);
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
