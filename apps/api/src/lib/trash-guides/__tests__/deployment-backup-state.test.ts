import { describe, expect, it } from "vitest";
import {
	parseDeploymentBackupState,
	shouldRetainDeploymentBackup,
} from "../deployment-backup-state.js";

function validBackup() {
	return {
		schemaVersion: 2,
		endpointKey: "user:RADARR:http://radarr/",
		connectionStateToken: "connection-token",
		customFormats: [],
		customFormatDeployments: [],
		managedCustomFormats: [],
		managedCustomFormatsCaptured: false,
		qualityProfileDeployment: {
			beforeProfile: null,
			status: "not_started",
			action: "updated",
			profileId: null,
			postStateToken: null,
		},
		namingDeployment: null,
	};
}

describe("parseDeploymentBackupState", () => {
	it("accepts the current identity-bound schema", () => {
		expect(parseDeploymentBackupState(JSON.stringify(validBackup())).schemaVersion).toBe(2);
	});

	it("preserves an intended post-write token used to reconcile a timed-out update", () => {
		const backup = validBackup();
		backup.customFormatDeployments = [
			{
				beforeFormat: { id: 7, name: "Foo" },
				action: "updated",
				resourceId: 7,
				name: "Foo",
				status: "pending",
				postStateToken: null,
				intendedPostStateToken: "intended-token",
			},
		] as never;

		expect(
			parseDeploymentBackupState(JSON.stringify(backup)).customFormatDeployments[0],
		).toMatchObject({ intendedPostStateToken: "intended-token" });
	});

	it("preserves the intended writable state used to recover a timed-out create", () => {
		const backup = validBackup();
		backup.customFormatDeployments = [
			{
				beforeFormat: null,
				action: "created",
				resourceId: null,
				name: "Foo",
				status: "pending",
				postStateToken: null,
				intendedPostState: {
					name: "Foo",
					includeCustomFormatWhenRenaming: false,
					specifications: [],
				},
			},
		] as never;

		expect(
			parseDeploymentBackupState(JSON.stringify(backup)).customFormatDeployments[0],
		).toMatchObject({
			intendedPostState: {
				name: "Foo",
				includeCustomFormatWhenRenaming: false,
				specifications: [],
			},
		});
	});

	it.each([0, -1, 7.5, "7"])("rejects invalid resource ID %s", (resourceId) => {
		const backup = validBackup();
		backup.customFormatDeployments = [
			{
				beforeFormat: null,
				action: "created",
				resourceId,
				name: "Foo",
				status: "applied",
				postStateToken: "token",
			},
		] as never;
		expect(() => parseDeploymentBackupState(JSON.stringify(backup))).toThrow();
	});

	it("rejects unknown phase statuses", () => {
		const backup = validBackup();
		backup.qualityProfileDeployment.status = "unknown" as never;
		expect(() => parseDeploymentBackupState(JSON.stringify(backup))).toThrow();
	});

	it("rejects an applied Custom Format whose upstream ID was not captured", () => {
		const backup = validBackup();
		backup.customFormatDeployments = [
			{
				beforeFormat: null,
				action: "created",
				resourceId: null,
				name: "Foo",
				status: "applied",
				postStateToken: "token",
			},
		] as never;

		expect(() => parseDeploymentBackupState(JSON.stringify(backup))).toThrow(
			"Applied CF state requires a resource ID",
		);
	});

	it("rejects an applied quality profile whose upstream ID was not captured", () => {
		const backup = validBackup();
		backup.qualityProfileDeployment = {
			beforeProfile: null,
			action: "created",
			profileId: null,
			profileName: "Any",
			status: "applied",
			postStateToken: "token",
		} as never;

		expect(() => parseDeploymentBackupState(JSON.stringify(backup))).toThrow(
			"Applied profile state requires a profile ID",
		);
	});
});

describe("shouldRetainDeploymentBackup", () => {
	it("allows an applied v2 deployment ledger to expire after ownership is terminal", () => {
		const backup = validBackup();
		backup.customFormatDeployments = [
			{
				beforeFormat: { id: 7, name: "Foo", specifications: [] },
				action: "updated",
				resourceId: 7,
				name: "Foo",
				status: "applied",
				postStateToken: "post-token",
			},
		] as never;

		expect(shouldRetainDeploymentBackup(JSON.stringify(backup))).toBe(false);
	});

	it("retains a v2 deployment ledger with a pending mutation", () => {
		const backup = validBackup();
		backup.customFormatDeployments = [
			{
				beforeFormat: null,
				action: "created",
				resourceId: 7,
				name: "Pending",
				status: "pending",
				postStateToken: null,
				intendedPostStateToken: "intended-token",
			},
		] as never;

		expect(shouldRetainDeploymentBackup(JSON.stringify(backup))).toBe(true);
	});

	it.each([
		["invalid JSON", "not-json"],
		["missing schema version", JSON.stringify({ endpointKey: "current-like" })],
		["string schema version", JSON.stringify({ schemaVersion: "2" })],
		["malformed current schema", JSON.stringify({ schemaVersion: 2 })],
		["future schema version", JSON.stringify({ schemaVersion: 3 })],
		["malformed legacy profile", JSON.stringify({ customFormats: [], qualityProfile: {} })],
		["malformed legacy Custom Format", JSON.stringify([{ id: 7, name: "Incomplete" }])],
	] as const)("retains %s", (_label, backupData) => {
		expect(shouldRetainDeploymentBackup(backupData)).toBe(true);
	});

	it.each([
		["raw Custom Format array", JSON.stringify([])],
		[
			"legacy Custom Format without include-on-rename",
			JSON.stringify([
				{
					id: 7,
					name: "Legacy CF",
					specifications: [],
				},
			]),
		],
		["object snapshot", JSON.stringify({ customFormats: [], qualityProfile: null })],
		[
			"object snapshot with Unknown quality",
			JSON.stringify({
				customFormats: [],
				qualityProfile: {
					id: 4,
					name: "Legacy",
					upgradeAllowed: true,
					cutoff: 0,
					items: [
						{
							id: 0,
							name: "Unknown",
							allowed: false,
							quality: { id: 0, name: "Unknown" },
							items: [],
						},
					],
					minFormatScore: 0,
					cutoffFormatScore: 0,
					minUpgradeFormatScore: 0,
					formatItems: [],
				},
			}),
		],
	] as const)("allows positively identified legacy %s cleanup", (_label, backupData) => {
		expect(shouldRetainDeploymentBackup(backupData)).toBe(false);
	});
});
