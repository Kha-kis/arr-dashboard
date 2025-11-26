"use client";

import { useEffect, useRef } from "react";
import { useDeploymentHistoryDetail } from "../../../hooks/api/useDeploymentHistory";
import { format } from "date-fns";
import { X } from "lucide-react";

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
	const dialogRef = useRef<HTMLDivElement>(null);

	// Handle Escape key and focus trap
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		// Focus the dialog on mount
		dialogRef.current?.focus();

		return () => {
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [onClose]);

	return (
		<div
			className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
			onClick={(e) => e.target === e.currentTarget && onClose()}
		>
			<div
				ref={dialogRef}
				tabIndex={-1}
				className="bg-bg-subtle rounded-lg shadow-lg max-w-4xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col border border-border focus:outline-none"
				role="dialog"
				aria-modal="true"
				aria-labelledby="deployment-details-title"
			>
				{/* Header */}
				<div className="flex items-center justify-between p-6 border-b border-border">
					<h2 id="deployment-details-title" className="text-xl font-semibold text-fg">Deployment Details</h2>
					<button
						onClick={onClose}
						className="p-1 rounded-md hover:bg-bg-muted transition-colors"
					>
						<X className="h-5 w-5 text-fg-muted" />
					</button>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-y-auto p-6">
					{isLoading && (
						<div className="flex items-center justify-center py-12">
							<div className="text-sm text-fg-muted">
								Loading deployment details...
							</div>
						</div>
					)}

					{error && (
						<div className="rounded-lg border border-danger bg-danger/10 p-4">
							<p className="text-sm font-medium text-danger">
								Failed to load deployment details
							</p>
							<p className="mt-1 text-xs text-danger/80">{error.message}</p>
						</div>
					)}

					{data?.data && (
						<div className="space-y-6">
							{/* Overview Section */}
							<section>
								<h3 className="text-sm font-semibold mb-3 text-fg">Overview</h3>
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
								<h3 className="text-sm font-semibold mb-3 text-fg">
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
								<h3 className="text-sm font-semibold mb-3 text-fg">Results</h3>
								<div className="grid grid-cols-3 gap-4">
									<div className="rounded-lg border border-border bg-bg-muted p-3">
										<div className="text-2xl font-bold text-success">
											{data.data.appliedCFs}
										</div>
										<div className="text-xs text-fg-muted mt-1">
											Applied
										</div>
									</div>
									<div className="rounded-lg border border-border bg-bg-muted p-3">
										<div className="text-2xl font-bold text-danger">
											{data.data.failedCFs}
										</div>
										<div className="text-xs text-fg-muted mt-1">
											Failed
										</div>
									</div>
									<div className="rounded-lg border border-border bg-bg-muted p-3">
										<div className="text-2xl font-bold text-info">
											{data.data.totalCFs}
										</div>
										<div className="text-xs text-fg-muted mt-1">
											Total
										</div>
									</div>
								</div>
							</section>

							{/* Applied Configs Section */}
							{data.data.appliedConfigs && data.data.appliedConfigs.length > 0 && (
									<section>
										<h3 className="text-sm font-semibold mb-3 text-fg">
											Applied Custom Formats
										</h3>
										<div className="rounded-lg border border-border bg-bg-muted divide-y divide-border max-h-48 overflow-y-auto">
											{data.data.appliedConfigs.map((config, index) => (
												<div key={index} className="px-3 py-2 text-sm flex items-center justify-between text-fg">
													<span>{config.name}</span>
													<span className="text-xs text-fg-muted capitalize">
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
									<h3 className="text-sm font-semibold mb-3 text-danger">
										Failed Custom Formats
									</h3>
									<div className="rounded-lg border border-danger/50 bg-danger/5 divide-y divide-danger/20 max-h-48 overflow-y-auto">
										{data.data.failedConfigs.map((config, index) => (
											<div
												key={index}
												className="px-3 py-2 text-sm"
											>
												<div className="font-medium text-danger">{config.name}</div>
												{config.error && (
													<div className="text-xs text-danger/80 mt-1">{config.error}</div>
												)}
											</div>
										))}
									</div>
								</section>
							)}

							{/* Errors Section */}
							{data.data.errors && (
								<section>
									<h3 className="text-sm font-semibold mb-3 text-danger">
										Errors
									</h3>
									<div className="rounded-lg border border-danger/50 bg-danger/5 p-3">
										<pre className="text-xs text-danger whitespace-pre-wrap font-mono">
											{data.data.errors}
										</pre>
									</div>
								</section>
							)}

							{/* Warnings Section */}
							{data.data.warnings && (
								<section>
									<h3 className="text-sm font-semibold mb-3 text-warning">
										Warnings
									</h3>
									<div className="rounded-lg border border-warning/50 bg-warning/5 p-3">
										<pre className="text-xs text-warning whitespace-pre-wrap font-mono">
											{data.data.warnings}
										</pre>
									</div>
								</section>
							)}

							{/* Backup Info Section */}
							{data.data.backup && (
								<section>
									<h3 className="text-sm font-semibold mb-3 text-fg">Backup</h3>
									<div className="rounded-lg border border-border bg-bg-muted p-3">
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
								</section>
							)}
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="flex items-center justify-end gap-3 p-6 border-t border-border">
					<button
						onClick={onClose}
						className="px-4 py-2 text-sm rounded-md border border-border text-fg hover:bg-bg-muted transition-colors"
					>
						Close
					</button>
					{data?.data &&
						!data.data.rolledBack &&
						onUndeploy && (
							<button
								onClick={() => onUndeploy(historyId)}
								className="px-4 py-2 text-sm rounded-md bg-orange-500 text-white hover:bg-orange-600 transition-colors"
								title="Remove Custom Formats deployed by this template (shared CFs will be kept)"
							>
								Undeploy
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
			<div className="text-xs text-fg-muted mb-1">{label}</div>
			<div className="text-sm font-medium text-fg">{value}</div>
		</div>
	);
}
