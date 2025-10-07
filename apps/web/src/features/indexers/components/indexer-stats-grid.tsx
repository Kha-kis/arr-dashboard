"use client";

import { Card, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import type { IndexerStats } from "../lib/indexers-utils";
import { numberFormatter } from "../lib/indexers-utils";

/**
 * Grid of statistics cards showing indexer counts and capabilities
 * @param stats - Computed indexer statistics
 * @returns React component displaying stats grid
 */
export const IndexerStatsGrid = ({ stats }: { stats: IndexerStats }) => {
	return (
		<>
			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<Card className="border-white/10 bg-white/5">
					<CardHeader className="pb-2">
						<CardDescription>Total indexers</CardDescription>
						<CardTitle className="text-2xl text-white">
							{numberFormatter.format(stats.total)}
						</CardTitle>
					</CardHeader>
				</Card>
				<Card className="border-white/10 bg-white/5">
					<CardHeader className="pb-2">
						<CardDescription>Enabled</CardDescription>
						<CardTitle className="text-2xl text-white">
							{numberFormatter.format(stats.enabled)}
						</CardTitle>
					</CardHeader>
				</Card>
				<Card className="border-white/10 bg-white/5">
					<CardHeader className="pb-2">
						<CardDescription>Torrent</CardDescription>
						<CardTitle className="text-2xl text-white">
							{numberFormatter.format(stats.torrent)}
						</CardTitle>
					</CardHeader>
				</Card>
				<Card className="border-white/10 bg-white/5">
					<CardHeader className="pb-2">
						<CardDescription>Usenet</CardDescription>
						<CardTitle className="text-2xl text-white">
							{numberFormatter.format(stats.usenet)}
						</CardTitle>
					</CardHeader>
				</Card>
			</div>

			<div className="grid gap-4 sm:grid-cols-2">
				<Card className="border-white/10 bg-white/5">
					<CardHeader className="pb-2">
						<CardDescription>Search capable</CardDescription>
						<CardTitle className="text-2xl text-white">
							{numberFormatter.format(stats.search)}
						</CardTitle>
					</CardHeader>
				</Card>
				<Card className="border-white/10 bg-white/5">
					<CardHeader className="pb-2">
						<CardDescription>RSS capable</CardDescription>
						<CardTitle className="text-2xl text-white">
							{numberFormatter.format(stats.rss)}
						</CardTitle>
					</CardHeader>
				</Card>
			</div>
		</>
	);
};
