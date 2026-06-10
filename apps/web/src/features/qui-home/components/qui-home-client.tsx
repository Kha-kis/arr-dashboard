"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { POLLING_STANDARD } from "../../../lib/polling-intervals";
import {
	AlertCircle,
	ArrowRight,
	CheckCircle2,
	Download,
	ExternalLink,
	HardDrive,
	History,
	Network,
	Pause,
	RefreshCw,
	TriangleAlert,
	Upload,
	Zap,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { DataFreshness, GlassmorphicCard, PremiumEmptyState, PremiumPageHeader, PremiumPageLoading } from "../../../components/layout";
import { Alert, AlertDescription, Button } from "../../../components/ui";
import { useIncognitoMode } from "../../../contexts/IncognitoContext";
import { useQuiAttention, useQuiSummary } from "../../../hooks/api/useQui";
import { runQuiBackfillNow } from "../../../lib/api-client/qui";
import { getErrorMessage } from "../../../lib/error-utils";
import { formatBytes } from "../../../lib/format-utils";
import { getLinuxInstanceName, getLinuxIsoName } from "../../../lib/incognito";
import { quiKeys } from "../../../lib/query-keys";
import { cn } from "../../../lib/utils";

/**
 * qui home page — the single-pane-of-glass entry surface (Phase 6).
 *
 * Three sections stacked vertically:
 *   1. **KPI strip** — at-a-glance numbers (totals, state counts, ratio, last sync)
 *   2. **Needs Attention feed** — torrents requiring operator action, with
 *      library context so each row says "your movie X is stalled" rather
 *      than just dumping a hash
 *   3. **Quick actions strip** — deep-links to the rest of the qui surfaces
 *
 * The page is intentionally NOT a re-skin of qui's own dashboard. qui
 * organizes its UI by torrent; this page organizes by library item. The
 * value-add is the join between qui state + *arr context.
 */
export const QuiHomeClient = () => {
	const summary = useQuiSummary();
	const attention = useQuiAttention(20);

	if (summary.isLoading) {
		return <PremiumPageLoading cardCount={3} />;
	}

	if (summary.isError) {
		return (
			<>
				<Header />
				<Alert variant="danger">
					<AlertDescription>
						Failed to load qui summary: {getErrorMessage(summary.error)}
					</AlertDescription>
				</Alert>
			</>
		);
	}

	const data = summary.data!;

	if (data.configuredInstances === 0) {
		return (
			<>
				<Header />
				<PremiumEmptyState
					icon={Network}
					title="No qui instance configured"
					description="Add a qui instance under Settings → Services. Once connected, this page becomes your at-a-glance view of torrent state across every qBittorrent backend qui manages."
					action={
						<Link href="/settings">
							<Button variant="primary">Go to Settings</Button>
						</Link>
					}
				/>
			</>
		);
	}

	return (
		<>
			<Header
				dataUpdatedAt={summary.dataUpdatedAt}
				isFetching={summary.isFetching}
				isError={summary.isError}
			/>
			<KpiStrip data={data} />
			<CorrelationBackfillCard />
			<AttentionSection
				items={attention.data?.items ?? []}
				totalCount={attention.data?.totalCount ?? 0}
				isLoading={attention.isLoading}
				isError={attention.isError}
				error={attention.error}
			/>
			<QuickActions />
		</>
	);
};

const Header = ({
	dataUpdatedAt,
	isFetching,
	isError,
}: {
	dataUpdatedAt?: number;
	isFetching?: boolean;
	isError?: boolean;
}) => (
	<PremiumPageHeader
		label="qui Integration"
		labelIcon={Network}
		title="qui — Torrent Layer"
		gradientTitle
		description="Your torrents across every qBittorrent backend qui manages, joined with the *arr library context so you can see at a glance which movies and shows need attention."
		actions={
			// Summary feed freshness — the page's panels all derive from it (B4)
			<DataFreshness
				dataUpdatedAt={dataUpdatedAt}
				isFetching={isFetching}
				isError={isError}
				pollIntervalMs={POLLING_STANDARD}
			/>
		}
	/>
);

// ── Correlation backfill — manual rescan ───────────────────────────────

/**
 * Card that triggers the path-correlation backfill on demand. Surfaces
 * the last result so the operator can see "we hashed N more rows this
 * run" without waiting for the next scheduler tick.
 *
 * Lives between the KPI strip and Needs Attention because the act of
 * running it is what shifts items from `Unmapped` to fully-correlated
 * — and the Attention feed renders the result.
 */
const CorrelationBackfillCard = () => {
	const queryClient = useQueryClient();
	const [lastResult, setLastResult] = useState<{
		rowsScanned: number;
		rowsHashed: number;
		durationMs: number;
	} | null>(null);
	const rescan = useMutation({
		mutationFn: runQuiBackfillNow,
		onSuccess: (data) => {
			setLastResult({
				rowsScanned: data.rowsScanned,
				rowsHashed: data.rowsHashed,
				durationMs: data.durationMs,
			});
			toast.success(
				`Hashed ${data.rowsHashed.toLocaleString()} of ${data.rowsScanned.toLocaleString()} rows in ${(data.durationMs / 1000).toFixed(1)}s`,
			);
			// Invalidate qui surfaces that depend on infoHash correlation so
			// new rows immediately propagate to the library, cross-seed, and
			// attention surfaces.
			queryClient.invalidateQueries({ queryKey: quiKeys.summary });
			queryClient.invalidateQueries({ queryKey: quiKeys.attention() });
			queryClient.invalidateQueries({ queryKey: quiKeys.crossSeedAvailability() });
			queryClient.invalidateQueries({ queryKey: quiKeys.crossSeedDiscovery() });
		},
		onError: (err) => {
			toast.error(`Backfill failed: ${getErrorMessage(err, "Unknown error")}`);
		},
	});
	return (
		<section className="mb-6">
			<GlassmorphicCard padding="md">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div>
						<h3 className="text-sm font-semibold text-foreground">Library correlation</h3>
						<p className="mt-1 text-xs text-muted-foreground">
							Scans up to 5,000 unmapped library items and tries to match each to a qui torrent by
							path, filename+size, or size+title+year. Hardlinked imports with *arr-renamed files
							get correlated via the last strategy. Same code as the every-6h scheduler; this just
							runs it now.
						</p>
						{lastResult ? (
							<p className="mt-2 text-xs text-emerald-300">
								Last run: hashed {lastResult.rowsHashed.toLocaleString()} of{" "}
								{lastResult.rowsScanned.toLocaleString()} scanned in{" "}
								{(lastResult.durationMs / 1000).toFixed(1)}s
							</p>
						) : null}
					</div>
					<Button variant="secondary" onClick={() => rescan.mutate()} disabled={rescan.isPending}>
						{rescan.isPending ? (
							<>
								<RefreshCw className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Correlating…
							</>
						) : (
							<>
								<RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Run correlation now
							</>
						)}
					</Button>
				</div>
			</GlassmorphicCard>
		</section>
	);
};

// ── KPI strip ──────────────────────────────────────────────────────────

interface KpiStripProps {
	data: {
		totalTorrents: number;
		byState: {
			seeding: number;
			downloading: number;
			paused: number;
			stalled: number;
			error: number;
			other: number;
		};
		avgRatio: number;
		lowRatioCount: number;
		dlSpeed: number;
		upSpeed: number;
		lastSyncAt: string | null;
		lastSyncOk: boolean | null;
		configuredInstances: number;
		qbitInstances: Array<{ id: number; name: string; connected: boolean; torrentCount: number }>;
	};
}

const KpiStrip = ({ data }: KpiStripProps) => {
	const [incognito] = useIncognitoMode();
	const disconnectedInstances = data.qbitInstances.filter((i) => !i.connected);
	return (
		<section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-7">
			<KpiCard
				label="Total torrents"
				value={data.totalTorrents.toLocaleString()}
				icon={Download}
				tone="default"
			/>
			<KpiCard
				label="Seeding"
				value={data.byState.seeding.toLocaleString()}
				sub={`${pct(data.byState.seeding, data.totalTorrents)} of total`}
				icon={Upload}
				tone="positive"
			/>
			<KpiCard
				label="Downloading"
				value={data.byState.downloading.toLocaleString()}
				sub={data.byState.stalled > 0 ? `${data.byState.stalled} stalled` : undefined}
				icon={Download}
				tone={data.byState.stalled > 0 ? "warning" : "default"}
			/>
			<KpiCard
				label="Paused / Errored"
				value={(data.byState.paused + data.byState.error).toLocaleString()}
				sub={data.byState.error > 0 ? `${data.byState.error} errored` : undefined}
				icon={data.byState.error > 0 ? AlertCircle : Pause}
				tone={data.byState.error > 0 ? "critical" : data.byState.paused > 0 ? "warning" : "default"}
			/>
			<KpiCard
				label="Avg ratio"
				value={data.avgRatio.toFixed(2)}
				sub={data.lowRatioCount > 0 ? `${data.lowRatioCount} below 1.00×` : "all healthy"}
				icon={Zap}
				tone={data.lowRatioCount > data.totalTorrents / 2 ? "warning" : "default"}
			/>
			<KpiCard
				label="Throughput"
				value={`↑ ${formatBytes(data.upSpeed)}/s`}
				sub={`↓ ${formatBytes(data.dlSpeed)}/s`}
				icon={Network}
				tone="default"
			/>
			<KpiCard
				label="qBit instances"
				value={`${data.qbitInstances.length - disconnectedInstances.length}/${data.qbitInstances.length}`}
				sub={
					disconnectedInstances.length > 0
						? `${disconnectedInstances
								.map((i) => (incognito ? getLinuxInstanceName(i.name) : i.name))
								.join(", ")} offline`
						: data.lastSyncAt
							? `synced ${relativeTime(data.lastSyncAt)}${data.lastSyncOk === false ? " · errored" : ""}`
							: "never synced"
				}
				icon={HardDrive}
				tone={
					disconnectedInstances.length > 0
						? "critical"
						: data.lastSyncOk === false
							? "warning"
							: "positive"
				}
			/>
		</section>
	);
};

interface KpiCardProps {
	label: string;
	value: string;
	sub?: string;
	icon: typeof Download;
	tone: "default" | "positive" | "warning" | "critical";
}

const TONE_BORDER: Record<KpiCardProps["tone"], string> = {
	default: "border-border/40",
	positive: "border-emerald-500/40",
	warning: "border-amber-500/40",
	critical: "border-red-500/40",
};

const TONE_VALUE: Record<KpiCardProps["tone"], string> = {
	default: "text-foreground",
	positive: "text-emerald-300",
	warning: "text-amber-300",
	critical: "text-red-300",
};

const KpiCard = ({ label, value, sub, icon: Icon, tone }: KpiCardProps) => (
	<div className={cn("rounded-xl border bg-card/30 p-4 backdrop-blur-sm", TONE_BORDER[tone])}>
		<div className="flex items-center justify-between">
			<span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
			<Icon className="h-4 w-4 text-muted-foreground/70" aria-hidden />
		</div>
		<div className={cn("mt-2 text-2xl font-semibold", TONE_VALUE[tone])}>{value}</div>
		{sub ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
	</div>
);

// ── Needs Attention feed ───────────────────────────────────────────────

interface AttentionSectionProps {
	items: ReadonlyArray<{
		hash: string;
		name: string;
		state: string;
		ratio: number;
		size: number;
		qbitInstanceId: number | null;
		qbitInstanceName: string | null;
		severity: "critical" | "warning";
		reason: string;
		libraryContext: {
			arrInstanceLabel: string;
			arrService: "sonarr" | "radarr" | "lidarr" | "readarr";
			title: string;
			year: number | null;
		} | null;
	}>;
	totalCount: number;
	isLoading: boolean;
	isError: boolean;
	error: unknown;
}

const AttentionSection = ({
	items,
	totalCount,
	isLoading,
	isError,
	error,
}: AttentionSectionProps) => {
	if (isLoading) {
		return (
			<section className="mb-6">
				<SectionHeading>Needs Attention</SectionHeading>
				<div className="space-y-2">
					<div className="h-16 animate-pulse rounded-md bg-muted/30" />
					<div className="h-16 animate-pulse rounded-md bg-muted/30" />
					<div className="h-16 animate-pulse rounded-md bg-muted/30" />
				</div>
			</section>
		);
	}
	if (isError) {
		return (
			<section className="mb-6">
				<SectionHeading>Needs Attention</SectionHeading>
				<Alert variant="danger">
					<AlertDescription>
						Failed to load attention feed: {getErrorMessage(error)}
					</AlertDescription>
				</Alert>
			</section>
		);
	}
	if (items.length === 0) {
		return (
			<section className="mb-6">
				<SectionHeading>Needs Attention</SectionHeading>
				<GlassmorphicCard padding="md">
					<div className="flex items-center gap-3 text-sm text-muted-foreground">
						<CheckCircle2 className="h-5 w-5 text-emerald-400" aria-hidden />
						<span>
							No torrents currently need attention — everything is seeding, downloading, or above
							ratio target.
						</span>
					</div>
				</GlassmorphicCard>
			</section>
		);
	}
	return (
		<section className="mb-6">
			<SectionHeading
				right={
					totalCount > items.length ? (
						<span className="text-xs text-muted-foreground">
							Showing {items.length} of {totalCount}
						</span>
					) : undefined
				}
			>
				Needs Attention
			</SectionHeading>
			<ul className="space-y-2">
				{items.map((item, idx) => (
					<AttentionRow key={item.hash} item={item} animationDelay={Math.min(idx, 12) * 30} />
				))}
			</ul>
		</section>
	);
};

interface AttentionRowProps {
	item: AttentionSectionProps["items"][number];
	animationDelay: number;
}

const SEVERITY_TONE: Record<"critical" | "warning", string> = {
	critical: "border-red-500/40 bg-red-500/5 text-red-300",
	warning: "border-amber-500/40 bg-amber-500/5 text-amber-300",
};

const SEVERITY_ICON: Record<"critical" | "warning", typeof AlertCircle> = {
	critical: AlertCircle,
	warning: TriangleAlert,
};

const AttentionRow = ({ item, animationDelay }: AttentionRowProps) => {
	const [incognito] = useIncognitoMode();
	const Icon = SEVERITY_ICON[item.severity];
	const torrentDisplayName = incognito ? getLinuxIsoName(item.hash) : item.name;
	const qbitLabel = item.qbitInstanceName
		? incognito
			? getLinuxInstanceName(item.qbitInstanceName)
			: item.qbitInstanceName
		: null;

	const libraryTitle = item.libraryContext
		? incognito
			? getLinuxIsoName(item.libraryContext.title)
			: item.libraryContext.title
		: null;
	const arrInstanceLabel = item.libraryContext
		? incognito
			? getLinuxInstanceName(item.libraryContext.arrInstanceLabel)
			: item.libraryContext.arrInstanceLabel
		: null;

	return (
		<li>
			<GlassmorphicCard padding="sm" animationDelay={animationDelay}>
				<div className="flex items-start gap-3">
					<div
						className={cn(
							"flex-shrink-0 mt-0.5 rounded-full border p-1.5",
							SEVERITY_TONE[item.severity],
						)}
						aria-hidden
					>
						<Icon className="h-3.5 w-3.5" />
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex items-baseline justify-between gap-3 flex-wrap">
							<div className="min-w-0 flex-1">
								{libraryTitle ? (
									<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
										<span className="text-sm font-medium text-foreground">{libraryTitle}</span>
										{item.libraryContext?.year ? (
											<span className="text-xs text-muted-foreground">
												({item.libraryContext.year})
											</span>
										) : null}
										<span className="rounded-md border border-border/40 bg-card/40 px-1.5 py-0.5 text-xs uppercase text-muted-foreground">
											{item.libraryContext?.arrService}
										</span>
										{arrInstanceLabel ? (
											<span className="text-xs text-muted-foreground">{arrInstanceLabel}</span>
										) : null}
									</div>
								) : (
									<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
										<span className="text-sm font-medium text-foreground break-all">
											{torrentDisplayName}
										</span>
										<span className="rounded-md border border-border/40 bg-card/40 px-1.5 py-0.5 text-xs uppercase text-muted-foreground">
											Unmapped
										</span>
									</div>
								)}
							</div>
							<span className="text-xs font-medium text-muted-foreground">{item.reason}</span>
						</div>
						<div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
							<span>Ratio: {item.ratio.toFixed(2)}×</span>
							<span aria-hidden>·</span>
							<span>{formatBytes(item.size) ?? "—"}</span>
							{qbitLabel ? (
								<>
									<span aria-hidden>·</span>
									<span>{qbitLabel}</span>
								</>
							) : null}
							{libraryTitle ? (
								<>
									<span aria-hidden>·</span>
									<span className="font-mono break-all">
										{incognito ? getLinuxIsoName(item.hash) : shortenHash(item.hash)}
									</span>
								</>
							) : null}
						</div>
					</div>
				</div>
			</GlassmorphicCard>
		</li>
	);
};

function shortenHash(hash: string): string {
	if (hash.length <= 16) return hash;
	return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

// ── Quick actions strip ────────────────────────────────────────────────

const QuickActions = () => (
	<section className="mb-6">
		<SectionHeading>Jump to</SectionHeading>
		<div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
			<QuickActionCard
				href="/library?torrentState=seeding"
				icon={Upload}
				title="Library — seeding"
				description="Filter your library to items qui has actively seeding."
			/>
			<QuickActionCard
				href="/cross-seed"
				icon={Network}
				title="Cross-Seed Discovery"
				description="Find sibling torrents qui can scan for across your tracked items."
			/>
			<QuickActionCard
				href="/qui-activity"
				icon={History}
				title="Activity feed"
				description="Scheduler ticks, mutations, and inbound webhook events."
			/>
			<QuickActionCard
				href="/pulse"
				icon={AlertCircle}
				title="Pulse — health"
				description="Cross-service health rollup including qui instance reachability."
			/>
		</div>
	</section>
);

interface QuickActionCardProps {
	href: string;
	icon: typeof Network;
	title: string;
	description: string;
}

const QuickActionCard = ({ href, icon: Icon, title, description }: QuickActionCardProps) => (
	<Link
		href={href}
		className="group rounded-xl border border-border/40 bg-card/30 p-4 backdrop-blur-sm transition-colors hover:border-border hover:bg-card/50"
	>
		<div className="flex items-center justify-between">
			<Icon className="h-5 w-5 text-muted-foreground/70" aria-hidden />
			<ArrowRight
				className="h-4 w-4 text-muted-foreground/70 transition-transform group-hover:translate-x-0.5"
				aria-hidden
			/>
		</div>
		<h3 className="mt-2 text-sm font-semibold text-foreground">{title}</h3>
		<p className="mt-1 text-xs text-muted-foreground">{description}</p>
	</Link>
);

// ── Small helpers ──────────────────────────────────────────────────────

interface SectionHeadingProps {
	children: React.ReactNode;
	right?: React.ReactNode;
}

const SectionHeading = ({ children, right }: SectionHeadingProps) => (
	<div className="mb-3 flex items-baseline justify-between gap-3">
		<h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
			{children}
		</h2>
		{right}
	</div>
);

function pct(n: number, total: number): string {
	if (total === 0) return "0%";
	return `${((n / total) * 100).toFixed(0)}%`;
}

function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (diffSec < 60) return `${diffSec}s ago`;
	if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
	if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
	return `${Math.round(diffSec / 86400)}d ago`;
}

// Suppress unused-import warnings — kept around for icon consistency
// across the home page.
void ExternalLink;
