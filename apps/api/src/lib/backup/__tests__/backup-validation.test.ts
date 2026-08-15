import { describe, expect, it } from "vitest";
import {
	isNonterminalRollback,
	isNonterminalUndeploy,
	normalizeBackupForRestore,
	validateCoordinationEvidence,
} from "../backup-validation.js";

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
	const baseData = {
		serviceInstances: [{ id: "instance-1", userId: "user-1" }],
		trashTemplates: [{ id: "template-1", userId: "user-1" }],
		trashBackups: [],
	};

	it("rejects a successful unrolled sync owner without its snapshot", () => {
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
		).toThrow("missing backup snapshot reference");
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
