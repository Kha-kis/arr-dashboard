/**
 * Version Tracker - Stub Implementation
 * Tracks version/sync events for TRaSH guides and custom formats
 */

export interface VersionTrackEvent {
	scope: "TRASH_CF" | "TRASH_QP" | "CF_GROUPS";
	serviceInstanceId: string;
	sourceRef?: string;
	appliedAt?: Date;
	checkedAt?: Date;
	details?: Record<string, unknown>;
}

export class VersionTracker {
	/**
	 * Track when a version/template was applied to an instance
	 */
	static async trackApplied(_evt: VersionTrackEvent): Promise<void> {
		// Stub: no-op for now
		// Future: log to database or telemetry
	}

	/**
	 * Track when a version/template was checked for updates
	 */
	static async trackChecked(_evt: VersionTrackEvent): Promise<void> {
		// Stub: no-op for now
		// Future: log to database or telemetry
	}
}
