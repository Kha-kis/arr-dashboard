import { describe, expect, it } from "vitest";
import {
	isNonterminalRollback,
	isNonterminalUndeploy,
	normalizeBackupForRestore,
	validateCoordinationEvidence,
} from "../backup-validation.js";
import { createDeploymentConnectionStateToken } from "../../trash-guides/deployment-target.js";

describe("isNonterminalRollback", () => {
	it("treats an exact backup-less manual resolution as terminal", () => {
		expect(
			isNonterminalRollback({
				status: "FAILED",
				backupId: null,
				rolledBack: false,
				rollbackStatus: "MANUALLY_RESOLVED",
			}),
		).toBe(false);
	});

	it("keeps malformed manual-resolution markers nonterminal", () => {
		expect(
			isNonterminalRollback({
				status: "SUCCESS",
				backupId: null,
				rolledBack: false,
				rollbackStatus: "MANUALLY_RESOLVED",
			}),
		).toBe(true);
	});
});

describe("validateCoordinationEvidence active ownership", () => {
	const instance = {
		id: "instance-1",
		userId: "user-1",
		service: "RADARR",
		baseUrl: "http://radarr:7878",
		encryptedApiKey: "encrypted-key",
		encryptionIv: "iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		connectionGeneration: 2,
	};
	const baseData = {
		serviceInstances: [instance],
		trashTemplates: [{ id: "template-1", userId: "user-1" }],
		trashBackups: [],
	};
	const activeSync = {
		id: "sync-owner",
		instanceId: "instance-1",
		templateId: "template-1",
		userId: "user-1",
		status: "PARTIAL_SUCCESS",
		rolledBack: false,
		rollbackStatus: null,
		backupId: "backup-1",
	};
	const validLedger = (connectionStateToken = createDeploymentConnectionStateToken(instance)) =>
		JSON.stringify({
			schemaVersion: 2,
			endpointKey: "user-1:RADARR:http://radarr:7878/:credential-1",
			connectionStateToken,
			customFormats: [],
			customFormatDeployments: [],
			managedCustomFormats: [],
			managedCustomFormatsCaptured: false,
			qualityProfileDeployment: {
				beforeProfile: null,
				status: "not_started",
				action: "created",
				profileId: null,
				profileName: null,
				postStateToken: null,
				intendedPostStateToken: null,
			},
			namingDeployment: null,
		});

	it("accepts an exact legacy terminal sync wrapper without a snapshot", () => {
		expect(() =>
			validateCoordinationEvidence({
				...baseData,
				trashSyncHistory: [
					{
						id: "sync-owner",
						instanceId: "instance-1",
						templateId: "template-1",
						userId: "user-1",
						status: "SUCCESS",
						rolledBack: false,
						rollbackStatus: null,
						backupId: null,
					},
				],
			}),
		).not.toThrow();
	});

	it.each([
		["invalid JSON", "not-json"],
		["incomplete schema-v2 ledger", JSON.stringify({ schemaVersion: 2 })],
	] as const)("rejects active recovery with %s", (_label, backupData) => {
		expect(() =>
			validateCoordinationEvidence({
				...baseData,
				trashBackups: [{ id: "backup-1", instanceId: "instance-1", userId: "user-1", backupData }],
				trashSyncHistory: [activeSync],
			}),
		).toThrow(/invalid deployment ledger/i);
	});

	it("rejects an active recovery ledger bound to a different connection", () => {
		expect(() =>
			validateCoordinationEvidence({
				...baseData,
				trashBackups: [
					{
						id: "backup-1",
						instanceId: "instance-1",
						userId: "user-1",
						backupData: validLedger("stale-connection-token"),
					},
				],
				trashSyncHistory: [activeSync],
			}),
		).toThrow(/different ARR connection/i);
	});

	it("rejects a schema-v2 ledger with a substituted credential identity", () => {
		expect(() =>
			validateCoordinationEvidence(
				{
					...baseData,
					trashBackups: [
						{
							id: "backup-1",
							instanceId: "instance-1",
							userId: "user-1",
							backupData: validLedger(),
						},
					],
					trashSyncHistory: [activeSync],
				},
				{ credentialIdentityForInstance: () => "different-credential" },
			),
		).toThrow(/different ARR connection/i);
	});

	it("accepts a valid schema-v2 recovery ledger bound to its saved connection", () => {
		expect(() =>
			validateCoordinationEvidence({
				...baseData,
				trashBackups: [
					{
						id: "backup-1",
						instanceId: "instance-1",
						userId: "user-1",
						backupData: validLedger(),
					},
				],
				trashSyncHistory: [activeSync],
			}),
		).not.toThrow();
	});

	it("rejects a successful unrolled deployment owner without its snapshot", () => {
		expect(() =>
			validateCoordinationEvidence({
				...baseData,
				templateDeploymentHistory: [
					{
						id: "deployment-owner",
						instanceId: "instance-1",
						templateId: "template-1",
						userId: "user-1",
						status: "SUCCESS",
						rolledBack: false,
						undeployStatus: null,
						backupId: null,
					},
				],
			}),
		).toThrow("missing backup snapshot reference");
	});

	it("accepts the exact legacy snapshotless partial-undeploy audit after normalization", () => {
		const normalized = normalizeBackupForRestore({
			version: "1.0",
			data: {
				...baseData,
				templateDeploymentHistory: [
					{
						id: "legacy-partial-undeploy",
						instanceId: "instance-1",
						templateId: "template-1",
						userId: "user-1",
						status: "PARTIAL_UNDEPLOY",
						rolledBack: false,
						undeployStatus: "PARTIAL",
						backupId: "missing-snapshot",
						canRollback: true,
					},
				],
				trashBackups: [],
			},
		} as never);
		const audit = normalized.data.templateDeploymentHistory?.[0] as Record<string, unknown>;

		expect(isNonterminalUndeploy(audit)).toBe(false);
		expect(() => validateCoordinationEvidence(normalized.data)).not.toThrow();
	});
});
