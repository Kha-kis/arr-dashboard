import { AsyncLocalStorage } from "node:async_hooks";

const STAGES = ["lane-wait", "connect", "guard", "yield", "statement-call", "owner-proof"] as const;
type Stage = (typeof STAGES)[number];
type Counter = Readonly<{ count: number; totalMs: number; maxMs: number }>;
export type RuntimeReadTiming = Readonly<Record<Stage, Counter>>;
type Scope = {
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

/** Opt-in observation; failures in the sink cannot replace the operation outcome. */
export function withRuntimeReadTiming<T>(
	operation: () => T | Promise<T>,
	observe: (stages: RuntimeReadTiming) => void,
): Promise<T> {
	const scope: Scope = {
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
				observe(Object.freeze(result));
			} catch {
				// No error, request fields, SQL or data enter this diagnostic boundary.
			}
		}
	});
}
