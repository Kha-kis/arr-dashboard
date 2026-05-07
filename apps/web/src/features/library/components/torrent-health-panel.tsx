"use client";

import type { LibraryItemType, QuiCrossSeedMatch } from "@arr/shared";
import { Activity, AlertCircle, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { GlassmorphicCard } from "../../../components/layout/premium-containers";
import { useTorrentState } from "../../../hooks/api/useQui";
import { getLinuxIsoName, useIncognitoMode } from "../../../lib/incognito";
import { describeQuiState } from "../lib/qui-display";

interface Props {
	arrInstanceId: string;
	arrItemId: number;
	itemType: LibraryItemType;
}

const formatBytes = (bytes: number): string => {
	if (!bytes || bytes <= 0) return "0";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
};

const formatSpeed = (bytesPerSec: number): string =>
	bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : "—";

const formatDuration = (seconds: number): string => {
	if (!seconds || seconds <= 0) return "—";
	const days = Math.floor(seconds / 86400);
	const hours = Math.floor((seconds % 86400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
};

const Metric = ({ label, value }: { label: string; value: React.ReactNode }) => (
	<div className="space-y-1">
		<p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
		<p className="text-sm font-medium text-foreground">{value}</p>
	</div>
);

const EmptyPanel = ({ heading, message }: { heading: string; message: string }) => (
	<GlassmorphicCard padding="md" className="space-y-2">
		<div className="flex items-center gap-2">
			<AlertCircle className="h-4 w-4 text-muted-foreground" />
			<p className="text-sm font-medium text-foreground">{heading}</p>
		</div>
		<p className="text-xs text-muted-foreground">{message}</p>
	</GlassmorphicCard>
);

const Sibling = ({ match }: { match: QuiCrossSeedMatch }) => {
	const [incognitoMode] = useIncognitoMode();
	const trackerHost = (() => {
		try {
			return new URL(match.tracker).hostname;
		} catch {
			return match.tracker;
		}
	})();
	const displayTracker = incognitoMode ? "tracker" : trackerHost;
	const displayInstance = incognitoMode ? "qbit" : match.instanceName;
	const matchTypeLabel =
		match.matchType === "release"
			? "release-name match"
			: match.matchType === "content_path"
				? "same files"
				: "name match";
	return (
		<li className="flex items-center justify-between gap-3 py-1.5 text-xs">
			<div className="flex min-w-0 items-center gap-2 truncate">
				<span className="truncate text-foreground">{displayTracker}</span>
				<span className="text-muted-foreground">·</span>
				<span className="text-muted-foreground">{match.state}</span>
				<span className="text-muted-foreground">·</span>
				<span className="text-muted-foreground">{matchTypeLabel}</span>
				{match.trackerHealth === "unregistered" && (
					<span className="ml-1 rounded border border-rose-500/30 bg-rose-500/10 px-1 py-0.5 text-[10px] uppercase tracking-wider text-rose-300">
						unregistered
					</span>
				)}
			</div>
			<span className="shrink-0 text-muted-foreground">{displayInstance}</span>
		</li>
	);
};

const PanelHeader = ({ children }: { children: React.ReactNode }) => (
	<div className="mb-3 flex items-center gap-2">
		<Activity className="h-4 w-4 text-muted-foreground" />
		<h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
			{children}
		</h3>
	</div>
);

export const TorrentHealthPanel = ({ arrInstanceId, arrItemId, itemType }: Props) => {
	const [siblingsExpanded, setSiblingsExpanded] = useState(false);
	const [incognitoMode] = useIncognitoMode();
	const query = useTorrentState({ arrInstanceId, arrItemId, itemType });

	if (query.isLoading) {
		return (
			<GlassmorphicCard padding="md">
				<PanelHeader>Torrent Health</PanelHeader>
				<div className="h-16 animate-pulse rounded-md bg-muted/30" />
			</GlassmorphicCard>
		);
	}

	if (query.isError) {
		return (
			<EmptyPanel
				heading="Torrent health unavailable"
				message="qui is unreachable or returned an error. Check the qui instance configuration."
			/>
		);
	}

	const data = query.data;
	if (!data || data.supported === false) {
		// Unsupported item type (e.g. series in v1) — render nothing.
		return null;
	}

	if (!data.infoHash || !data.torrent) {
		const heading = !data.infoHash ? "No torrent record" : "Torrent not tracked by qui";
		const message = data.reason ?? "No additional information.";
		return <EmptyPanel heading={heading} message={message} />;
	}

	const torrent = data.torrent;
	const siblings = data.siblings ?? [];
	const { label: stateLbl, tone: stateTone } = describeQuiState(torrent.state);
	const displayName = incognitoMode ? getLinuxIsoName(torrent.hash) : torrent.name;
	const displayInstance = incognitoMode ? "qbit" : (torrent.instanceName ?? data.quiInstanceLabel);

	return (
		<GlassmorphicCard padding="md">
			<PanelHeader>Torrent Health</PanelHeader>
			<div className="space-y-4">
				<div className="flex flex-wrap items-center gap-2">
					<span
						className={`rounded-md border px-2 py-0.5 text-xs font-medium ${stateTone}`}
						aria-label={`Torrent state: ${stateLbl}`}
					>
						{stateLbl}
					</span>
					{displayInstance && (
						<span className="text-xs text-muted-foreground">{displayInstance}</span>
					)}
					<span className="ml-auto truncate text-xs text-muted-foreground" title={displayName}>
						{displayName}
					</span>
				</div>

				<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
					<Metric label="Ratio" value={torrent.ratio.toFixed(2)} />
					<Metric label="Seed time" value={formatDuration(torrent.seedingTime)} />
					<Metric label="Size" value={formatBytes(torrent.size)} />
					<Metric
						label="Peers"
						value={
							<span>
								{torrent.numLeechs}{" "}
								<span className="text-xs text-muted-foreground">({torrent.numSeeds} seeds)</span>
							</span>
						}
					/>
				</div>

				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
					<span>↑ {formatSpeed(torrent.upSpeed)}</span>
					<span>↓ {formatSpeed(torrent.dlSpeed)}</span>
					{torrent.category && <span>· {torrent.category}</span>}
					{torrent.tags.length > 0 && <span>· {torrent.tags.join(", ")}</span>}
				</div>

				{siblings.length > 0 && (
					<div className="border-t border-border/40 pt-3">
						<button
							type="button"
							className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
							onClick={() => setSiblingsExpanded((v) => !v)}
							aria-expanded={siblingsExpanded}
						>
							{siblingsExpanded ? (
								<ChevronDown className="h-3 w-3" />
							) : (
								<ChevronRight className="h-3 w-3" />
							)}
							<span>Cross-seed siblings ({siblings.length})</span>
						</button>
						{siblingsExpanded && (
							<ul className="mt-2 divide-y divide-border/30">
								{siblings.map((s) => (
									<Sibling key={`${s.instanceId}-${s.hash}`} match={s} />
								))}
							</ul>
						)}
					</div>
				)}
			</div>
		</GlassmorphicCard>
	);
};
