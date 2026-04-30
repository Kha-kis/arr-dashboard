/**
 * Per-rule concurrency lock for auto-tag execution.
 *
 * Prevents the scheduler tick and an on-demand "Run now" from executing
 * the same rule simultaneously. Without this, two concurrent
 * `series.update` calls can read-modify-write the same `tags` array
 * and one rule's tag can be lost (read [3,5] twice → both write
 * [3,5,X] then [3,5,Y] — only one X/Y survives).
 *
 * Single-process scope: the lock is a Node `Set<ruleId>` in module
 * state. The app runs as a single Node process per Docker container,
 * so this is sufficient. If we ever go multi-process / multi-replica,
 * we'd need to move to a DB-backed `running` boolean column with
 * compare-and-set semantics.
 */

const inFlight = new Set<string>();

export type LockedRunResult<T> =
	| { status: "ran"; result: T }
	| { status: "skipped"; reason: "already-running" };

/**
 * Run `fn()` exclusively for `ruleId`. If another caller is already
 * running for the same `ruleId`, returns immediately with
 * `{ status: "skipped", reason: "already-running" }` and does NOT
 * invoke `fn`.
 *
 * The lock is released in a `finally` block, so even if `fn` throws,
 * the rule is unlocked for the next run.
 */
export async function runRuleWithLock<T>(
	ruleId: string,
	fn: () => Promise<T>,
): Promise<LockedRunResult<T>> {
	if (inFlight.has(ruleId)) {
		return { status: "skipped", reason: "already-running" };
	}
	inFlight.add(ruleId);
	try {
		const result = await fn();
		return { status: "ran", result };
	} finally {
		inFlight.delete(ruleId);
	}
}

/**
 * Test-only helper to clear the in-flight set between test runs. Don't
 * call from production code.
 */
export function _clearInFlightForTesting(): void {
	inFlight.clear();
}
