"use client";

import { useDeploymentHistoryDetail } from "../../../hooks/api/useDeploymentHistory";
import { format } from "date-fns";
import { History, AlertCircle } from "lucide-react";
import {
	Dialog,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogContent,
	DialogFooter,
} from "../../../components/ui/dialog";
import { Button, Skeleton } from "../../../components/ui";

interface DeploymentHistoryDetailsModalProps {
	historyId: string;
	onClose: () => void;
	onUndeploy?: (historyId: string) => void;
}

export function DeploymentHistoryDetailsModal({
	historyId,
	onClose,
	onUndeploy,
}: DeploymentHistoryDetailsModalProps) {
	const { data, isLoading, error } = useDeploymentHistoryDetail(historyId);

	return (
		<Dialog open={true} onOpenChange={onClose} size="lg">
			<DialogHeader>
				<DialogTitle>
					<div className="flex items-center gap-2">
						<History className="h-5 w-5" />
						Deployment Details
					</div>
				</DialogTitle>
				<DialogDescription>
					View details of this deployment
				</DialogDescription>
			</DialogHeader>

			<DialogContent className="space-y-6">
				{isLoading && (
					<div className="space-y-4">
						<Skeleton className="h-24 w-full" />
						<Skeleton className="h-32 w-full" />
						<Skeleton className="h-48 w-full" />
					</div>
				)}

				{error && (
					<div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
						<div className="flex items-start gap-3">
							<AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
							<div>
								<p className="text-sm font-medium text-fg">
									Failed to load deployment details
								</p>
								<p className="text-sm text-fg-muted mt-1">{error.message}</p>
							</div>
						</div>
					</div>
				)}

				{data?.data && (
					<>
						{/* Overview Section */}
						<div className="rounded-lg border border-border bg-bg-subtle p-4">
							<h3 className="text-sm font-medium text-fg mb-3">Overview</h3>
							<div className="grid grid-cols-2 gap-4">
								<InfoField
									label="Deployed At"
									value={format(
										new Date(data.data.deployedAt),
										"MMM d, yyyy 'at' h:mm a",
									)}
								/>
								<InfoField
									label="Duration"
									value={
										data.data.duration ? `${data.data.duration} seconds` : "N/A"
									}
								/>
								<InfoField label="Status" value={data.data.status} />
								<InfoField label="Deployed By" value={data.data.deployedBy} />
								{data.data.rolledBack && (
									<InfoField
										label="Rolled Back"
										value={
											data.data.rolledBackAt
												? format(
														new Date(data.data.rolledBackAt),
														"MMM d, yyyy 'at' h:mm a",
													)
												: "Yes"
										}
									/>
								)}
							</div>
						</div>

						{/* Instance & Template Section */}
						<div className="rounded-lg border border-border bg-bg-subtle p-4">
							<h3 className="text-sm font-medium text-fg mb-3">
								Instance & Template
							</h3>
							<div className="grid grid-cols-2 gap-4">
								{data.data.instance && (
									<>
										<InfoField
											label="Instance"
											value={data.data.instance.label}
										/>
										<InfoField
											label="Instance Service"
											value={data.data.instance.service}
										/>
									</>
								)}
								{data.data.template && (
									<>
										<InfoField label="Template" value={data.data.template.name} />
										<InfoField
											label="Template Type"
											value={data.data.template.serviceType}
										/>
										{data.data.template.description && (
											<div className="col-span-2">
												<InfoField
													label="Description"
													value={data.data.template.description}
												/>
											</div>
										)}
									</>
								)}
							</div>
						</div>

						{/* Results Section */}
						<div className="rounded-lg border border-border bg-bg-subtle p-4">
							<h3 className="text-sm font-medium text-fg mb-3">Results</h3>
							<div className="grid grid-cols-3 gap-4">
								<div className="space-y-1">
									<p className="text-xs text-green-700 dark:text-green-300">Applied</p>
									<p className="text-2xl font-semibold text-green-600 dark:text-green-400">
										{data.data.appliedCFs}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs text-red-700 dark:text-red-300">Failed</p>
									<p className="text-2xl font-semibold text-red-600 dark:text-red-400">
										{data.data.failedCFs}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs text-blue-700 dark:text-blue-300">Total</p>
									<p className="text-2xl font-semibold text-blue-600 dark:text-blue-400">
										{data.data.totalCFs}
									</p>
								</div>
							</div>
						</div>

						{/* Applied Configs Section */}
						{data.data.appliedConfigs && data.data.appliedConfigs.length > 0 && (
							<div className="space-y-3">
								<h3 className="text-sm font-medium text-fg">
									Applied Custom Formats ({data.data.appliedConfigs.length})
								</h3>
								<div className="rounded-lg border border-border bg-bg-subtle divide-y divide-border max-h-48 overflow-y-auto">
									{data.data.appliedConfigs.map((config, index) => (
										<div key={index} className="px-3 py-2 text-sm flex items-center justify-between text-fg">
											<span>{config.name}</span>
											<span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/10 text-green-700 dark:text-green-300 capitalize">
												{config.action}
											</span>
										</div>
									))}
								</div>
							</div>
						)}

						{/* Failed Configs Section */}
						{data.data.failedConfigs && data.data.failedConfigs.length > 0 && (
							<div className="space-y-3">
								<h3 className="text-sm font-medium text-red-600 dark:text-red-400">
									Failed Custom Formats ({data.data.failedConfigs.length})
								</h3>
								<div className="rounded-lg border border-red-500/30 bg-red-500/10 divide-y divide-red-500/20 max-h-48 overflow-y-auto">
									{data.data.failedConfigs.map((config, index) => (
										<div key={index} className="px-3 py-2 text-sm">
											<div className="font-medium text-red-700 dark:text-red-300">{config.name}</div>
											{config.error && (
												<div className="text-xs text-red-600 dark:text-red-400 mt-1">{config.error}</div>
											)}
										</div>
									))}
								</div>
							</div>
						)}

						{/* Errors Section */}
						{data.data.errors && (
							<div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
								<div className="flex items-start gap-3">
									<AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
									<div>
										<p className="text-sm font-medium text-fg">Errors</p>
										<pre className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap font-mono mt-2">
											{data.data.errors}
										</pre>
									</div>
								</div>
							</div>
						)}

						{/* Warnings Section */}
						{data.data.warnings && (
							<div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
								<div className="flex items-start gap-3">
									<AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
									<div>
										<p className="text-sm font-medium text-fg">Warnings</p>
										<pre className="text-xs text-amber-600 dark:text-amber-400 whitespace-pre-wrap font-mono mt-2">
											{data.data.warnings}
										</pre>
									</div>
								</div>
							</div>
						)}

						{/* Backup Info Section */}
						{data.data.backup && (
							<div className="rounded-lg border border-border bg-bg-subtle p-4">
								<h3 className="text-sm font-medium text-fg mb-3">Backup</h3>
								<InfoField
									label="Backup Created"
									value={format(
										new Date(data.data.backup.createdAt),
										"MMM d, yyyy 'at' h:mm a",
									)}
								/>
								<p className="text-xs text-fg-muted mt-2">
									A backup was created before this deployment.
								</p>
							</div>
						)}
					</>
				)}
			</DialogContent>

			<DialogFooter>
				<Button variant="ghost" onClick={onClose}>
					Close
				</Button>
				{data?.data &&
					!data.data.rolledBack &&
					onUndeploy && (
						<Button
							variant="danger"
							onClick={() => onUndeploy(historyId)}
							title="Remove Custom Formats deployed by this template (shared CFs will be kept)"
						>
							Undeploy
						</Button>
					)}
			</DialogFooter>
		</Dialog>
	);
}

function InfoField({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div className="text-xs text-fg-muted mb-1">{label}</div>
			<div className="text-sm font-medium text-fg">{value}</div>
		</div>
	);
}
