import { AsyncLocalStorage } from "node:async_hooks";
import {
	withRuntimeReadTiming,
	type RuntimeReadTiming,
} from "../backup/restore-runtime-read-timing.js";

const PHASES = ["materialize", "validate", "fingerprint", "checkpoint-wait"] as const;
type Phase = (typeof PHASES)[number];
type Counter = Readonly<{ count: number; totalMs: number; maxMs: number }>;
export type JellyfinDisplayReadTiming = Readonly<{
	stages: Readonly<Record<Phase, Counter>>;
	runtime: RuntimeReadTiming;
}>;
type Scope = {
	closed: boolean;
	stages: Record<Phase, { count: number; totalMs: number; maxMs: number }>;
};
const scopes = new AsyncLocalStorage<Scope>();
const noop = () => undefined;

/** Fixed aggregate counters only; inclusive phases and runtime spans overlap. */
export function startJellyfinDisplayReadPhase(phase: Phase): () => void {
	const scope = scopes.getStore();
	if (!scope || scope.closed) return noop;
	const startedAt = performance.now();
	let finished = false;
	return () => {
		if (finished || scope.closed) return;
		finished = true;
		const elapsed = performance.now() - startedAt;
		if (!Number.isFinite(elapsed) || elapsed < 0) return;
		const counter = scope.stages[phase];
		counter.count = Math.min(Number.MAX_SAFE_INTEGER, counter.count + 1);
		counter.totalMs = Math.min(Number.MAX_SAFE_INTEGER, counter.totalMs + elapsed);
		counter.maxMs = Math.max(counter.maxMs, elapsed);
	};
}

export function measureJellyfinDisplayReadPhase<T>(
	phase: Phase,
	operation: () => Promise<T>,
): Promise<T> {
	const scope = scopes.getStore();
	if (!scope || scope.closed) return operation();
	const finish = startJellyfinDisplayReadPhase(phase);
	try {
		return operation().finally(finish);
	} catch (error) {
		finish();
		throw error;
	}
}

/** Opt-in observation only; never records inputs, rows, errors or identifiers. */
export function withJellyfinDisplayReadTiming<T>(
	operation: () => T | Promise<T>,
	observe: (timing: JellyfinDisplayReadTiming) => void,
): Promise<T> {
	const scope: Scope = {
		closed: false,
		stages: Object.fromEntries(
			PHASES.map((phase) => [phase, { count: 0, totalMs: 0, maxMs: 0 }]),
		) as Scope["stages"],
	};
	return scopes.run(scope, async () => {
		let runtime!: RuntimeReadTiming;
		try {
			return await withRuntimeReadTiming(operation, (value) => {
				runtime = value;
			});
		} finally {
			scope.closed = true;
			try {
				const stages = Object.fromEntries(
					PHASES.map((phase) => {
						const c = scope.stages[phase];
						return [
							phase,
							Object.freeze({
								count: c.count,
								totalMs: Math.round(c.totalMs * 1000) / 1000,
								maxMs: Math.round(c.maxMs * 1000) / 1000,
							}),
						];
					}),
				) as Record<Phase, Counter>;
				observe(Object.freeze({ stages: Object.freeze(stages), runtime }));
			} catch {
				/* Diagnostics must not change the original read value or error. */
			}
		}
	});
}
