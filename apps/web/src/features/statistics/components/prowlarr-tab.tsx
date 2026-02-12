"use client";

import type { ProwlarrIndexerStat } from "@arr/shared";
import { Globe, CheckCircle2, AlertTriangle, Activity, TrendingUp } from "lucide-react";
import { PremiumCard, StatCard } from "../../../components/layout";
import { formatPercent } from "../lib/formatters";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { useIncognitoMode, getLinuxInstanceName, getLinuxIndexer } from "../../../lib/incognito";
import type { useStatisticsData } from "../hooks/useStatisticsData";

const integer = new Intl.NumberFormat();
const percentFormatter = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 1,
});

type StatisticsData = ReturnType<typeof useStatisticsData>;

interface ProwlarrTabProps {
	prowlarrTotals: StatisticsData["prowlarrTotals"];
	prowlarrRows: StatisticsData["prowlarrRows"];
}

export const ProwlarrTab = ({ prowlarrTotals, prowlarrRows }: ProwlarrTabProps) => {
	const [incognitoMode] = useIncognitoMode();

	return (
		<div className="flex flex-col gap-6">
			{/* Stats Grid */}
			<div
				className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
			>
				<StatCard value={prowlarrTotals.totalIndexers} label="Indexers" icon={Globe} gradient={SERVICE_GRADIENTS.prowlarr} animationDelay={200} />
				<StatCard value={prowlarrTotals.activeIndexers} label="Active" icon={CheckCircle2} gradient={SERVICE_GRADIENTS.prowlarr} animationDelay={250} />
				<StatCard value={prowlarrTotals.pausedIndexers} label="Paused" icon={AlertTriangle} gradient={SERVICE_GRADIENTS.prowlarr} animationDelay={300} />
				<StatCard
					value={prowlarrTotals.averageResponseTime ? `${percentFormatter.format(prowlarrTotals.averageResponseTime)} ms` : "-"}
					label="Avg Response"
					icon={Activity}
					gradient={SERVICE_GRADIENTS.prowlarr}
					animationDelay={350}
				/>
			</div>

			<div
				className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "300ms", animationFillMode: "backwards" }}
			>
				<StatCard value={prowlarrTotals.totalQueries} label="Queries" description="Total searches" animationDelay={400} />
				<StatCard value={prowlarrTotals.successfulQueries ?? "-"} label="Successful" description="Queries" animationDelay={450} />
				<StatCard value={prowlarrTotals.totalGrabs} label="Total Grabs" animationDelay={500} />
				<StatCard value={formatPercent(prowlarrTotals.grabRate)} label="Grab Rate" animationDelay={550} />
			</div>

			{/* Top Indexers */}
			{prowlarrTotals.indexers.length > 0 && (
				<PremiumCard
					title="Top Indexers"
					description="Performance breakdown by indexer"
					icon={TrendingUp}
					gradientIcon={false}
					animationDelay={400}
				>
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-border/50">
									<th className="text-left py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</th>
									<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Queries</th>
									<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Grabs</th>
									<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Success Rate</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-border/30">
								{prowlarrTotals.indexers.map((indexer: ProwlarrIndexerStat, index: number) => (
									<tr key={`${index}-${indexer.name}`} className="hover:bg-muted/20 transition-colors">
										<td className="py-3 px-4 font-medium">
											{incognitoMode ? getLinuxIndexer(indexer.name) : indexer.name}
										</td>
										<td className="py-3 px-4 text-right text-muted-foreground">{integer.format(indexer.queries)}</td>
										<td className="py-3 px-4 text-right text-muted-foreground">{integer.format(indexer.grabs)}</td>
										<td className="py-3 px-4 text-right">
											<span style={{ color: SERVICE_GRADIENTS.prowlarr.from }}>
												{formatPercent(indexer.successRate)}
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</PremiumCard>
			)}

			{/* Instance Table */}
			<PremiumCard
				title="Instance Details"
				description="Per-instance breakdown of your Prowlarr servers"
				icon={Globe}
				gradientIcon={false}
				animationDelay={500}
			>
				{prowlarrRows.length === 0 ? (
					<p className="text-muted-foreground text-center py-8">No Prowlarr instances configured.</p>
				) : (
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-border/50">
									<th className="text-left py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Instance</th>
									<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Indexers</th>
									<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Active</th>
									<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Paused</th>
									<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Queries</th>
									<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Grabs</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-border/30">
								{prowlarrRows.map((row) => (
									<tr key={row.instanceId} className="hover:bg-muted/20 transition-colors">
										<td className="py-3 px-4 font-medium">
											{incognitoMode ? getLinuxInstanceName(row.instanceName) : row.instanceName}
										</td>
										<td className="py-3 px-4 text-right">{integer.format(row.totalIndexers)}</td>
										<td className="py-3 px-4 text-right">{integer.format(row.activeIndexers)}</td>
										<td className="py-3 px-4 text-right">{integer.format(row.pausedIndexers)}</td>
										<td className="py-3 px-4 text-right">{integer.format(row.totalQueries)}</td>
										<td className="py-3 px-4 text-right">{integer.format(row.totalGrabs)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</PremiumCard>
		</div>
	);
};
