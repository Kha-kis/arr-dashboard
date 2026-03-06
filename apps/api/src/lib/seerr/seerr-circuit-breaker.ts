/**
 * Seerr Circuit Breaker
 *
 * In-memory, per-instance circuit breaker that prevents cascading failures.
 *
 * States:
 * - CLOSED: requests flow normally; consecutive failures tracked
 * - OPEN: all requests fail-fast; transitions to HALF_OPEN after cooldown
 * - HALF_OPEN: a single probe request is allowed; success → CLOSED, failure → OPEN
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_FAILURE_WINDOW_MS = 60_000; // 60s
const DEFAULT_COOLDOWN_MS = 30_000; // 30s
const CLEANUP_INTERVAL_MS = 5 * 60_000; // 5 min

export interface CircuitBreakerOptions {
	failureThreshold?: number;
	failureWindowMs?: number;
	cooldownMs?: number;
}

interface CircuitData {
	state: CircuitState;
	failures: number[];
	openedAt: number | null;
}

export class SeerrCircuitBreaker {
	private readonly circuits = new Map<string, CircuitData>();
	private readonly failureThreshold: number;
	private readonly failureWindowMs: number;
	private readonly cooldownMs: number;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor(opts?: CircuitBreakerOptions) {
		this.failureThreshold = opts?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
		this.failureWindowMs = opts?.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS;
		this.cooldownMs = opts?.cooldownMs ?? DEFAULT_COOLDOWN_MS;

		// Periodic cleanup of idle circuit data
		this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
		this.cleanupTimer.unref();
	}

	/** Check if a request is allowed. Throws if circuit is OPEN. */
	check(instanceId: string): void {
		const circuit = this.circuits.get(instanceId);
		if (!circuit) return; // No data → CLOSED

		if (circuit.state === "OPEN") {
			const elapsed = Date.now() - (circuit.openedAt ?? 0);
			if (elapsed >= this.cooldownMs) {
				// Transition to HALF_OPEN — allow one probe
				circuit.state = "HALF_OPEN";
				return;
			}
			throw new CircuitBreakerOpenError(instanceId, this.cooldownMs - elapsed);
		}
		// CLOSED or HALF_OPEN — allow the request
	}

	/** Report a successful request. Resets the circuit to CLOSED. */
	reportSuccess(instanceId: string): void {
		const circuit = this.circuits.get(instanceId);
		if (!circuit) return;
		circuit.state = "CLOSED";
		circuit.failures = [];
		circuit.openedAt = null;
	}

	/** Report a failed request. May transition CLOSED → OPEN or HALF_OPEN → OPEN. */
	reportFailure(instanceId: string): void {
		let circuit = this.circuits.get(instanceId);
		if (!circuit) {
			circuit = { state: "CLOSED", failures: [], openedAt: null };
			this.circuits.set(instanceId, circuit);
		}

		if (circuit.state === "HALF_OPEN") {
			// Probe failed → re-open
			circuit.state = "OPEN";
			circuit.openedAt = Date.now();
			circuit.failures = [];
			return;
		}

		// CLOSED state — track failure
		const now = Date.now();
		circuit.failures.push(now);

		// Prune failures outside the window
		const windowStart = now - this.failureWindowMs;
		circuit.failures = circuit.failures.filter((t) => t >= windowStart);

		if (circuit.failures.length >= this.failureThreshold) {
			circuit.state = "OPEN";
			circuit.openedAt = now;
			circuit.failures = [];
		}
	}

	/** Get the current state for an instance (useful for health reporting). */
	getState(instanceId: string): CircuitState {
		const circuit = this.circuits.get(instanceId);
		if (!circuit) return "CLOSED";

		// Check for automatic OPEN → HALF_OPEN transition
		if (circuit.state === "OPEN") {
			const elapsed = Date.now() - (circuit.openedAt ?? 0);
			if (elapsed >= this.cooldownMs) return "HALF_OPEN";
		}
		return circuit.state;
	}

	/** Clean up idle circuits that have been CLOSED with no recent failures. */
	private cleanup(): void {
		const now = Date.now();
		for (const [id, circuit] of this.circuits) {
			if (circuit.state === "CLOSED" && circuit.failures.length === 0) {
				this.circuits.delete(id);
			} else if (circuit.state === "OPEN" && circuit.openedAt) {
				// Clean up very old OPEN circuits (> 10x cooldown)
				if (now - circuit.openedAt > this.cooldownMs * 10) {
					this.circuits.delete(id);
				}
			}
		}
	}

	/** Release resources (cleanup timer). */
	destroy(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		this.circuits.clear();
	}
}

export class CircuitBreakerOpenError extends Error {
	readonly statusCode = 503;
	readonly retryAfterMs: number;

	constructor(instanceId: string, retryAfterMs: number) {
		super(
			`Seerr circuit breaker open for instance ${instanceId} — retrying in ${Math.ceil(retryAfterMs / 1000)}s`,
		);
		this.name = "CircuitBreakerOpenError";
		this.retryAfterMs = retryAfterMs;
	}
}
