import type { BackupData } from "@arr/shared";
import { describe, expect, it } from "vitest";
import { ArrClientFactory } from "../../arr/client-factory.js";
import { Encryptor } from "../../auth/encryption.js";
import type { ServiceInstance } from "../../prisma.js";
import { importConnectionFingerprint } from "../../queue-cleaner/import-receipt.js";
import {
	createDeploymentConnectionBinding,
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
	isCurrentDeploymentConnectionMapping,
	isDeploymentBackupEndpointIdentityCurrent,
	isVerifiedClonedProfileSourceConnection,
} from "../../trash-guides/deployment-target.js";
import { translateRestoreBindings } from "../backup-restore-bindings.js";
type Row = Record<string, unknown>;
const source = new Encryptor("11".repeat(32)),
	destination = new Encryptor("22".repeat(32));
function fixture() {
	const encrypted = source.encrypt("synthetic-key");
	const instance = {
		id: "arr",
		userId: "owner",
		service: "RADARR",
		name: "same-title",
		baseUrl: "http://synthetic.invalid",
		encryptedApiKey: encrypted.value,
		encryptionIv: encrypted.iv,
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
	};
	const fingerprint = importConnectionFingerprint(instance as unknown as ServiceInstance);
	const original: BackupData["data"] = {
		users: [{ id: "owner" }],
		sessions: [],
		serviceInstances: [instance],
		serviceTags: [],
		serviceInstanceTags: [],
		oidcAccounts: [],
		webAuthnCredentials: [],
		arrImportOperations: [
			{
				id: "operation",
				userId: "owner",
				instanceId: "arr",
				originalInstanceId: "arr",
				service: "RADARR",
				connectionFingerprint: fingerprint,
			},
		],
		queueCleanerImportReceipts: [
			{ id: "receipt", instanceId: "arr", connectionFingerprint: fingerprint },
		],
	};
	const translated = structuredClone(original);
	const fresh = destination.encrypt("synthetic-key");
	Object.assign(translated.serviceInstances[0] as Row, {
		encryptedApiKey: fresh.value,
		encryptionIv: fresh.iv,
	});
	return { original, translated, fingerprint };
}
describe("exact representation-only connection translation", () => {
	for (const field of ["baseUrl", "userId", "service", "encryptedApiKey"] as const)
		it(`rejects changed original incoming connection ${field}`, () => {
			const { original, translated } = fixture();
			(original.serviceInstances[0] as Row)[field] = "different";
			expect(() => translateRestoreBindings(original, translated, source, destination)).toThrow(
				"invalid-binding",
			);
		});
	it("rejects missing connection instead of matching by name", () => {
		const { original, translated } = fixture();
		original.serviceInstances = [];
		expect(() => translateRestoreBindings(original, translated, source, destination)).toThrow(
			"invalid-binding",
		);
	});
	it("rejects cross-owner operation binding", () => {
		const { original, translated } = fixture();
		(original.arrImportOperations![0] as Row).userId = "other-owner";
		expect(() => translateRestoreBindings(original, translated, source, destination)).toThrow(
			"invalid-binding",
		);
	});
	it("maps proven original binding and preserves unrelated operation state", () => {
		const { original, translated, fingerprint } = fixture();
		Object.assign(original.arrImportOperations![0] as Row, { state: "unknown", commandId: 42 });
		Object.assign(translated.arrImportOperations![0] as Row, { state: "unknown", commandId: 42 });
		const bindings = translateRestoreBindings(original, translated, source, destination);
		const expected = importConnectionFingerprint(translated.serviceInstances[0] as ServiceInstance);
		expect(bindings).toEqual([
			{
				serviceInstanceId: "arr",
				originalFingerprint: fingerprint,
				translatedFingerprint: expected,
			},
		]);
		expect(translated.arrImportOperations![0]).toMatchObject({
			connectionFingerprint: expected,
			state: "unknown",
			commandId: 42,
		});
		expect(translated.queueCleanerImportReceipts![0]).toMatchObject({
			connectionFingerprint: expected,
		});
		expect(original.arrImportOperations![0]).toMatchObject({ connectionFingerprint: fingerprint });
	});
	for (const [field, value] of [
		["baseUrl", "http://changed.invalid"],
		["userId", "other-owner"],
		["service", "SONARR"],
		["id", "other-instance"],
	])
		it(`rejects translated identity drift ${field}`, () => {
			const { original, translated } = fixture();
			(translated.serviceInstances[0] as Row)[field!] = value;
			expect(() => translateRestoreBindings(original, translated, source, destination)).toThrow(
				"invalid-binding",
			);
		});
	it("rejects changed destination credential", () => {
		const { original, translated } = fixture();
		const changed = destination.encrypt("other-key");
		Object.assign(translated.serviceInstances[0] as Row, {
			encryptedApiKey: changed.value,
			encryptionIv: changed.iv,
		});
		expect(() => translateRestoreBindings(original, translated, source, destination)).toThrow(
			"invalid-binding",
		);
	});
	it("rejects historical fingerprint mismatch even with a same-title connection", () => {
		const { original, translated } = fixture();
		const collision = structuredClone(original.serviceInstances[0]) as Row;
		collision.id = "other";
		original.serviceInstances.push(collision);
		translated.serviceInstances.push(structuredClone(collision));
		(original.arrImportOperations![0] as Row).connectionFingerprint = importConnectionFingerprint(
			collision as unknown as ServiceInstance,
		);
		expect(() => translateRestoreBindings(original, translated, source, destination)).toThrow(
			"invalid-binding",
		);
	});
	it("keeps validated detached terminal evidence historical", () => {
		const { original, translated, fingerprint } = fixture();
		const detached = {
			id: "operation",
			userId: "owner",
			instanceId: null,
			originalInstanceId: "deleted",
			service: "RADARR",
			connectionFingerprint: fingerprint,
			commandTerminal: true,
			commandId: 42,
			commandState: "completed",
			state: "completed",
			selectedFileCount: 1,
			verifiedFileCount: 1,
			submissionStartedAt: "2026-10-07T00:00:00Z",
			lastCheckedAt: "2026-10-07T00:00:00Z",
			updatedAt: "2026-10-07T00:00:00Z",
			reconcileToken: null,
			reconcileExpiresAt: null,
			origin: "manual",
			mode: "Copy",
			idempotencyKey: "historical",
			requestFingerprint: `v1:${"a".repeat(64)}`,
			commandFingerprint: `v1:${"b".repeat(64)}`,
			encryptedSources: "synthetic-ciphertext",
			sourcesEncryptionIv: "synthetic-iv",
			legacyReceiptId: null,
			reason: null,
			preparationExpiresAt: "2026-10-07T00:00:00Z",
			nextCheckAt: null,
			reconcileCursor: null,
			revision: 1,
			createdAt: "2026-10-07T00:00:00Z",
		};
		original.arrImportOperations = [detached];
		translated.arrImportOperations = [structuredClone(detached)];
		original.queueCleanerImportReceipts = [];
		translated.queueCleanerImportReceipts = [];
		translateRestoreBindings(original, translated, source, destination);
		expect(translated.arrImportOperations).toEqual([detached]);
		expect((translated.arrImportOperations[0] as Row).instanceId).toBeNull();
	});
	it("rejects nonterminal detached evidence", () => {
		const { original, translated } = fixture();
		(original.arrImportOperations![0] as Row).instanceId = null;
		(translated.arrImportOperations![0] as Row).instanceId = null;
		expect(() => translateRestoreBindings(original, translated, source, destination)).toThrow(
			"invalid-binding",
		);
	});
});

function trashFixture(target = destination) {
	const { original } = fixture();
	original.arrImportOperations = [];
	original.queueCleanerImportReceipts = [];
	const instance = original.serviceInstances[0] as ServiceInstance;
	instance.connectionGeneration = 4;
	const token = createDeploymentConnectionStateToken(instance);
	original.trashTemplates = [
		{
			id: "template",
			userId: "owner",
			serviceType: "RADARR",
			name: "same-title",
			configData: JSON.stringify({
				custom: { retained: true },
				completeQualityProfile: {
					sourceInstanceId: "arr",
					sourceConnectionStateToken: token,
					id: 7,
					name: "same-title",
					unknownField: [1, 2],
				},
			}),
		},
	];
	original.templateQualityProfileMappings = [
		{
			id: "mapping",
			templateId: "template",
			instanceId: "arr",
			connectionGeneration: 4,
			connectionStateToken: token,
			qualityProfileId: 7,
			qualityProfileName: "same-title",
			managedCustomFormatsCaptured: true,
			managedCustomFormats: '[{"resourceId":8,"stateToken":"positive-proof"}]',
			syncStrategy: "manual",
		},
	];
	original.instanceQualityProfileOverrides = [
		{
			id: "override",
			userId: "owner",
			instanceId: "arr",
			connectionGeneration: 4,
			connectionStateToken: token,
			qualityProfileId: 7,
			customFormatId: 8,
			score: 50,
			status: "UNCERTAIN",
			intentOperation: "SET_SCORE",
			intendedScore: 60,
		},
	];
	original.trashBackups = [
		{
			id: "recovery",
			userId: "owner",
			instanceId: "arr",
			backupData: JSON.stringify({
				schemaVersion: 2,
				endpointKey: createDeploymentEndpointKey("owner", {
					...instance,
					credentialIdentity: new ArrClientFactory(source).createConnectionCredentialIdentity(
						instance,
					),
				}),
				connectionStateToken: token,
				customFormats: [{ id: 8, extra: "retained" }],
				customFormatDeployments: [
					{
						beforeFormat: {
							id: 8,
							name: "synthetic",
							includeCustomFormatWhenRenaming: false,
							specifications: [],
						},
						action: "updated",
						resourceId: 8,
						name: "synthetic",
						status: "applied",
						postStateToken: "positive-proof",
						unknownField: true,
					},
				],
				managedCustomFormats: [
					{
						trashId: "synthetic",
						name: "synthetic",
						resourceId: 8,
						stateToken: "managed-proof",
						profileId: 7,
						appliedScore: 50,
					},
				],
				managedCustomFormatsCaptured: true,
				qualityProfileDeployment: {
					beforeProfile: {
						id: 7,
						name: "same-title",
						upgradeAllowed: true,
						cutoff: 0,
						items: [],
						minFormatScore: 0,
						cutoffFormatScore: 0,
						minUpgradeFormatScore: 0,
						formatItems: [],
					},
					action: "updated",
					profileId: 7,
					status: "pending",
					postStateToken: null,
					intendedPostStateToken: "intended-proof",
				},
				namingDeployment: {
					beforeConfig: { renameMovies: true },
					status: "pending",
					postStateToken: null,
					intendedPostStateToken: "naming-proof",
				},
				unknownEvidence: { outcome: "unknown", positive: true },
			}),
		},
	];
	const translated = structuredClone(original);
	const encrypted = target.encrypt("synthetic-key");
	Object.assign(translated.serviceInstances[0] as Row, {
		encryptedApiKey: encrypted.value,
		encryptionIv: encrypted.iv,
	});
	return { original, translated, instance };
}

describe("portable TRaSH representation bindings", () => {
	for (const target of [source, destination]) {
		it(`keeps real consumers current with ${target === source ? "same" : "different"} keys and conserves all other evidence`, () => {
			const { original, translated } = trashFixture(target);
			const before = structuredClone(original);
			translateRestoreBindings(original, translated, source, target);
			const instance = translated.serviceInstances[0] as ServiceInstance;
			for (const field of [
				"templateQualityProfileMappings",
				"instanceQualityProfileOverrides",
			] as const) {
				const row = translated[field]![0] as Row;
				expect
					.soft(
						isCurrentDeploymentConnectionMapping(row as never, [
							createDeploymentConnectionBinding(instance),
						]),
					)
					.toBe(true);
				expect({ ...row, connectionStateToken: null }).toEqual({
					...(original[field]![0] as Row),
					connectionStateToken: null,
				});
			}
			const state = JSON.parse((translated.trashBackups![0] as Row).backupData as string);
			expect
				.soft(
					isDeploymentBackupEndpointIdentityCurrent({
						userId: "owner",
						backupEndpointKey: state.endpointKey,
						backupConnectionStateToken: state.connectionStateToken,
						instance,
						credentialIdentity: new ArrClientFactory(target).createConnectionCredentialIdentity(
							instance,
						),
					}),
				)
				.toBe(true);
			const previous = JSON.parse((original.trashBackups![0] as Row).backupData as string);
			expect({ ...state, endpointKey: null, connectionStateToken: null }).toEqual({
				...previous,
				endpointKey: null,
				connectionStateToken: null,
			});
			const config = JSON.parse((translated.trashTemplates![0] as Row).configData as string);
			expect(
				isVerifiedClonedProfileSourceConnection({
					...config.completeQualityProfile,
					sourceInstance: instance,
					equivalentInstanceIds: [instance.id],
				}),
			).toBe(true);
			const previousConfig = JSON.parse((original.trashTemplates![0] as Row).configData as string);
			expect({
				...config,
				completeQualityProfile: {
					...config.completeQualityProfile,
					sourceConnectionStateToken: null,
				},
			}).toEqual({
				...previousConfig,
				completeQualityProfile: {
					...previousConfig.completeQualityProfile,
					sourceConnectionStateToken: null,
				},
			});
			expect(original).toEqual(before);
		});
	}
	const cases: Array<[string, (data: BackupData["data"]) => void]> = [
		[
			"stale mapping token",
			(data) => {
				(data.templateQualityProfileMappings![0] as Row).connectionStateToken = "stale";
			},
		],
		[
			"malformed mapping token",
			(data) => {
				(data.templateQualityProfileMappings![0] as Row).connectionStateToken = "";
			},
		],
		[
			"mapping generation",
			(data) => {
				(data.templateQualityProfileMappings![0] as Row).connectionGeneration = 3;
			},
		],
		[
			"mapping parent owner",
			(data) => {
				(data.trashTemplates![0] as Row).userId = "other";
			},
		],
		[
			"mapping parent service",
			(data) => {
				(data.trashTemplates![0] as Row).serviceType = "SONARR";
			},
		],
		[
			"missing mapping parent service",
			(data) => {
				delete (data.trashTemplates![0] as Row).serviceType;
			},
		],
		[
			"missing clone source service",
			(data) => {
				data.templateQualityProfileMappings = [];
				delete (data.trashTemplates![0] as Row).serviceType;
			},
		],
		[
			"override owner",
			(data) => {
				(data.instanceQualityProfileOverrides![0] as Row).userId = "other";
			},
		],
		[
			"stale override token",
			(data) => {
				(data.instanceQualityProfileOverrides![0] as Row).connectionStateToken = "stale";
			},
		],
		[
			"missing owner parent",
			(data) => {
				data.users = [];
			},
		],
		[
			"backup owner",
			(data) => {
				(data.trashBackups![0] as Row).userId = "other";
			},
		],
		[
			"changed original generation",
			(data) => {
				(data.serviceInstances[0] as Row).connectionGeneration = 5;
			},
		],
		[
			"changed original credential",
			(data) => {
				const key = source.encrypt("changed");
				Object.assign(data.serviceInstances[0] as Row, {
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				});
			},
		],
		[
			"same-title cross-instance",
			(data) => {
				const key = source.encrypt("other-credential");
				const other = {
					...(data.serviceInstances[0] as Row),
					id: "other",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				};
				data.serviceInstances.push(other);
				(data.templateQualityProfileMappings![0] as Row).instanceId = "other";
			},
		],
	];
	for (const [name, mutate] of cases)
		it(`rejects ${name}`, () => {
			const { original, translated } = trashFixture();
			mutate(original);
			for (const field of [
				"users",
				"trashTemplates",
				"templateQualityProfileMappings",
				"instanceQualityProfileOverrides",
				"trashBackups",
			] as const)
				(translated as Row)[field] = structuredClone(original[field]);
			if (name === "changed original generation")
				(translated.serviceInstances[0] as Row).connectionGeneration = 5;
			if (name === "changed original credential") {
				const key = destination.encrypt("changed");
				Object.assign(translated.serviceInstances[0] as Row, {
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				});
			}
			if (name === "same-title cross-instance") {
				const key = destination.encrypt("other-credential");
				const other = {
					...(translated.serviceInstances[0] as Row),
					id: "other",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				};
				translated.serviceInstances.push(other);
			}
			expect(() => translateRestoreBindings(original, translated, source, destination)).toThrow(
				"invalid-binding",
			);
		});
	for (const [name, mutate] of [
		[
			"stale recovery connection",
			(state: Row) => {
				state.connectionStateToken = "stale";
			},
		],
		[
			"stale endpoint",
			(state: Row) => {
				state.endpointKey = "stale";
			},
		],
		[
			"missing applied resource proof",
			(state: Row) => {
				(state.customFormatDeployments as Row[])[0]!.postStateToken = null;
			},
		],
		[
			"missing applied resource ID",
			(state: Row) => {
				(state.customFormatDeployments as Row[])[0]!.resourceId = null;
			},
		],
	] as const)
		it(`rejects ${name} without inventing recovery evidence`, () => {
			const { original, translated } = trashFixture();
			const state = JSON.parse((original.trashBackups![0] as Row).backupData as string);
			mutate(state);
			(original.trashBackups![0] as Row).backupData = JSON.stringify(state);
			translated.trashBackups = structuredClone(original.trashBackups);
			expect(() => translateRestoreBindings(original, translated, source, destination)).toThrow(
				"invalid-binding",
			);
		});
	for (const [field, value] of [
		["sourceConnectionStateToken", "stale"],
		["sourceConnectionStateToken", ""],
		["sourceInstanceId", "missing"],
		["sourceInstanceId", null],
	] as const)
		it(`rejects unverifiable clone source ${field}=${value}`, () => {
			const { original, translated } = trashFixture();
			const config = JSON.parse((original.trashTemplates![0] as Row).configData as string);
			config.completeQualityProfile[field] = value;
			(original.trashTemplates![0] as Row).configData = JSON.stringify(config);
			translated.trashTemplates = structuredClone(original.trashTemplates);
			expect(() => translateRestoreBindings(original, translated, source, destination)).toThrow(
				"invalid-binding",
			);
		});
	it("keeps genuinely unbound legacy mapping and clone metadata unbound", () => {
		const { original, translated } = trashFixture();
		for (const field of [
			"templateQualityProfileMappings",
			"instanceQualityProfileOverrides",
		] as const) {
			Object.assign(original[field]![0] as Row, {
				connectionGeneration: 0,
				connectionStateToken: null,
			});
			translated[field] = structuredClone(original[field]);
		}
		const config = JSON.parse((original.trashTemplates![0] as Row).configData as string);
		delete config.completeQualityProfile.sourceConnectionStateToken;
		(original.trashTemplates![0] as Row).configData = JSON.stringify(config);
		translated.trashTemplates = structuredClone(original.trashTemplates);
		translateRestoreBindings(original, translated, source, destination);
		expect(translated.templateQualityProfileMappings).toEqual(
			original.templateQualityProfileMappings,
		);
		expect(translated.instanceQualityProfileOverrides).toEqual(
			original.instanceQualityProfileOverrides,
		);
		expect(translated.trashTemplates).toEqual(original.trashTemplates);
	});
	it("preserves genuine legacy recovery snapshots without manufacturing v2 authority", () => {
		const { original, translated } = trashFixture();
		(original.trashBackups![0] as Row).backupData = JSON.stringify({
			customFormats: [],
			qualityProfile: null,
			extra: true,
		});
		translated.trashBackups = structuredClone(original.trashBackups);
		translateRestoreBindings(original, translated, source, destination);
		expect(translated.trashBackups).toEqual(original.trashBackups);
	});
	it("translates a proven pre-URL endpoint key using the existing endpoint predicate", () => {
		const { original, translated, instance } = trashFixture();
		const state = JSON.parse((original.trashBackups![0] as Row).backupData as string);
		state.endpointKey = `owner:RADARR:${new ArrClientFactory(source).createConnectionCredentialIdentity(instance)}`;
		(original.trashBackups![0] as Row).backupData = JSON.stringify(state);
		translated.trashBackups = structuredClone(original.trashBackups);
		translateRestoreBindings(original, translated, source, destination);
		const after = translated.serviceInstances[0] as ServiceInstance;
		const restored = JSON.parse((translated.trashBackups![0] as Row).backupData as string);
		expect(
			isDeploymentBackupEndpointIdentityCurrent({
				userId: "owner",
				instance: after,
				backupEndpointKey: restored.endpointKey,
				backupConnectionStateToken: restored.connectionStateToken,
				credentialIdentity: new ArrClientFactory(destination).createConnectionCredentialIdentity(
					after,
				),
			}),
		).toBe(true);
	});
});
