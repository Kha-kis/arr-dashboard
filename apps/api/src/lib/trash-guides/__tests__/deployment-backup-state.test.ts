import { describe, expect, it } from "vitest";
import { parseDeploymentBackupState } from "../deployment-backup-state.js";

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
