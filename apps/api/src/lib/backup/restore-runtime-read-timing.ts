import { AsyncLocalStorage } from "node:async_hooks";

const STAGES = ["lane-wait", "connect", "guard", "yield", "statement-call", "owner-proof"] as const;
type Stage = (typeof STAGES)[number];
type Counter = Readonly<{ count: number; totalMs: number; maxMs: number }>;
export type RuntimeReadTiming = Readonly<Record<Stage, Counter>>;
const SLOW_SQLITE_READ_MS = 250;
const SQL_FAMILIES = {
	plex_cache: "plex-library-cache",
	plex_episode_cache: "plex-episode-cache",
	plex_generation_targets: "plex-target-ledger",
	cache_refresh_status: "refresh-status",
	serviceinstance: "service-instance",
} as const;
export type SlowSqliteReadTiming = Readonly<{
	family: (typeof SQL_FAMILIES)[keyof typeof SQL_FAMILIES] | "other";
	elapsedMs: number;
	synchronousNativeMs: number;
	attempts: number;
}>;
type Scope = {
	observeSlowSqliteRead: boolean;
	slowestSqliteRead?: SlowSqliteReadTiming;
	closed: boolean;
	stages: Record<Stage, { count: number; totalMs: number; maxMs: number }>;
};
const scopes = new AsyncLocalStorage<Scope>();
const noop = () => undefined;
const milliseconds = (value: number) => Math.round(value * 1000) / 1000;

/** Fixed aggregate counters only. Inclusive spans overlap and must not be added. */
export function startRuntimeReadTiming(stage: Stage): () => void {
	const scope = scopes.getStore();
	if (!scope || scope.closed) return noop;
	const startedAt = performance.now();
	let finished = false;
	return () => {
		if (finished || scope.closed) return;
		finished = true;
		const elapsed = performance.now() - startedAt;
		if (!Number.isFinite(elapsed) || elapsed < 0) return;
		const counter = scope.stages[stage];
		counter.count = Math.min(Number.MAX_SAFE_INTEGER, counter.count + 1);
		counter.totalMs = Math.min(Number.MAX_SAFE_INTEGER, counter.totalMs + elapsed);
		counter.maxMs = Math.max(counter.maxMs, elapsed);
	};
}

export function measureRuntimeReadTiming<T>(stage: Stage, operation: () => Promise<T>): Promise<T> {
	const scope = scopes.getStore();
	if (!scope || scope.closed) return operation();
	const finish = startRuntimeReadTiming(stage);
	try {
		// Invoke synchronously: no extra await between a native fence and SQL.
		return operation().finally(finish);
	} catch (error) {
		finish();
		throw error;
	}
}

/** One opt-in, fixed-family sample per request. Never retain SQL text or arguments. */
export function startSlowSqliteReadTiming(sql: string) {
	const scope = scopes.getStore();
	if (!scope?.observeSlowSqliteRead || scope.closed || !/^\s*SELECT\b/i.test(sql)) return;
	const startedAt = performance.now();
	let synchronousNativeMs = 0;
	let attempts = 0;
	return {
		startAttempt() {
			attempts++;
			const started = performance.now();
			return () => {
				synchronousNativeMs += performance.now() - started;
			};
		},
		finish() {
			if (scope.closed || attempts === 0) return;
			const elapsedMs = performance.now() - startedAt;
			if (
				!Number.isFinite(elapsedMs) ||
				!Number.isFinite(synchronousNativeMs) ||
				synchronousNativeMs < 0 ||
				elapsedMs < SLOW_SQLITE_READ_MS ||
				elapsedMs <= (scope.slowestSqliteRead?.elapsedMs ?? 0)
			)
				return;

			const table =
				/\bFROM\s+(?:(?:"main"|`main`|main)\.)?["`]?(plex_cache|plex_episode_cache|plex_generation_targets|cache_refresh_status|serviceinstance)["`]?(?=\s|[,);]|$)/i
					.exec(sql)?.[1]
					?.toLowerCase() as keyof typeof SQL_FAMILIES | undefined;
			scope.slowestSqliteRead = Object.freeze({
				family: table ? SQL_FAMILIES[table] : "other",
				elapsedMs: milliseconds(elapsedMs),
				synchronousNativeMs: milliseconds(synchronousNativeMs),
				attempts,
			});
		},
	};
}

/** Opt-in observation; failures in the sink cannot replace the operation outcome. */
export function withRuntimeReadTiming<T>(
	operation: () => T | Promise<T>,
	observe: (stages: RuntimeReadTiming, slowestSqliteRead?: SlowSqliteReadTiming) => void,
	options?: { slowSqliteRead?: boolean },
): Promise<T> {
	const scope: Scope = {
		observeSlowSqliteRead: options?.slowSqliteRead === true,
		closed: false,
		stages: Object.fromEntries(
			STAGES.map((stage) => [stage, { count: 0, totalMs: 0, maxMs: 0 }]),
		) as Scope["stages"],
	};
	return scopes.run(scope, async () => {
		try {
			return await operation();
		} finally {
			scope.closed = true;
			try {
				const result = Object.fromEntries(
					STAGES.map((stage) => {
						const counter = scope.stages[stage];
						return [
							stage,
							Object.freeze({
								count: counter.count,
								totalMs: milliseconds(counter.totalMs),
								maxMs: milliseconds(counter.maxMs),
							}),
						];
					}),
				) as RuntimeReadTiming;
				Object.freeze(result);
				if (scope.slowestSqliteRead) observe(result, scope.slowestSqliteRead);
				else observe(result);
			} catch {
				// No error, request fields, SQL or data enter this diagnostic boundary.
			}
		}
	});
}
