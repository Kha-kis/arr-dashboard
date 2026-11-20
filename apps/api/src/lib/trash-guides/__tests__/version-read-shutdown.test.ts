import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggers } from "../../logger.js";
import { TemplateUpdater } from "../template-updater.js";
import { UpdateScheduler } from "../update-scheduler.js";
import { createVersionTracker } from "../version-tracker.js";

const commit = {
	sha: "synthetic",
	commit: {
		author: { name: "Synthetic", email: "synthetic@example.invalid", date: "2026-10-21T00:00:00Z" },
		message: "Synthetic",
	},
	html_url: "https://example.invalid/synthetic",
};
const version = {
	commitHash: "synthetic",
	commitDate: "2026-10-21T00:00:00Z",
	commitMessage: "Synthetic",
	commitUrl: "https://example.invalid/synthetic",
};
let fetchSignals: AbortSignal[] = [];
const schedulers: UpdateScheduler[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	fetchSignals = [];
});
afterEach(async () => {
	await vi.runAllTimersAsync();
	await Promise.all(schedulers.splice(0).map((s) => s.shutdown()));
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
async function flush() {
	for (let i = 0; i < 40; i++) await Promise.resolve();
}
function holdFetch() {
	vi.stubGlobal(
		"fetch",
		(_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init.signal!;
				fetchSignals.push(signal);
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
	);
}
function scheduler(tracker = createVersionTracker()) {
	const cache = vi.fn().mockResolvedValue({ refreshed: 0, failed: 0, errors: [] }),
		notify = vi.fn().mockResolvedValue(undefined),
		s = new UpdateScheduler(
			{ enabled: true, intervalHours: 12 },
			{ refreshAllCaches: cache } as never,
			tracker,
			{ trashTemplate: { count: async () => 0 } } as never,
			{ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
			undefined,
			{ notifyFn: notify },
		);
	schedulers.push(s);
	return { s, cache, notify };
}
describe("TRaSH read-only version cancellation", () => {
	it("refuses an already-cancelled read before issuing any GET", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return new Response(JSON.stringify(commit));
		});
		const controller = new AbortController(),
			reason = new Error("synthetic shutdown");
		controller.abort(reason);
		const result = await createVersionTracker()
			.getLatestCommit({ signal: controller.signal })
			.catch((e) => e);
		expect(calls).toBe(0);
		expect(result).toBe(reason);
	});
	it("cancels and joins a response body already being read", async () => {
		const controller = new AbortController(),
			reason = new Error("synthetic shutdown");
		let body!: ReadableStreamDefaultController<Uint8Array>;
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			const signal = init.signal!;
			fetchSignals.push(signal);
			return new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						body = c;
						signal.addEventListener("abort", () => c.error(signal.reason), { once: true });
					},
				}),
			);
		});
		const outcome = createVersionTracker()
			.getLatestCommit({ signal: controller.signal })
			.catch((e) => e);
		try {
			await flush();
			controller.abort(reason);
			await flush();
			expect(fetchSignals[0]?.aborted).toBe(true);
			expect(await outcome).toBe(reason);
		} finally {
			try {
				body.close();
			} catch {}
			await outcome;
		}
	});
	it("aborts an actual held metadata GET without retrying shutdown", async () => {
		holdFetch();
		const controller = new AbortController(),
			reason = new Error("synthetic shutdown"),
			outcome = createVersionTracker()
				.getLatestCommit({ signal: controller.signal })
				.catch((e) => e);
		await flush();
		expect(fetchSignals).toHaveLength(1);
		controller.abort(reason);
		await flush();
		expect(fetchSignals[0]?.aborted).toBe(true);
		expect(await outcome).toBe(reason);
		await vi.runAllTimersAsync();
		expect(fetchSignals).toHaveLength(1);
	});
	it("stops retry backoff before a later GET can start", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			throw Error("synthetic offline");
		});
		const controller = new AbortController(),
			reason = new Error("synthetic shutdown"),
			outcome = createVersionTracker()
				.getLatestCommit({ signal: controller.signal })
				.catch((e) => e);
		await flush();
		expect(calls).toBe(1);
		controller.abort(reason);
		await vi.runAllTimersAsync();
		expect(calls).toBe(1);
		expect(await outcome).toBe(reason);
	});
	it("joins the actual scheduler read cancellation without starting cache work or recording success", async () => {
		holdFetch();
		const { s, cache, notify } = scheduler();
		s.start();
		await flush();
		expect(fetchSignals).toHaveLength(1);
		const closing = s.shutdown();
		await flush();
		expect(fetchSignals[0]?.aborted).toBe(true);
		await closing;
		expect(cache).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect(s.getStats().lastCheckAt).toBeUndefined();
		expect(s.getStats().lastCheckResult).toBeUndefined();
		expect(s.getStats().nextCheckAt).toBeUndefined();
	});
	it("rejects a manually accepted cancelled read rather than reporting success", async () => {
		holdFetch();
		const { s, cache, notify } = scheduler(),
			outcome = s.triggerCheck().catch((e) => e);
		await flush();
		expect(fetchSignals).toHaveLength(1);
		const closing = s.shutdown();
		await flush();
		expect(fetchSignals[0]?.aborted).toBe(true);
		await closing;
		expect(await outcome).toBeInstanceOf(Error);
		expect(cache).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect(s.getStats().lastCheckResult).toBeUndefined();
	});
	it("retains ordinary retry recovery without a shutdown signal", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			if (++calls < 3) throw Error("synthetic offline");
			return new Response(JSON.stringify(commit));
		});
		const outcome = createVersionTracker().getLatestCommit();
		await vi.runAllTimersAsync();
		await expect(outcome).resolves.toEqual(version);
		expect(calls).toBe(3);
	});
	it("still joins a metadata dependency that ignores cancellation and prevents later writes", async () => {
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		const { s, cache, notify } = scheduler({
			getLatestCommit: async () => {
				await held;
				return version;
			},
		} as never);
		s.start();
		await flush();
		let closed = false;
		const closing = s.shutdown().then(() => {
			closed = true;
		});
		await flush();
		expect(closed).toBe(false);
		release();
		await closing;
		expect(cache).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect(s.getStats().lastCheckResult).toBeUndefined();
	});
	it("preserves ordinary successful metadata reads when no cancellation is requested", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify(commit), { status: 200 }));
		await expect(createVersionTracker().getLatestCommit()).resolves.toEqual(version);
	});
});

function trackedScheduler({ notifyOnly = false, fetchConfigsAtCommit = vi.fn() } = {}) {
	const template = {
		id: "tracked-template",
		userId: "user-1",
		name: "Tracked template",
		serviceType: "RADARR",
		trashGuidesCommitHash: "old",
		configData: '{"customFormats":[]}',
		hasUserModifications: false,
		qualityProfileMappings: [{ syncStrategy: notifyOnly ? "notify" : "auto" }],
	};
	const findTemplates = vi.fn().mockResolvedValue([template]);
	const prisma = {
		trashTemplate: {
			count: vi.fn().mockResolvedValue(1),
			findMany: vi.fn(({ distinct }: { distinct?: string[] }) =>
				distinct ? [{ userId: template.userId }] : findTemplates(),
			),
			findUnique: vi.fn().mockResolvedValue(template),
		},
		templateQualityProfileMapping: { findFirst: vi.fn().mockResolvedValue({ id: "auto" }) },
		$transaction: vi.fn(),
	};
	const tracker = createVersionTracker();
	const provenance = { version: 1, repository: "TRaSH-Guides/Guides", commitHash: commit.sha };
	const setVerified = vi.fn();
	const updater = new TemplateUpdater(
		prisma as never,
		tracker,
		{
			get: vi.fn().mockResolvedValue([]),
			getSnapshot: vi.fn().mockResolvedValue(null),
			setVerified,
		} as never,
		{ getCommitProvenance: () => provenance, fetchConfigsAtCommit } as never,
	);
	vi.spyOn(updater, "refreshAllCaches").mockResolvedValue({
		refreshed: 0,
		failed: 0,
		errors: [],
		verifiedConfigTypes: [],
		verifiedQualitySizeData: null,
	});
	const notify = vi.fn().mockResolvedValue(undefined);
	const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const s = new UpdateScheduler(
		{ enabled: true, intervalHours: 12 },
		updater,
		tracker,
		prisma as never,
		logger,
		undefined,
		{ notifyFn: notify },
	);
	vi.spyOn(
		s as never as { processQualitySizeSync: () => Promise<unknown> },
		"processQualitySizeSync",
	).mockResolvedValue({ autoSynced: 0, updatesPending: 0, errors: [] });
	vi.spyOn(
		s as never as { processNamingSync: () => Promise<unknown> },
		"processNamingSync",
	).mockResolvedValue({ autoSynced: 0, updatesPending: 0, errors: [] });
	schedulers.push(s);
	return {
		s,
		updater,
		notify,
		logger,
		template,
		findTemplates,
		setVerified,
		transaction: prisma.$transaction,
	};
}

describe("TRaSH tracked template shutdown", () => {
	it.each([
		{ stage: "per-user check", read: 2, ref: "master", notifyOnly: false },
		{ stage: "auto-update check", read: 3, ref: "master", notifyOnly: false },
		{ stage: "target commit metadata", read: 4, ref: commit.sha, notifyOnly: false },
		{ stage: "attention check", read: 4, ref: "master", notifyOnly: true },
	])("cancels and joins the $stage GET", async ({ read, ref, notifyOnly }) => {
		const { s, notify, logger, setVerified, transaction } = trackedScheduler({ notifyOnly });
		let release!: () => void;
		let heldSignal: AbortSignal | undefined;
		const fetch = vi.fn(async (url: string, init: RequestInit) => {
			if (fetch.mock.calls.length !== read) return new Response(JSON.stringify(commit));
			expect(url).toMatch(new RegExp(`/commits/${ref}$`));
			heldSignal = init.signal!;
			return new Promise<Response>((resolve, reject) => {
				release = () => resolve(new Response(JSON.stringify(commit)));
				heldSignal!.addEventListener("abort", () => reject(heldSignal!.reason), { once: true });
			});
		});
		vi.stubGlobal("fetch", fetch);

		const work = s.triggerCheck().catch((error) => error);
		try {
			for (let i = 0; i < 5 && !heldSignal; i++) await flush();
			expect(heldSignal).toBeDefined();
			const closing = s.shutdown();
			expect(heldSignal?.aborted).toBe(true);
			await closing;
			expect(await work).toBe(heldSignal?.reason);
			expect(fetch).toHaveBeenCalledTimes(read);
			expect(transaction).not.toHaveBeenCalled();
			expect(setVerified).not.toHaveBeenCalled();
			expect(notify).not.toHaveBeenCalled();
			expect(logger.error).not.toHaveBeenCalled();
			expect(s.getStats().lastCheckResult).toBeUndefined();
		} finally {
			release?.();
			await work;
		}
	});

	it("joins an abort-ignoring commit-content sibling and rejects its late data before publication", async () => {
		let release!: () => void;
		const held = new Promise<[]>((resolve) => {
			release = () => resolve([]);
		});
		const fetchConfigsAtCommit = vi.fn(
			(
				_service: string,
				configType: string,
				_commit: string,
				options?: { signal?: AbortSignal },
			) => {
				if (configType === "CUSTOM_FORMATS") return held;
				const signal = options?.signal;
				if (!signal) return Promise.resolve([]);
				return new Promise<[]>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
		);
		const { s, notify, setVerified, transaction } = trackedScheduler({ fetchConfigsAtCommit });
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify(commit)));

		const work = s.triggerCheck().catch((error) => error);
		try {
			for (let i = 0; i < 5 && fetchConfigsAtCommit.mock.calls.length < 3; i++) await flush();
			expect(fetchConfigsAtCommit).toHaveBeenCalledTimes(3);
			let closed = false;
			const closing = s.shutdown().then(() => {
				closed = true;
			});
			const signals = fetchConfigsAtCommit.mock.calls.map(([, , , options]) => options?.signal);
			await flush();
			expect(signals.map((signal) => signal?.aborted)).toEqual([true, true, true]);
			expect(closed).toBe(false);
			release();
			await closing;
			expect(await work).toBe(signals[0]?.reason);
			expect(setVerified).not.toHaveBeenCalled();
			expect(transaction).not.toHaveBeenCalled();
			expect(notify).not.toHaveBeenCalled();
			expect(s.getStats().lastCheckResult).toBeUndefined();
		} finally {
			release();
			await work;
		}
	});

	it.each(["SUCCESS", "UNCERTAIN"] as const)(
		"hands off a completed %s deployment when a later template read is cancelled",
		async (status) => {
			const { s, updater, notify, template, findTemplates, transaction } = trackedScheduler();
			findTemplates.mockResolvedValue([
				{
					...template,
					id: "catch-up-template",
					trashGuidesCommitHash: commit.sha,
					lastSyncedAt: new Date("2026-10-20"),
					qualityProfileMappings: [
						{
							syncStrategy: "auto",
							lastSyncedAt: new Date("2026-10-19"),
							instance: { enabled: true },
						},
					],
				},
				template,
			]);
			const deployment = vi
				.spyOn(
					updater as unknown as { deployToMappedInstances: () => Promise<unknown> },
					"deployToMappedInstances",
				)
				.mockResolvedValue([
					{
						status,
						instanceId: "instance-1",
						instanceLabel: "Synthetic target",
						endpointKey: "synthetic-endpoint",
						errors: ["Synthetic uncertain deployment"],
					},
				]);
			let heldSignal: AbortSignal | undefined;
			let release!: () => void;
			vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
				if (!url.endsWith(`/commits/${commit.sha}`)) return new Response(JSON.stringify(commit));
				heldSignal = init.signal!;
				return new Promise<Response>((resolve, reject) => {
					release = () => resolve(new Response(JSON.stringify(commit)));
					heldSignal!.addEventListener("abort", () => reject(heldSignal!.reason), { once: true });
				});
			});
			const work = s.triggerCheck().catch((error) => error);
			try {
				for (let i = 0; i < 5 && !heldSignal; i++) await flush();
				expect(deployment).toHaveBeenCalledTimes(1);
				expect(heldSignal).toBeDefined();
				const closing = s.shutdown();
				expect(heldSignal?.aborted).toBe(true);
				await closing;
				expect(await work).toBe(heldSignal?.reason);
				expect(transaction).not.toHaveBeenCalled();
				expect(notify).toHaveBeenCalledTimes(1);
				if (status === "UNCERTAIN") {
					expect(notify).toHaveBeenCalledWith(
						expect.objectContaining({ eventType: "TRASH_DEPLOY_UNCERTAIN" }),
						{ userId: template.userId, fallbackEventTypes: ["TRASH_SYNC_ERROR"] },
					);
				} else {
					expect(notify).toHaveBeenCalledWith(
						expect.objectContaining({
							eventType: "TRASH_PROFILE_UPDATED",
							body: "1 synced before the update check was interrupted by shutdown",
							metadata: { templatesAutoSynced: 1, qualitySizeAutoSynced: 0, interrupted: true },
						}),
					);
				}
				expect(s.getStats().lastCheckResult).toBeUndefined();
			} finally {
				release?.();
				await work;
			}
		},
	);

	it.each([false, true])("drains entered fallback cache writes with failure=%s", async (failed) => {
		const warn = vi.spyOn(loggers.trashGuides, "warn").mockImplementation(() => {});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchConfigsAtCommit = vi.fn().mockResolvedValue([]);
		const { s, setVerified, transaction, notify, logger } = trackedScheduler({
			fetchConfigsAtCommit,
		});
		setVerified.mockImplementation(async (_service, configType) => {
			if (configType === "CUSTOM_FORMATS") await held;
			if (failed && configType === "CF_GROUPS")
				throw new Error("Synthetic cache publication failure");
		});
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify(commit)));
		const work = s.triggerCheck().catch((error) => error);
		try {
			for (let i = 0; i < 5 && setVerified.mock.calls.length < 3; i++) await flush();
			expect(setVerified).toHaveBeenCalledTimes(3);
			let closed = false;
			const closing = s.shutdown().then(() => {
				closed = true;
			});
			await flush();
			expect(closed).toBe(false);
			release();
			await closing;
			expect(await work).toBeInstanceOf(Error);
			expect(transaction).not.toHaveBeenCalled();
			expect(notify).not.toHaveBeenCalled();
			expect(s.getStats().lastCheckResult).toBeUndefined();
			if (failed) {
				expect(warn).toHaveBeenCalledExactlyOnceWith(
					{ serviceType: "RADARR", configType: "CF_GROUPS", operation: "setVerified" },
					"TRaSH cache write failed during shutdown",
				);
				expect(logger.warn).toHaveBeenCalledWith(
					{ errorCount: 1 },
					"TRaSH update check had errors before shutdown interrupted acquisition",
				);
			} else {
				expect(warn).not.toHaveBeenCalled();
				expect(logger.warn).not.toHaveBeenCalled();
			}
		} finally {
			release();
			await work;
			warn.mockRestore();
		}
	});
});
