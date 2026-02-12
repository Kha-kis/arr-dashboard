"use client";

import type { SearchResult } from "@arr/shared";
import { Copy, ExternalLink, Search } from "lucide-react";
import { Button } from "../../../components/ui/button";
import {
	PremiumTable,
	PremiumTableHeader,
	PremiumTableRow,
	PremiumEmptyState,
	PremiumSkeleton,
	StatusBadge,
} from "../../../components/layout";
import {
	useIncognitoMode,
	getLinuxIsoName,
	getLinuxIndexer,
	getLinuxInstanceName,
} from "../../../lib/incognito";
import { formatBytes } from "../../../lib/format-utils";

const integer = new Intl.NumberFormat();

const _formatDate = (value?: string): string => {
	if (!value) {
		return "-";
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return "-";
	}
	return parsed.toLocaleString();
};

const getAgeHours = (result: SearchResult): number | null => {
	if (typeof result.ageHours === "number" && Number.isFinite(result.ageHours)) {
		return result.ageHours;
	}
	if (typeof result.age === "number" && Number.isFinite(result.age)) {
		return result.age;
	}
	if (typeof result.ageDays === "number" && Number.isFinite(result.ageDays)) {
		return result.ageDays * 24;
	}
	if (result.publishDate) {
		const parsed = Date.parse(result.publishDate);
		if (!Number.isNaN(parsed)) {
			const diff = Date.now() - parsed;
			if (diff > 0) {
				return diff / (1000 * 60 * 60);
			}
		}
	}
	return null;
};

const formatAgeLabel = (result: SearchResult): string => {
	const age = getAgeHours(result);
	if (age === null) {
		return "-";
	}
	if (age < 1) {
		return "<1h";
	}
	if (age < 24) {
		return `${Math.round(age)}h`;
	}
	const days = age / 24;
	if (days < 7) {
		return `${Math.round(days)}d`;
	}
	const weeks = days / 7;
	if (weeks < 5) {
		return `${Math.round(weeks)}w`;
	}
	const months = days / 30;
	return `${Math.round(months)}mo`;
};

const getQualityLabel = (quality: SearchResult["quality"]): string | null => {
	if (!quality || typeof quality !== "object") {
		return null;
	}
	const maybeNested = (quality as any).quality;
	if (maybeNested && typeof maybeNested === "object") {
		const name = typeof maybeNested.name === "string" ? maybeNested.name : undefined;
		const resolution =
			typeof maybeNested.resolution === "number" ? maybeNested.resolution : undefined;
		if (name || resolution) {
			if (name && resolution && !name.includes(`${resolution}p`)) {
				return `${name} ${resolution}p`;
			}
			if (name) {
				return name;
			}
			return `${resolution}p`;
		}
	}
	const name = (quality as any).name;
	return typeof name === "string" ? name : null;
};

const metricBadgeClass =
	"inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground";

interface SearchResultsTableProps {
	results: SearchResult[];
	loading?: boolean;
	emptyMessage?: string;
	onGrab?: (result: SearchResult) => Promise<void> | void;
	grabbingKey?: string | null;
	onCopyMagnet?: (result: SearchResult) => Promise<void> | void;
	onOpenInfo?: (result: SearchResult) => void;
}

const buildRowKey = (result: SearchResult) =>
	`${result.instanceId}:${result.indexerId}:${result.id}`;

export const SearchResultsTable = ({
	results,
	loading,
	emptyMessage,
	onGrab,
	grabbingKey,
	onCopyMagnet,
	onOpenInfo,
}: SearchResultsTableProps) => {
	const [incognitoMode] = useIncognitoMode();

	if (loading) {
		return <PremiumSkeleton variant="card" className="h-48" />;
	}

	if (results.length === 0) {
		return (
			<PremiumEmptyState
				icon={Search}
				title="No Results"
				description={emptyMessage ?? "No results yet. Submit a query to begin."}
			/>
		);
	}

	return (
		<PremiumTable>
			<table className="w-full divide-y divide-border text-sm text-muted-foreground">
				<PremiumTableHeader>
					<tr>
						<th className="px-4 py-3 text-left text-xs uppercase tracking-wide text-muted-foreground">Release</th>
						<th className="px-4 py-3 text-right text-xs uppercase tracking-wide text-muted-foreground">Actions</th>
					</tr>
				</PremiumTableHeader>
				<tbody className="divide-y divide-border">
					{results.map((result) => {
						const key = buildRowKey(result);
						const copyable = Boolean(result.magnetUrl ?? result.downloadUrl ?? result.link);
						const hasInfo = Boolean(
							result.infoUrl ?? result.link ?? result.downloadUrl ?? result.magnetUrl,
						);
						const qualityLabel = getQualityLabel(result.quality);
						const ageLabel = formatAgeLabel(result);
						const sizeLabel = formatBytes(result.size);
						const rejectionMessage =
							result.rejected && result.rejectionReasons?.length
								? result.rejectionReasons.join(", ")
								: null;

						return (
							<PremiumTableRow key={key} className="align-top">
								<td className="px-4 py-4 text-foreground">
									<div className="space-y-3 wrap-break-word">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-semibold leading-tight wrap-break-word">
												{incognitoMode ? getLinuxIsoName(result.title) : result.title}
											</span>
											<StatusBadge status={result.protocol === "torrent" ? "success" : "info"}>
												{result.protocol.toUpperCase()}
											</StatusBadge>
											{qualityLabel ? (
												<span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
													{qualityLabel}
												</span>
											) : null}
											{result.rejected ? (
												<StatusBadge status="error">Rejected</StatusBadge>
											) : null}
										</div>

										<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
											<span className="font-medium text-muted-foreground">
												{incognitoMode ? getLinuxIndexer(result.indexer) : result.indexer}
											</span>
											<span className="text-muted-foreground">#{result.indexerId}</span>
											<span className="text-muted-foreground">
												{incognitoMode ? getLinuxInstanceName(result.instanceName) : result.instanceName}
											</span>
										</div>

										<div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
											<span className={metricBadgeClass}>Size {sizeLabel}</span>
											<span className={metricBadgeClass}>
												Seeders {integer.format(result.seeders ?? 0)}
											</span>
											<span className={metricBadgeClass}>
												Leechers {integer.format(result.leechers ?? 0)}
											</span>
											<span className={metricBadgeClass}>Age {ageLabel}</span>
											{typeof result.downloadVolumeFactor === "number" ||
											typeof result.uploadVolumeFactor === "number" ? (
												<span className={metricBadgeClass}>
													Ratio DL {result.downloadVolumeFactor ?? 1}x / UL{" "}
													{result.uploadVolumeFactor ?? 1}x
												</span>
											) : null}
										</div>

										{result.categories?.length ? (
											<div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
												<span className="uppercase text-muted-foreground">Categories</span>
												<span>{result.categories.join(", ")}</span>
											</div>
										) : null}

										{result.languages?.length ? (
											<div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
												<span className="uppercase text-muted-foreground">Languages</span>
												<span>{result.languages.map((language) => language.name).join(", ")}</span>
											</div>
										) : null}

										{rejectionMessage ? (
											<div className="rounded-lg border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-100 whitespace-pre-wrap wrap-break-word">
												{rejectionMessage}
											</div>
										) : null}
									</div>
								</td>
								<td className="px-4 py-4 text-right text-muted-foreground">
									<div className="flex flex-col items-end gap-2 sm:flex-row sm:justify-end sm:gap-3">
										<Button
											variant="secondary"
											disabled={!onGrab || grabbingKey === key}
											onClick={() => onGrab?.(result)}
											className="px-3"
										>
											{grabbingKey === key ? "Sending..." : "Grab"}
										</Button>
										<Button
											variant="ghost"
											disabled={!onCopyMagnet || !copyable}
											onClick={() => onCopyMagnet?.(result)}
											className="px-3"
										>
											<Copy className="mr-2 h-4 w-4" /> Copy
										</Button>
										<Button
											variant="ghost"
											disabled={!onOpenInfo || !hasInfo}
											onClick={() => onOpenInfo?.(result)}
											className="px-3"
										>
											<ExternalLink className="mr-2 h-4 w-4" /> Details
										</Button>
									</div>
								</td>
							</PremiumTableRow>
						);
					})}
				</tbody>
			</table>
		</PremiumTable>
	);
};
