"use client";

import type { LucideIcon } from "lucide-react";
import { AlertTriangle, CheckCircle2, Circle, PauseCircle, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { StatusBadge } from "./premium-data-display";

/* =============================================================================
   DOMAIN STATUS
   Shared vocabulary for service + integration health across the app.

   Meanings (prefer runtime/effective state over static config):
   - healthy     reachable AND validated
   - degraded    reachable but partially failing (timeouts, auth warnings, etc.)
   - offline     configured but unreachable / last check failed
   - configured  set up but never validated yet
   - disabled    intentionally turned off by the operator
   ============================================================================= */

export type DomainStatus = "healthy" | "degraded" | "offline" | "configured" | "disabled";

interface DomainStatusMeta {
	/** Maps to the underlying `StatusBadge` semantic palette */
	badge: "success" | "warning" | "error" | "info" | "default";
	/** Default human label shown in the badge */
	label: string;
	/** Icon paired with the label in the badge */
	icon: LucideIcon;
	/** Short operator-facing description, suitable for a title attribute */
	description: string;
}

const STATUS_META: Record<DomainStatus, DomainStatusMeta> = {
	healthy: {
		badge: "success",
		label: "Healthy",
		icon: CheckCircle2,
		description: "Reachable and last check succeeded",
	},
	degraded: {
		badge: "warning",
		label: "Degraded",
		icon: AlertTriangle,
		// Explicitly frames the badge as a point-in-time snapshot and
		// defers the "is it broken right now?" question to Pulse, which
		// is the canonical live-health surface. Avoids the framing
		// conflict where a cached "Degraded" badge contradicted a
		// fresh Pulse state.
		description: "Last check reported issues. See Pulse for live health.",
	},
	offline: {
		badge: "error",
		label: "Offline",
		icon: XCircle,
		// Same framing discipline as `degraded`: the label "Offline" is
		// a snapshot of the last test, not a live claim. Pointing at
		// Pulse keeps the operator from reading "Offline" as a live
		// diagnosis when it may be stale.
		description: "Last check failed. See Pulse for live health.",
	},
	configured: {
		badge: "info",
		label: "Configured",
		icon: Circle,
		description: "Set up but not yet validated",
	},
	disabled: {
		badge: "default",
		label: "Disabled",
		icon: PauseCircle,
		description: "Intentionally turned off",
	},
};

/** Look up badge props + label/icon/description for a domain status. */
export function getDomainStatusMeta(status: DomainStatus): DomainStatusMeta {
	return STATUS_META[status];
}

interface DomainStatusBadgeProps {
	status: DomainStatus;
	/** Override the default label (e.g. "Active" instead of "Healthy"). */
	label?: ReactNode;
	/** Hide the icon when space is tight. */
	hideIcon?: boolean;
	className?: string;
	/** Optional override for the hover description. */
	title?: string;
}

/**
 * Shared status badge for service/integration health.
 * Wraps the low-level `StatusBadge` primitive with a stable taxonomy so that
 * `healthy`/`degraded`/etc. render identically across every surface.
 */
export function DomainStatusBadge({
	status,
	label,
	hideIcon,
	className,
	title,
}: DomainStatusBadgeProps) {
	const meta = STATUS_META[status];
	return (
		<span title={title ?? meta.description} className={cn("inline-flex", className)}>
			<StatusBadge status={meta.badge} icon={hideIcon ? undefined : meta.icon}>
				{label ?? meta.label}
			</StatusBadge>
		</span>
	);
}

/* =============================================================================
   DERIVATION HELPERS
   Thin adapters from concrete runtime shapes -> DomainStatus. Keep each one
   focused on a single surface so callers stay readable.
   ============================================================================= */

/**
 * Derive status for an ARR service instance (Sonarr/Radarr/Prowlarr/Lidarr/Readarr).
 * Prefers the most recent transient test result when present; falls back to
 * `configured` whenever we don't yet have a signal from a real round-trip.
 */
export function deriveServiceInstanceStatus(input: {
	enabled: boolean;
	hasApiKey: boolean;
	/** Most recent test round-trip, if any. */
	testResult?: { success: boolean } | null;
}): DomainStatus {
	if (!input.enabled) return "disabled";
	if (!input.hasApiKey) return "configured";
	if (!input.testResult) return "configured";
	return input.testResult.success ? "healthy" : "offline";
}

/**
 * Derive status for a notification channel. Uses the persisted last-test
 * outcome so the badge reflects real delivery health, not just the enable toggle.
 */
export function deriveNotificationChannelStatus(input: {
	enabled: boolean;
	lastTestedAt: string | null;
	lastTestResult: string | null;
}): DomainStatus {
	if (!input.enabled) return "disabled";
	if (!input.lastTestedAt || !input.lastTestResult) return "configured";
	if (input.lastTestResult === "success") return "healthy";
	return "offline";
}
