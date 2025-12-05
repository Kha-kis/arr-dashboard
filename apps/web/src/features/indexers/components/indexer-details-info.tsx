"use client";

import type { ProwlarrIndexer, ProwlarrIndexerDetails } from "@arr/shared";
import { DetailStat } from "./detail-stat";
import {
	formatDateTime,
	formatResponseTime,
	formatSuccessRate,
	protocolLabel,
} from "../lib/indexers-utils";

/**
 * Displays detailed information about an indexer including implementation,
 * protocol, priority, stats, capabilities, categories, and configuration
 * @param detail - Indexer details object
 * @param indexer - Base indexer object
 * @returns React component displaying indexer details
 */
export const IndexerDetailsInfo = ({
	detail,
	indexer,
}: {
	detail: ProwlarrIndexerDetails;
	indexer: ProwlarrIndexer;
}) => {
	const stats = detail.stats;
	const capabilities = detail.capabilities ?? indexer.capabilities ?? [];
	const categories = detail.categories ?? [];

	return (
		<>
			<div className="grid flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
				<DetailStat label="Implementation" value={detail.implementationName ?? "Unknown"} />
				<DetailStat label="Protocol" value={protocolLabel(detail.protocol ?? indexer.protocol)} />
				<DetailStat
					label="Priority"
					value={
						typeof detail.priority === "number"
							? detail.priority.toString()
							: detail.priority === 0
								? "0"
								: undefined
					}
				/>
				<DetailStat
					label="App profile"
					value={
						typeof detail.appProfileId === "number" ? detail.appProfileId.toString() : "Default"
					}
				/>
				<DetailStat label="Privacy" value={detail.privacy ?? undefined} />
				<DetailStat label="Language" value={detail.language ?? undefined} />
			</div>

			{stats ? (
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
					<DetailStat label="Success rate" value={formatSuccessRate(stats.successRate)} />
					<DetailStat
						label="Average response"
						value={formatResponseTime(stats.averageResponseTime)}
					/>
					<DetailStat label="Last check" value={formatDateTime(stats.lastCheck)} />
					<DetailStat label="Last failure" value={formatDateTime(stats.lastFailure)} />
				</div>
			) : null}

			{capabilities.length > 0 ? (
				<div className="space-y-2">
					<p className="text-xs uppercase tracking-widest text-fg-muted">Capabilities</p>
					<div className="flex flex-wrap gap-2">
						{capabilities.map((capability, index) => (
							<span
								key={`${index}-${capability}`}
								className="rounded-full border border-border px-3 py-1 text-xs text-fg-muted"
							>
								{capability}
							</span>
						))}
					</div>
				</div>
			) : null}

			{categories.length > 0 ? (
				<div className="space-y-2">
					<p className="text-xs uppercase tracking-widest text-fg-muted">Categories</p>
					<div className="flex flex-wrap gap-2">
						{categories.map((category, index) => (
							<span
								key={`${index}-${category}`}
								className="rounded-full border border-border px-3 py-1 text-xs text-fg-muted"
							>
								{category}
							</span>
						))}
					</div>
				</div>
			) : null}
		</>
	);
};
