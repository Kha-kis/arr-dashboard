import { performance } from "node:perf_hooks";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import { TemplateUpdater } from "../../lib/trash-guides/template-updater.js";
import notificationServicePlugin from "../notification-service.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";
import trashUpdateSchedulerPlugin from "../trash-update-scheduler.js";

const apps: FastifyInstance[] = [];
const releases: Array<() => void> = [];
const tasks: Promise<unknown>[] = [];
type NativeFixture = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
const natives: NativeFixture[] = [];
const ownedRows = new Map<
	NativeFixture,
	{
		templates: Array<{ id: string; userId: string }>;
		mappings: Array<{ id: string; templateId: string; instanceId: string; userId: string }>;
	}
>();
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;
async function waitForNative(observation: () => boolean) {
	const deadline = performance.now() + 4_000;
	while (!observation()) {
		if (performance.now() >= deadline) return false;
		await settle();
	}
	return true;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	releases.push(resolve);
	return { promise, resolve };
}

async function settle() {
	for (let turn = 0; turn < 8; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

type Phase =
	| "repo"
	| "version"
	| "strategy"
	| "cache"
	| "auto"
	| "subscription"
	| "send"
	| "log"
	| "channel";
type Origin = "startup" | "interval" | "manual";

async function boot(
	options: {
		origin?: Origin;
		hold?: { phase: Phase; gate: Promise<void>; reject?: boolean };
		siblingFailure?: "strategy" | "cache";
		empty?: boolean;
		listen?: boolean;
	} = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	natives.push(native);
	ownedRows.set(native, { templates: [], mappings: [] });
	const state = {
		repo: 0,
		strategy: 0,
		cache: 0,
		auto: 0,
		subscription: 0,
		send: 0,
		log: 0,
		channel: 0,
		pending: 0,
		teardown: 0,
		pendingAtTeardown: -1,
		afterTeardown: 0,
		version: 0,
	};
	const entered = deferred();
	const events: string[] = [];
	let armed = options.origin === undefined || options.origin === "startup";
	let held = false;
	const pause = async (phase: Phase, eligible = true) => {
		state[phase]++;
		if (state.teardown) state.afterTeardown++;
		state.pending++;
		try {
			if (armed && eligible && !held && options.hold?.phase === phase) {
				held = true;
				entered.resolve();
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic update dependency failure");
			}
		} finally {
			if (state.teardown) state.afterTeardown++;
			state.pending--;
		}
	};

	const owned = ownedRows.get(native)!;
	let templateId = "";
	let instanceId = "";
	await native.run(async () => {
		await native.prisma.notificationSubscription.create({
			data: { channelId: native.channelId, eventType: "TRASH_SYNC_ERROR" },
		});
		const key = native.encryptor.encrypt("synthetic-provider-key");
		const instance = await native.prisma.serviceInstance.create({
			data: {
				userId: native.userId,
				service: "RADARR",
				label: "Synthetic instance",
				baseUrl: "https://example.invalid/synthetic-provider",
				encryptedApiKey: key.value,
				encryptionIv: key.iv,
			},
		});
		instanceId = instance.id;
		const template = await native.prisma.trashTemplate.create({
			data: {
				userId: native.userId,
				name: "Synthetic template",
				serviceType: "RADARR",
				configData: "{}",
				trashGuidesCommitHash: "synthetic-old-commit",
				deletedAt: armed && !options.empty ? null : new Date("2026-10-01T00:00:00.000Z"),
			},
		});
		templateId = template.id;
		owned.templates.push({ id: template.id, userId: native.userId });
		for (const [index, syncStrategy] of ["auto", "notify"].entries()) {
			const mapping = await native.prisma.templateQualityProfileMapping.create({
				data: {
					templateId,
					instanceId,
					qualityProfileId: index + 1,
					qualityProfileName: "Synthetic profile",
					syncStrategy,
				},
			});
			owned.mappings.push({ id: mapping.id, templateId, instanceId, userId: native.userId });
		}
	});
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime);
	const prisma = client.prisma;
	const repoRead = prisma.trashSettings.findFirst.bind(prisma.trashSettings);
	const repoReads: { findFirst: AwaitOnly<typeof prisma.trashSettings.findFirst> } =
		prisma.trashSettings;
	vi.spyOn(repoReads, "findFirst").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: { customRepoOwner: { not: null } },
			select: {
				customRepoOwner: true,
				customRepoName: true,
				customRepoBranch: true,
				customRepoMode: true,
			},
		});
		const row = await repoRead(args);
		await pause("repo", state.repo > 0);
		return row;
	});
	const countRead = prisma.trashTemplate.count.bind(prisma.trashTemplate);
	const counts: { count: AwaitOnly<typeof prisma.trashTemplate.count> } = prisma.trashTemplate;
	vi.spyOn(counts, "count").mockImplementation(async (args) => {
		const strategy = args?.where?.qualityProfileMappings?.some?.syncStrategy;
		expect(["auto", "notify"]).toContain(strategy);
		expect(args?.where?.deletedAt).toBeNull();
		if (strategy === "auto") {
			expect(args?.where?.OR).toEqual([
				{ trashGuidesCommitHash: { not: null } },
				{ sourceQualityProfileTrashId: { not: null } },
			]);
		} else expect(args?.where?.trashGuidesCommitHash).toEqual({ not: null });
		const count = await countRead(args);
		await pause("strategy", strategy === "auto");
		if (armed && options.siblingFailure === "strategy" && strategy === "notify")
			throw new Error("Synthetic sibling failure");
		return count;
	});
	const templatesRead = prisma.trashTemplate.findMany.bind(prisma.trashTemplate);
	const templates: { findMany: AwaitOnly<typeof prisma.trashTemplate.findMany> } =
		prisma.trashTemplate;
	vi.spyOn(templates, "findMany").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: {
				deletedAt: null,
				OR: [
					{ trashGuidesCommitHash: { not: null } },
					{
						sourceQualityProfileTrashId: { not: null },
						qualityProfileMappings: { some: { syncStrategy: "auto" } },
					},
				],
			},
			select: { userId: true },
			distinct: ["userId"],
		});
		const rows = await templatesRead(args);
		expect(rows).toEqual(armed && !options.empty ? [{ userId: native.userId }] : []);
		return rows;
	});
	const qualityRead = prisma.qualitySizeMapping.findMany.bind(prisma.qualitySizeMapping);
	const qualityMappings: { findMany: AwaitOnly<typeof prisma.qualitySizeMapping.findMany> } =
		prisma.qualitySizeMapping;
	vi.spyOn(qualityMappings, "findMany").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: { syncStrategy: { in: ["auto", "notify"] } },
			include: { instance: true },
		});
		const rows = await qualityRead(args);
		expect(rows).toEqual([]);
		return rows;
	});
	const namingRead = prisma.namingConfig.findMany.bind(prisma.namingConfig);
	const naming: { findMany: AwaitOnly<typeof prisma.namingConfig.findMany> } = prisma.namingConfig;
	vi.spyOn(naming, "findMany").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: { syncStrategy: { in: ["auto", "notify"] }, lastDeployedHash: { not: null } },
			include: { instance: true },
		});
		const rows = await namingRead(args);
		expect(rows).toEqual([]);
		return rows;
	});
	const subscriptionRead = prisma.notificationSubscription.findMany.bind(
		prisma.notificationSubscription,
	);
	const subscriptions: { findMany: AwaitOnly<typeof prisma.notificationSubscription.findMany> } =
		prisma.notificationSubscription;
	vi.spyOn(subscriptions, "findMany").mockImplementation(async (args) => {
		expect(args?.include).toEqual({ channel: true });
		if (typeof args?.where?.eventType === "string")
			expect(args.where.eventType).toBe("TRASH_SYNC_ERROR");
		else {
			expect(args?.where?.eventType).toEqual({
				in: ["TRASH_DEPLOY_UNCERTAIN", "TRASH_SYNC_ERROR"],
			});
			expect(args?.where?.channel).toEqual({ userId: native.userId });
		}
		const rows = await subscriptionRead({ ...args, include: { channel: true } });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.channelId).toBe(native.channelId);
		expect(rows[0]?.channel.userId).toBe(native.userId);
		await pause("subscription");
		return rows;
	});
	const transaction = prisma.$transaction.bind(prisma);
	vi.spyOn(prisma, "$transaction").mockImplementation(async (operation, transactionOptions) =>
		transaction(async (tx) => {
			const logCreate = tx.notificationLog.create.bind(tx.notificationLog);
			const history: { create: AwaitOnly<typeof tx.notificationLog.create> } = tx.notificationLog;
			vi.spyOn(history, "create").mockImplementation(async (args) => {
				expect(args.data.channelId).toBe(native.channelId);
				const row = await logCreate(args);
				await pause("log");
				return row;
			});
			const channelUpdate = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
			const channels: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
				tx.notificationChannel;
			vi.spyOn(channels, "updateMany").mockImplementation(async (args) => {
				expect(args.where?.id).toBe(native.channelId);
				expect(args.where?.userId).toBe(native.userId);
				const row = await channelUpdate(args);
				if (args.data.lastSendResult !== undefined) {
					expect(args.where?.type).toBe("DISCORD");
					expect(args.where?.encryptedConfig).toBeTypeOf("string");
					expect(args.where?.configIv).toBeTypeOf("string");
					await pause("channel");
				}
				return row;
			});
			return operation(tx);
		}, transactionOptions),
	);

	// Keep the real version tracker and response parser, replacing only its GET boundary.
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: unknown, request?: RequestInit) => {
			expect(request?.method ?? "GET").toBe("GET");
			expect(request?.body).toBeUndefined();
			expect(request?.signal).toBeInstanceOf(AbortSignal);
			if (url !== "https://api.github.com/repos/TRaSH-Guides/Guides/commits/master")
				throw new Error("Fixture forbids another network request");
			await pause("version");
			return new Response(
				JSON.stringify({
					sha: "synthetic-commit",
					commit: {
						author: {
							name: "Synthetic",
							email: "synthetic@example.invalid",
							date: "2026-10-02T00:00:00Z",
						},
						message: "Synthetic commit",
					},
					html_url: "https://synthetic.invalid/commit",
				}),
				{ status: 200 },
			);
		}),
	);
	// Synthetic cache/deployment results isolate lifetime; they do not establish
	// actual provider authority or perform a cache write or an ARR deployment.
	vi.spyOn(TemplateUpdater.prototype, "refreshAllCaches").mockImplementation(async (service) => {
		if (!["RADARR", "SONARR"].includes(service)) throw new Error("Unexpected service");
		await pause("cache", service === "RADARR");
		if (armed && options.siblingFailure === "cache" && service === "SONARR")
			throw new Error("Synthetic sibling failure");
		return {
			refreshed: 0,
			failed: 0,
			errors: [],
			verifiedConfigTypes: [],
			verifiedQualitySizeData: null,
		};
	});
	vi.spyOn(TemplateUpdater.prototype, "checkForUpdates").mockImplementation(async (owner) => {
		if (owner !== native.userId) throw new Error("Unexpected template owner");
		return {
			totalTemplates: 1,
			outdatedTemplates: 1,
			templatesWithUpdates: [],
			upToDateTemplates: 0,
			latestCommit: {
				commitHash: "synthetic-commit",
				commitDate: "2026-10-02T00:00:00Z",
				commitMessage: "Synthetic commit",
				commitUrl: "https://synthetic.invalid/commit",
			},
		};
	});
	vi.spyOn(TemplateUpdater.prototype, "processAutoUpdates").mockImplementation(async (owner) => {
		if (owner !== native.userId) throw new Error("Unexpected deployment owner");
		await pause("auto");
		return {
			processed: 1,
			successful: 0,
			failed: 0,
			uncertain: 1,
			skippedForApproval: 0,
			templatesWithScoreConflicts: 0,
			uncertainDeployments: [
				{
					endpointKey: `${native.userId}:RADARR:${instanceId}`,
					instanceId,
					instanceLabel: "Synthetic instance",
					status: "UNCERTAIN",
					success: false,
					errors: ["Synthetic uncertain write"],
				},
			],
			results: [],
		};
	});
	vi.spyOn(TemplateUpdater.prototype, "getTemplatesNeedingAttention").mockImplementation(
		async (owner) => {
			if (owner !== native.userId) throw new Error("Unexpected attention owner");
			return [];
		},
	);
	vi.spyOn(NotificationDispatcher.prototype, "send").mockImplementation(
		async (type, config, payload) => {
			if (
				type !== "DISCORD" ||
				config.webhookUrl !== "https://example.invalid/synthetic-worker" ||
				!["TRASH_SYNC_ERROR", "TRASH_DEPLOY_UNCERTAIN"].includes(payload.eventType)
			)
				throw new Error("Unexpected synthetic notification");
			events.push(payload.eventType);
			await pause("send");
			return { success: true, retryable: false };
		},
	);

	const app = Fastify({ logger: false });
	apps.push(app);
	app.decorate("restoreRuntime", native.runtime);
	app.decorate("prisma", prisma);
	app.decorate("encryptor", native.encryptor);
	app.decorate("config", { APP_URL: "https://synthetic.invalid" } as never);
	app.decorate("arrClientFactory", {
		create() {
			throw new Error("Fixture forbids provider access");
		},
		rawRequest() {
			throw new Error("Fixture forbids provider access");
		},
	} as never);
	app.decorate("deploymentExecutor", {} as never);
	await app.register(
		fp(
			async (server) => {
				server.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					await client.close();
					state.teardown++;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(fp(async () => {}, { name: "security" }));
	await app.register(fp(async () => {}, { name: "deployment-executor" }));
	registerRestoreBootstrapPlugin(app, notificationServicePlugin);
	registerRestoreBootstrapPlugin(app, schedulerRegistryPlugin);
	await app.after();
	const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		const work = track(...args);
		tasks.push(work.catch(() => undefined));
		return work;
	});
	const interval = vi.spyOn(globalThis, "setInterval");
	// Required local initialization stays starting; production starts work only onListen.
	registerRestoreBootstrapPlugin(app, trashUpdateSchedulerPlugin);
	await app.after();
	let onListenCompleted = false;
	// Fastify runs this only after the production async onListen hook has settled.
	app.addHook("onListen", async () => {
		onListenCompleted = true;
	});
	registerRestoreRuntimeActivation(app);
	const closing = deferred();
	app.addHook("preClose", async () => closing.resolve());
	let readySettled = false;
	const ready = Promise.resolve(app.ready()).finally(() => {
		readySettled = true;
	});
	expect(await waitForNative(() => readySettled)).toBe(true);
	await ready;
	const idle = async () => {
		await settle();
		await Promise.all(tasks);
		await app.notificationService.drain();
	};
	if (options.listen !== false) {
		await app.listen({ host: "127.0.0.1", port: 0 });
		if (armed && options.hold) expect(await waitForNative(() => held)).toBe(true);
		else {
			expect(await waitForNative(() => onListenCompleted)).toBe(true);
			await idle();
			expect(
				onListenCompleted,
				"Production onListen must finish before fixture work is armed",
			).toBe(true);
		}
	}
	if (options.origin !== undefined && options.origin !== "startup") {
		armed = true;
		if (!options.empty)
			await native.run(() =>
				native.prisma.trashTemplate.updateMany({
					where: { id: templateId, userId: native.userId },
					data: { deletedAt: null },
				}),
			);
	}
	const callback = () => {
		const fn = [...interval.mock.calls]
			.reverse()
			.find(([, delay]) => delay === 12 * 60 * 60_000)?.[0];
		if (typeof fn !== "function") throw new Error("No update interval callback");
		return fn;
	};
	return {
		app,
		native,
		state,
		events,
		templateId,
		instanceId,
		idle,
		callback,
		entered: entered.promise,
		closing: closing.promise,
		tick: () => callback()(),
		waitUntilHeld: () => waitForNative(() => held),
		manual() {
			// Direct scheduler callers enter the same ordinary native authority as a request.
			const work = native.runtime.runOperation(() => app.trashUpdateScheduler.triggerCheck());
			const outcome = work.then(
				() => "fulfilled",
				() => "rejected",
			);
			tasks.push(outcome);
			return outcome;
		},
		async outcome() {
			return native.run(async () => ({
				template: await native.prisma.trashTemplate.findFirstOrThrow({
					where: { id: templateId, userId: native.userId },
				}),
				mappings: await native.prisma.templateQualityProfileMapping.findMany({
					where: {
						templateId,
						instanceId,
						template: { userId: native.userId },
						instance: { userId: native.userId },
					},
					orderBy: { qualityProfileId: "asc" },
				}),
				events: await native.prisma.notificationOutboxEvent.findMany({
					where: { userId: native.userId },
					orderBy: { acceptedAt: "asc" },
				}),
				deliveries: await native.prisma.notificationOutboxDelivery.findMany({
					where: { userId: native.userId },
					orderBy: { createdAt: "asc" },
				}),
				history: await native.prisma.notificationLog.findMany({
					where: { channelId: native.channelId },
					orderBy: { sentAt: "asc" },
				}),
				channel: await native.prisma.notificationChannel.findFirstOrThrow({
					where: { id: native.channelId, userId: native.userId },
				}),
			}));
		},
	};
}

async function assertPersisted(
	fixture: Awaited<ReturnType<typeof boot>>,
	eventType: "TRASH_DEPLOY_UNCERTAIN" | "TRASH_SYNC_ERROR" | null,
	deliveryState: "ready" | "sent" | "uncertain" | "submitting" | null,
	error = "Synthetic update dependency failure",
) {
	const result = await fixture.outcome();
	expect(result.events.map((row) => row.eventType)).toEqual(eventType ? [eventType] : []);
	expect(result.deliveries.map((row) => row.state)).toEqual(deliveryState ? [deliveryState] : []);
	expect(result.history.map((row) => row.status)).toEqual(deliveryState === "sent" ? ["sent"] : []);
	for (const delivery of result.deliveries) {
		expect(delivery.userId).toBe(fixture.native.userId);
		expect(delivery.channelId).toBe(fixture.native.channelId);
		expect(delivery.channelType).toBe("DISCORD");
		expect(delivery.subscriptionEventType).toBe("TRASH_SYNC_ERROR");
		expect(delivery.attemptOrdinal).toBe(0);
		expect(delivery.nextAttemptAt.toISOString()).toBe("2026-10-02T00:00:00.000Z");
		const stored = result.events.find((row) => row.id === delivery.eventId)!;
		expect(stored.userId).toBe(fixture.native.userId);
		expect(stored.dueAt.toISOString()).toBe("2026-10-02T00:00:00.000Z");
		expect(stored.encryptedPayload).not.toContain("Synthetic instance");
		const work = await fixture.native.run(() =>
			fixture.native.repository().readEvent(delivery.eventId),
		);
		expect(work?.payload.eventType).toBe(eventType);
		expect(work?.payload.url).toBe("https://synthetic.invalid/trash-guides");
		expect(work?.policy).toEqual({ stage: "ready" });
		expect(work?.fallbackEventTypes).toEqual(
			eventType === "TRASH_DEPLOY_UNCERTAIN" ? ["TRASH_SYNC_ERROR"] : [],
		);
		expect(work?.recipients).toEqual([
			{
				channelId: fixture.native.channelId,
				channelType: "DISCORD",
				subscriptionEventType: "TRASH_SYNC_ERROR",
			},
		]);
		if (eventType === "TRASH_DEPLOY_UNCERTAIN") {
			expect(work?.payload.title).toBe(
				"Automatic TRaSH deployment needs review on Synthetic instance",
			);
			expect(work?.payload.body).toBe("Synthetic uncertain write");
			expect(work?.payload.metadata).toEqual({
				instanceId: fixture.instanceId,
				endpointKey: `${fixture.native.userId}:RADARR:${fixture.instanceId}`,
				reason: "uncertain_result",
			});
		} else {
			expect(work?.payload.title).toBe("TRaSH Guides sync failed");
			expect(work?.payload.body).toBe(error);
			expect(work?.payload.metadata).toBeUndefined();
		}
	}
	expect(result.channel.lastSendResult).toBe(deliveryState === "sent" ? "success" : null);
	expect(result.channel.lastSentAt?.toISOString() ?? null).toBe(
		deliveryState === "sent" ? "2026-10-02T00:00:00.000Z" : null,
	);
	expect(result.template.userId).toBe(fixture.native.userId);
	expect(result.template.configData).toBe("{}");
	expect(result.template.trashGuidesCommitHash).toBe("synthetic-old-commit");
	expect(result.mappings.map(({ syncStrategy }) => syncStrategy)).toEqual(["auto", "notify"]);
	expect(result.mappings.map(({ templateId, instanceId }) => ({ templateId, instanceId }))).toEqual(
		[
			{ templateId: fixture.templateId, instanceId: fixture.instanceId },
			{ templateId: fixture.templateId, instanceId: fixture.instanceId },
		],
	);
}

beforeEach(() => {
	vi.useFakeTimers({
		toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
	});
	vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
	vi.stubEnv("GITHUB_TOKEN", "");
	vi.stubEnv("TRASH_UPDATE_SCHEDULER_ENABLED", "true");
	vi.stubEnv("TRASH_UPDATE_CHECK_INTERVAL_HOURS", "12");
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await settle();
	await Promise.all(tasks.splice(0));
	await Promise.all(apps.splice(0).map((app) => app.close()));
	for (const native of natives.splice(0)) {
		const owned = ownedRows.get(native)!;
		if (owned.mappings.length > 0) {
			const where = {
				OR: owned.mappings.map(({ id, templateId, instanceId, userId }) => ({
					id,
					templateId,
					instanceId,
					template: { userId },
					instance: { userId },
				})),
			};
			const removed = await native.run(() =>
				native.prisma.templateQualityProfileMapping.deleteMany({ where }),
			);
			expect(removed.count).toBe(owned.mappings.length);
			expect(
				await native.run(() => native.prisma.templateQualityProfileMapping.count({ where })),
			).toBe(0);
		}
		if (owned.templates.length > 0) {
			const where = { OR: owned.templates };
			const removed = await native.run(() => native.prisma.trashTemplate.deleteMany({ where }));
			expect(removed.count).toBe(owned.templates.length);
			expect(await native.run(() => native.prisma.trashTemplate.count({ where }))).toBe(0);
		}
		ownedRows.delete(native);
		await native.close();
	}
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("TRaSH Update accepted work and notification drain", () => {
	it("opens real native admission before held optional startup work, then joins that work on shutdown", async () => {
		vi.useRealTimers();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
		const gate = deferred();
		const fixture = await boot({
			listen: false,
			hold: { phase: "version", gate: gate.promise },
		});
		expect((await fixture.outcome()).template.id).toBe(fixture.templateId);
		expect(fixture.state.repo).toBe(1);
		expect(fixture.state.version).toBe(0);
		await fixture.app.listen({ host: "127.0.0.1", port: 0 });
		expect(await fixture.waitUntilHeld()).toBe(true);
		await fixture.entered;
		const changed = await fixture.app.restoreRuntime.runOperation(() =>
			fixture.app.prisma.trashTemplate.updateMany({
				where: { id: fixture.templateId, userId: fixture.native.userId },
				data: { description: "Native readiness observation" },
			}),
		);
		expect(changed.count).toBe(1);
		expect((await fixture.outcome()).template.description).toBe("Native readiness observation");
		let closed = false;
		const closing = fixture.app.close().then(() => {
			closed = true;
		});
		await fixture.closing;
		await settle();
		expect(closed).toBe(false);
		expect(fixture.state.pending).toBe(1);
		gate.resolve();
		await closing;
		expect(fixture.state.pendingAtTeardown).toBe(0);
		expect(fixture.state.afterTeardown).toBe(0);
		expect(fixture.events).toEqual([]);
		expect(fixture.state.auto).toBe(0);
		expect(fixture.app.trashUpdateScheduler.getStats().lastCheckResult).toBeUndefined();
		await assertPersisted(fixture, null, null);
	});

	it("does not start optional automatic work when a ready runtime closes before listen", async () => {
		vi.useRealTimers();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
		const fixture = await boot({ listen: false });
		expect((await fixture.outcome()).mappings).toHaveLength(2);
		await fixture.app.close();
		expect(fixture.state.repo).toBe(1);
		expect(fixture.state.version).toBe(0);
		expect(fixture.state.afterTeardown).toBe(0);
		expect(fixture.events).toEqual([]);
		await assertPersisted(fixture, null, null);
	});

	for (const origin of ["startup", "interval", "manual"] as const) {
		for (const phase of [
			"repo",
			"strategy",
			"cache",
			"auto",
			"subscription",
			"send",
			"log",
			"channel",
		] as const) {
			for (const reject of [false, true]) {
				it(`drains ${origin} ${phase} ${reject ? "failure" : "completion"} before teardown`, async () => {
					const gate = deferred();
					const fixture = await boot({ origin, hold: { phase, gate: gate.promise, reject } });
					const previousResult = structuredClone(
						fixture.app.trashUpdateScheduler.getStats().lastCheckResult,
					);
					let outcome: Promise<string> | undefined;
					if (origin === "interval") fixture.tick();
					if (origin === "manual") outcome = fixture.manual();
					expect(await fixture.waitUntilHeld()).toBe(true);
					expect(fixture.state.pending).toBeGreaterThan(0);
					await fixture.entered;
					let closed = false;
					const close = fixture.app.close().then(() => {
						closed = true;
					});
					await fixture.closing;
					await settle();
					expect(closed).toBe(false);
					expect(fixture.state.teardown).toBe(0);
					gate.resolve();
					await close;
					expect(fixture.state.pendingAtTeardown).toBe(0);
					expect(fixture.state.afterTeardown).toBe(0);
					expect(fixture.app.trashUpdateScheduler.getStats()).toMatchObject({
						isRunning: false,
						nextCheckAt: undefined,
					});
					if (!reject && (phase === "repo" || phase === "strategy")) {
						// These read-only preflight dependencies still join, but a
						// shutdown cancellation cannot start later cache/deployment work.
						expect(fixture.state.auto).toBe(0);
						expect(fixture.app.trashUpdateScheduler.getStats().lastCheckResult).toEqual(
							previousResult,
						);
						expect(fixture.events).toEqual([]);
						await assertPersisted(fixture, null, null);
						if (outcome) expect(await outcome).toBe("rejected");
						return;
					}
					if (!reject) {
						expect(fixture.app.trashUpdateScheduler.getStats().lastCheckResult).toMatchObject({
							templatesAutoSynced: 0,
							templatesWithUncertainDeployments: 1,
							errors: [],
						});
					} else if (["repo", "strategy", "cache", "auto"].includes(phase)) {
						expect(fixture.app.trashUpdateScheduler.getStats().lastCheckResult?.errors).toEqual([
							"Synthetic update dependency failure",
						]);
					}
					const startedSend = ["send", "log", "channel"].includes(phase);
					const eventType =
						reject && phase === "subscription"
							? null
							: reject && ["repo", "strategy", "cache", "auto"].includes(phase)
								? "TRASH_SYNC_ERROR"
								: "TRASH_DEPLOY_UNCERTAIN";
					const deliveryState =
						eventType === null
							? null
							: !startedSend
								? "ready"
								: !reject
									? "sent"
									: phase === "send"
										? "uncertain"
										: "submitting";
					expect(fixture.events).toEqual(startedSend ? [eventType] : []);
					await assertPersisted(fixture, eventType, deliveryState);
					if (outcome)
						expect(await outcome).toBe(
							reject && ["repo", "strategy", "cache", "auto"].includes(phase)
								? "rejected"
								: "fulfilled",
						);
				});
			}
		}
	}

	it.each(["strategy", "cache"] as const)(
		"drains a held %s sibling when the other sibling rejects",
		async (phase) => {
			const gate = deferred();
			const fixture = await boot({ hold: { phase, gate: gate.promise }, siblingFailure: phase });
			await fixture.entered;
			let closed = false;
			const close = fixture.app.close().then(() => {
				closed = true;
			});
			await fixture.closing;
			await settle();
			expect(closed).toBe(false);
			expect(fixture.state.teardown).toBe(0);
			gate.resolve();
			await close;
			expect(fixture.state.pendingAtTeardown).toBe(0);
			expect(fixture.state.afterTeardown).toBe(0);
			expect(fixture.events).toEqual([]);
			await assertPersisted(fixture, "TRASH_SYNC_ERROR", "ready", "Synthetic sibling failure");
			expect(fixture.app.trashUpdateScheduler.getStats().lastCheckResult?.errors).toEqual([
				"Synthetic sibling failure",
			]);
		},
	);

	it("refuses late manual work, queued timers and starts after admission closes", async () => {
		const fixture = await boot({ empty: true });
		const callback = fixture.callback();
		const before = fixture.state.repo;
		await fixture.app.close();
		callback();
		fixture.app.trashUpdateScheduler.start();
		await expect(fixture.app.trashUpdateScheduler.triggerCheck()).rejects.toThrow("shutting down");
		await settle();
		expect(fixture.state.repo).toBe(before);
		expect(fixture.state.afterTeardown).toBe(0);
	});

	it("retires captured callbacks while preserving ordinary stop/restart and manual checks", async () => {
		const fixture = await boot({ empty: true });
		const callback = fixture.callback();
		const before = fixture.state.repo;
		fixture.app.trashUpdateScheduler.stop();
		callback();
		await settle();
		expect(fixture.state.repo).toBe(before);
		expect(await fixture.manual()).toBe("fulfilled");
		expect(fixture.state.repo).toBe(before + 1);
		await fixture.native.runtime.runOperation(() => fixture.app.trashUpdateScheduler.start());
		await fixture.idle();
		expect(fixture.state.repo).toBe(before + 2);
		callback();
		await settle();
		expect(fixture.state.repo).toBe(before + 2);
		fixture.tick();
		await fixture.idle();
		expect(fixture.state.repo).toBe(before + 3);
	});

	it("keeps startup and twelve-hour cadence without duplicating start", async () => {
		// Advance scheduler time, not PostgreSQL's real query/connection safety deadlines.
		vi.useRealTimers();
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
		vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
		const fixture = await boot({ empty: true });
		const before = fixture.state.repo;
		fixture.app.trashUpdateScheduler.start();
		await vi.advanceTimersByTimeAsync(12 * 60 * 60_000 - 1);
		expect(fixture.state.repo).toBe(before);
		await vi.advanceTimersByTimeAsync(1);
		await fixture.idle();
		expect(fixture.state.repo).toBe(before + 1);
	});

	it("drains a manually accepted check even when automatic scheduling is disabled", async () => {
		vi.stubEnv("TRASH_UPDATE_SCHEDULER_ENABLED", "false");
		const gate = deferred();
		const fixture = await boot({ origin: "manual", hold: { phase: "auto", gate: gate.promise } });
		expect(fixture.state.strategy).toBe(0);
		const work = fixture.manual();
		expect(await fixture.waitUntilHeld()).toBe(true);
		await fixture.entered;
		const close = fixture.app.close();
		await fixture.closing;
		await settle();
		expect(fixture.state.teardown).toBe(0);
		gate.resolve();
		await close;
		expect(await work).toBe("fulfilled");
		expect(fixture.events).toEqual([]);
		await assertPersisted(fixture, "TRASH_DEPLOY_UNCERTAIN", "ready");
	});

	it("shares duplicate shutdown and waits for a check despite concurrent manual and timer attempts", async () => {
		const gate = deferred();
		const fixture = await boot({ hold: { phase: "auto", gate: gate.promise } });
		await fixture.entered;
		fixture.tick();
		expect(await fixture.manual()).toBe("fulfilled");
		await settle();
		expect(fixture.state.auto).toBe(1);
		const scheduler = fixture.app.trashUpdateScheduler as unknown as { shutdown(): Promise<void> };
		const first = scheduler.shutdown();
		expect(scheduler.shutdown()).toBe(first);
		let drained = false;
		const drain = first.then(() => {
			drained = true;
		});
		await settle();
		expect(drained).toBe(false);
		gate.resolve();
		await drain;
		await fixture.idle();
		expect(fixture.events).toEqual(["TRASH_DEPLOY_UNCERTAIN"]);
		await assertPersisted(fixture, "TRASH_DEPLOY_UNCERTAIN", "sent");
		await fixture.app.close();
		expect(fixture.state.pendingAtTeardown).toBe(0);
	});

	it("recovers on the next manual check and preserves manual rejection rather than registry swallowing", async () => {
		const gate = deferred();
		const fixture = await boot({
			origin: "manual",
			hold: { phase: "strategy", gate: gate.promise, reject: true },
		});
		const before = fixture.app.schedulerRegistry.getStatus(JOB_ID.trashUpdate);
		const work = fixture.manual();
		expect(await fixture.waitUntilHeld()).toBe(true);
		await fixture.entered;
		gate.resolve();
		expect(await work).toBe("rejected");
		expect(await fixture.manual()).toBe("fulfilled");
		await fixture.idle();
		expect(fixture.events).toEqual(["TRASH_SYNC_ERROR", "TRASH_DEPLOY_UNCERTAIN"]);
		const result = await fixture.outcome();
		expect(result.events.map(({ eventType }) => eventType).sort()).toEqual([
			"TRASH_DEPLOY_UNCERTAIN",
			"TRASH_SYNC_ERROR",
		]);
		expect(result.deliveries).toHaveLength(2);
		expect(
			result.deliveries.every(
				({ state, userId, channelId, attemptOrdinal }) =>
					state === "sent" &&
					userId === fixture.native.userId &&
					channelId === fixture.native.channelId &&
					attemptOrdinal === 0,
			),
		).toBe(true);
		expect(result.history.map(({ status }) => status)).toEqual(["sent", "sent"]);
		expect(result.channel.lastSendResult).toBe("success");
		for (const stored of result.events) {
			const work = await fixture.native.run(() => fixture.native.repository().readEvent(stored.id));
			expect(work?.payload.eventType).toBe(stored.eventType);
			expect(work?.recipients).toEqual([
				{
					channelId: fixture.native.channelId,
					channelType: "DISCORD",
					subscriptionEventType: "TRASH_SYNC_ERROR",
				},
			]);
			expect(work?.fallbackEventTypes).toEqual(
				stored.eventType === "TRASH_DEPLOY_UNCERTAIN" ? ["TRASH_SYNC_ERROR"] : [],
			);
		}
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.trashUpdate)).toEqual(before);
	});

	it("treats scheduled maintenance as a pause but rejects a manual maintenance request", async () => {
		const fixture = await boot({ empty: true });
		const before = fixture.app.schedulerRegistry.getStatus(JOB_ID.trashUpdate);
		const reads = fixture.state.repo;
		const errors = vi.spyOn(fixture.app.log, "error");
		await withCleanupMaintenanceGuard(async () => {
			fixture.tick();
			await fixture.idle();
			await expect(
				fixture.native.runtime.runOperation(() => fixture.app.trashUpdateScheduler.triggerCheck()),
			).rejects.toThrow("maintenance");
		});
		expect(errors).not.toHaveBeenCalled();
		expect(fixture.state.repo).toBe(reads);
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.trashUpdate)).toEqual(before);
	});
});
