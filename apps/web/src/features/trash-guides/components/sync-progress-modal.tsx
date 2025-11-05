"use client";

import { useEffect } from "react";
import { CheckCircle2, XCircle, Loader2, AlertCircle } from "lucide-react";
import { useSyncProgress } from "../../../hooks/api/useSync";
import type { SyncProgressStatus } from "../../../lib/api-client/sync";

interface SyncProgressModalProps {
	syncId: string;
	templateName: string;
	instanceName: string;
	onComplete: () => void;
	onClose: () => void;
}

const STAGE_ORDER: SyncProgressStatus[] = [
	"INITIALIZING",
	"VALIDATING",
	"BACKING_UP",
	"APPLYING",
	"COMPLETED",
];

const STAGE_LABELS: Record<SyncProgressStatus, string> = {
	INITIALIZING: "Initializing",
	VALIDATING: "Validating",
	BACKING_UP: "Creating Backup",
	APPLYING: "Applying Configurations",
	COMPLETED: "Completed",
	FAILED: "Failed",
};

export const SyncProgressModal = ({
	syncId,
	templateName,
	instanceName,
	onComplete,
	onClose,
}: SyncProgressModalProps) => {
	const { progress, error, isLoading, isPolling } = useSyncProgress(syncId);

	// Auto-call onComplete when sync finishes successfully
	useEffect(() => {
		if (progress?.status === "COMPLETED") {
			setTimeout(() => {
				onComplete();
			}, 2000); // Give user time to see completion
		}
	}, [progress?.status, onComplete]);

	const currentStage = progress?.status || "INITIALIZING";
	const currentStageIndex = STAGE_ORDER.indexOf(currentStage);
	const isFailed = currentStage === "FAILED";
	const isCompleted = currentStage === "COMPLETED";

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
			<div className="w-full max-w-3xl rounded-xl border border-white/10 bg-gray-900 shadow-2xl">
				{/* Header */}
				<div className="border-b border-white/10 p-6">
					<div className="flex items-center justify-between">
						<div>
							<h2 className="text-xl font-semibold text-white">Sync Progress</h2>
							<p className="mt-1 text-sm text-white/60">
								Template: <span className="font-medium text-white">{templateName}</span> →
								Instance: <span className="font-medium text-white">{instanceName}</span>
							</p>
						</div>
						{isPolling && (
							<span className="rounded-full bg-yellow-500/10 px-3 py-1 text-xs font-medium text-yellow-400">
								Polling Mode
							</span>
						)}
					</div>
				</div>

				{/* Content */}
				<div className="p-6">
					{isLoading && (
						<div className="flex items-center justify-center py-12">
							<div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
							<span className="ml-3 text-white/60">Connecting...</span>
						</div>
					)}

					{!isLoading && progress && (
						<div className="space-y-6">
							{/* 5-Stage Stepper */}
							<div className="relative">
								<div className="flex items-center justify-between">
									{STAGE_ORDER.filter((s) => s !== "FAILED").map((stage, index) => {
										const isActive = currentStageIndex === index;
										const isPast = currentStageIndex > index;
										const isCurrentFailed = isFailed && currentStageIndex === index;

										return (
											<div key={stage} className="flex flex-1 items-center">
												{/* Stage Circle */}
												<div className="relative flex flex-col items-center">
													<div
														className={`flex h-10 w-10 items-center justify-center rounded-full border-2 transition ${
															isCurrentFailed
																? "border-red-500 bg-red-500/10"
																: isPast || isCompleted
																	? "border-green-500 bg-green-500/10"
																	: isActive
																		? "border-primary bg-primary/10"
																		: "border-white/20 bg-white/5"
														}`}
													>
														{isCurrentFailed ? (
															<XCircle className="h-5 w-5 text-red-400" />
														) : isPast || isCompleted ? (
															<CheckCircle2 className="h-5 w-5 text-green-400" />
														) : isActive ? (
															<Loader2 className="h-5 w-5 animate-spin text-primary" />
														) : (
															<span className="text-sm font-medium text-white/40">{index + 1}</span>
														)}
													</div>
													<span
														className={`mt-2 text-xs font-medium ${
															isActive ? "text-white" : "text-white/50"
														}`}
													>
														{STAGE_LABELS[stage]}
													</span>
												</div>

												{/* Connector Line */}
												{index < STAGE_ORDER.length - 2 && (
													<div
														className={`mx-2 h-0.5 flex-1 transition ${
															isPast || isCompleted ? "bg-green-500" : "bg-white/20"
														}`}
													/>
												)}
											</div>
										);
									})}
								</div>
							</div>

							{/* Progress Bar */}
							<div>
								<div className="mb-2 flex items-center justify-between text-sm">
									<span className="font-medium text-white">{progress.currentStep}</span>
									<span className="text-white/60">{Math.round(progress.progress)}%</span>
								</div>
								<div className="h-2 overflow-hidden rounded-full bg-white/10">
									<div
										className={`h-full transition-all duration-300 ${
											isFailed ? "bg-red-500" : isCompleted ? "bg-green-500" : "bg-primary"
										}`}
										style={{ width: `${progress.progress}%` }}
									/>
								</div>
							</div>

							{/* Statistics */}
							<div className="grid grid-cols-3 gap-4">
								<div className="rounded-lg border border-white/10 bg-white/5 p-4">
									<p className="text-sm text-white/60">Total Configs</p>
									<p className="mt-1 text-2xl font-semibold text-white">{progress.totalConfigs}</p>
								</div>
								<div className="rounded-lg border border-green-500/20 bg-green-500/10 p-4">
									<p className="text-sm text-green-400">Applied</p>
									<p className="mt-1 text-2xl font-semibold text-green-300">
										{progress.appliedConfigs}
									</p>
								</div>
								<div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4">
									<p className="text-sm text-red-400">Failed</p>
									<p className="mt-1 text-2xl font-semibold text-red-300">{progress.failedConfigs}</p>
								</div>
							</div>

							{/* Errors */}
							{progress.errors.length > 0 && (
								<div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4">
									<div className="flex items-start gap-3">
										<AlertCircle className="h-5 w-5 flex-shrink-0 text-red-400" />
										<div className="flex-1">
											<h3 className="font-medium text-red-200">
												{progress.errors.length} Error{progress.errors.length !== 1 ? "s" : ""}{" "}
												Occurred
											</h3>
											<ul className="mt-2 space-y-1 text-sm text-red-300">
												{progress.errors.map((error, index) => (
													<li key={index}>
														<span className="font-medium">{error.configName}:</span> {error.error}
														{error.retryable && (
															<span className="ml-2 text-xs text-red-400">(retryable)</span>
														)}
													</li>
												))}
											</ul>
										</div>
									</div>
								</div>
							)}

							{/* Success Message */}
							{isCompleted && progress.errors.length === 0 && (
								<div className="rounded-lg border border-green-500/20 bg-green-500/10 p-4">
									<div className="flex items-center gap-3">
										<CheckCircle2 className="h-5 w-5 text-green-400" />
										<div>
											<h3 className="font-medium text-green-200">Sync Completed Successfully</h3>
											<p className="mt-0.5 text-sm text-green-300">
												All configurations have been applied to {instanceName}
											</p>
										</div>
									</div>
								</div>
							)}
						</div>
					)}

					{error && (
						<div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4">
							<div className="flex items-start gap-3">
								<XCircle className="h-5 w-5 flex-shrink-0 text-red-400" />
								<div>
									<h3 className="font-medium text-red-200">Connection Error</h3>
									<p className="mt-1 text-sm text-red-300">{error.message}</p>
								</div>
							</div>
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="flex items-center justify-end gap-3 border-t border-white/10 p-6">
					{(isCompleted || isFailed) && (
						<button
							type="button"
							onClick={onClose}
							className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
						>
							Close
						</button>
					)}
					{!isCompleted && !isFailed && (
						<div className="flex items-center gap-2 text-sm text-white/60">
							<Loader2 className="h-4 w-4 animate-spin" />
							Sync in progress...
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
