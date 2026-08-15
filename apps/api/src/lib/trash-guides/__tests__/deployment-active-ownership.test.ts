import { describe, expect, it, vi } from "vitest";
import { resolveActiveDeploymentOwnership } from "../deployment-active-ownership.js";

function state(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		schemaVersion: 2,
		endpointKey: "endpoint",
		connectionStateToken: "connection",
		customFormats: [],
		customFormatDeployments: [],
		managedCustomFormats: [],
		managedCustomFormatsCaptured: true,
		qualityProfileDeployment: {
			beforeProfile: null,
			status: "not_started",
			action: "created",
			profileId: null,
			profileName: "Profile",
			postStateToken: null,
			intendedPostStateToken: null,
		},
		namingDeployment: null,
		...overrides,
	});
}

describe("active deployment ownership", () => {
	it("rejects a superseded rollback target", async () => {
		const prisma = {
			templateDeploymentHistory: {
				findMany: vi.fn().mockResolvedValue([
					{
						templateId: "template-1",
						backupId: "new",
						status: "SUCCESS",
						deployedAt: new Date("2026-01-02"),
						backup: { backupData: state() },
					},
					{
						templateId: "template-1",
						backupId: "old",
						status: "SUCCESS",
						deployedAt: new Date("2026-01-01"),
						backup: { backupData: state() },
					},
				]),
			},
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
				backupId: "old",
				templateId: "template-1",
			}),
		).rejects.toThrow("newer deployment");
	});

	it("fails closed when one template has active backups with tied timestamps", async () => {
		const tiedAt = new Date("2026-01-02");
		const prisma = {
			templateDeploymentHistory: {
				findMany: vi.fn().mockResolvedValue([
					{
						templateId: "template-1",
						backupId: "target",
						status: "SUCCESS",
						deployedAt: tiedAt,
						backup: { backupData: state() },
					},
					{
						templateId: "template-1",
						backupId: "tied",
						status: "SUCCESS",
						deployedAt: tiedAt,
						backup: { backupData: state() },
					},
				]),
			},
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
				backupId: "target",
				templateId: "template-1",
			}),
		).rejects.toThrow("same deployment time");
	});

	it("combines exact identities from managed and per-write ledgers", async () => {
		const target = {
			templateId: "template-1",
			backupId: "target",
			status: "SUCCESS",
			deployedAt: new Date("2026-01-02"),
			backup: { backupData: state() },
		};
		const other = {
			templateId: "template-2",
			backupId: "other",
			status: "PARTIAL_SUCCESS",
			deployedAt: new Date("2026-01-03"),
			backup: {
				backupData: state({
					managedCustomFormats: [
						{
							trashId: "managed",
							name: "Managed",
							resourceId: 7,
							stateToken: "format",
							profileId: 3,
							appliedScore: 100,
						},
					],
					customFormatDeployments: [
						{
							beforeFormat: null,
							action: "created",
							resourceId: 8,
							name: "Created",
							status: "applied",
							postStateToken: "post",
							intendedPostStateToken: null,
						},
					],
					qualityProfileDeployment: {
						beforeProfile: { id: 3 },
						status: "applied",
						action: "updated",
						profileId: 3,
						profileName: "Profile",
						postStateToken: "profile",
						intendedPostStateToken: "profile",
					},
					namingDeployment: {
						beforeConfig: {},
						status: "applied",
						postStateToken: "naming",
						intendedPostStateToken: "naming",
					},
				}),
			},
		};
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([target, other]) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		const result = await resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
			backupId: "target",
			templateId: "template-1",
		});

		expect([...result.sharedCustomFormatIds]).toEqual([7, 8]);
		expect([...result.sharedQualityProfileIds]).toEqual([3]);
		expect(result.namingOwnedByAnotherDeployment).toBe(true);
		expect([...result.sharedCustomFormatStateTokens.get(7)!]).toEqual(["format"]);
		expect([...result.sharedCustomFormatStateTokens.get(8)!]).toEqual(["post"]);
		expect([...result.sharedQualityProfileStateTokens.get(3)!]).toEqual(["profile"]);
		expect([...result.sharedNamingStateTokens]).toEqual(["naming"]);
	});

	it("keeps the newest surviving owner state when multiple templates touched one resource", async () => {
		const managedState = (token: string) =>
			state({
				managedCustomFormats: [
					{
						trashId: "shared",
						name: "Shared",
						resourceId: 7,
						stateToken: token,
						profileId: 3,
						appliedScore: 100,
					},
				],
			});
		const rows = [
			{
				templateId: "target-template",
				backupId: "target",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-04"),
				backup: { backupData: state() },
			},
			{
				templateId: "older-survivor",
				backupId: "older",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-01"),
				backup: { backupData: managedState("older-state") },
			},
			{
				templateId: "newer-survivor",
				backupId: "newer",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-03"),
				backup: { backupData: managedState("newer-state") },
			},
		];
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue(rows) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		const result = await resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
			backupId: "target",
			templateId: "target-template",
		});

		expect([...result.sharedCustomFormatStateTokens.get(7)!]).toEqual(["newer-state"]);
	});

	it("marks a target resource as non-restorable when a newer survivor touched it", async () => {
		const managedState = (token: string) =>
			state({
				managedCustomFormats: [
					{
						trashId: "shared",
						name: "Shared",
						resourceId: 7,
						stateToken: token,
						profileId: 3,
						appliedScore: 100,
					},
				],
			});
		const rows = [
			{
				templateId: "target-template",
				backupId: "target",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-01"),
				backup: { backupData: managedState("target-state") },
			},
			{
				templateId: "survivor-template",
				backupId: "survivor",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-02"),
				backup: { backupData: managedState("survivor-state") },
			},
		];
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue(rows) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		const result = await resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
			backupId: "target",
			templateId: "target-template",
		});

		expect(result.sharedCustomFormatIds).toContain(7);
		expect(result.restorableSharedCustomFormatIds).not.toContain(7);
	});

	it("fails closed when a target and survivor touched a resource at the same time", async () => {
		const managedState = (token: string) =>
			state({
				managedCustomFormats: [
					{
						trashId: "shared",
						name: "Shared",
						resourceId: 7,
						stateToken: token,
						profileId: 3,
						appliedScore: 100,
					},
				],
			});
		const tiedAt = new Date("2026-01-02");
		const rows = [
			{
				templateId: "target-template",
				backupId: "target",
				status: "SUCCESS",
				deployedAt: tiedAt,
				backup: { backupData: managedState("target-state") },
			},
			{
				templateId: "survivor-template",
				backupId: "survivor",
				status: "SUCCESS",
				deployedAt: tiedAt,
				backup: { backupData: managedState("survivor-state") },
			},
		];
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue(rows) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
				backupId: "target",
				templateId: "target-template",
			}),
		).rejects.toThrow("same deployment time");
	});

	it("fails closed when surviving owners of one resource have tied timestamps", async () => {
		const managedState = (token: string) =>
			state({
				managedCustomFormats: [
					{
						trashId: "shared",
						name: "Shared",
						resourceId: 7,
						stateToken: token,
						profileId: 3,
						appliedScore: 100,
					},
				],
			});
		const tiedAt = new Date("2026-01-03");
		const rows = [
			{
				templateId: "target-template",
				backupId: "target",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-04"),
				backup: { backupData: state() },
			},
			{
				templateId: "survivor-a",
				backupId: "survivor-a",
				status: "SUCCESS",
				deployedAt: tiedAt,
				backup: { backupData: managedState("state-a") },
			},
			{
				templateId: "survivor-b",
				backupId: "survivor-b",
				status: "SUCCESS",
				deployedAt: tiedAt,
				backup: { backupData: managedState("state-b") },
			},
		];
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue(rows) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
				backupId: "target",
				templateId: "target-template",
			}),
		).rejects.toThrow("same deployment time");
	});

	it("fails closed when a competing deployment has no verified survivor state", async () => {
		const rows = [
			{
				templateId: "template-1",
				backupId: "target",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-01"),
				backup: { backupData: state() },
			},
			{
				templateId: "template-2",
				backupId: "other",
				status: "PARTIAL_SUCCESS",
				deployedAt: new Date("2026-01-02"),
				backup: {
					backupData: state({
						customFormatDeployments: [
							{
								beforeFormat: null,
								action: "created",
								resourceId: 8,
								name: "Created",
								status: "pending",
								postStateToken: null,
								intendedPostStateToken: "intended",
							},
						],
					}),
				},
			},
		];
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue(rows) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
				backupId: "target",
				templateId: "template-1",
			}),
		).rejects.toThrow("verified Custom Format state");
	});

	it("fails closed when a competing deployment never captured ownership", async () => {
		const rows = [
			{
				templateId: "template-1",
				backupId: "target",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-01"),
				backup: { backupData: state() },
			},
			{
				templateId: "template-2",
				backupId: "other",
				status: "PARTIAL_SUCCESS",
				deployedAt: new Date("2026-01-02"),
				backup: { backupData: state({ managedCustomFormatsCaptured: false }) },
			},
		];
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue(rows) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
				backupId: "target",
				templateId: "template-1",
			}),
		).rejects.toThrow("incomplete Custom Format ownership");
	});

	it("fails closed when an unrolled deployment lost its backup relation", async () => {
		const prisma = {
			templateDeploymentHistory: {
				findMany: vi.fn().mockResolvedValue([
					{
						templateId: "template-1",
						backupId: "target",
						status: "SUCCESS",
						deployedAt: new Date("2026-01-01"),
						backup: null,
					},
				]),
			},
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
				backupId: "target",
				templateId: "template-1",
			}),
		).rejects.toThrow("ownership relation is missing");
	});

	it("fails closed when an unrolled sync lost its template relation", async () => {
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: {
				findMany: vi.fn().mockResolvedValue([
					{
						templateId: null,
						backupId: "target",
						status: "SUCCESS",
						startedAt: new Date("2026-01-01"),
						backup: { backupData: state() },
					},
				]),
			},
		};

		await expect(
			resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
				backupId: "target",
				templateId: "template-1",
			}),
		).rejects.toThrow("ownership relation is missing");
	});

	it("ignores a backup-less sync after explicit manual resolution", async () => {
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: {
				findMany: vi.fn().mockResolvedValue([
					{
						templateId: null,
						backupId: null,
						status: "FAILED",
						startedAt: new Date("2026-01-01"),
						backup: null,
						rolledBack: false,
						rollbackStatus: "MANUALLY_RESOLVED",
					},
				]),
			},
		};

		await expect(
			resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
				backupId: "target",
				templateId: "template-1",
			}),
		).rejects.toThrow("newer deployment");
	});

	it.each(["SUCCESS", "FAILED"])(
		"ignores a legacy terminal %s sync wrapper without ownership metadata",
		async (status) => {
			const prisma = {
				templateDeploymentHistory: {
					findMany: vi.fn().mockResolvedValue([
						{
							templateId: "template-1",
							backupId: "target",
							status: "SUCCESS",
							deployedAt: new Date("2026-01-02"),
							backup: { backupData: state() },
						},
					]),
				},
				trashSyncHistory: {
					findMany: vi.fn().mockResolvedValue([
						{
							templateId: null,
							backupId: null,
							status,
							startedAt: new Date("2025-01-01"),
							backup: null,
							rolledBack: false,
							rollbackStatus: null,
						},
					]),
				},
			};

			await expect(
				resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
					backupId: "target",
					templateId: "template-1",
				}),
			).resolves.toBeDefined();
		},
	);

	it("fails closed when a backup ID points to a missing backup row", async () => {
		const rows = [
			{
				templateId: "template-1",
				backupId: "target",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-01"),
				backup: { backupData: state() },
			},
			{
				templateId: "template-2",
				backupId: "missing",
				status: "PARTIAL_SUCCESS",
				deployedAt: new Date("2026-01-02"),
				backup: null,
			},
		];
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue(rows) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
				backupId: "target",
				templateId: "template-1",
			}),
		).rejects.toThrow("ownership relation is missing");
	});

	it("treats malformed failed history as ambiguous active ownership", async () => {
		const rows = [
			{
				templateId: "template-1",
				backupId: "target",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-01"),
				backup: { backupData: state() },
			},
			{
				templateId: "template-2",
				backupId: "failed",
				status: "FAILED",
				deployedAt: new Date("2026-01-02"),
				backup: { backupData: "not-json" },
			},
		];
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue(rows) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		await expect(
			resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
				backupId: "target",
				templateId: "template-1",
			}),
		).rejects.toThrow("invalid ownership metadata");
	});

	it("allows shared restoration only across a matching before-state and survivor post-state chain", async () => {
		const targetState = state({
			customFormatDeployments: [
				{
					beforeFormat: { id: 7, name: "Shared" },
					action: "updated",
					resourceId: 7,
					name: "Shared",
					status: "applied",
					postStateToken: "target-format-post",
				},
			],
			qualityProfileDeployment: {
				beforeProfile: { id: 3, name: "Profile", formatItems: [] },
				status: "applied",
				action: "updated",
				profileId: 3,
				profileName: "Profile",
				postStateToken: "target-profile-post",
			},
			namingDeployment: {
				beforeConfig: { renameMovies: false },
				status: "applied",
				postStateToken: "target-naming-post",
			},
		});
		const survivorState = state({
			customFormatDeployments: [
				{
					beforeFormat: null,
					action: "created",
					resourceId: 7,
					name: "Shared",
					status: "applied",
					postStateToken: "373729921fc51c4805d22de8b04d62e412d8a76396f102b9af586211d75ff5d1",
				},
			],
			qualityProfileDeployment: {
				beforeProfile: { id: 3 },
				status: "applied",
				action: "updated",
				profileId: 3,
				profileName: "Profile",
				postStateToken: "13316e449d497aebe9728f2df57001f3627a676826faf463fe6c4861fa74d825",
			},
			namingDeployment: {
				beforeConfig: { renameMovies: true },
				status: "applied",
				postStateToken: "e790ec8f4fc6decf93f45ffbd3467dcde5f204ab1562bf4d6f9537e9c0a5b235",
			},
		});
		const rows = [
			{
				templateId: "target-template",
				backupId: "target",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-03"),
				backup: { backupData: targetState },
			},
			{
				templateId: "survivor-template",
				backupId: "survivor",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-02"),
				backup: { backupData: survivorState },
			},
		];
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue(rows) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		const result = await resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
			backupId: "target",
			templateId: "target-template",
		});

		expect(result.restorableSharedCustomFormatIds).toContain(7);
		expect(result.restorableSharedQualityProfileIds).toContain(3);
		expect(result.sharedNamingRestorationAllowed).toBe(true);
	});

	it("does not restore a shared Custom Format after manual drift broke the ownership chain", async () => {
		const rows = [
			{
				templateId: "target-template",
				backupId: "target",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-03"),
				backup: {
					backupData: state({
						customFormatDeployments: [
							{
								beforeFormat: { id: 7, name: "Manually drifted" },
								action: "updated",
								resourceId: 7,
								name: "Shared",
								status: "applied",
								postStateToken: "target-post",
							},
						],
					}),
				},
			},
			{
				templateId: "survivor-template",
				backupId: "survivor",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-02"),
				backup: {
					backupData: state({
						customFormatDeployments: [
							{
								beforeFormat: null,
								action: "created",
								resourceId: 7,
								name: "Shared",
								status: "applied",
								postStateToken: "373729921fc51c4805d22de8b04d62e412d8a76396f102b9af586211d75ff5d1",
							},
						],
					}),
				},
			},
		];
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue(rows) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		const result = await resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
			backupId: "target",
			templateId: "target-template",
		});

		expect(result.restorableSharedCustomFormatIds).not.toContain(7);
	});

	it("does not restore a shared quality profile after manual drift broke the ownership chain", async () => {
		const profileState = (beforeProfile: Record<string, unknown> | null, postStateToken: string) =>
			state({
				qualityProfileDeployment: {
					beforeProfile,
					status: "applied",
					action: "updated",
					profileId: 3,
					profileName: "Profile",
					postStateToken,
				},
			});
		const rows = [
			{
				templateId: "target-template",
				backupId: "target",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-03"),
				backup: {
					backupData: profileState(
						{ id: 3, name: "Profile", formatItems: [{ format: 7, score: 25 }] },
						"target-post",
					),
				},
			},
			{
				templateId: "survivor-template",
				backupId: "survivor",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-02"),
				backup: {
					backupData: profileState(
						{ id: 3 },
						"13316e449d497aebe9728f2df57001f3627a676826faf463fe6c4861fa74d825",
					),
				},
			},
		];
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue(rows) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		const result = await resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
			backupId: "target",
			templateId: "target-template",
		});

		expect(result.restorableSharedQualityProfileIds).not.toContain(3);
	});

	it("does not restore shared naming after manual drift broke the ownership chain", async () => {
		const namingState = (beforeConfig: Record<string, unknown>, postStateToken: string) =>
			state({
				namingDeployment: {
					beforeConfig,
					status: "applied",
					postStateToken,
				},
			});
		const rows = [
			{
				templateId: "target-template",
				backupId: "target",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-03"),
				backup: {
					backupData: namingState({ renameMovies: true }, "target-post"),
				},
			},
			{
				templateId: "survivor-template",
				backupId: "survivor",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-02"),
				backup: {
					backupData: namingState(
						{ renameMovies: false },
						"e790ec8f4fc6decf93f45ffbd3467dcde5f204ab1562bf4d6f9537e9c0a5b235",
					),
				},
			},
		];
		const prisma = {
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue(rows) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};

		const result = await resolveActiveDeploymentOwnership(prisma as never, "user", ["instance"], {
			backupId: "target",
			templateId: "target-template",
		});

		expect(result.sharedNamingRestorationAllowed).toBe(false);
	});
});
