import { describe, expect, it } from "vitest";
import {
	appendCleanupAuditEvent,
	createCleanupAuditEventKey,
	CleanupAuditEventConflictError,
	CleanupAuditOwnershipError,
	listCleanupAuditEvents,
	listCleanupAuditTimeline,
} from "../cleanup-audit.js";

type StoredEvent = {
	id: string;
	configId: string;
	eventKey: string;
	actionId: string;
	correlationId: string;
	actionSequence: number;
	eventOrder: number;
	actorType: string;
	actorId: string | null;
	trigger: string;
	target: string;
	outcome: string;
	evidence: string;
	details: string | null;
	fingerprint: string;
	createdAt: Date;
};

function eventInput(overrides: Partial<Parameters<typeof appendCleanupAuditEvent>[1]> = {}) {
	return {
		userId: "user-a",
		configId: "config-a",
		eventKey: "event-1",
		actionId: "action-1",
		correlationId: "run-1",
		actorType: "system" as const,
		actorId: null,
		eventType: "claim" as const,
		trigger: "scheduled" as const,
		target: { kind: "approval", id: "approval-1" },
		outcome: "success" as const,
		evidence: { authority: "verified", dryRun: false },
		details: { attempt: 1 },
		...overrides,
	};
}

function createAuditStore(options: { configOwner?: string } = {}) {
	const rows: StoredEvent[] = [];
	const configOwner = options.configOwner ?? "user-a";

	return {
		rows,
		libraryCleanupConfig: {
			findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
				where.id === "config-a" && where.userId === configOwner
					? { id: "config-a", userId: configOwner }
					: null,
		},
		libraryCleanupAuditEvent: {
			findFirst: async ({
				where,
				orderBy,
			}: {
				where: { configId: string; eventKey?: string; actionId?: string };
				orderBy?: { actionSequence?: "desc" };
			}) => {
				const matches = rows.filter(
					(row) =>
						row.configId === where.configId &&
						(where.eventKey === undefined || row.eventKey === where.eventKey) &&
						(where.actionId === undefined || row.actionId === where.actionId),
				);
				return orderBy?.actionSequence === "desc"
					? ([...matches].sort((left, right) => right.actionSequence - left.actionSequence)[0] ??
							null)
					: (matches[0] ?? null);
			},
			create: async ({ data }: { data: Omit<StoredEvent, "id" | "eventOrder" | "createdAt"> }) => {
				if (rows.some((row) => row.configId === data.configId && row.eventKey === data.eventKey)) {
					throw { code: "P2002" };
				}
				if (
					rows.some(
						(row) =>
							row.configId === data.configId &&
							row.actionId === data.actionId &&
							row.actionSequence === data.actionSequence,
					)
				) {
					throw { code: "P2002" };
				}
				const row = {
					...data,
					id: `audit-${rows.length + 1}`,
					eventOrder: rows.length + 1,
					createdAt: new Date(`2026-08-12T00:00:0${rows.length}.000Z`),
				};
				rows.push(row);
				return row;
			},
			findMany: async ({
				where,
				take,
				cursor,
				skip,
			}: {
				where: {
					configId: string;
					correlationId?: string;
					eventOrder?: { gt: number };
				};
				take: number;
				cursor?: { eventOrder: number };
				skip?: number;
			}) => {
				const after = cursor?.eventOrder ?? where.eventOrder?.gt ?? 0;
				return rows
					.filter(
						(row) =>
							row.configId === where.configId &&
							(where.correlationId === undefined || row.correlationId === where.correlationId) &&
							row.eventOrder > after,
					)
					.sort((left, right) => left.eventOrder - right.eventOrder)
					.slice(skip ? 1 : 0, (skip ? 1 : 0) + take);
			},
		},
	};
}

describe("cleanup audit writer", () => {
	it("builds bounded deterministic event keys for long durable action IDs", () => {
		const input = {
			actionId: `mutation-intent:${"a".repeat(220)}`,
			correlationId: `proposal:${"b".repeat(220)}`,
			eventType: "proposal_created" as const,
		};

		const key = createCleanupAuditEventKey(input);

		expect(key.length).toBeLessThanOrEqual(256);
		expect(key).toBe(createCleanupAuditEventKey(input));
		expect(key).toContain("proposal_created");
		expect(createCleanupAuditEventKey({ ...input, eventType: "claim" })).not.toBe(key);
	});

	it("assigns database order and a per-action sequence without accepting either from callers", async () => {
		const prisma = createAuditStore();

		const first = await appendCleanupAuditEvent(prisma as never, eventInput());
		const second = await appendCleanupAuditEvent(
			prisma as never,
			eventInput({ eventKey: "event-2", correlationId: "run-2" }),
		);

		expect(first.order).toBe(1);
		expect(first.actionSequence).toBe(1);
		expect(second.order).toBe(2);
		expect(second.actionSequence).toBe(2);
	});

	it("keeps lifecycle event type distinct from its trigger and exposes validated target metadata", async () => {
		const prisma = createAuditStore();

		const event = await appendCleanupAuditEvent(
			prisma as never,
			eventInput({
				eventType: "mutation_started",
				trigger: "recovery",
				target: {
					kind: "approval",
					id: "approval-1",
					instanceId: "radarr-1",
					itemType: "movie",
					arrItemId: 42,
					targetScope: "series",
				},
			}),
		);

		expect(event).toMatchObject({
			actorType: "system",
			actorId: null,
			eventType: "mutation_started",
			trigger: "recovery",
			target: {
				kind: "approval",
				instanceId: "radarr-1",
				itemType: "movie",
				arrItemId: 42,
				targetScope: "series",
			},
		});
	});

	it("records exact episode and activity identity without putting operator data in arbitrary JSON", async () => {
		const prisma = createAuditStore();
		const proposal = await appendCleanupAuditEvent(
			prisma as never,
			{
				...eventInput({
					eventType: "proposal_created" as never,
					target: {
						kind: "approval",
						id: "approval-1",
						instanceId: "sonarr-1",
						itemType: "series",
						arrItemId: 100,
						arrEpisodeId: 200,
						targetScope: "episode",
					} as never,
				}),
				summary: {
					title: "Example Show",
					ruleId: "rule-1",
					ruleName: "Expired episodes",
					action: "delete_files",
					reason: "Episode is outside the configured retention window",
				},
			} as never,
		);
		const review = await appendCleanupAuditEvent(
			prisma as never,
			eventInput({ eventKey: "event-2", eventType: "approval_reviewed" as never }),
		);

		expect(proposal).toMatchObject({
			eventType: "proposal_created",
			target: { arrEpisodeId: 200, targetScope: "episode" },
			summary: {
				title: "Example Show",
				ruleId: "rule-1",
				action: "delete_files",
			},
		});
		expect(review).toMatchObject({ eventType: "approval_reviewed" });
	});

	it("bounds oversized display fields before they become audit payloads", async () => {
		const prisma = createAuditStore();

		const event = await appendCleanupAuditEvent(
			prisma as never,
			{
				...eventInput(),
				summary: { title: "t".repeat(600), reason: "r".repeat(1200) },
			} as never,
		);

		expect(event.summary.title).toHaveLength(512);
		expect(event.summary.title?.endsWith("…")).toBe(true);
		expect(event.summary.reason).toHaveLength(1024);
		expect(event.summary.reason?.endsWith("…")).toBe(true);
	});

	it("returns the original immutable row for an identical event key retry", async () => {
		const prisma = createAuditStore();

		const original = await appendCleanupAuditEvent(prisma as never, eventInput());
		const retry = await appendCleanupAuditEvent(prisma as never, eventInput());

		expect(retry).toEqual(original);
		expect(prisma.rows).toHaveLength(1);
	});

	it("rejects a changed event reused with the same key instead of overwriting history", async () => {
		const prisma = createAuditStore();
		await appendCleanupAuditEvent(prisma as never, eventInput());

		await expect(
			appendCleanupAuditEvent(
				prisma as never,
				eventInput({ outcome: "failed", details: { attempt: 2 } }),
			),
		).rejects.toBeInstanceOf(CleanupAuditEventConflictError);
		expect(prisma.rows).toHaveLength(1);
		expect(prisma.rows[0]?.outcome).toBe("success");
	});

	it("does not read or append audit rows through another user's cleanup configuration", async () => {
		const prisma = createAuditStore({ configOwner: "user-b" });

		await expect(appendCleanupAuditEvent(prisma as never, eventInput())).rejects.toBeInstanceOf(
			CleanupAuditOwnershipError,
		);
		await expect(
			listCleanupAuditEvents(prisma as never, {
				userId: "user-a",
				configId: "config-a",
				limit: 10,
			}),
		).rejects.toBeInstanceOf(CleanupAuditOwnershipError);
	});

	it("returns a bounded page in database order without exposing raw payload fields", async () => {
		const prisma = createAuditStore();
		for (const index of [1, 2, 3]) {
			await appendCleanupAuditEvent(
				prisma as never,
				eventInput({ eventKey: `event-${index}`, correlationId: `run-${index}` }),
			);
		}

		const page = await listCleanupAuditEvents(prisma as never, {
			userId: "user-a",
			configId: "config-a",
			limit: 2,
		});

		expect(page.events.map((event) => event.order)).toEqual([1, 2]);
		expect(page.nextCursor).toBe(2);
		expect(page.events[0]).not.toHaveProperty("payload");
	});

	it("returns a bounded correlation timeline scoped to the owning user and configuration", async () => {
		const prisma = createAuditStore();
		await appendCleanupAuditEvent(prisma as never, eventInput());
		await appendCleanupAuditEvent(
			prisma as never,
			eventInput({ eventKey: "event-2", correlationId: "run-2" }),
		);

		const timeline = await listCleanupAuditTimeline(prisma as never, {
			userId: "user-a",
			configId: "config-a",
			correlationId: "run-1",
			limit: 10,
		});

		expect(timeline.events.map((event) => event.eventKey)).toEqual(["event-1"]);
	});

	it("rejects details that could retain credentials or an upstream raw payload", async () => {
		const prisma = createAuditStore();

		await expect(
			appendCleanupAuditEvent(prisma as never, eventInput({ details: { apiKey: "not-allowed" } })),
		).rejects.toThrow("sensitive audit field");
		await expect(
			appendCleanupAuditEvent(
				prisma as never,
				eventInput({ evidence: { payload: "not-allowed" } }),
			),
		).rejects.toThrow("sensitive audit field");
	});

	it("rejects nested or undefined metadata instead of silently reshaping it", async () => {
		const prisma = createAuditStore();

		await expect(
			appendCleanupAuditEvent(
				prisma as never,
				eventInput({ evidence: { nested: { state: "verified" } } as never }),
			),
		).rejects.toThrow("metadata value");
		await expect(
			appendCleanupAuditEvent(
				prisma as never,
				eventInput({ evidence: { missing: undefined } as never }),
			),
		).rejects.toThrow("metadata value");
	});

	it("rejects target metadata outside the typed activity contract", async () => {
		const prisma = createAuditStore();

		await expect(
			appendCleanupAuditEvent(
				prisma as never,
				eventInput({
					target: { kind: "approval", itemType: "author" } as never,
				}),
			),
		).rejects.toThrow("target item type");
	});

	it("rejects lifecycle outcomes outside the public activity contract", async () => {
		const prisma = createAuditStore();

		await expect(
			appendCleanupAuditEvent(prisma as never, eventInput({ outcome: "succeeded" as never })),
		).rejects.toThrow("outcome");
	});

	it("bounds audit metadata keys and entry counts", async () => {
		const prisma = createAuditStore();

		await expect(
			appendCleanupAuditEvent(
				prisma as never,
				eventInput({ evidence: { ["x".repeat(257)]: true } }),
			),
		).rejects.toThrow("metadata key");
		await expect(
			appendCleanupAuditEvent(
				prisma as never,
				eventInput({
					evidence: Object.fromEntries(
						Array.from({ length: 33 }, (_, index) => [`field${index}`, index]),
					),
				}),
			),
		).rejects.toThrow("metadata entries");
	});
});
