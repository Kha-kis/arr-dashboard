import { performance } from "node:perf_hooks";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSchedulers } from "../../bootstrap/schedulers.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import * as executor from "../../lib/library-cleanup/cleanup-executor.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import type { CleanupRunResult } from "../../lib/library-cleanup/types.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import cleanupPlugin from "../library-cleanup-scheduler.js";
import notificationPlugin from "../notification-service.js";
import registryPlugin from "../scheduler-registry.js";

const apps: FastifyInstance[] = [];
const releases: Array<() => void> = [];
const tasks: Promise<unknown>[] = [];
type NativeFixture = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;
type Phase =
	| "audit"
	| "rescan"
	| "approval"
	| "recovery-write"
	| "config"
	| "execute"
	| "advance"
	| "subscription"
	| "send"
	| "log"
	| "channel";
type Mode = "partial" | "completed" | "dry-run" | "empty" | "future" | "disabled" | "recovery";
const nativeFixtures: NativeFixture[] = [];
const nativeRows = new Map<
	NativeFixture,
	{
		configs: Array<{ id: string; userId: string }>;
		instances: Array<{ id: string; userId: string }>;
		approvals: Array<{ id: string; configId: string; userId: string }>;
		channels: Array<{ id: string; userId: string }>;
		subscriptions: Array<{ channelId: string; eventType: string; userId: string }>;
	}
>();
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}
async function settle() {
	await new Promise<void>((done) => setImmediate(done));
}
async function waitForNative(observe: () => boolean) {
	const deadline = performance.now() + 4_000;
	while (!observe()) {
		if (performance.now() >= deadline) return false;
		await settle();
	}
	return true;
}
// Actual schema, two owned encrypted recipient graphs, independent native
// clients and production-selected bootstrap. Only executor/transport are fake.
async function boot(
	options: {
		origin?: "startup" | "interval";
		hold?: { phase: Phase; gate: Promise<void>; reject?: boolean; count?: number };
		mode?: Mode;
		owner?: "synthetic-a" | "synthetic-b";
	} = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	nativeFixtures.push(native);
	const other = await native.createOwner();
	const owners = [{ userId: native.userId, channelId: native.channelId }, other];
	const selected = options.owner === "synthetic-b" ? other : owners[0]!;
	const foreign = options.owner === "synthetic-b" ? owners[0]! : other;
	const owner = selected.userId;
	const channelId = selected.channelId;
	const owned: NonNullable<ReturnType<typeof nativeRows.get>> = {
		configs: [],
		instances: [],
		approvals: [],
		channels: [],
		subscriptions: [],
	};
	nativeRows.set(native, owned);
	const allowedEvents = ["CLEANUP_ITEMS_REMOVED", "CLEANUP_ITEMS_FLAGGED", "SYSTEM_ERROR"] as const;
	let configId = "",
		recoveryId: string | undefined,
		foreignApprovalId: string | undefined;
	const dueMode = !["empty", "disabled", "recovery"].includes(options.mode ?? "partial");
	await native.run(async () => {
		for (const recipient of owners) {
			const encrypted = native.encryptor.encrypt(
				JSON.stringify({
					webhookUrl: `https://example.invalid/synthetic-worker/${recipient.userId}`,
				}),
			);
			expect(
				(
					await native.prisma.notificationChannel.updateMany({
						where: { id: recipient.channelId, userId: recipient.userId },
						data: {
							name: "Same synthetic channel",
							encryptedConfig: encrypted.value,
							configIv: encrypted.iv,
						},
					})
				).count,
			).toBe(1);
			owned.channels.push({ id: recipient.channelId, userId: recipient.userId });
			for (const eventType of allowedEvents) {
				const row = await native.prisma.notificationSubscription.create({
					data: { channelId: recipient.channelId, eventType },
				});
				owned.subscriptions.push({
					channelId: row.channelId,
					eventType: row.eventType,
					userId: recipient.userId,
				});
			}
			const key = native.encryptor.encrypt("synthetic-provider-key");
			const instance = await native.prisma.serviceInstance.create({
				data: {
					userId: recipient.userId,
					service: "RADARR",
					label: "Same synthetic label",
					baseUrl: "https://example.invalid/synthetic-provider",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				},
			});
			owned.instances.push({ id: instance.id, userId: recipient.userId });
			const config = await native.prisma.libraryCleanupConfig.create({
				data: {
					userId: recipient.userId,
					enabled: recipient.userId === owner && dueMode,
					dryRunMode: options.mode === "dry-run",
					intervalHours: 24,
					nextRunAt: new Date(
						Date.now() + (options.origin === "interval" || options.mode === "future" ? 1 : -1),
					),
					...(options.mode === "recovery" && recipient.userId === foreign.userId
						? { runClaimToken: "synthetic-live-lease", runClaimedAt: new Date() }
						: {}),
				},
			});
			owned.configs.push({ id: config.id, userId: recipient.userId });
			if (recipient.userId === owner) configId = config.id;
			if (options.mode === "recovery") {
				const row = await native.prisma.libraryCleanupApproval.create({
					data: {
						configId: config.id,
						instanceId: instance.id,
						arrItemId: 1,
						itemType: "movie",
						title: "Same synthetic title",
						matchedRuleId: "synthetic-rule",
						matchedRuleName: "Synthetic rule",
						reason: "Synthetic recovery",
						action: "delete",
						sizeOnDisk: 1n,
						status: recipient.userId === owner ? "pending" : "executing",
						reviewedAt: recipient.userId === owner ? null : new Date(Date.now() - 7_200_000),
						executionToken: recipient.userId === owner ? null : "synthetic-live-execution",
						expiresAt: new Date(
							Date.now() +
								(recipient.userId === owner && options.origin !== "interval" ? -1 : 86_400_000),
						),
					},
				});
				owned.approvals.push({ id: row.id, configId: config.id, userId: recipient.userId });
				if (recipient.userId === owner) recoveryId = row.id;
				else foreignApprovalId = row.id;
			}
		}
	});
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime);
	const prisma = client.prisma;
	const state = {
		audit: 0,
		rescan: 0,
		approval: 0,
		"recovery-write": 0,
		config: 0,
		execute: 0,
		advance: 0,
		subscription: 0,
		send: 0,
		log: 0,
		channel: 0,
		pending: 0,
		teardown: 0,
		pendingAtTeardown: -1,
		afterTeardown: 0,
		forbidden: 0,
		network: 0,
		readySettled: false,
	};
	let armed = options.origin !== "interval",
		holdOffset = 0,
		held = false;
	const entered = deferred(),
		closing = deferred();
	const events: Array<{ owner: string; event: string; metadata: unknown }> = [];
	const payloads: Array<{ title: string; body: string; url?: string; metadata?: unknown }> = [];
	const statuses: string[] = [],
		advances: string[] = [],
		executions: string[] = [];
	const failures: string[] = [],
		warnings: Array<{ name: string; message: string }> = [];
	const pause = async (phase: Phase) => {
		const count = ++state[phase];
		if (state.teardown) state.afterTeardown++;
		state.pending++;
		try {
			if (
				armed &&
				options.hold?.phase === phase &&
				count === holdOffset + (options.hold.count ?? 1)
			) {
				held = true;
				entered.resolve();
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic cleanup dependency unavailable");
			}
		} finally {
			if (state.teardown) state.afterTeardown++;
			state.pending--;
		}
	};
	const refuse = () => {
		state.forbidden++;
		throw new Error("Fixture refuses an unexpected mutation or provider operation");
	};
	vi.stubGlobal("fetch", () => {
		state.network++;
		return refuse();
	});
	const auditRead = prisma.libraryCleanupApproval.findMany.bind(prisma.libraryCleanupApproval);
	const auditReads: { findMany: AwaitOnly<typeof prisma.libraryCleanupApproval.findMany> } =
		prisma.libraryCleanupApproval;
	vi.spyOn(auditReads, "findMany").mockImplementation(async (args) => {
		if (args?.where?.status === "executed") {
			expect(args.where.terminalAuditRecordedAt).toBe(null);
			expect(args.include).toEqual({ config: { select: { userId: true } } });
			expect(args.take).toBe(100);
			await pause("audit");
		}
		const rows = await auditRead(args);
		if (args?.where?.status === "executed") expect(rows).toEqual([]);
		for (const row of rows) expect(owned.approvals.map((item) => item.id)).toContain(row.id);
		return rows;
	});
	const scanRead = prisma.libraryCleanupMediaServerScan.findMany.bind(
		prisma.libraryCleanupMediaServerScan,
	);
	const scanReads: { findMany: AwaitOnly<typeof prisma.libraryCleanupMediaServerScan.findMany> } =
		prisma.libraryCleanupMediaServerScan;
	vi.spyOn(scanReads, "findMany").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: {
				approval: { status: "executed" },
				status: { in: ["pending", "failed", "triggering", "triggered", "skipped"] },
			},
			select: {
				id: true,
				status: true,
				nextAttemptAt: true,
				approval: { select: { config: { select: { id: true, userId: true } } } },
			},
		});
		await pause("rescan");
		const rows = await scanRead(args);
		expect(rows).toEqual([]);
		return rows;
	});
	const approvalRead = prisma.libraryCleanupApproval.findFirst.bind(prisma.libraryCleanupApproval);
	const approvalReads: { findFirst: AwaitOnly<typeof prisma.libraryCleanupApproval.findFirst> } =
		prisma.libraryCleanupApproval;
	vi.spyOn(approvalReads, "findFirst").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: {
				OR: [
					{ status: "pending", expiresAt: { lt: new Date() } },
					{
						status: { in: ["approved", "executing", "retry_executing"] },
						reviewedAt: { lt: new Date(Date.now() - 3_600_000) },
						config: {
							OR: [
								{ runClaimToken: null },
								{ runClaimedAt: null },
								{ runClaimedAt: { lt: new Date(Date.now() - 7_200_000) } },
							],
						},
					},
				],
			},
			select: { id: true },
		});
		await pause("approval");
		const row = await approvalRead(args);
		if (row) expect(row.id).toBe(recoveryId);
		return row;
	});
	const recoveryWrite = prisma.libraryCleanupApproval.updateMany.bind(
		prisma.libraryCleanupApproval,
	);
	const recoveryWrites: { updateMany: AwaitOnly<typeof prisma.libraryCleanupApproval.updateMany> } =
		prisma.libraryCleanupApproval;
	vi.spyOn(recoveryWrites, "updateMany").mockImplementation(async (args) => {
		expect(options.mode).toBe("recovery");
		if (args.data.status === "expired" && args.where?.id === recoveryId) {
			expect(args).toEqual({
				where: { id: recoveryId, status: "pending", expiresAt: { lt: new Date() } },
				data: {
					status: "expired",
					reviewedAt: new Date(),
					lastExecutionError: "Approval expired before operator action.",
				},
			});
			await pause("recovery-write");
		}
		return recoveryWrite(args);
	});
	const configRead = prisma.libraryCleanupConfig.findFirst.bind(prisma.libraryCleanupConfig);
	const configReads: { findFirst: AwaitOnly<typeof prisma.libraryCleanupConfig.findFirst> } =
		prisma.libraryCleanupConfig;
	vi.spyOn(configReads, "findFirst").mockImplementation(async (args) => {
		expect(args).toEqual({ where: { enabled: true } });
		await pause("config");
		const row = await configRead(args);
		if (row)
			expect(row).toMatchObject({
				id: configId,
				userId: owner,
				enabled: true,
				dryRunMode: options.mode === "dry-run",
			});
		else expect(dueMode).toBe(false);
		return row;
	});
	const advance = prisma.libraryCleanupConfig.update.bind(prisma.libraryCleanupConfig);
	const configWrites: { update: AwaitOnly<typeof prisma.libraryCleanupConfig.update> } =
		prisma.libraryCleanupConfig;
	vi.spyOn(configWrites, "update").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: { id: configId },
			data: { lastRunAt: new Date(), nextRunAt: new Date(Date.now() + 86_400_000) },
		});
		await pause("advance");
		const row = await advance(args);
		advances.push(row.id);
		return row;
	});
	const subscriptionRead = prisma.notificationSubscription.findMany.bind(
		prisma.notificationSubscription,
	);
	const subscriptionReads: {
		findMany: AwaitOnly<typeof prisma.notificationSubscription.findMany>;
	} = prisma.notificationSubscription;
	vi.spyOn(subscriptionReads, "findMany").mockImplementation(async (args) => {
		expect(allowedEvents).toContain(args?.where?.eventType);
		expect(args?.include).toEqual({ channel: true });
		const selectedOwner = args?.where?.channel;
		expect(
			selectedOwner === undefined ||
				JSON.stringify(selectedOwner) === JSON.stringify({ userId: owner }),
		).toBe(true);
		await pause("subscription");
		const rows = await subscriptionRead({ ...args, include: { channel: true } });
		expect(rows).toHaveLength(selectedOwner === undefined ? 2 : 1);
		expect(rows.map((row) => row.channel.userId).sort()).toEqual(
			(selectedOwner === undefined ? owners.map((row) => row.userId) : [owner]).sort(),
		);
		return rows;
	});
	const transaction = prisma.$transaction.bind(prisma);
	vi.spyOn(prisma, "$transaction").mockImplementation(async (operation, transactionOptions) =>
		transaction(async (tx) => {
			const historyWrite = tx.notificationLog.create.bind(tx.notificationLog);
			const history: { create: AwaitOnly<typeof tx.notificationLog.create> } = tx.notificationLog;
			vi.spyOn(history, "create").mockImplementation(async (args) => {
				expect(owners.map((row) => row.channelId)).toContain(args.data.channelId);
				await pause("log");
				const row = await historyWrite(args);
				statuses.push(row.status);
				return row;
			});
			const channelWrite = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
			const channels: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
				tx.notificationChannel;
			vi.spyOn(channels, "updateMany").mockImplementation(async (args) => {
				const recipient = owners.find((row) => row.channelId === args.where?.id);
				expect(recipient).toBeDefined();
				expect(args.where?.userId).toBe(recipient?.userId);
				if (args.data.lastSendResult !== undefined) await pause("channel");
				return channelWrite(args);
			});
			return operation(tx);
		}, transactionOptions),
	);
	const result: CleanupRunResult = {
		isDryRun: options.mode === "dry-run",
		status: options.mode === "partial" || !options.mode ? "partial" : "completed",
		itemsEvaluated: 2,
		itemsFlagged: options.mode === "dry-run" ? 2 : 0,
		itemsRemoved: options.mode === "dry-run" ? 0 : 1,
		itemsUnmonitored: 0,
		itemsFilesDeleted: 0,
		itemsSkipped: options.mode === "partial" || !options.mode ? 1 : 0,
		details:
			options.mode === "dry-run"
				? [
						{
							instanceId: owned.instances.find((row) => row.userId === owner)!.id,
							arrItemId: 1,
							title: "Synthetic item",
							ruleId: "synthetic-rule",
							rule: "Synthetic rule",
							reason: "Synthetic dry run",
							action: "flagged",
						},
					]
				: [],
		durationMs: 1,
	};
	vi.spyOn(executor, "executeCleanupRun").mockImplementation(async (deps, userId) => {
		expect(deps.prisma).toBe(prisma);
		expect(userId).toBe(owner);
		expect(deps.auditTrigger).toBe("scheduled");
		expect(deps.skipPendingMediaServerRescanRetry).toBe(true);
		expect(typeof deps.quiClientFactory).toBe("function");
		expect(typeof deps.quiFileHashIndexFactory).toBe("function");
		await pause("execute");
		executions.push(userId);
		return result;
	});
	vi.spyOn(NotificationDispatcher.prototype, "send").mockImplementation(
		async (type, recipient, payload) => {
			expect(type).toBe("DISCORD");
			const deliveryOwner = owners.find(
				(row) => recipient.webhookUrl === `https://example.invalid/synthetic-worker/${row.userId}`,
			);
			expect(deliveryOwner).toBeDefined();
			expect(allowedEvents).toContain(payload.eventType);
			events.push({
				owner: deliveryOwner!.userId,
				event: payload.eventType,
				metadata: payload.metadata,
			});
			payloads.push({
				title: payload.title,
				body: payload.body,
				url: payload.url,
				metadata: payload.metadata,
			});
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
	app.decorate("arrClientFactory", { create: refuse } as never);
	vi.spyOn(app.log, "error").mockImplementation((...args: unknown[]) => {
		const error = (args[0] as { err?: Error })?.err;
		if (error) failures.push(error.name);
	});
	vi.spyOn(app.log, "warn").mockImplementation((...args: unknown[]) => {
		const error = (args[0] as { err?: Error })?.err;
		if (error) warnings.push({ name: error.name, message: error.message });
	});
	await app.register(
		fp(
			async (server) => {
				server.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					expect(state.pending).toBe(0);
					await client.close();
					state.teardown++;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(fp(async () => {}, { name: "security" }));
	await app.register(fp(async () => {}, { name: "arr-client" }));
	registerRestoreBootstrapPlugin(app, notificationPlugin);
	registerRestoreBootstrapPlugin(app, registryPlugin);
	await app.after();
	const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		const task = track(...args);
		tasks.push(task.catch(() => undefined));
		return task;
	});
	const intervals = vi.spyOn(globalThis, "setInterval");
	const register = app.register.bind(app),
		displayName = Symbol.for("fastify.display-name"),
		pluginMeta = Symbol.for("plugin-meta");
	let selectedRegistrations = 0;
	const registration = vi.spyOn(app, "register").mockImplementation(((
		plugin: unknown,
		...args: unknown[]
	) => {
		if (
			typeof plugin === "function" &&
			Reflect.get(plugin, displayName) === Reflect.get(cleanupPlugin, displayName)
		) {
			expect(plugin).not.toBe(cleanupPlugin);
			expect(Reflect.get(plugin, pluginMeta)).toBe(Reflect.get(cleanupPlugin, pluginMeta));
			selectedRegistrations++;
			return Reflect.apply(register, app, [plugin, ...args]);
		}
		return app;
	}) as typeof app.register);
	try {
		registerSchedulers(app);
		expect(selectedRegistrations).toBe(1);
	} finally {
		registration.mockRestore();
	}
	await app.after();
	registerRestoreRuntimeActivation(app);
	app.addHook("preClose", async () => closing.resolve());
	const ready = Promise.resolve(app.ready()).finally(() => {
		state.readySettled = true;
	});
	tasks.push(ready.catch(() => undefined));
	expect(await waitForNative(() => state.readySettled)).toBe(true);
	await ready;
	const pending = () =>
		(app.cleanupScheduler as unknown as { pendingChecks: Set<Promise<void>> }).pendingChecks;
	const idle = async () => {
		expect(await waitForNative(() => pending().size === 0)).toBe(true);
		await app.notificationService.drain();
	};
	const callback = () => {
		const timer = [...intervals.mock.calls].reverse().find(([, delay]) => delay === 60_000)?.[0];
		if (typeof timer !== "function") throw new Error("Native minute callback missing");
		return timer;
	};
	if (options.origin === "interval") {
		await idle();
		holdOffset = options.hold ? state[options.hold.phase] : 0;
		await native.run(async () => {
			if (dueMode && options.mode !== "future")
				await native.prisma.libraryCleanupConfig.update({
					where: { id: configId },
					data: { nextRunAt: new Date(Date.now() - 1) },
				});
			if (recoveryId)
				await native.prisma.libraryCleanupApproval.updateMany({
					where: { id: recoveryId, config: { userId: owner }, status: "pending" },
					data: { expiresAt: new Date(Date.now() - 1) },
				});
		});
		armed = true;
	} else if (options.hold) expect(await waitForNative(() => held)).toBe(true);
	else await idle();
	const outcome = () =>
		native.run(async () => ({
			config: await native.prisma.libraryCleanupConfig.findFirstOrThrow({
				where: { id: configId, userId: owner },
			}),
			approvals: await native.prisma.libraryCleanupApproval.findMany({
				where: { config: { userId: owner }, configId },
			}),
			audits: await native.prisma.libraryCleanupAuditEvent.findMany({
				where: { config: { userId: owner }, configId },
				orderBy: { id: "asc" },
			}),
			scans: await native.prisma.libraryCleanupMediaServerScan.findMany({
				where: { approval: { config: { userId: owner }, configId } },
			}),
			events: await native.prisma.notificationOutboxEvent.findMany({
				where: { userId: owner },
				orderBy: { id: "asc" },
			}),
			deliveries: await native.prisma.notificationOutboxDelivery.findMany({
				where: { userId: owner },
				orderBy: { id: "asc" },
			}),
			history: await native.prisma.notificationLog.findMany({
				where: { channelId },
				orderBy: { id: "asc" },
			}),
			channel: await native.prisma.notificationChannel.findFirstOrThrow({
				where: { id: channelId, userId: owner },
			}),
			foreignConfig: await native.prisma.libraryCleanupConfig.findFirstOrThrow({
				where: { userId: foreign.userId },
			}),
			foreignApprovals: await native.prisma.libraryCleanupApproval.findMany({
				where: { config: { userId: foreign.userId } },
			}),
			foreignAudits: await native.prisma.libraryCleanupAuditEvent.findMany({
				where: { config: { userId: foreign.userId } },
			}),
			foreignEvents: await native.prisma.notificationOutboxEvent.findMany({
				where: { userId: foreign.userId },
			}),
			foreignDeliveries: await native.prisma.notificationOutboxDelivery.findMany({
				where: { userId: foreign.userId },
			}),
			foreignHistory: await native.prisma.notificationLog.findMany({
				where: { channelId: foreign.channelId },
			}),
		}));
	return {
		app,
		native,
		prisma,
		owner,
		channelId,
		foreign,
		configId,
		recoveryId,
		foreignApprovalId,
		state,
		failures,
		warnings,
		events,
		payloads,
		statuses,
		advances,
		executions,
		result,
		ready,
		idle,
		pending,
		outcome,
		entered: entered.promise,
		closing: closing.promise,
		waitUntilHeld: () => waitForNative(() => held),
		callback,
		tick: () => callback()(),
	};
}
async function bootNativeBoundary(origin: "startup" | "interval") {
	const f = await boot({ origin });
	if (origin === "interval") {
		f.tick();
		await f.idle();
	}
	return f;
}
type Fixture = Awaited<ReturnType<typeof boot>>;
type Snapshot = Awaited<ReturnType<Fixture["outcome"]>>;
function cleanupPayload(mode: "partial" | "completed" | "dry-run" = "partial") {
	return {
		eventType: mode === "dry-run" ? "CLEANUP_ITEMS_FLAGGED" : "CLEANUP_ITEMS_REMOVED",
		title: mode === "partial" ? "Library cleanup needs review" : "Library cleanup completed",
		body:
			mode === "dry-run"
				? "1 actionable matches in dry run"
				: mode === "partial"
					? "1 removed, 1 skipped"
					: "1 removed",
		url: "https://synthetic.invalid/library-cleanup",
		metadata:
			mode === "dry-run"
				? { itemsFlagged: 2, itemsSkipped: 0 }
				: {
						itemsRemoved: 1,
						itemsUnmonitored: 0,
						itemsFilesDeleted: 0,
						itemsSkipped: mode === "partial" ? 1 : 0,
					},
	};
}
const failurePayload = {
	eventType: "SYSTEM_ERROR",
	title: "Library cleanup failed",
	body: "Synthetic cleanup dependency unavailable",
	url: "https://synthetic.invalid/library",
	metadata: undefined,
};
function assertNativeGraph(
	f: Fixture,
	snapshot: Snapshot,
	payload: ReturnType<typeof cleanupPayload> | typeof failurePayload,
	state: "ready" | "sent" | "uncertain" | "submitting",
	foreign = false,
) {
	const userId = foreign ? f.foreign.userId : f.owner,
		channelId = foreign ? f.foreign.channelId : f.channelId;
	const events = foreign ? snapshot.foreignEvents : snapshot.events;
	const deliveries = foreign ? snapshot.foreignDeliveries : snapshot.deliveries;
	const history = foreign ? snapshot.foreignHistory : snapshot.history;
	expect(events).toHaveLength(1);
	expect(deliveries).toHaveLength(1);
	const event = events[0]!,
		delivery = deliveries[0]!;
	expect(event).toMatchObject({
		userId,
		eventType: payload.eventType,
		stage: state === "sent" || state === "uncertain" ? "terminal" : "ready",
		dueAt: new Date(),
		acceptedAt: new Date(),
	});
	expect(event.encryptedPayload).not.toContain(payload.title);
	const envelope = JSON.parse(
		f.native.encryptor.decrypt({ value: event.encryptedPayload, iv: event.payloadIv }),
	);
	const { metadata, ...content } = payload;
	expect(envelope).toMatchObject({
		purpose: "arr-dashboard:notification-outbox-event",
		eventId: event.id,
		userId,
		acceptedAt: new Date().toISOString(),
		dueAt: new Date().toISOString(),
		policy: { stage: "ready" },
		payload: { ...content, ...(metadata === undefined ? {} : { metadata }) },
		recipients: [{ channelId, channelType: "DISCORD", subscriptionEventType: payload.eventType }],
	});
	expect(delivery).toMatchObject({
		userId,
		eventId: event.id,
		channelId,
		channelType: "DISCORD",
		subscriptionEventType: payload.eventType,
		state,
		attemptOrdinal: 0,
		nextAttemptAt: new Date(),
	});
	if (state === "ready")
		expect(delivery).toMatchObject({
			attemptToken: null,
			workerEpoch: null,
			dispatchedAt: null,
			completedAt: null,
		});
	else {
		expect(delivery.attemptToken).toEqual(expect.any(String));
		expect(delivery.workerEpoch).toEqual(expect.any(String));
		expect(delivery.dispatchedAt).toEqual(new Date());
		expect(delivery.completedAt).toEqual(state === "submitting" ? null : new Date());
	}
	if (state === "sent") {
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({
			channelId,
			eventType: payload.eventType,
			title: payload.title,
			body: payload.body,
			status: "sent",
			retryCount: 0,
		});
	} else expect(history).toEqual([]);
}
function assertNativeRecovery(f: Fixture, snapshot: Snapshot, recovered: boolean) {
	expect(snapshot.approvals).toHaveLength(1);
	expect(snapshot.approvals[0]).toMatchObject({
		id: f.recoveryId,
		configId: f.configId,
		status: recovered ? "expired" : "pending",
		lastExecutionError: recovered ? "Approval expired before operator action." : null,
		reviewedAt: recovered ? new Date() : null,
		executionToken: null,
	});
	if (recovered) {
		expect(snapshot.audits).toHaveLength(1);
		expect(snapshot.audits[0]).toMatchObject({
			configId: f.configId,
			actionId: f.recoveryId,
			approvalId: f.recoveryId,
			eventType: "approval_expired",
			outcome: "blocked",
			trigger: "recovery",
			reason: "Approval expired before operator action.",
		});
	} else expect(snapshot.audits).toEqual([]);
	expect(snapshot.foreignApprovals).toHaveLength(1);
	expect(snapshot.foreignApprovals[0]).toMatchObject({
		id: f.foreignApprovalId,
		status: "executing",
		executionToken: "synthetic-live-execution",
		reviewedAt: new Date(Date.now() - 7_200_000),
	});
	expect(snapshot.foreignConfig).toMatchObject({
		runClaimToken: "synthetic-live-lease",
		runClaimedAt: new Date(),
		lastRunAt: null,
	});
	expect(snapshot.foreignAudits).toEqual([]);
	expect(snapshot.scans).toEqual([]);
	expect(snapshot.config.lastRunAt).toBe(null);
	expect(f.executions).toEqual([]);
	expect(f.advances).toEqual([]);
	expect(snapshot.events).toEqual([]);
	expect(snapshot.foreignEvents).toEqual([]);
}
beforeEach(() => {
	vi.useFakeTimers({
		toFake: ["Date", "setInterval", "clearInterval"],
	});
	vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
	vi.stubEnv("GITHUB_TOKEN", "");
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await settle();
	await Promise.all(tasks.splice(0));
	for (const app of apps.splice(0)) {
		app.cleanupScheduler?.stop();
		await app.close();
	}
	for (const native of nativeFixtures.splice(0)) {
		await native.run(async () => {
			const owned = nativeRows.get(native);
			for (const row of owned?.configs ?? []) {
				const deleted = await native.prisma.libraryCleanupConfig.deleteMany({ where: row });
				expect(deleted.count).toBe(1);
				expect(await native.prisma.libraryCleanupConfig.count({ where: row })).toBe(0);
				expect(
					await native.prisma.libraryCleanupApproval.count({ where: { configId: row.id } }),
				).toBe(0);
				expect(
					await native.prisma.libraryCleanupAuditEvent.count({ where: { configId: row.id } }),
				).toBe(0);
				expect(await native.prisma.libraryCleanupLog.count({ where: { configId: row.id } })).toBe(
					0,
				);
			}
			for (const row of owned?.approvals ?? []) {
				expect(
					await native.prisma.libraryCleanupMediaServerScan.count({
						where: { approvalId: row.id },
					}),
				).toBe(0);
			}
			for (const row of owned?.instances ?? []) {
				expect((await native.prisma.serviceInstance.deleteMany({ where: row })).count).toBe(1);
				expect(await native.prisma.serviceInstance.count({ where: row })).toBe(0);
			}
			for (const row of owned?.subscriptions ?? []) {
				const where = {
					channelId: row.channelId,
					eventType: row.eventType,
					channel: { userId: row.userId },
				};
				expect((await native.prisma.notificationSubscription.deleteMany({ where })).count).toBe(1);
				expect(await native.prisma.notificationSubscription.count({ where })).toBe(0);
			}
			for (const row of owned?.channels ?? []) {
				expect((await native.prisma.notificationChannel.deleteMany({ where: row })).count).toBe(1);
				expect(await native.prisma.notificationChannel.count({ where: row })).toBe(0);
			}
		});
		nativeRows.delete(native);
		await native.close();
	}
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("Library Cleanup accepted recovery, execution and notification drain", () => {
	it.each(["startup", "interval"] as const)(
		"native %s immediate cleanup persists and delivers without a held boundary",
		async (origin) => {
			const f = await bootNativeBoundary(origin);
			const result = await f.outcome();
			expect({
				executions: f.executions.length,
				advances: f.advances.length,
				sends: f.events.length,
				failures: f.failures,
				warnings: f.warnings,
				events: result.events.length,
				deliveries: result.deliveries.length,
				history: result.history.map((row) => row.status),
			}).toEqual({
				executions: 1,
				advances: 1,
				sends: 1,
				failures: [],
				warnings: [],
				events: 1,
				deliveries: 1,
				history: ["sent"],
			});
			expect(result.config.lastRunAt).toEqual(new Date());
			expect(result.config.nextRunAt).toEqual(new Date(Date.now() + 86_400_000));
			expect(result.events).toHaveLength(1);
			expect(result.deliveries).toHaveLength(1);
			expect(result.events[0]).toMatchObject({
				userId: f.native.userId,
				eventType: "CLEANUP_ITEMS_REMOVED",
				stage: "terminal",
				dueAt: new Date(),
			});
			expect(result.events[0]?.encryptedPayload).not.toContain("Library cleanup");
			expect(
				JSON.parse(
					f.native.encryptor.decrypt({
						value: result.events[0]!.encryptedPayload,
						iv: result.events[0]!.payloadIv,
					}),
				),
			).toMatchObject({
				purpose: "arr-dashboard:notification-outbox-event",
				userId: f.native.userId,
				payload: {
					eventType: "CLEANUP_ITEMS_REMOVED",
					title: "Library cleanup needs review",
					body: "1 removed, 1 skipped",
					url: "https://synthetic.invalid/library-cleanup",
					metadata: { itemsRemoved: 1, itemsUnmonitored: 0, itemsFilesDeleted: 0, itemsSkipped: 1 },
				},
			});
			expect(result.deliveries[0]).toMatchObject({
				userId: f.native.userId,
				eventId: result.events[0]!.id,
				channelId: f.native.channelId,
				channelType: "DISCORD",
				subscriptionEventType: "CLEANUP_ITEMS_REMOVED",
				state: "sent",
				attemptOrdinal: 0,
			});
			expect(result.history.map((row) => row.status)).toEqual(["sent"]);
			expect(result.foreignEvents).toEqual([]);
			expect(result.foreignHistory).toEqual([]);
			expect(f.payloads).toEqual([
				{
					title: "Library cleanup needs review",
					body: "1 removed, 1 skipped",
					url: "https://synthetic.invalid/library-cleanup",
					metadata: { itemsRemoved: 1, itemsUnmonitored: 0, itemsFilesDeleted: 0, itemsSkipped: 1 },
				},
			]);
			expect(f.state.forbidden).toBe(0);
		},
	);
	for (const origin of ["startup", "interval"] as const) {
		for (const phase of [
			"audit",
			"rescan",
			"approval",
			"recovery-write",
			"config",
			"execute",
			"advance",
			"subscription",
			"send",
			"log",
			"channel",
		] as const) {
			for (const reject of [false, true]) {
				it(`drains ${origin} ${phase} ${reject ? "failure" : "completion"} before teardown`, async () => {
					const gate = deferred();
					const fixture = await boot({
						origin,
						mode: phase === "recovery-write" ? "recovery" : "partial",
						hold: { phase, gate: gate.promise, reject },
					});
					if (origin === "interval") fixture.tick();
					expect(await fixture.waitUntilHeld()).toBe(true);
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
					expect(fixture.state.forbidden).toBe(0);
					expect(fixture.state.network).toBe(0);
					const snapshot = await fixture.outcome();
					if (phase === "recovery-write") {
						assertNativeRecovery(fixture, snapshot, !reject);
						return;
					}
					const failure = reject && ["approval", "config", "execute", "advance"].includes(phase);
					const broadcast = reject && (phase === "approval" || phase === "config");
					const executed = !(reject && ["approval", "config", "execute"].includes(phase));
					const advanced = executed && !(reject && phase === "advance");
					expect(fixture.executions).toEqual(executed ? [fixture.owner] : []);
					expect(fixture.advances).toEqual(advanced ? [fixture.configId] : []);
					expect(snapshot.config.lastRunAt).toEqual(advanced ? new Date() : null);
					expect(snapshot.foreignConfig.lastRunAt).toBe(null);
					expect(snapshot.scans).toEqual([]);
					if (reject && phase === "subscription") {
						expect(snapshot.events).toEqual([]);
						expect(snapshot.deliveries).toEqual([]);
						expect(snapshot.history).toEqual([]);
						expect(fixture.events).toEqual([]);
					} else {
						const dispatched = phase === "send" || phase === "log" || phase === "channel";
						const deliveryState = !dispatched
							? "ready"
							: !reject
								? "sent"
								: phase === "send"
									? "uncertain"
									: "submitting";
						assertNativeGraph(
							fixture,
							snapshot,
							failure ? failurePayload : cleanupPayload(),
							deliveryState,
						);
						expect(fixture.events).toEqual(
							dispatched
								? [
										{
											owner: fixture.owner,
											event: "CLEANUP_ITEMS_REMOVED",
											metadata: cleanupPayload().metadata,
										},
									]
								: [],
						);
						if (broadcast) assertNativeGraph(fixture, snapshot, failurePayload, "ready", true);
					}
					if (!broadcast) {
						expect(snapshot.foreignEvents).toEqual([]);
						expect(snapshot.foreignDeliveries).toEqual([]);
						expect(snapshot.foreignHistory).toEqual([]);
					}
					if (!reject) expect(fixture.warnings).toEqual([]);
					if (!["send", "log", "channel"].includes(phase))
						expect(snapshot.channel.lastSentAt).toBe(null);
				});
			}
		}
	}
	it("refuses a retired timer and start after terminal close", async () => {
		const fixture = await boot({ mode: "empty" });
		const old = fixture.callback();
		await fixture.app.close();
		const audit = fixture.state.audit;
		old();
		fixture.app.cleanupScheduler.start();
		old();
		await settle();
		expect(fixture.state.audit).toBe(audit);
		expect(fixture.state.afterTeardown).toBe(0);
	});
	it("keeps stop/restart nonterminal while refusing callbacks from the old generation", async () => {
		const fixture = await boot({ mode: "empty" });
		const old = fixture.callback();
		fixture.app.cleanupScheduler.stop();
		old();
		await settle();
		expect(fixture.state.audit).toBe(2);
		fixture.app.cleanupScheduler.start();
		await fixture.idle();
		expect(fixture.state.audit).toBe(4);
		old();
		await settle();
		expect(fixture.state.audit).toBe(4);
		fixture.tick();
		await fixture.idle();
		expect(fixture.state.audit).toBe(6);
	});
	it("retains both overlapping recovery reads and duplicate shutdown", async () => {
		const first = deferred(),
			second = deferred();
		const fixture = await boot({ hold: { phase: "audit", gate: first.promise } });
		expect(await fixture.waitUntilHeld()).toBe(true);
		// A second accepted check can overlap discovery under the existing semantics.
		const approval = fixture.app.prisma.libraryCleanupApproval;
		const reads: { findMany: AwaitOnly<typeof approval.findMany> } = approval;
		const find = vi.mocked(reads.findMany).getMockImplementation();
		if (!find) throw new Error("Native discovery forwarding wrapper missing");
		let secondHeld = false;
		vi.spyOn(reads, "findMany").mockImplementation(async (...args) => {
			if (secondHeld) return find(...args);
			secondHeld = true;
			fixture.state.pending++;
			try {
				await second.promise;
				return await find(...args);
			} finally {
				fixture.state.pending--;
			}
		});
		fixture.tick();
		expect(await waitForNative(() => fixture.state.pending === 2)).toBe(true);
		let closed = 0;
		const closes = [fixture.app.close(), fixture.app.close()].map((p) =>
			p.then(() => {
				closed++;
			}),
		);
		await fixture.closing;
		await settle();
		expect(closed).toBe(0);
		first.resolve();
		expect(await waitForNative(() => fixture.state.pending === 1)).toBe(true);
		expect(closed).toBe(0);
		second.resolve();
		await Promise.all(closes);
		expect(fixture.state.pendingAtTeardown).toBe(0);
		expect(fixture.state.teardown).toBe(1);
		expect(fixture.state.afterTeardown).toBe(0);
	});
	it("preserves minute cadence and duplicate-start protection", async () => {
		const fixture = await boot({ mode: "empty" });
		fixture.app.cleanupScheduler.start();
		await vi.advanceTimersByTimeAsync(59_999);
		expect(fixture.state.config).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await fixture.idle();
		expect(fixture.state.config).toBe(2);
	});
	it.each(["empty", "disabled", "future", "recovery"] as const)(
		"does not execute a %s due-run",
		async (mode) => {
			const fixture = await boot({ mode });
			expect(fixture.executions).toEqual([]);
			expect(fixture.advances).toEqual([]);
			expect(fixture.events).toEqual([]);
			expect(fixture.state.forbidden).toBe(0);
			const snapshot = await fixture.outcome();
			expect(snapshot.events).toEqual([]);
			expect(snapshot.deliveries).toEqual([]);
			expect(snapshot.history).toEqual([]);
			expect(snapshot.foreignEvents).toEqual([]);
			expect(snapshot.config.lastRunAt).toBe(null);
			if (mode === "recovery") assertNativeRecovery(fixture, snapshot, true);
		},
	);
	it.each(["completed", "partial", "dry-run"] as const)(
		"retains honest %s result and owner through notification handoff",
		async (mode) => {
			const gate = deferred();
			const fixture = await boot({
				mode,
				owner: "synthetic-b",
				hold: { phase: "execute", gate: gate.promise },
			});
			await fixture.entered;
			const close = fixture.app.close();
			await fixture.closing;
			await settle();
			expect(fixture.state.teardown).toBe(0);
			gate.resolve();
			await close;
			expect(fixture.executions).toEqual([fixture.owner]);
			expect(fixture.advances).toEqual([fixture.configId]);
			expect(fixture.events).toEqual([]);
			const snapshot = await fixture.outcome();
			assertNativeGraph(fixture, snapshot, cleanupPayload(mode), "ready");
			expect(snapshot.foreignEvents).toEqual([]);
			expect(snapshot.foreignHistory).toEqual([]);
			expect(fixture.state.afterTeardown).toBe(0);
		},
	);
	it("keeps readiness independent of held optional startup execution while close joins it", async () => {
		const gate = deferred();
		const fixture = await boot({ hold: { phase: "execute", gate: gate.promise } });
		expect(fixture.state.readySettled).toBe(true);
		expect(await fixture.waitUntilHeld()).toBe(true);
		expect(fixture.pending().size).toBe(1);
		expect(
			await fixture.native.run(() =>
				fixture.native.prisma.user.count({ where: { id: fixture.owner } }),
			),
		).toBe(1);
		let joined = false;
		const close = fixture.app.close().then(() => {
			joined = true;
		});
		await fixture.closing;
		expect(joined).toBe(false);
		expect(fixture.state.teardown).toBe(0);
		gate.resolve();
		await close;
		expect(fixture.state.pendingAtTeardown).toBe(0);
		expect(fixture.state.afterTeardown).toBe(0);
		expect(fixture.executions).toEqual([fixture.owner]);
		assertNativeGraph(fixture, await fixture.outcome(), cleanupPayload(), "ready");
		expect(fixture.events).toEqual([]);
	});
	it("keeps an execution failure owner-scoped and recovers on the next tick", async () => {
		const gate = deferred();
		const fixture = await boot({
			owner: "synthetic-b",
			hold: { phase: "execute", gate: gate.promise, reject: true },
		});
		await fixture.entered;
		gate.resolve();
		await fixture.idle();
		expect(fixture.advances).toEqual([]);
		expect(fixture.events.map(({ event, owner }) => ({ event, owner }))).toEqual([
			{ event: "SYSTEM_ERROR", owner: fixture.owner },
		]);
		expect(fixture.app.cleanupScheduler.isRunning).toBe(false);
		fixture.tick();
		await fixture.idle();
		expect(fixture.executions).toEqual([fixture.owner]);
		expect(fixture.advances).toEqual([fixture.configId]);
		const snapshot = await fixture.outcome();
		expect(snapshot.events.map((row) => row.eventType).sort()).toEqual([
			"CLEANUP_ITEMS_REMOVED",
			"SYSTEM_ERROR",
		]);
		expect(snapshot.deliveries.map((row) => row.state)).toEqual(["sent", "sent"]);
		expect(snapshot.history).toHaveLength(2);
		expect(snapshot.foreignEvents).toEqual([]);
	});
	it("preserves the in-flight execution overlap guard", async () => {
		const gate = deferred();
		const fixture = await boot({ hold: { phase: "execute", gate: gate.promise } });
		await fixture.entered;
		fixture.tick();
		expect(await waitForNative(() => fixture.pending().size === 1)).toBe(true);
		expect(fixture.state.config).toBe(1);
		expect(fixture.state.execute).toBe(1);
		gate.resolve();
		await fixture.idle();
		expect(fixture.executions).toEqual([fixture.owner]);
	});
	it("does not produce false failed attempts during maintenance", async () => {
		const fixture = await boot({ mode: "empty" });
		const before = fixture.app.schedulerRegistry.getStatus(JOB_ID.libraryCleanup);
		const errors = vi.spyOn(fixture.app.log, "error");
		await withCleanupMaintenanceGuard(async () => {
			fixture.tick();
			await fixture.idle();
		});
		expect(fixture.state.audit).toBe(2);
		expect(errors).not.toHaveBeenCalled();
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.libraryCleanup)).toEqual(before);
	});
	it("retains maintenance exclusion through recovery and bookkeeping", async () => {
		const gate = deferred();
		const fixture = await boot({ hold: { phase: "advance", gate: gate.promise } });
		await fixture.entered;
		await expect(withCleanupMaintenanceGuard(async () => {})).rejects.toThrow("maintenance");
		gate.resolve();
		await fixture.idle();
		await withCleanupMaintenanceGuard(async () => {});
	});
});
