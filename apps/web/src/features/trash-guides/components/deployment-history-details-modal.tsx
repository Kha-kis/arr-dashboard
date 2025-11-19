"use client";

import { useDeploymentHistoryDetail } from "../../../hooks/api/useDeploymentHistory";
import { format } from "date-fns";
import { X } from "lucide-react";

interface DeploymentHistoryDetailsModalProps {
	historyId: string;
	onClose: () => void;
	onRollback?: (historyId: string) => void;
}

export function DeploymentHistoryDetailsModal({
	historyId,
	onClose,
	onRollback,
}: DeploymentHistoryDetailsModalProps) {
	const { data, isLoading, error } = useDeploymentHistoryDetail(historyId);

	return (
		<div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
			<div className="bg-background rounded-lg shadow-lg max-w-4xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col">
				{/* Header */}
				<div className="flex items-center justify-between p-6 border-b">
					<h2 className="text-xl font-semibold">Deployment Details</h2>
					<button
						onClick={onClose}
						className="p-1 rounded-md hover:bg-muted transition-colors"
					>
						<X className="h-5 w-5" />
					</button>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-y-auto p-6">
					{isLoading && (
						<div className="flex items-center justify-center py-12">
							<div className="text-sm text-muted-foreground">
								Loading deployment details...
							</div>
						</div>
					)}

					{error && (
						<div className="rounded-lg border border-destructive bg-destructive/10 p-4">
							<p className="text-sm font-medium text-destructive">
								Failed to load deployment details
							</p>
							<p className="mt-1 text-xs text-destructive/80">{error.message}</p>
						</div>
					)}

					{data?.data && (
						<div className="space-y-6">
							{/* Overview Section */}
							<section>
								<h3 className="text-sm font-semibold mb-3">Overview</h3>
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
							</section>

							{/* Instance & Template Section */}
							<section>
								<h3 className="text-sm font-semibold mb-3">
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
							</section>

							{/* Results Section */}
							<section>
								<h3 className="text-sm font-semibold mb-3">Results</h3>
								<div className="grid grid-cols-3 gap-4">
									<div className="rounded-lg border p-3">
										<div className="text-2xl font-bold text-green-600 dark:text-green-400">
											{data.data.appliedCFs}
										</div>
										<div className="text-xs text-muted-foreground mt-1">
											Applied
										</div>
									</div>
									<div className="rounded-lg border p-3">
										<div className="text-2xl font-bold text-red-600 dark:text-red-400">
											{data.data.failedCFs}
										</div>
										<div className="text-xs text-muted-foreground mt-1">
											Failed
										</div>
									</div>
									<div className="rounded-lg border p-3">
										<div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
											{data.data.totalCFs}
										</div>
										<div className="text-xs text-muted-foreground mt-1">
											Total
										</div>
									</div>
								</div>
							</section>

							{/* Applied Configs Section */}
							{data.data.appliedConfigs && data.data.appliedConfigs.length > 0 && (
									<section>
										<h3 className="text-sm font-semibold mb-3">
											Applied Custom Formats
										</h3>
										<div className="rounded-lg border divide-y max-h-48 overflow-y-auto">
											{data.data.appliedConfigs.map((config, index) => (
												<div key={index} className="px-3 py-2 text-sm flex items-center justify-between">
													<span>{config.name}</span>
													<span className="text-xs text-muted-foreground capitalize">
														{config.action}
													</span>
												</div>
											))}
										</div>
									</section>
								)}

							{/* Failed Configs Section */}
							{data.data.failedConfigs && data.data.failedConfigs.length > 0 && (
								<section>
									<h3 className="text-sm font-semibold mb-3 text-destructive">
										Failed Custom Formats
									</h3>
									<div className="rounded-lg border border-destructive/50 divide-y max-h-48 overflow-y-auto">
										{data.data.failedConfigs.map((config, index) => (
											<div
												key={index}
												className="px-3 py-2 text-sm"
											>
												<div className="font-medium text-destructive">{config.name}</div>
												{config.error && (
													<div className="text-xs text-destructive/80 mt-1">{config.error}</div>
												)}
											</div>
										))}
									</div>
								</section>
							)}

							{/* Errors Section */}
							{data.data.errors && (
								<section>
									<h3 className="text-sm font-semibold mb-3 text-destructive">
										Errors
									</h3>
									<div className="rounded-lg border border-destructive/50 bg-destructive/5 p-3">
										<pre className="text-xs text-destructive whitespace-pre-wrap font-mono">
											{data.data.errors}
										</pre>
									</div>
								</section>
							)}

							{/* Warnings Section */}
							{data.data.warnings && (
								<section>
									<h3 className="text-sm font-semibold mb-3 text-yellow-600 dark:text-yellow-400">
										Warnings
									</h3>
									<div className="rounded-lg border border-yellow-500/50 bg-yellow-500/5 p-3">
										<pre className="text-xs text-yellow-600 dark:text-yellow-400 whitespace-pre-wrap font-mono">
											{data.data.warnings}
										</pre>
									</div>
								</section>
							)}

							{/* Backup Info Section */}
							{data.data.backup && (
								<section>
									<h3 className="text-sm font-semibold mb-3">Backup</h3>
									<div className="rounded-lg border p-3">
										<InfoField
											label="Backup Created"
											value={format(
												new Date(data.data.backup.createdAt),
												"MMM d, yyyy 'at' h:mm a",
											)}
										/>
										<p className="text-xs text-muted-foreground mt-2">
											A backup was created before this deployment and can be used
											for rollback.
										</p>
									</div>
								</section>
							)}
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="flex items-center justify-end gap-3 p-6 border-t">
					<button
						onClick={onClose}
						className="px-4 py-2 text-sm rounded-md border hover:bg-muted transition-colors"
					>
						Close
					</button>
					{data?.data &&
						!data.data.rolledBack &&
						data.data.backupId &&
						onRollback && (
							<button
								onClick={() => onRollback(historyId)}
								className="px-4 py-2 text-sm rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
							>
								Rollback Deployment
							</button>
						)}
				</div>
			</div>
		</div>
	);
}

function InfoField({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div className="text-xs text-muted-foreground mb-1">{label}</div>
			<div className="text-sm font-medium">{value}</div>
		</div>
	);
}
