import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAutomationRoutes } from "../automation.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const USER_ID = "cross-user";
const draft = {
	name: "Archive workflow",
	document: {
		version: 1 as const,
		root: { kind: "age", params: { field: "arrAddedAt", operator: "older_than", days: 30 } },
	},
	scope: { serviceTypes: ["RADARR"], instanceIds: [] },
	actions: [{ type: "send_notification" }, { type: "exempt_cleanup" }] as const,
};

type Row = {
	id: string;
	userId: string;
	name: string;
	document: string;
	scope: string;
	actions: string;
	deployedName: string | null;
	deployedDocument: string | null;
	deployedScope: string | null;
	deployedActions: string | null;
	deploymentVersion: number;
	deployedAt: Date | null;
	dryRunFingerprint: string | null;
	lastDryRunAt: Date | null;
	lastRunAt: Date | null;
	lastRunStatus: string | null;
	lastRunMessage: string | null;
	createdAt: Date;
	updatedAt: Date;
};

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let row: Row | null;

beforeEach(async () => {
	row = null;
	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: USER_ID, username: "admin" });
	const crossDomainRule = {
		findMany: vi.fn(async () => (row ? [row] : [])),
		findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) =>
			row?.id === where.id && row.userId === where.userId ? row : null,
		),
		create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
			const now = new Date();
			row = {
				...(data as Row),
				id: "cross-1",
				userId: USER_ID,
				deployedDocument: null,
				deployedName: null,
				deployedScope: null,
				deployedActions: null,
				deploymentVersion: 0,
				deployedAt: null,
				dryRunFingerprint: null,
				lastDryRunAt: null,
				lastRunAt: null,
				lastRunStatus: null,
				lastRunMessage: null,
				createdAt: now,
				updatedAt: now,
			};
			return row;
		}),
		update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
			if (!row) throw new Error("missing row");
			const increment = (data.deploymentVersion as { increment?: number } | undefined)?.increment;
			row = {
				...row,
				...data,
				deploymentVersion: increment ? row.deploymentVersion + increment : row.deploymentVersion,
				updatedAt: new Date(),
			} as Row;
			return row;
		}),
		deleteMany: vi.fn(async () => ({ count: row ? 1 : 0 })),
	};
	const prisma = {
		crossDomainRule,
		crossDomainRuleMatch: {
			findMany: vi.fn(async () => []),
			deleteMany: vi.fn(async () => ({ count: 0 })),
		},
		serviceInstance: { findMany: vi.fn(async () => []) },
		libraryCleanupRule: { findMany: vi.fn(async () => []) },
		autoTagRule: { findMany: vi.fn(async () => []) },
		notificationRule: { findMany: vi.fn(async () => []) },
		$transaction: async (callback: (tx: unknown) => unknown) => callback(prisma),
	};
	app.decorate("prisma", prisma as never);
	app.decorate("arrClientFactory", {} as never);
	await app.register(registerAutomationRoutes);
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => app.close());

describe("cross-domain automation routes", () => {
	it("saves a draft without activating it", async () => {
		const response = await injectAuthenticated("POST", "/automation/cross-domain-rules", {
			body: draft,
		});
		expect(response.statusCode).toBe(201);
		expect(JSON.parse(response.payload).rule).toMatchObject({
			id: "cross-1",
			active: false,
			deploymentVersion: 0,
		});
		expect(row?.deployedDocument).toBeNull();
	});

	it("rejects deploy until the exact draft has been dry-run", async () => {
		await injectAuthenticated("POST", "/automation/cross-domain-rules", { body: draft });
		const response = await injectAuthenticated(
			"POST",
			"/automation/cross-domain-rules/cross-1/deploy",
		);
		expect(response.statusCode).toBe(409);
		expect(row?.deployedAt).toBeNull();
	});

	it("dry-runs without mutations, then atomically deploys the previewed snapshot", async () => {
		await injectAuthenticated("POST", "/automation/cross-domain-rules", { body: draft });
		const preview = await injectAuthenticated(
			"POST",
			"/automation/cross-domain-rules/cross-1/dry-run",
		);
		expect(preview.statusCode).toBe(200);
		expect(JSON.parse(preview.payload)).toMatchObject({ itemsEvaluated: 0, itemsMatched: 0 });
		expect(row?.deployedAt).toBeNull();
		expect(row?.dryRunFingerprint).toHaveLength(64);

		const deploy = await injectAuthenticated(
			"POST",
			"/automation/cross-domain-rules/cross-1/deploy",
		);
		expect(deploy.statusCode).toBe(200);
		expect(row?.deployedDocument).toBe(row?.document);
		expect(row?.deployedActions).toBe(row?.actions);
		expect(row?.deploymentVersion).toBe(1);
		expect(row?.deployedAt).toBeInstanceOf(Date);
		expect(row?.dryRunFingerprint).toBeNull();
	});

	it("editing an active rule preserves the deployed snapshot and invalidates its preview", async () => {
		await injectAuthenticated("POST", "/automation/cross-domain-rules", { body: draft });
		await injectAuthenticated("POST", "/automation/cross-domain-rules/cross-1/dry-run");
		await injectAuthenticated("POST", "/automation/cross-domain-rules/cross-1/deploy");
		const deployedDocument = row?.deployedDocument;

		const edited = { ...draft, name: "Revised workflow" };
		const response = await injectAuthenticated("PATCH", "/automation/cross-domain-rules/cross-1", {
			body: edited,
		});
		expect(response.statusCode).toBe(200);
		expect(row?.name).toBe("Revised workflow");
		expect(row?.deployedDocument).toBe(deployedDocument);
		expect(row?.dryRunFingerprint).toBeNull();
		expect(JSON.parse(response.payload).rule).toMatchObject({
			active: true,
			hasDraftChanges: true,
		});
	});

	it("deactivates the active snapshot while preserving the draft", async () => {
		await injectAuthenticated("POST", "/automation/cross-domain-rules", { body: draft });
		await injectAuthenticated("POST", "/automation/cross-domain-rules/cross-1/dry-run");
		await injectAuthenticated("POST", "/automation/cross-domain-rules/cross-1/deploy");

		const response = await injectAuthenticated(
			"POST",
			"/automation/cross-domain-rules/cross-1/deactivate",
		);
		expect(response.statusCode).toBe(200);
		expect(row?.document).toBe(JSON.stringify(draft.document));
		expect(row?.deployedDocument).toBeNull();
		expect(JSON.parse(response.payload).rule).toMatchObject({ active: false });
	});
});
