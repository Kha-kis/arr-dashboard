const MAX_REQUESTS = 4_000;
const MAX_DURATION_MS = 10 * 60 * 1_000;
export type TargetWatchReadPhase = "discovery" | "validation";

/** One operation owns this budget across discovery, approval and mutation fences. */
export class TargetWatchReadBudget {
	private used = 0;
	private startedAt: number | undefined;
	private stopped = false;
	private discoveryStopped = false;
	private discoveryUsed = 0;
	constructor(
		private readonly maxRequests = MAX_REQUESTS,
		private readonly maxDurationMs = MAX_DURATION_MS,
		private readonly clock: () => number = () => performance.now(),
	) {
		if (
			!Number.isSafeInteger(maxRequests) ||
			maxRequests < 0 ||
			!Number.isSafeInteger(maxDurationMs) ||
			maxDurationMs < 0
		) {
			throw new Error("Invalid provider read budget");
		}
	}
	get exhausted(): boolean {
		return this.stopped || this.discoveryStopped;
	}
	get requestsUsed(): number {
		return this.used;
	}
	tryConsume(requests = 1, phase: TargetWatchReadPhase = "discovery"): boolean {
		const now = this.clock();
		this.startedAt ??= now;
		if (
			this.stopped ||
			!Number.isSafeInteger(requests) ||
			requests < 1 ||
			!Number.isFinite(now) ||
			now < this.startedAt ||
			now - this.startedAt > this.maxDurationMs
		) {
			this.stopped = true;
			return false;
		}
		// Reserve a quarter of the operation allowance for selected items' live
		// mutation fences. A large discovery pass cannot spend that allowance.
		if (
			phase === "discovery" &&
			(this.discoveryStopped || this.discoveryUsed + requests > Math.floor(this.maxRequests * 0.75))
		) {
			this.discoveryStopped = true;
			return false;
		}
		if (this.used + requests > this.maxRequests) {
			this.stopped = true;
			return false;
		}
		this.used += requests;
		if (phase === "discovery") this.discoveryUsed += requests;
		return true;
	}
}
