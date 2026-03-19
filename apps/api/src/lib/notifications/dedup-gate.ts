import { createHash } from "node:crypto";
import type { NotificationPayload } from "./types.js";

const DEFAULT_TTL_MS = 60_000; // 60 seconds
const CLEANUP_INTERVAL_MS = 30_000; // 30 seconds

export class DedupGate {
	private seen: Map<string, number> = new Map();
	private cleanupTimer: ReturnType<typeof setInterval>;

	constructor(private ttlMs: number = DEFAULT_TTL_MS) {
		this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
		if (this.cleanupTimer.unref) this.cleanupTimer.unref();
	}

	isDuplicate(payload: NotificationPayload): boolean {
		const key = this.computeKey(payload);
		const now = Date.now();
		const existing = this.seen.get(key);
		if (existing && now - existing < this.ttlMs) {
			return true;
		}
		this.seen.set(key, now);
		return false;
	}

	private computeKey(payload: NotificationPayload): string {
		const data = `${payload.eventType}:${payload.title}:${payload.body}`;
		return createHash("sha256").update(data).digest("hex");
	}

	private cleanup(): void {
		const now = Date.now();
		for (const [key, timestamp] of this.seen) {
			if (now - timestamp >= this.ttlMs) {
				this.seen.delete(key);
			}
		}
	}

	destroy(): void {
		clearInterval(this.cleanupTimer);
		this.seen.clear();
	}
}
