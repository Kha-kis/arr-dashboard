/**
 * GET /api/automation/rules — the composer's v1 read surface (charter §5.1).
 *
 * Asserts the boundary contract: every domain's stored (v0) rules are served
 * normalized to v1, retired/unknown kinds are annotated (not dropped), and an
 * unparseable row is surfaced honestly rather than 500'd. Ownership scoping is
 * exercised through the stubbed Prisma `where` clauses.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAutomationRoutes } from "../automation.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

type CriteriaRow = {
	id: string;
	name: string;
	enabled: boolean;
	ruleType: string;
	parameters: string;
	operator: string | null;
	conditions: string | null;
};
type NotificationRow = {
	id: string;
	name: string;
	enabled: boolean;
	conditions: string;
};

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let userCounter = 0;

let cleanupRules: CriteriaRow[];
let autoTagRules: CriteriaRow[];
let notificationRules: NotificationRow[];
// Records the `where` each surface was queried with, to assert ownership scoping.
let queriedWith: Record<string, unknown>;

beforeEach(async () => {
	userCounter += 1;
	cleanupRules = [];
	autoTagRules = [];
	notificationRules = [];
	queriedWith = {};

	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: `user-automation-${userCounter}`, username: "admin" });
	app.decorate("prisma", {
		libraryCleanupRule: {
			findMany: async (args: { where: unknown }) => {
				queriedWith.cleanup = args.where;
				return cleanupRules;
			},
		},
		autoTagRule: {
			findMany: async (args: { where: unknown }) => {
				queriedWith.autoTag = args.where;
				return autoTagRules;
			},
		},
		notificationRule: {
			findMany: async (args: { where: unknown }) => {
				queriedWith.notification = args.where;
				return notificationRules;
			},
		},
	} as unknown as never);
	await app.register(registerAutomationRoutes);
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app?.close();
});

async function getRules() {
	const res = await injectAuthenticated("GET", "/automation/rules");
	expect(res.statusCode).toBe(200);
	return JSON.parse(res.payload).rules as Array<Record<string, unknown>>;
}

describe("GET /api/automation/rules", () => {
	it("scopes each surface to the current user (cleanup via config.userId)", async () => {
		const expectedUser = `user-automation-${userCounter}`;
		await getRules();
		expect(queriedWith.cleanup).toEqual({ config: { userId: expectedUser } });
		expect(queriedWith.autoTag).toEqual({ userId: expectedUser });
		expect(queriedWith.notification).toEqual({ userId: expectedUser });
	});

	it("maps a single criteria rule to a v1 predicate document", async () => {
		cleanupRules = [
			{
				id: "c1",
				name: "Old movies",
				enabled: true,
				ruleType: "age",
				parameters: JSON.stringify({ operator: "older_than", days: 30 }),
				operator: null,
				conditions: null,
			},
		];

		const rule = (await getRules())[0]!;
		expect(rule).toMatchObject({
			id: "c1",
			context: "library-cleanup",
			unparseable: false,
			unavailableKinds: [],
			document: {
				version: 1,
				root: { kind: "age", params: { operator: "older_than", days: 30 } },
			},
		});
	});

	it("maps a composite criteria rule to an all/any group", async () => {
		autoTagRules = [
			{
				id: "a1",
				name: "Action 2020+",
				enabled: true,
				ruleType: "composite",
				parameters: "{}",
				operator: "AND",
				conditions: JSON.stringify([
					{ ruleType: "genre", parameters: { genres: ["Action"] } },
					{ ruleType: "year_range", parameters: { from: 2020, to: 2024 } },
				]),
			},
		];

		const rule = (await getRules())[0]!;
		expect(rule.context).toBe("auto-tag");
		expect(rule.document).toMatchObject({
			version: 1,
			root: {
				all: [
					{ kind: "genre", params: { genres: ["Action"] } },
					{ kind: "year_range", params: { from: 2020, to: 2024 } },
				],
			},
		});
	});

	it("maps a notifications rule to field_match predicates", async () => {
		notificationRules = [
			{
				id: "n1",
				name: "Hunt done",
				enabled: false,
				conditions: JSON.stringify([
					{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
				]),
			},
		];

		const rule = (await getRules())[0]!;
		expect(rule).toMatchObject({
			id: "n1",
			enabled: false,
			context: "notifications",
			unparseable: false,
			document: {
				version: 1,
				root: {
					all: [
						{
							kind: "field_match",
							params: { field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
						},
					],
				},
			},
		});
	});

	it("annotates retired/unknown kinds without dropping the rule", async () => {
		cleanupRules = [
			{
				id: "c-retired",
				name: "Legacy rule",
				enabled: true,
				ruleType: "totally_unknown_kind",
				parameters: "{}",
				operator: null,
				conditions: null,
			},
		];

		const rule = (await getRules())[0]!;
		expect(rule.unparseable).toBe(false);
		expect(rule.unavailableKinds).toEqual(["totally_unknown_kind"]);
		expect(rule.document).toMatchObject({
			root: { kind: "totally_unknown_kind", unavailableKind: true },
		});
	});

	it("surfaces an unparseable rule honestly (document null, flagged)", async () => {
		cleanupRules = [
			{
				id: "c-bad",
				name: "Broken rule",
				enabled: true,
				ruleType: "age",
				parameters: "not valid json {",
				operator: null,
				conditions: null,
			},
		];

		const rule = (await getRules())[0]!;
		expect(rule).toMatchObject({
			id: "c-bad",
			name: "Broken rule",
			unparseable: true,
			document: null,
			unavailableKinds: [],
		});
	});

	it("returns rules from all three surfaces together", async () => {
		cleanupRules = [
			{
				id: "c1",
				name: "c",
				enabled: true,
				ruleType: "age",
				parameters: "{}",
				operator: null,
				conditions: null,
			},
		];
		autoTagRules = [
			{
				id: "a1",
				name: "a",
				enabled: true,
				ruleType: "genre",
				parameters: "{}",
				operator: null,
				conditions: null,
			},
		];
		notificationRules = [{ id: "n1", name: "n", enabled: true, conditions: "[]" }];

		const rules = await getRules();
		expect(rules.map((r) => r.context).sort()).toEqual([
			"auto-tag",
			"library-cleanup",
			"notifications",
		]);
	});
});
