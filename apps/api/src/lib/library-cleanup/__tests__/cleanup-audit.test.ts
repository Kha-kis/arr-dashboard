import { describe, expect, it, vi } from "vitest";
import {
	approvalRecordToAuditSnapshot,
	recordApprovalExecutionClaimed,
	recordApprovalExecutionOutcome,
	recordApprovalMediaRescanEvent,
	recordApprovalMutationBoundary,
	recordApprovalRecoveryTransition,
	recordConfiguredRunAudit,
	runCleanupAuditBestEffort,
} from "../cleanup-audit.js";

type StoredEvent = {
	id: number;
	sequence: number;
	configId: string;
	actionId: string;
	eventKey: string;
	eventType: string;
	outcome: string;
	trigger: string;
	actorType: string;
	actorId: string | null;
	reason: string;
	details: string | null;
	[key: string]: unknown;
};

function seedEvent(id: number, actionId: string, eventType = "candidate_selected"): StoredEvent {
	return {
		id,
		sequence: id,
		configId: "config-1",
		actionId,
		eventKey: `seed:${id}`,
		eventType,
		outcome: "info",
		trigger: "scheduled",
		actorType: "scheduler",
		actorId: null,
		reason: "seed",
		details: null,
	};
}

function makeAuditPrisma(initial: StoredEvent[] = []) {
	const rows = [...initial];
	let nextId = rows.reduce((maximum, event) => Math.max(maximum, event.id), 0) + 1;
	let transactionTail = Promise.resolve();
	const delegate = {
		findUnique: vi.fn(
			async ({ where }: { where: { eventKey: string } }) =>
				rows.find((event) => event.eventKey === where.eventKey) ?? null,
		),
		create: vi.fn(async ({ data }: { data: Omit<StoredEvent, "id"> }) => {
			if (rows.some((event) => event.eventKey === data.eventKey)) {
				throw Object.assign(new Error("duplicate event"), { code: "P2002" });
			}
			const created = { ...data, id: nextId++ } as StoredEvent;
			rows.push(created);
			return created;
		}),
		update: vi.fn(
			async ({ where, data }: { where: { id: number }; data: { sequence: number } }) => {
				const event = rows.find((candidate) => candidate.id === where.id);
				if (!event) throw new Error("event missing");
				Object.assign(event, data);
				return event;
			},
		),
		count: vi.fn(
			async ({ where }: { where: { configId: string; actionId?: string } }) =>
				rows.filter(
					(event) =>
						event.configId === where.configId &&
						(where.actionId === undefined || event.actionId === where.actionId),
				).length,
		),
		findMany: vi.fn(
			async ({
				where,
				orderBy,
				take,
				skip = 0,
			}: {
				where: {
					configId: string;
					actionId?: string | { in: string[] };
					id?: { in?: number[]; notIn?: number[] };
					eventType?: string;
				};
				orderBy: { id: "asc" | "desc" };
				take?: number;
				skip?: number;
			}) => {
				const selectedActions =
					typeof where.actionId === "object" ? new Set(where.actionId.in) : null;
				const selectedIds = where.id?.in ? new Set(where.id.in) : null;
				const excludedIds = where.id?.notIn ? new Set(where.id.notIn) : null;
				return rows
					.filter(
						(event) =>
							event.configId === where.configId &&
							(where.actionId === undefined ||
								event.actionId === where.actionId ||
								selectedActions?.has(event.actionId)) &&
							(!selectedIds || selectedIds.has(event.id)) &&
							!excludedIds?.has(event.id) &&
							(where.eventType === undefined || event.eventType === where.eventType),
					)
					.sort((left, right) => (orderBy.id === "asc" ? left.id - right.id : right.id - left.id))
					.slice(skip, take === undefined ? undefined : skip + take);
			},
		),
		groupBy: vi.fn(
			async ({
				where,
				skip,
				take,
			}: {
				where: { configId: string };
				skip: number;
				take: number;
			}) => {
				const grouped = new Map<string, StoredEvent[]>();
				for (const event of rows) {
					if (event.configId !== where.configId) continue;
					const timeline = grouped.get(event.actionId) ?? [];
					timeline.push(event);
					grouped.set(event.actionId, timeline);
				}
				return [...grouped]
					.map(([actionId, timeline]) => ({
						actionId,
						_max: { id: Math.max(...timeline.map((event) => event.id)) },
						_count: { _all: timeline.length },
					}))
					.sort((left, right) => (left._max.id ?? 0) - (right._max.id ?? 0))
					.slice(skip, skip + take);
			},
		),
		deleteMany: vi.fn(
			async ({
				where,
			}: {
				where: {
					configId: string;
					actionId: string | { in: string[] };
					id?: { in?: number[]; notIn?: number[] };
				};
			}) => {
				const selected =
					typeof where.actionId === "string"
						? new Set([where.actionId])
						: new Set(where.actionId.in);
				const retainedIds = new Set(where.id?.notIn ?? []);
				const selectedIds = where.id?.in ? new Set(where.id.in) : null;
				let deleted = 0;
				for (let index = rows.length - 1; index >= 0; index--) {
					const event = rows[index]!;
					if (
						event.configId === where.configId &&
						selected.has(event.actionId) &&
						(!selectedIds || selectedIds.has(event.id)) &&
						!retainedIds.has(event.id)
					) {
						rows.splice(index, 1);
						deleted++;
					}
				}
				return { count: deleted };
			},
		),
	};
	const transaction = {
		libraryCleanupAuditEvent: delegate,
		$executeRaw: vi.fn(async () => 1),
	};
	const prisma = {
		libraryCleanupAuditEvent: delegate,
		$transaction: async <T>(operation: (value: typeof transaction) => Promise<T>) => {
			let release!: () => void;
			const predecessor = transactionTail;
			transactionTail = new Promise<void>((resolve) => {
				release = resolve;
			});
			await predecessor;
			try {
				return await operation(transaction);
			} finally {
				release();
			}
		},
	};
	return { prisma, rows, delegate };
}

const log = {
	warn: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
};

function approval(overrides: Record<string, unknown> = {}) {
	return approvalRecordToAuditSnapshot({
		id: "approval-1",
		configId: "config-1",
		instanceId: "sonarr-1",
		arrItemId: 42,
		itemType: "series",
		targetScope: "episode",
		arrEpisodeId: 101,
		title: "Example",
		matchedRuleId: "rule-1",
		matchedRuleName: "Cleanup",
		action: "delete",
		reason: "Matched cleanup policy",
		status: "executing",
		...overrides,
	});
}

describe("library cleanup append-only audit", () => {
	it("keeps durable media rescan follow-up on the same idempotent action timeline", async () => {
		const { prisma, rows } = makeAuditPrisma();
		const options = {
			approval: approval({ status: "executed" }),
			correlationId: "media-rescan:approval-1",
			trigger: "scheduled" as const,
			attempt: 1,
			targetCount: 2,
		};

		await recordApprovalMediaRescanEvent(
			prisma as never,
			{ ...options, eventType: "media_rescan_pending" },
			log as never,
		);
		await recordApprovalMediaRescanEvent(
			prisma as never,
			{ ...options, eventType: "media_rescan_pending" },
			log as never,
		);
		await recordApprovalMediaRescanEvent(
			prisma as never,
			{ ...options, eventType: "media_rescan_triggered" },
			log as never,
		);
		await recordApprovalMediaRescanEvent(
			prisma as never,
			{ ...options, attempt: 2, eventType: "media_rescan_skipped" },
			log as never,
		);

		expect(rows.map((event) => event.eventType)).toEqual([
			"media_rescan_pending",
			"media_rescan_triggered",
			"media_rescan_skipped",
		]);
		expect(rows.every((event) => event.actionId === "approval-1")).toBe(true);
	});

	it("retries Prisma PostgreSQL serialization conflicts exposed through driver metadata", async () => {
		const { prisma, rows } = makeAuditPrisma();
		const transaction = prisma.$transaction.bind(prisma);
		let attempts = 0;
		prisma.$transaction = async (operation) => {
			attempts++;
			if (attempts === 1) {
				throw Object.assign(new Error("Raw query failed"), {
					code: "P2010",
					meta: {
						driverAdapterError: {
							cause: {
								originalCode: "40001",
								kind: "TransactionWriteConflict",
							},
						},
					},
				});
			}
			return transaction(operation);
		};

		await recordApprovalExecutionClaimed(
			prisma as never,
			{ approval: approval(), correlationId: "postgres-retry", trigger: "approval" },
			log as never,
		);

		expect(attempts).toBe(2);
		expect(rows).toEqual([
			expect.objectContaining({
				eventType: "execution_claimed",
				correlationId: "postgres-retry",
			}),
		]);
	});

	it("records every prepared SDK mutation boundary before an honest partial outcome", async () => {
		const { prisma, rows } = makeAuditPrisma();
		const correlationId = "attempt-1";
		await recordApprovalExecutionClaimed(
			prisma as never,
			{ approval: approval(), correlationId, trigger: "approval", actorId: "user-1" },
			log as never,
		);
		await recordApprovalMutationBoundary(
			prisma as never,
			{
				approval: approval(),
				correlationId,
				trigger: "approval",
				actorId: "user-1",
				attempt: 1,
				step: "radarr_movie_file_delete",
			},
			log as never,
		);
		await recordApprovalMutationBoundary(
			prisma as never,
			{
				approval: approval(),
				correlationId,
				trigger: "approval",
				actorId: "user-1",
				attempt: 2,
				step: "radarr_movie_record_delete",
			},
			log as never,
		);
		await recordApprovalExecutionOutcome(
			prisma as never,
			{
				approval: approval({
					status: "retry_pending",
					lastExecutionError: "File deleted; record retained after safety revalidation failed.",
				}),
				correlationId,
				trigger: "approval",
				actorId: "user-1",
				auditPrepared: true,
				mutationAttempted: true,
			},
			log as never,
		);

		expect(rows.map((event) => event.eventType)).toEqual([
			"execution_claimed",
			"mutation_prepared",
			"mutation_prepared",
			"retry_pending",
		]);
		expect(rows.slice(1, 3).map((event) => JSON.parse(event.details ?? "{}").step)).toEqual([
			"radarr_movie_file_delete",
			"radarr_movie_record_delete",
		]);
		expect(rows.at(-1)).toMatchObject({
			outcome: "failed",
			actorType: "operator",
			actorId: "user-1",
			reason: "File deleted; record retained after safety revalidation failed.",
		});
		expect(rows.every((event) => event.sequence === event.id)).toBe(true);
	});

	it("leaves an explicit unknown outcome when recovery follows a crash boundary", async () => {
		const { prisma, rows } = makeAuditPrisma();
		await recordApprovalExecutionClaimed(
			prisma as never,
			{ approval: approval(), correlationId: "crashed", trigger: "retry" },
			log as never,
		);
		await recordApprovalMutationBoundary(
			prisma as never,
			{
				approval: approval(),
				correlationId: "crashed",
				trigger: "retry",
				attempt: 1,
				step: "sonarr_episode_file_delete",
			},
			log as never,
		);
		await recordApprovalRecoveryTransition(
			prisma as never,
			{
				approval: approval({ status: "retry_pending" }),
				correlationId: "recovery:approval-1",
				fromStatus: "retry_executing",
				toStatus: "retry_pending",
				reason: "Recovered after process restart.",
				mutationOutcome: "unknown",
				trigger: "retry",
			},
			log as never,
		);

		expect(rows.at(-1)).toMatchObject({
			eventType: "recovery_transition",
			outcome: "failed",
			actorType: "system",
			trigger: "retry",
		});
		expect(JSON.parse(rows.at(-1)?.details ?? "{}")).toMatchObject({
			fromStatus: "retry_executing",
			toStatus: "retry_pending",
			mutationOutcome: "unknown",
		});
	});

	it("keeps queue creation and idempotent execution events on the approval timeline", async () => {
		const { prisma, rows } = makeAuditPrisma();
		const queuedRun = {
			configId: "config-1",
			runLogId: "queue-run-1",
			trigger: "scheduled" as const,
			result: {
				isDryRun: false,
				status: "completed" as const,
				itemsEvaluated: 1,
				itemsFlagged: 1,
				itemsRemoved: 0,
				itemsUnmonitored: 0,
				itemsFilesDeleted: 0,
				itemsSkipped: 0,
				durationMs: 10,
				details: [
					{
						actionId: "approval-queue-1",
						approvalId: "approval-queue-1",
						instanceId: "radarr-1",
						arrItemId: 9,
						title: "Queued",
						ruleId: "rule-1",
						rule: "Old",
						reason: "Not watched for 90 days",
						action: "queued_for_approval" as const,
						intendedAction: "delete" as const,
					},
				],
			},
		};

		await recordConfiguredRunAudit(prisma as never, queuedRun, log as never);
		await recordConfiguredRunAudit(prisma as never, queuedRun, log as never);
		await recordApprovalExecutionClaimed(
			prisma as never,
			{
				approval: approval({
					id: "approval-queue-1",
					instanceId: "radarr-1",
					arrItemId: 9,
					targetScope: "series",
					arrEpisodeId: null,
					title: "Queued",
					reason: "Not watched for 90 days",
				}),
				correlationId: "approval-attempt-1",
				trigger: "approval",
			},
			log as never,
		);
		await recordApprovalExecutionClaimed(
			prisma as never,
			{
				approval: approval({ id: "approval-queue-1" }),
				correlationId: "approval-attempt-1",
				trigger: "approval",
			},
			log as never,
		);

		expect(rows.map((event) => event.eventType)).toEqual([
			"candidate_selected",
			"approval_pending",
			"execution_claimed",
		]);
		expect(new Set(rows.map((event) => event.actionId))).toEqual(new Set(["approval-queue-1"]));
		expect(rows.some((event) => event.actionId.startsWith("run:"))).toBe(false);
	});

	it("does not invent a synthetic timeline for a queued detail missing its approval ID", async () => {
		const { prisma, rows } = makeAuditPrisma();

		await recordConfiguredRunAudit(
			prisma as never,
			{
				configId: "config-1",
				runLogId: "legacy-queue-run",
				trigger: "scheduled",
				result: {
					isDryRun: false,
					status: "completed",
					itemsEvaluated: 1,
					itemsFlagged: 1,
					itemsRemoved: 0,
					itemsUnmonitored: 0,
					itemsFilesDeleted: 0,
					itemsSkipped: 0,
					durationMs: 10,
					details: [
						{
							instanceId: "radarr-1",
							arrItemId: 9,
							title: "Legacy queued row",
							ruleId: "rule-1",
							rule: "Old",
							reason: "Matched",
							action: "queued_for_approval",
							intendedAction: "delete",
						},
					],
				},
			},
			log as never,
		);

		expect(rows).toHaveLength(0);
	});

	it("does not persist any audit events for configured dry runs", async () => {
		const { prisma, rows } = makeAuditPrisma();
		const options = {
			configId: "config-1",
			runLogId: "run-1",
			trigger: "manual" as const,
			actorId: "user-1",
			result: {
				isDryRun: true,
				status: "completed" as const,
				itemsEvaluated: 1,
				itemsFlagged: 1,
				itemsRemoved: 0,
				itemsUnmonitored: 0,
				itemsFilesDeleted: 0,
				itemsSkipped: 0,
				durationMs: 10,
				details: [
					{
						instanceId: "radarr-1",
						arrItemId: 9,
						title: "Dry Run",
						ruleId: "rule-1",
						rule: "Old",
						reason: "Would match",
						action: "flagged" as const,
						intendedAction: "delete" as const,
					},
				],
			},
		};
		await recordConfiguredRunAudit(prisma as never, options, log as never);
		await recordConfiguredRunAudit(prisma as never, options, log as never);

		expect(rows).toHaveLength(0);
	});

	it("never reports terminal success when durable intent finalization failed", async () => {
		const { prisma, rows } = makeAuditPrisma();
		await recordApprovalExecutionOutcome(
			prisma as never,
			{
				approval: approval({ status: "executed" }),
				correlationId: "durable-failure",
				trigger: "manual",
				auditPrepared: true,
				mutationAttempted: true,
				durableStateRecordingFailed: true,
			},
			log as never,
		);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ eventType: "execution_incomplete", outcome: "failed" });
		expect(JSON.parse(rows[0]?.details ?? "{}")).toMatchObject({
			durableStateRecordingFailed: true,
			mutationAttempted: true,
		});
	});

	it("records a direct upstream success with failed intent finalization as incomplete", async () => {
		const { prisma, rows } = makeAuditPrisma();
		await recordConfiguredRunAudit(
			prisma as never,
			{
				configId: "config-1",
				runLogId: "direct-run",
				trigger: "scheduled",
				result: {
					isDryRun: false,
					status: "partial",
					itemsEvaluated: 1,
					itemsFlagged: 1,
					itemsRemoved: 1,
					itemsUnmonitored: 0,
					itemsFilesDeleted: 0,
					itemsSkipped: 0,
					durationMs: 10,
					details: [
						{
							actionId: "direct-intent",
							instanceId: "radarr-1",
							arrItemId: 9,
							title: "Direct",
							ruleId: "rule-1",
							rule: "Old",
							reason: "Upstream completed but durable status failed",
							action: "removed",
							intendedAction: "delete",
							auditPrepared: true,
							mutationAttempted: true,
							durableStateRecordingFailed: true,
						},
					],
				},
			},
			log as never,
		);

		expect(rows.at(-1)).toMatchObject({ eventType: "execution_incomplete", outcome: "failed" });
		expect(rows.some((event) => event.eventType === "terminal_succeeded")).toBe(false);
	});

	it.each(["manual", "scheduled"] as const)(
		"preserves the %s trigger on a recovery event",
		async (trigger) => {
			const { prisma, rows } = makeAuditPrisma();
			await recordApprovalRecoveryTransition(
				prisma as never,
				{
					approval: approval({ status: "retry_pending" }),
					correlationId: `recovery:${trigger}`,
					fromStatus: "retry_executing",
					toStatus: "retry_pending",
					reason: "Recovered after interruption.",
					mutationOutcome: "unknown",
					trigger,
				},
				log as never,
			);

			expect(rows[0]).toMatchObject({ eventType: "recovery_transition", trigger });
		},
	);

	it("does not let an audit failure change the authoritative result", async () => {
		const warn = vi.fn();
		await expect(
			runCleanupAuditBestEffort(
				async () => {
					throw new Error("audit unavailable");
				},
				{ warn },
				"test",
			),
		).resolves.toBe(false);
		expect(warn).toHaveBeenCalledOnce();
	});

	it("prunes only durably closed timelines and retains an old retry lifecycle", async () => {
		const initial = [
			seedEvent(1, "old-retry", "candidate_selected"),
			seedEvent(2, "old-retry", "retry_pending"),
		];
		let id = 3;
		for (let timeline = 0; timeline < 11; timeline++) {
			for (let eventIndex = 0; eventIndex < 1_000; eventIndex++) {
				initial.push(
					seedEvent(
						id++,
						`closed-${timeline}`,
						eventIndex === 999 ? "terminal_succeeded" : "candidate_selected",
					),
				);
			}
		}
		const { prisma, rows } = makeAuditPrisma(initial);
		await recordApprovalRecoveryTransition(
			prisma as never,
			{
				approval: approval({ id: "new-action", status: "pending" }),
				correlationId: "retention",
				fromStatus: "approved",
				toStatus: "pending",
				reason: "Recovered.",
				mutationOutcome: "not_started",
				trigger: "scheduled",
			},
			log as never,
		);

		expect(rows.filter((event) => event.actionId === "old-retry")).toHaveLength(2);
		expect(rows.some((event) => event.actionId === "closed-0")).toBe(false);
		expect(rows.some((event) => event.actionId === "new-action")).toBe(true);
	});

	it("caps one huge oldest active timeline without losing required retry evidence", async () => {
		const initial: StoredEvent[] = [];
		for (let id = 1; id <= 5_000; id++) {
			initial.push(
				seedEvent(
					id,
					"oldest-active",
					id === 1 ? "candidate_selected" : id === 5_000 ? "retry_pending" : "mutation_prepared",
				),
			);
		}
		let id = 5_001;
		for (let timeline = 0; timeline < 6; timeline++) {
			for (let eventIndex = 0; eventIndex < 1_000; eventIndex++) {
				initial.push(
					seedEvent(
						id++,
						`newer-closed-${timeline}`,
						eventIndex === 999 ? "terminal_succeeded" : "candidate_selected",
					),
				);
			}
		}
		const { prisma, rows } = makeAuditPrisma(initial);
		await recordApprovalRecoveryTransition(
			prisma as never,
			{
				approval: approval({ id: "append", status: "pending" }),
				correlationId: "oldest-active-cap",
				fromStatus: "approved",
				toStatus: "pending",
				reason: "Recovered.",
				mutationOutcome: "not_started",
				trigger: "scheduled",
			},
			log as never,
		);

		const active = rows.filter((event) => event.actionId === "oldest-active");
		expect(active.length).toBeLessThanOrEqual(1_000);
		expect(active.some((event) => event.eventType === "candidate_selected")).toBe(true);
		expect(active.some((event) => event.eventType === "retry_pending")).toBe(true);
	});

	it("uses the actual post-trim count when required evidence overlaps the recent window", async () => {
		const requiredTail = [
			"approval_pending",
			"approval_approved",
			"execution_claimed",
			"mutation_prepared",
			"execution_deferred",
			"execution_incomplete",
			"retry_pending",
			"recovery_transition",
			"candidate_selected",
			"terminal_succeeded",
		];
		const initial: StoredEvent[] = [];
		for (let id = 1; id <= 1_100; id++) {
			initial.push(
				seedEvent(id, "overlap-closed", requiredTail[id - 1_091] ?? "candidate_selected"),
			);
		}
		let id = 1_101;
		for (let timeline = 0; timeline < 10; timeline++) {
			for (let eventIndex = 0; eventIndex < 1_000; eventIndex++) {
				initial.push(
					seedEvent(
						id++,
						`closed-overlap-${timeline}`,
						eventIndex === 999 ? "terminal_succeeded" : "candidate_selected",
					),
				);
			}
		}
		const { prisma, rows } = makeAuditPrisma(initial);

		await recordApprovalRecoveryTransition(
			prisma as never,
			{
				approval: approval({ id: "overlap-append", status: "pending" }),
				correlationId: "overlap-retention",
				fromStatus: "approved",
				toStatus: "pending",
				reason: "Recovered.",
				mutationOutcome: "not_started",
				trigger: "scheduled",
			},
			log as never,
		);

		expect(rows.length).toBeLessThanOrEqual(10_000);
		expect(rows.some((event) => event.actionId === "overlap-append")).toBe(true);
	});

	it("compacts the oldest nonterminal timeline to exactly the global event cap", async () => {
		const initial: StoredEvent[] = [];
		let id = 1;
		for (let timeline = 0; timeline < 10; timeline++) {
			for (let eventIndex = 0; eventIndex < 1_000; eventIndex++) {
				initial.push(
					seedEvent(
						id++,
						`active-${timeline}`,
						eventIndex === 0
							? "candidate_selected"
							: eventIndex === 998
								? "mutation_prepared"
								: eventIndex === 999
									? "retry_pending"
									: "execution_claimed",
					),
				);
			}
		}
		for (let eventIndex = 0; eventIndex < 7; eventIndex++) {
			initial.push(
				seedEvent(id++, "active-tail", eventIndex === 6 ? "retry_pending" : "execution_claimed"),
			);
		}
		const { prisma, rows } = makeAuditPrisma(initial);

		await recordApprovalRecoveryTransition(
			prisma as never,
			{
				approval: approval({ id: "cap-append", status: "pending" }),
				correlationId: "exact-global-cap",
				fromStatus: "approved",
				toStatus: "pending",
				reason: "Recovered.",
				mutationOutcome: "not_started",
				trigger: "scheduled",
			},
			log as never,
		);

		expect(rows).toHaveLength(10_000);
		const oldest = rows.filter((event) => event.actionId === "active-0");
		expect(oldest).toHaveLength(992);
		expect(oldest.some((event) => event.eventType === "candidate_selected")).toBe(true);
		expect(oldest.some((event) => event.eventType === "mutation_prepared")).toBe(true);
		expect(oldest.some((event) => event.eventType === "retry_pending")).toBe(true);
		expect(rows.some((event) => event.actionId === "cap-append")).toBe(true);
	});

	it("enforces the hard cap when protected pending evidence alone exceeds it", async () => {
		const initial: StoredEvent[] = [];
		let id = 1;
		for (let timeline = 0; timeline < 5_001; timeline++) {
			initial.push(seedEvent(id++, `pending-${timeline}`, "candidate_selected"));
			initial.push(seedEvent(id++, `pending-${timeline}`, "approval_pending"));
		}
		const { prisma, rows } = makeAuditPrisma(initial);

		await recordApprovalRecoveryTransition(
			prisma as never,
			{
				approval: approval({ id: "overflow-recovery", status: "pending" }),
				correlationId: "protected-overflow",
				fromStatus: "approved",
				toStatus: "pending",
				reason: "Recovered without changing approval authority.",
				mutationOutcome: "not_started",
				trigger: "scheduled",
			},
			log as never,
		);

		expect(rows).toHaveLength(10_000);
		expect(rows.some((event) => event.actionId === "pending-0")).toBe(false);
		expect(rows.filter((event) => event.actionId === "pending-1")).toHaveLength(1);
		expect(rows.some((event) => event.actionId === "overflow-recovery")).toBe(true);
		expect(
			rows.some((event) =>
				["terminal_succeeded", "reconciled_without_mutation", "safety_blocked"].includes(
					event.eventType,
				),
			),
		).toBe(false);
	});

	it("serializes a concurrent append with retention so the append is never deleted", async () => {
		const initial = [
			seedEvent(1, "old", "candidate_selected"),
			seedEvent(2, "old", "retry_pending"),
		];
		for (let id = 3; id <= 10_001; id++)
			initial.push(
				seedEvent(id, "closed", id === 10_001 ? "terminal_succeeded" : "candidate_selected"),
			);
		const { prisma, rows } = makeAuditPrisma(initial);

		await Promise.all([
			recordApprovalRecoveryTransition(
				prisma as never,
				{
					approval: approval({ id: "old", status: "pending" }),
					correlationId: "concurrent-old",
					fromStatus: "approved",
					toStatus: "pending",
					reason: "Concurrent recovery.",
					mutationOutcome: "not_started",
					trigger: "scheduled",
				},
				log as never,
			),
			recordApprovalRecoveryTransition(
				prisma as never,
				{
					approval: approval({ id: "new", status: "pending" }),
					correlationId: "concurrent-new",
					fromStatus: "approved",
					toStatus: "pending",
					reason: "Concurrent recovery.",
					mutationOutcome: "not_started",
					trigger: "scheduled",
				},
				log as never,
			),
		]);

		expect(rows.some((event) => event.eventKey.includes("concurrent-old"))).toBe(true);
		expect(rows.some((event) => event.eventKey.includes("concurrent-new"))).toBe(true);
		expect(rows.filter((event) => event.actionId === "old").length).toBeGreaterThanOrEqual(3);
	});
});
