/**
 * Operator Console domain tiles — grouping + status derivation.
 *
 * The scheduler registry exposes 22 jobs (`GET /api/system/jobs`), many of
 * them internal plumbing. The console's tiles group them into the operator's
 * domain vocabulary (the same nouns as the sidebar), so one tile answers
 * "is this domain running, when did it last act, how often does it act."
 *
 * Trust rules applied here:
 * - NO derived "next run at HH:MM" claims. `JobStatus` records facts
 *   (last runs, declared cadence) — it has no `nextExecution`, and
 *   `lastStartedAt + intervalMs` is a proxy, not a promise. Tiles show the
 *   declared cadence ("every 10 min", exactly true) and last activity
 *   (recorded fact) instead.
 * - Service-availability gating by OMISSION: domains whose backing service
 *   has no enabled instance (qui, Seerr, media servers) render no tile at
 *   all rather than a misleading "healthy" for a no-op job.
 * - Status thresholds mirror the Pulse scheduler collector
 *   (FAILING_THRESHOLD = 2 consecutive failures → degraded) so the tiles
 *   and the attention feed can never disagree about the same job.
 * - `session-cleanup` is excluded: internal hygiene with no operator
 *   action or page to link to.
 */

import type { ServiceInstanceSummary } from "@arr/shared";
import type { LucideIcon } from "lucide-react";
import {
	Archive,
	Inbox,
	Library,
	MonitorPlay,
	Network,
	Sparkles,
	Tag,
	Target,
	Trash2,
} from "lucide-react";
import type { DomainStatus } from "../../../components/layout/domain-status";
import type { SystemJobStatus } from "../../../lib/api-client/system";

export interface ConsoleDomain {
	id: string;
	label: string;
	icon: LucideIcon;
	/** Action link — must point at an existing page showing the domain's data. */
	href: string;
	/** Registry job ids that make up this domain. */
	jobIds: readonly string[];
	/**
	 * Tile renders only when at least one ENABLED instance of one of these
	 * service types exists. Omitted = always relevant (core domains).
	 */
	requiresService?: readonly string[];
}

// Mirrors the Pulse scheduler collector's FAILING_THRESHOLD — keep in sync
// with apps/api/src/lib/pulse/collectors.ts.
const FAILING_THRESHOLD = 2;

export const CONSOLE_DOMAINS: readonly ConsoleDomain[] = [
	{
		id: "backup",
		label: "Backup",
		icon: Archive,
		href: "/settings?tab=backups",
		jobIds: ["backup"],
	},
	{
		id: "library",
		label: "Library",
		icon: Library,
		href: "/library",
		jobIds: ["library-sync", "library-cleanup", "insights-digest"],
	},
	{
		id: "hunting",
		label: "Hunting",
		icon: Target,
		href: "/hunting",
		jobIds: ["hunting"],
	},
	{
		id: "queue-cleaner",
		label: "Queue Cleaner",
		icon: Trash2,
		href: "/queue-cleaner",
		jobIds: ["queue-cleaner"],
	},
	{
		id: "trash-guides",
		label: "TRaSH Guides",
		icon: Sparkles,
		href: "/trash-guides",
		jobIds: ["trash-update", "trash-sync", "trash-backup-cleanup"],
	},
	{
		id: "media-caches",
		label: "Media Caches",
		icon: MonitorPlay,
		href: "/statistics",
		jobIds: [
			"plex-cache",
			"plex-episode-cache",
			"jellyfin-cache",
			"jellyfin-episode-cache",
			"session-snapshot",
		],
		requiresService: ["plex", "jellyfin", "emby"],
	},
	{
		id: "automation",
		label: "Auto-Tag & Labels",
		icon: Tag,
		href: "/auto-tag",
		jobIds: ["auto-tag", "label-sync", "tmdb-list-cache", "trakt-list-cache"],
	},
	{
		id: "qui",
		label: "qui",
		icon: Network,
		href: "/qui",
		jobIds: ["qui-torrent-state-sync", "infohash-backfill"],
		requiresService: ["qui"],
	},
	{
		id: "requests",
		label: "Requests",
		icon: Inbox,
		href: "/requests",
		jobIds: ["seerr-health"],
		requiresService: ["seerr"],
	},
];

export interface DomainTileModel {
	domain: ConsoleDomain;
	status: DomainStatus;
	/** Hover/tooltip copy explaining the status. */
	statusDetail: string;
	/** Epoch ms of the most recent job activity, or null when never ran. */
	lastActivityMs: number | null;
	/** Human cadence ("every 10 min") when ALL member jobs declare one… */
	cadence: string | null;
	/** …true while any member job is mid-run. */
	isRunning: boolean;
}

function toMs(iso: string | null): number | null {
	if (!iso) return null;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : null;
}

export function formatCadence(intervalMs: number): string {
	const minutes = Math.round(intervalMs / 60_000);
	if (minutes < 60) return `every ${minutes} min`;
	const hours = Math.round(minutes / 60);
	return hours === 1 ? "every hour" : `every ${hours} h`;
}

/**
 * Derive one tile's model from the registry jobs. Pure — unit-tested
 * directly. Returns null when the domain has no registered member jobs
 * (nothing truthful to show).
 */
export function deriveDomainTile(
	domain: ConsoleDomain,
	jobs: readonly SystemJobStatus[],
): DomainTileModel | null {
	const members = jobs.filter((job) => domain.jobIds.includes(job.id));
	if (members.length === 0) return null;

	const disabledMember = members.find((job) => job.disabled);
	const failingMember = members.find((job) => job.consecutiveFailures >= FAILING_THRESHOLD);
	// "Most recent run failed" — lastFailureAt strictly newer than lastSuccessAt.
	const lastRunFailedMember = members.find((job) => {
		const failure = toMs(job.lastFailureAt);
		const success = toMs(job.lastSuccessAt);
		return failure !== null && (success === null || failure > success);
	});
	const everRan = members.some((job) => job.totalRuns > 0);

	let status: DomainStatus;
	let statusDetail: string;
	if (disabledMember) {
		status = "disabled";
		statusDetail = disabledMember.disabledReason
			? `${disabledMember.label}: ${disabledMember.disabledReason}`
			: `${disabledMember.label} is disabled`;
	} else if (failingMember) {
		status = "degraded";
		statusDetail = `${failingMember.label}: ${failingMember.consecutiveFailures} consecutive failures`;
	} else if (lastRunFailedMember) {
		status = "degraded";
		statusDetail = `${lastRunFailedMember.label}: last run failed`;
	} else if (!everRan) {
		status = "configured";
		statusDetail = "Registered — no runs yet";
	} else {
		status = "healthy";
		statusDetail = "All jobs healthy";
	}

	const lastActivityMs = members.reduce<number | null>((latest, job) => {
		const candidate = toMs(job.lastFinishedAt) ?? toMs(job.lastStartedAt);
		if (candidate === null) return latest;
		return latest === null ? candidate : Math.max(latest, candidate);
	}, null);

	// A cadence claim is only exactly true when every member declares one;
	// config-driven jobs (per-instance schedules) get no cadence line rather
	// than an approximate one.
	const intervals = members
		.map((job) => job.intervalMs)
		.filter((ms): ms is number => typeof ms === "number" && ms > 0);
	const cadence =
		intervals.length === members.length && intervals.length > 0
			? formatCadence(Math.min(...intervals))
			: null;

	return {
		domain,
		status,
		statusDetail,
		lastActivityMs,
		cadence,
		isRunning: members.some((job) => job.state === "running"),
	};
}

/**
 * Build the tile list: service-gated domains are OMITTED when no enabled
 * instance of a backing service exists (trust rule: never show a tile for
 * a no-op job as if it were doing work).
 */
export function buildDomainTiles(
	jobs: readonly SystemJobStatus[],
	services: readonly Pick<ServiceInstanceSummary, "service" | "enabled">[],
): DomainTileModel[] {
	const enabledServices = new Set(
		services.filter((s) => s.enabled).map((s) => s.service.toLowerCase()),
	);
	const tiles: DomainTileModel[] = [];
	for (const domain of CONSOLE_DOMAINS) {
		if (
			domain.requiresService &&
			!domain.requiresService.some((service) => enabledServices.has(service))
		) {
			continue;
		}
		const tile = deriveDomainTile(domain, jobs);
		if (tile) tiles.push(tile);
	}
	return tiles;
}
