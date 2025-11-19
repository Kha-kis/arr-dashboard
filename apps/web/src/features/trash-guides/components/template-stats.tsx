"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchTemplateStats } from "../../../lib/api-client/templates";
import type { TemplateStatsResponse } from "../../../lib/api-client/templates";
import { ChevronDown, ChevronUp, Calendar, Package, Users, Activity, RefreshCw, Rocket, Layers, History } from "lucide-react";
import { BulkDeploymentModal } from "./bulk-deployment-modal";
import { DeploymentHistoryTable } from "./deployment-history-table";

interface TemplateStatsProps {
	templateId: string;
	templateName: string;
	onSync?: (instanceId: string, instanceName: string) => void;
	onDeploy?: (instanceId: string, instanceName: string) => void;
}

export const TemplateStats = ({ templateId, templateName, onSync, onDeploy }: TemplateStatsProps) => {
	const [expanded, setExpanded] = useState(false);
	const [showBulkDeployment, setShowBulkDeployment] = useState(false);
	const [showHistory, setShowHistory] = useState(false);

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
					{/* Action Buttons */}
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => setShowHistory(true)}
							className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-white transition hover:bg-white/10"
						>
							<History className="h-4 w-4" />
							View Deployment History
						</button>
					</div>

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
							<div className="flex items-center justify-between">
								<h4 className="text-sm font-medium text-white/70">Instances Using This Template</h4>
								{stats.instances.length > 1 && (
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											setShowBulkDeployment(true);
										}}
										className="flex items-center gap-1 rounded bg-primary/20 px-2 py-1 text-xs font-medium text-primary transition hover:bg-primary/30"
										title="Deploy to multiple instances at once"
									>
										<Layers className="h-3 w-3" />
										Bulk Deploy
									</button>
								)}
							</div>
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
											{onDeploy && (
												<button
													type="button"
													onClick={(e) => {
														e.stopPropagation();
														onDeploy(instance.instanceId, instance.instanceName);
													}}
													className="flex items-center gap-1 rounded bg-green-500/20 px-2 py-1 text-xs font-medium text-green-400 transition hover:bg-green-500/30"
													title="Preview deployment to this instance"
												>
													<Rocket className="h-3 w-3" />
													Deploy
												</button>
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

			{/* Bulk Deployment Modal */}
			{showBulkDeployment && stats && (
				<BulkDeploymentModal
					open={showBulkDeployment}
					onClose={() => setShowBulkDeployment(false)}
					templateId={templateId}
					templateName={templateName}
					instances={stats.instances.map((inst) => ({
						instanceId: inst.instanceId,
						instanceLabel: inst.instanceName,
						instanceType: inst.instanceType,
					}))}
					onDeploySuccess={() => {
						setShowBulkDeployment(false);
					}}
				/>
			)}

			{/* Deployment History Modal */}
			{showHistory && (
				<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
					<div className="bg-background rounded-lg shadow-lg max-w-6xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col">
						{/* Header */}
						<div className="flex items-center justify-between p-6 border-b">
							<div>
								<h2 className="text-xl font-semibold">Deployment History</h2>
								<p className="text-sm text-muted-foreground mt-1">
									{templateName}
								</p>
							</div>
							<button
								onClick={() => setShowHistory(false)}
								className="p-1 rounded-md hover:bg-muted transition-colors"
							>
								<ChevronUp className="h-5 w-5" />
							</button>
						</div>

						{/* Content */}
						<div className="flex-1 overflow-y-auto p-6">
							<DeploymentHistoryTable templateId={templateId} limit={10} />
						</div>

						{/* Footer */}
						<div className="flex items-center justify-end gap-3 p-6 border-t">
							<button
								onClick={() => setShowHistory(false)}
								className="px-4 py-2 text-sm rounded-md border hover:bg-muted transition-colors"
							>
								Close
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
};
