import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import { registerCustomFormatRoutes } from "../custom-format-routes.js";

const mocks = vi.hoisted(() => ({
	source: vi.fn(),
	fetcher: vi.fn(),
	version: vi.fn(),
	cacheSet: vi.fn(),
	lease: vi.fn(),
}));
vi.mock("../../../lib/trash-guides/github-fetcher.js", () => ({
	createTrashFetcher: mocks.fetcher,
}));
vi.mock("../../../lib/trash-guides/version-tracker.js", () => ({
	createVersionTracker: () => ({ getLatestCommit: mocks.version }),
}));
vi.mock("../../../lib/trash-guides/cache-manager.js", () => ({
	createCacheManager: () => ({
		isFresh: async () => false,
		get: async () => null,
		set: mocks.cacheSet,
	}),
}));
vi.mock("../../../lib/library-cleanup/cleanup-executor.js", () => ({
	withRenewableCleanupTopologyMutationLease: async (
		_deps: unknown,
		_user: unknown,
		callback: (lease: unknown) => unknown,
	) => callback({ assertOwnership: mocks.lease }),
	withCleanupTopologyMutationLease: async (
		_deps: unknown,
		_user: unknown,
		callback: () => unknown,
	) => callback(),
}));

const format = (trash_id = "selected", name = "Selected") => ({
	trash_id,
	name,
	specifications: [],
});
const instance = {
	id: "instance-1",
	userId: "user-1",
	service: "RADARR",
	enabled: true,
	baseUrl: "http://synthetic.invalid",
	encryptedApiKey: "key",
	encryptionIv: "iv",
	connectionGeneration: 1,
};

describe("standalone custom-format publication admission", () => {
	let app: FastifyInstance;
	let prisma: any;
	let client: any;
	let active = false;
	const wire = new Map<number, any>();
	beforeEach(async () => {
		vi.clearAllMocks();
		active = false;
		wire.clear();
		mocks.source.mockResolvedValue([format()]);
		mocks.fetcher.mockImplementation(() => ({
			fetchConfigs: mocks.source,
			fetchConfigsAtCommit: mocks.source,
		}));
		mocks.version.mockResolvedValue({ commitHash: "a".repeat(40) });
		mocks.lease.mockResolvedValue(undefined);
		prisma = {
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue(instance),
				findMany: vi.fn().mockResolvedValue([instance]),
			},
			trashSettings: { findUnique: vi.fn().mockResolvedValue(null) },
			trashCache: { findFirst: vi.fn().mockResolvedValue({ commitHash: "old" }) },
			standaloneCFDeployment: {
				upsert: vi.fn().mockResolvedValue({}),
				findMany: vi.fn().mockResolvedValue([]),
			},
			trashSyncHistory: {
				findMany: vi.fn().mockResolvedValue([]),
				create: vi.fn().mockResolvedValue({ id: "history-1" }),
				update: vi.fn().mockResolvedValue({}),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
		};
		client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([]),
				getById: vi.fn(async (id) => wire.get(id)),
				create: vi.fn(async (body) => {
					const id = wire.size + 1;
					const result = { id, ...body };
					wire.set(id, result);
					return result;
				}),
				update: vi.fn(async (id, body) => {
					const result = { id, ...body };
					wire.set(id, result);
					return result;
				}),
			},
		};
		app = Fastify();
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		app.decorate("prisma", prisma);
		app.decorate("arrClientFactory", {
			create: () => client,
			createConnectionCredentialIdentity: () => "identity",
		} as never);
		app.decorate("deploymentExecutor", {
			runWithEndpointMutation: async (
				_user: string,
				_instance: unknown,
				_operation: string,
				action: () => unknown,
			) => {
				if (active) throw Object.assign(new Error("Operation active"), { statusCode: 409 });
				active = true;
				try {
					return await action();
				} finally {
					active = false;
				}
			},
		} as never);
		await app.register(registerCustomFormatRoutes);
	});
	afterEach(async () => {
		await app.close();
	});
	const payload = (trashIds: string[] = ["selected"]) => ({
		instanceId: instance.id,
		serviceType: "RADARR",
		trashIds,
	});
	it("refuses an incomplete selected set before any provider write or cache publication", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(["selected", "missing"]),
		});
		expect(response.statusCode).toBe(409);
		expect(client.customFormat.create).not.toHaveBeenCalled();
		expect(client.customFormat.update).not.toHaveBeenCalled();
		expect(mocks.cacheSet).not.toHaveBeenCalled();
	});
	it.each(
		[[], [format(), format()], [format(), format("other", "Selected")]].map((data) => ({ data })),
	)("refuses empty or ambiguous current source %j", async ({ data }) => {
		mocks.source.mockResolvedValue(data);
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(),
		});
		expect(response.statusCode).toBe(409);
		expect(client.customFormat.create).not.toHaveBeenCalled();
		expect(mocks.cacheSet).not.toHaveBeenCalled();
	});
	it("requires strict pinned reads and never replaces the previous cache on retrieval failure", async () => {
		mocks.source.mockRejectedValue(new Error("late file missing"));
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(),
		});
		expect(response.statusCode).toBe(500);
		expect(mocks.fetcher).toHaveBeenCalledWith(expect.objectContaining({ strictContent: true }));
		expect(mocks.source).toHaveBeenCalledWith("RADARR", "CUSTOM_FORMATS", "a".repeat(40));
		expect(mocks.cacheSet).not.toHaveBeenCalled();
		expect(client.customFormat.create).not.toHaveBeenCalled();
	});
	it("pins and merges official/custom sources separately in supplementary mode", async () => {
		prisma.trashSettings.findUnique.mockResolvedValue({
			customRepoOwner: "synthetic",
			customRepoName: "guides",
			customRepoBranch: "custom",
			customRepoMode: "supplementary",
		});
		mocks.source
			.mockResolvedValueOnce([format()])
			.mockResolvedValueOnce([format("selected", "Override")]);
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(),
		});
		expect(response.json()).toMatchObject({ success: true, created: ["Override"] });
		expect(mocks.fetcher).toHaveBeenCalledTimes(2);
		expect(
			mocks.fetcher.mock.calls.every(
				([options]) =>
					options.strictContent === true && options.repoConfig.mode !== "supplementary",
			),
		).toBe(true);
		expect(mocks.cacheSet).not.toHaveBeenCalled();
	});
	it("refuses duplicate requested IDs without source or target calls", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(["selected", "selected"]),
		});
		expect(response.statusCode).toBe(409);
		expect(mocks.source).not.toHaveBeenCalled();
		expect(client.customFormat.getAll).not.toHaveBeenCalled();
	});
	it.each(
		[
			[
				{ id: 1, name: "Selected" },
				{ id: 2, name: "Selected" },
			],
			[
				{ id: 1, name: "Selected" },
				{ id: 1, name: "Other" },
			],
			[
				{
					id: 1,
					name: "Selected",
					specifications: [{ fields: [{ name: "trash_id", value: "another-id" }] }],
				},
			],
		].map((existing) => ({ existing })),
	)("refuses duplicate or conflicting upstream identity %j", async ({ existing }) => {
		client.customFormat.getAll.mockResolvedValue(existing);
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(),
		});
		expect(response.statusCode).toBe(409);
		expect(client.customFormat.create).not.toHaveBeenCalled();
		expect(client.customFormat.update).not.toHaveBeenCalled();
	});
	it("re-fetches and preserves the full upstream resource before an update", async () => {
		const current = { id: 7, name: "Selected", specifications: [], customFlag: "preserve" };
		client.customFormat.getAll.mockResolvedValue([current]);
		client.customFormat.getById.mockResolvedValueOnce(current);
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(),
		});
		expect(response.json()).toMatchObject({
			success: true,
			updated: ["Selected"],
			targets: [{ trashId: "selected", status: "updated", tracked: true }],
		});
		expect(client.customFormat.getById).toHaveBeenCalledWith(7);
		expect(client.customFormat.update).toHaveBeenCalledWith(
			7,
			expect.objectContaining({ customFlag: "preserve" }),
		);
	});
	it.each(["connection", "source"])("refuses %s drift before a provider write", async (kind) => {
		mocks.source.mockImplementation(async () => {
			if (kind === "connection")
				prisma.serviceInstance.findFirst.mockResolvedValue({
					...instance,
					connectionGeneration: 2,
				});
			else prisma.trashSettings.findUnique.mockResolvedValue({ customRepoOwner: "changed" });
			return [format()];
		});
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(),
		});
		expect(response.statusCode).toBe(409);
		expect(client.customFormat.create).not.toHaveBeenCalled();
		expect(prisma.trashSyncHistory.create).not.toHaveBeenCalled();
	});
	it("honors a pending operation on an equivalent endpoint", async () => {
		prisma.serviceInstance.findMany.mockResolvedValue([instance, { ...instance, id: "alias" }]);
		prisma.trashSyncHistory.findMany.mockResolvedValue([{ status: "UNCERTAIN", backup: null }]);
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(),
		});
		expect(response.statusCode).toBe(400);
		expect(prisma.trashSyncHistory.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "user-1",
					instanceId: { in: [instance.id, "alias"] },
				}),
			}),
		);
		expect(mocks.source).not.toHaveBeenCalled();
		expect(client.customFormat.create).not.toHaveBeenCalled();
	});
	it("records uncertain write and skipped remaining IDs without replay", async () => {
		mocks.source.mockResolvedValue([format(), format("next", "Next")]);
		client.customFormat.create.mockRejectedValue(new Error("response lost"));
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(["selected", "next"]),
		});
		expect(response.json()).toMatchObject({
			success: false,
			outcome: "uncertain",
			created: [],
			targets: [
				{ trashId: "selected", status: "uncertain" },
				{ trashId: "next", status: "skipped" },
			],
		});
		expect(client.customFormat.create).toHaveBeenCalledTimes(1);
		expect(prisma.standaloneCFDeployment.upsert).not.toHaveBeenCalled();
		expect(prisma.trashSyncHistory.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "UNCERTAIN", configsSkipped: 1 }),
			}),
		);
	});
	it("retains acknowledged success separately from tracking failure", async () => {
		prisma.standaloneCFDeployment.upsert.mockRejectedValue(new Error("database unavailable"));
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(),
		});
		expect(response.json()).toMatchObject({
			success: false,
			outcome: "uncertain",
			created: ["Selected"],
			targets: [{ status: "created", tracked: false }],
		});
		expect(client.customFormat.create).toHaveBeenCalledTimes(1);
		expect(prisma.trashSyncHistory.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "UNCERTAIN", configsApplied: 1 }),
			}),
		);
	});
	it("does not report full success when history finalization fails", async () => {
		prisma.trashSyncHistory.updateMany.mockRejectedValue(new Error("database unavailable"));
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(),
		});
		expect(response.json()).toMatchObject({
			success: false,
			outcome: "uncertain",
			created: ["Selected"],
		});
		expect(client.customFormat.create).toHaveBeenCalledTimes(1);
	});
	it("bounds mutations to one call and rejects overlapping invocations", async () => {
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0,
			peak = 0;
		mocks.source.mockResolvedValue([format(), format("next", "Next")]);
		client.customFormat.create.mockImplementation(async (body: unknown) => {
			const id = wire.size + 1;
			wire.set(id, { id, ...(body as object) });
			calls++;
			peak = Math.max(peak, calls);
			entered();
			await held;
			calls--;
			return wire.get(id);
		});
		const first = createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(["selected", "next"]),
		});
		await started;
		const second = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(),
		});
		expect(second.statusCode).toBe(409);
		release();
		expect((await first).json().success).toBe(true);
		expect(peak).toBe(1);
		expect(client.customFormat.create).toHaveBeenCalledTimes(2);
	});
	it("refuses unverified post-write state and leaves an actionable durable hold", async () => {
		client.customFormat.getById.mockResolvedValue({ id: 1, name: "Different", specifications: [] });
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(),
		});
		expect(response.json()).toMatchObject({
			success: false,
			outcome: "uncertain",
			created: [],
			targets: [{ status: "uncertain", tracked: false }],
		});
		expect(prisma.standaloneCFDeployment.upsert).not.toHaveBeenCalled();
		expect(prisma.trashSyncHistory.create).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "UNCERTAIN" }) }),
		);
	});
	it("recognizes an already-satisfied canonical state without another provider write", async () => {
		const current = {
			id: 7,
			name: "Selected",
			includeCustomFormatWhenRenaming: false,
			specifications: [],
		};
		client.customFormat.getAll.mockResolvedValue([current]);
		client.customFormat.getById.mockResolvedValue(current);
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(),
		});
		expect(response.json()).toMatchObject({
			success: true,
			unchanged: ["Selected"],
			targets: [{ status: "unchanged", tracked: true }],
		});
		expect(client.customFormat.update).not.toHaveBeenCalled();
		expect(client.customFormat.create).not.toHaveBeenCalled();
	});
	it.each(["RADARR", "SONARR"])(
		"accepts only supported %s language default materialization",
		async (serviceType) => {
			prisma.serviceInstance.findFirst.mockResolvedValue({ ...instance, service: serviceType });
			prisma.serviceInstance.findMany.mockResolvedValue([{ ...instance, service: serviceType }]);
			mocks.source.mockResolvedValue([
				{
					...format(),
					specifications: [
						{
							name: "Language",
							implementation: "LanguageSpecification",
							negate: false,
							required: true,
							fields: { value: 1 },
						},
					],
				},
			]);
			client.customFormat.getById.mockImplementation(async (id: number) => {
				const current = structuredClone(wire.get(id));
				current.specifications[0].fields.push({ name: "exceptLanguage", value: false });
				return current;
			});
			const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
				body: { ...payload(), serviceType },
			});
			expect(response.json().success).toBe(true);
		},
	);
	it.each(["same", "legacy", "changed-repo", "changed-commit"])(
		"keeps update comparison source-aware: %s",
		async (variant) => {
			const sources = [
				{
					repository: variant === "changed-repo" ? "other/repo" : "trash-guides/guides",
					branch: "master",
					commitHash: variant === "changed-commit" ? "b".repeat(40) : "a".repeat(40),
				},
			];
			prisma.standaloneCFDeployment.findMany.mockResolvedValue([
				{
					cfTrashId: "selected",
					cfName: "Selected",
					instanceId: instance.id,
					serviceType: "RADARR",
					instance: { label: "Synthetic" },
					commitHash:
						variant === "legacy" ? "a".repeat(40) : JSON.stringify({ version: 1, sources }),
				},
			]);
			const response = await createInjectAuthenticated(app)("GET", "/standalone-updates");
			expect(response.json().hasUpdates).toBe(variant === "changed-commit");
			expect(response.json().unknownDeployments).toHaveLength(
				variant === "legacy" || variant === "changed-repo" ? 1 : 0,
			);
			expect(prisma.trashCache.findFirst).not.toHaveBeenCalled();
		},
	);
	it("refuses lost topology lease after source wait before creating a hold or sending", async () => {
		mocks.source.mockImplementation(async () => {
			mocks.lease.mockRejectedValue(new Error("Execution lease lost"));
			return [format()];
		});
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(),
		});
		expect(response.statusCode).toBe(500);
		expect(client.customFormat.create).not.toHaveBeenCalled();
		expect(prisma.trashSyncHistory.create).not.toHaveBeenCalled();
	});
	it("stops tracking and later sends when lease is lost during a provider request", async () => {
		mocks.source.mockResolvedValue([format(), format("next", "Next")]);
		client.customFormat.create.mockImplementation(async (body: object) => {
			wire.set(1, { id: 1, ...body });
			mocks.lease.mockRejectedValue(new Error("Execution lease lost"));
			return wire.get(1);
		});
		const response = await createInjectAuthenticated(app)("POST", "/deploy-multiple", {
			body: payload(["selected", "next"]),
		});
		expect(response.json()).toMatchObject({
			success: false,
			outcome: "uncertain",
			created: [],
			targets: [{ status: "uncertain" }, { status: "skipped" }],
		});
		expect(client.customFormat.create).toHaveBeenCalledTimes(1);
		expect(prisma.standaloneCFDeployment.upsert).not.toHaveBeenCalled();
		expect(prisma.trashSyncHistory.updateMany).not.toHaveBeenCalled();
	});
});
