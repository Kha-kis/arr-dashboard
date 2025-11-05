"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchTemplateStats } from "../../../lib/api-client/templates";
import type { TemplateStatsResponse } from "../../../lib/api-client/templates";
import { ChevronDown, ChevronUp, Calendar, Package, Users, Activity, RefreshCw } from "lucide-react";

interface TemplateStatsProps {
	templateId: string;
	onSync?: (instanceId: string, instanceName: string) => void;
}

export const TemplateStats = ({ templateId, onSync }: TemplateStatsProps) => {
	const [expanded, setExpanded] = useState(false);

	const { data, isLoading } = useQuery<TemplateStatsResponse>({
		queryKey: ["template-stats", templateId],
		queryFn: () => fetchTemplateStats(templateId),
		enabled: expanded,
	});

	if (isLoading && expanded) {
		return (
			<div className="rounded-lg border border-white/10 bg-white/5 p-4">
				<div className="flex items-center gap-2 text-sm text-white/60">
					<Activity className="h-4 w-4 animate-spin" />
					<span>Loading stats...</span>
				</div>
			</div>
		);
	}

	const stats = data?.stats;

	return (
		<div className="space-y-2">
			{/* Stats Summary */}
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex w-full items-center justify-between rounded-lg border border-white/10 bg-white/5 p-3 text-left transition hover:bg-white/10"
			>
				<div className="flex items-center gap-3">
					<Activity className="h-4 w-4 text-primary" />
					<span className="text-sm font-medium text-white">Template Stats</span>
					{stats && (
						<>
							{stats.isActive ? (
								<span className="rounded-full bg-green-500/20 px-2 py-0.5 text-xs font-medium text-green-400">
									Active
								</span>
							) : (
								<span className="rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium text-white/60">
									Inactive
								</span>
							)}
							{stats.activeInstanceCount > 0 && (
								<span className="text-xs text-white/60">
									{stats.activeInstanceCount} instance{stats.activeInstanceCount !== 1 ? "s" : ""}
								</span>
							)}
						</>
					)}
				</div>
				{expanded ? (
					<ChevronUp className="h-4 w-4 text-white/40" />
				) : (
					<ChevronDown className="h-4 w-4 text-white/40" />
				)}
			</button>

			{/* Expanded Stats Details */}
			{expanded && stats && (
				<div className="rounded-lg border border-white/10 bg-white/5 p-4 space-y-4">
					{/* Metrics Grid */}
					<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
						<div className="space-y-1">
							<div className="flex items-center gap-2 text-xs text-white/60">
								<Package className="h-3 w-3" />
								<span>Formats</span>
							</div>
							<p className="text-lg font-semibold text-white">{stats.formatCount}</p>
						</div>

						<div className="space-y-1">
							<div className="flex items-center gap-2 text-xs text-white/60">
								<Package className="h-3 w-3" />
								<span>Groups</span>
							</div>
							<p className="text-lg font-semibold text-white">{stats.groupCount}</p>
						</div>

						<div className="space-y-1">
							<div className="flex items-center gap-2 text-xs text-white/60">
								<Users className="h-3 w-3" />
								<span>Usage Count</span>
							</div>
							<p className="text-lg font-semibold text-white">{stats.usageCount}</p>
						</div>

						<div className="space-y-1">
							<div className="flex items-center gap-2 text-xs text-white/60">
								<Calendar className="h-3 w-3" />
								<span>Last Used</span>
							</div>
							<p className="text-xs font-medium text-white">
								{stats.lastUsedAt ? new Date(stats.lastUsedAt).toLocaleDateString() : "Never"}
							</p>
						</div>
					</div>

					{/* Instances List */}
					{stats.instances.length > 0 && (
						<div className="space-y-2">
							<h4 className="text-sm font-medium text-white/70">Instances Using This Template</h4>
							<div className="space-y-2">
								{stats.instances.map((instance) => (
									<div
										key={instance.instanceId}
										className="flex items-center justify-between rounded border border-white/10 bg-white/5 p-3"
									>
										<div className="flex items-center gap-3">
											<div className="flex items-center gap-2">
												<span className="text-sm font-medium text-white">{instance.instanceName}</span>
												<span className="rounded bg-white/10 px-2 py-0.5 text-xs text-white/60">
													{instance.instanceType}
												</span>
											</div>
											{instance.hasActiveSchedule && (
												<span className="rounded-full bg-green-500/20 px-2 py-0.5 text-xs font-medium text-green-400">
													Scheduled
												</span>
											)}
										</div>
										<div className="flex items-center gap-2">
											{instance.lastAppliedAt && (
												<div className="flex items-center gap-1 text-xs text-white/60">
													<Calendar className="h-3 w-3" />
													<span>{new Date(instance.lastAppliedAt).toLocaleDateString()}</span>
												</div>
											)}
											{onSync && (
												<button
													type="button"
													onClick={(e) => {
														e.stopPropagation();
														onSync(instance.instanceId, instance.instanceName);
													}}
													className="flex items-center gap-1 rounded bg-primary/20 px-2 py-1 text-xs font-medium text-primary transition hover:bg-primary/30"
													title="Sync template to this instance"
												>
													<RefreshCw className="h-3 w-3" />
													Sync
												</button>
											)}
										</div>
									</div>
								))}
							</div>
						</div>
					)}

					{stats.instances.length === 0 && (
						<div className="rounded border border-white/10 bg-white/5 p-4 text-center">
							<p className="text-sm text-white/60">No instances have used this template yet.</p>
						</div>
					)}
				</div>
			)}
		</div>
	);
};
