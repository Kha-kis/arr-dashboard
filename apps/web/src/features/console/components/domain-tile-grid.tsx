"use client";

/**
 * Operator Console — per-domain tiles (charter §2.1 surface 1).
 *
 * One tile per operator domain: health (DomainStatusBadge taxonomy),
 * last activity (recorded fact), declared tick cadence (registry
 * constant), and a link to the domain's page. Derivation lives in
 * ../lib/console-domains.ts (pure, unit-tested); this file only renders.
 *
 * Trust rules enforced at render:
 * - Error state is honest (AsyncStateView) — never an all-healthy grid on
 *   a failed fetch.
 * - "Never ran" renders as such, not as a fake timestamp.
 * - statusDetail tooltips pass through anonymizeHealthMessage in incognito
 *   (disabledReason strings are plugin-authored free text).
 */

import { Loader2, ServerCog } from "lucide-react";
import Link from "next/link";
import { AsyncStateView, DomainStatusBadge, formatRelativeTime } from "../../../components/layout";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useSystemJobs } from "../../../hooks/api/useSystem";
import { anonymizeHealthMessage, useIncognitoMode } from "../../../lib/incognito";
import { buildDomainTiles, type DomainTileModel } from "../lib/console-domains";

function DomainTile({
	tile,
	index,
	incognito,
}: {
	tile: DomainTileModel;
	index: number;
	incognito: boolean;
}) {
	const { domain } = tile;
	const Icon = domain.icon;
	const lastActivity = formatRelativeTime(tile.lastActivityMs ?? undefined);
	const statusDetail = incognito ? anonymizeHealthMessage(tile.statusDetail) : tile.statusDetail;

	return (
		<li
			className="animate-in fade-in slide-in-from-bottom-2"
			style={{ animationDelay: `${index * 30}ms`, animationFillMode: "backwards" }}
		>
			<Link
				href={domain.href}
				className="flex h-full flex-col gap-3 rounded-xl border border-border/50 bg-card/30 p-4 backdrop-blur-sm transition-colors hover:bg-card/50"
			>
				<div className="flex items-center gap-2">
					<Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
						{domain.label}
					</span>
					{tile.isRunning && (
						<span
							className="flex items-center gap-1 text-xs text-muted-foreground"
							aria-label={`${domain.label} is running`}
						>
							<Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
						</span>
					)}
				</div>
				<DomainStatusBadge status={tile.status} title={statusDetail} />
				<div className="mt-auto space-y-0.5 text-xs text-muted-foreground">
					{/* "Last activity", not "Last run": the registry records scheduler
					    TICKS — a backup tick that decides "not due yet" still counts.
					    "Last run just now" would misread as "a backup just completed". */}
					<p>{lastActivity ? `Last activity ${lastActivity}` : "No activity yet"}</p>
					{tile.cadence && <p>Checks {tile.cadence}</p>}
				</div>
			</Link>
		</li>
	);
}

export function DomainTileGrid() {
	const jobsQuery = useSystemJobs();
	const servicesQuery = useServicesQuery();
	const [incognito] = useIncognitoMode();

	// Tiles are built from the JOBS feed alone; the services feed only
	// drives gating. If services fails, degrade to "no enabled services
	// known" — core domains still render, gated tiles are omitted (the
	// same outcome as genuinely having no such service) and the omission
	// is disclosed below rather than silently swallowed. Blocking ALL
	// tiles on a services failure would render a false "nothing
	// registered" empty state while the schedulers are demonstrably fine.
	const tiles = jobsQuery.data
		? buildDomainTiles(jobsQuery.data.jobs, servicesQuery.data ?? [])
		: [];

	return (
		<AsyncStateView
			isLoading={jobsQuery.isLoading || servicesQuery.isLoading}
			isError={jobsQuery.isError}
			error={jobsQuery.error}
			isEmpty={tiles.length === 0}
			onRetry={() => void jobsQuery.refetch()}
			errorTitle="Couldn't load domain status"
			loadingFallback={
				<ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
					{Array.from({ length: 6 }, (_, i) => (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton list
							key={i}
							className="h-28 animate-pulse rounded-xl border border-border/30 bg-muted/10"
						/>
					))}
				</ul>
			}
			emptyState={{
				icon: ServerCog,
				title: "No domain schedulers registered",
				description: "Background jobs report here once the API process registers them.",
			}}
		>
			<ul
				className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
				aria-label="Domain status tiles"
				data-testid="domain-tile-grid"
			>
				{tiles.map((tile, index) => (
					<DomainTile key={tile.domain.id} tile={tile} index={index} incognito={incognito} />
				))}
			</ul>
			{servicesQuery.isError && (
				<p className="mt-3 text-xs text-muted-foreground" data-testid="services-gating-degraded">
					Couldn't load the service list — tiles for service-linked domains (qui, Requests, Media
					Caches) are hidden until it recovers.
				</p>
			)}
		</AsyncStateView>
	);
}
