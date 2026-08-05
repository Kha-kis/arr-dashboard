import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLibraryCleanupRoutes } from "../library-cleanup.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const condition = {
	ruleType: "age" as const,
	parameters: { operator: "older_than", days: 30 },
};
const storedExpression = {
	version: 1 as const,
	root: {
		type: "not" as const,
		child: { type: "condition" as const, ...condition },
	},
};

function makeRule(overrides: Record<string, unknown> = {}) {
	return {
		id: "rule-1",
		configId: "config-1",
		name: "Protected",
		enabled: false,
		priority: 9,
		ruleType: "composite",
		parameters: "{}",
		serviceFilter: JSON.stringify(["SONARR"]),
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		targetScope: "series",
		action: "unmonitor",
		scanMediaServerAfterDelete: false,
		operator: null,
		conditions: JSON.stringify(storedExpression),
		retentionMode: true,
		useGlobalRejectionMemory: false,
		rejectionMemoryDays: 30,
		createdAt: new Date("2026-07-30T00:00:00.000Z"),
		updatedAt: new Date("2026-07-30T00:00:00.000Z"),
		...overrides,
	};
}

describe("PUT /library-cleanup/rules/:id partial persistence", () => {
	let app: FastifyInstance;
	let existing: ReturnType<typeof makeRule>;
	let update: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		existing = makeRule();
		update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
			existing = {
				...existing,
				...data,
				updatedAt: new Date("2026-07-31T00:00:00.000Z"),
			};
			return existing;
		});

		app = Fastify({ logger: false });
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		app.decorate("prisma", {
			libraryCleanupRule: {
				findFirst: vi.fn(async () => existing),
				update,
			},
			libraryCleanupConfig: {
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
		} as never);
		app.decorate("arrClientFactory", {} as never);
		app.decorate("encryptor", {} as never);
		await app.register(registerLibraryCleanupRoutes);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("renames without changing disabled retention safety fields", async () => {
		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { name: "Renamed" },
		});

		expect(response.statusCode).toBe(200);
		expect(update).toHaveBeenCalledWith({
			where: { id: "rule-1" },
			data: { name: "Renamed" },
		});
		expect(response.json()).toMatchObject({
			name: "Renamed",
			enabled: false,
			priority: 9,
			action: "unmonitor",
			retentionMode: true,
			useGlobalRejectionMemory: false,
		});
	});

	it("preserves an enabled scan on sparse update and accepts explicit false", async () => {
		existing = makeRule({
			action: "delete",
			retentionMode: false,
			scanMediaServerAfterDelete: true,
		});
		const renamed = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { name: "Still scans" },
		});
		expect(renamed.statusCode).toBe(200);
		expect(update.mock.calls[0]?.[0].data).toEqual({ name: "Still scans" });
		expect(renamed.json().scanMediaServerAfterDelete).toBe(true);

		const disabled = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { scanMediaServerAfterDelete: false },
		});
		expect(disabled.statusCode).toBe(200);
		expect(update.mock.calls[1]?.[0].data).toEqual({ scanMediaServerAfterDelete: false });
	});

	it("treats undefined representation fields as omitted over authenticated JSON", async () => {
		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: {
				name: "Undefined fields omitted",
				expression: undefined,
				operator: undefined,
				conditions: undefined,
			},
		});

		expect(response.statusCode).toBe(200);
		expect(update.mock.calls[0]?.[0].data).toEqual({ name: "Undefined fields omitted" });
		expect(response.json().expression).toEqual(storedExpression);
	});

	it("updates a recursive expression without rewriting unrelated fields", async () => {
		const expression = {
			version: 1 as const,
			root: {
				type: "group" as const,
				operator: "OR" as const,
				children: [
					{ type: "condition" as const, ...condition },
					{
						type: "not" as const,
						child: {
							type: "condition" as const,
							ruleType: "no_file" as const,
							parameters: {},
						},
					},
				],
			},
		};
		const normalizedExpression = {
			...expression,
			root: {
				...expression.root,
				children: [
					{
						type: "condition" as const,
						...condition,
						parameters: {
							field: "arrAddedAt",
							...condition.parameters,
						},
					},
					expression.root.children[1]!,
				],
			},
		};

		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { expression },
		});

		expect(response.statusCode).toBe(200);
		expect(update.mock.calls[0]?.[0].data).toEqual({
			operator: null,
			conditions: JSON.stringify(normalizedExpression),
		});
		expect(response.json()).toMatchObject({
			enabled: false,
			priority: 9,
			action: "unmonitor",
			retentionMode: true,
			useGlobalRejectionMemory: false,
			expression: normalizedExpression,
		});
	});

	it("replaces recursive storage with legacy conditions without rewriting unrelated fields", async () => {
		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { operator: "AND", conditions: [condition] },
		});

		expect(response.statusCode).toBe(200);
		expect(update.mock.calls[0]?.[0].data).toEqual({
			operator: "AND",
			conditions: JSON.stringify([
				{ ...condition, parameters: { field: "arrAddedAt", ...condition.parameters } },
			]),
		});
		expect(response.json()).toMatchObject({
			enabled: false,
			priority: 9,
			action: "unmonitor",
			retentionMode: true,
			useGlobalRejectionMemory: false,
			operator: "AND",
			conditions: [{ ...condition, parameters: { field: "arrAddedAt", ...condition.parameters } }],
			expression: null,
		});
	});

	it("rejects explicitly clearing the only recursive representation", async () => {
		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { expression: null },
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().error).toContain("require an expression");
		expect(update).not.toHaveBeenCalled();
	});

	it("persists explicit null representation fields on a single rule without defaults", async () => {
		existing = makeRule({
			ruleType: "age",
			parameters: JSON.stringify(condition.parameters),
			operator: null,
			conditions: null,
		});

		const response = await createInjectAuthenticated(app)("PUT", "/library-cleanup/rules/rule-1", {
			body: { operator: null, conditions: null },
		});

		expect(response.statusCode).toBe(200);
		expect(update.mock.calls[0]?.[0].data).toEqual({
			operator: null,
			conditions: null,
		});
		expect(response.json()).toMatchObject({
			enabled: false,
			priority: 9,
			action: "unmonitor",
			retentionMode: true,
			useGlobalRejectionMemory: false,
		});
	});
});
