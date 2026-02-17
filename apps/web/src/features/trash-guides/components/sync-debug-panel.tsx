"use client";

/**
 * Sync Debug Panel
 *
 * Development-only debug panel showing validation internals.
 * Self-contained with its own toggle state.
 */

import { Bug, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { MAX_RETRY_ATTEMPTS } from "../../../hooks/api/useSync";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import type { ValidationResult } from "../../../lib/api-client/trash-guides";
import type { ValidationTiming, RetryProgress } from "../lib/sync-validation-utils";

interface SyncDebugPanelProps {
	templateId: string;
	instanceId: string;
	mutationStatus: "idle" | "pending" | "error" | "success";
	retryCount: number;
	maxManualRetries: number;
	retryProgress: RetryProgress | null;
	timing: ValidationTiming;
	validation: ValidationResult | null;
	hasSilentFailure: boolean;
	error: Error | null;
}

export const SyncDebugPanel = ({
	templateId,
	instanceId,
	mutationStatus,
	retryCount,
	maxManualRetries,
	retryProgress,
	timing,
	validation,
	hasSilentFailure,
	error,
}: SyncDebugPanelProps) => {
	const [showDebugPanel, setShowDebugPanel] = useState(false);

	return (
		<div className="mt-4 rounded-xl border border-purple-500/30 bg-purple-500/10">
			<button
				type="button"
				onClick={() => setShowDebugPanel(!showDebugPanel)}
				className="flex w-full items-center justify-between p-3 text-left text-sm font-medium text-purple-300 hover:bg-purple-500/10 rounded-xl"
			>
				<span className="flex items-center gap-2">
					<Bug className="h-4 w-4" />
					Debug Panel (Development Only)
				</span>
				{showDebugPanel ? (
					<ChevronUp className="h-4 w-4" />
				) : (
					<ChevronDown className="h-4 w-4" />
				)}
			</button>
			{showDebugPanel && (
				<div className="border-t border-purple-500/20 p-3">
					<div className="space-y-2 font-mono text-xs">
						<div className="grid grid-cols-2 gap-2">
							<span className="text-purple-400">Template ID:</span>
							<span className="text-purple-200 break-all">{templateId}</span>
						</div>
						<div className="grid grid-cols-2 gap-2">
							<span className="text-purple-400">Instance ID:</span>
							<span className="text-purple-200 break-all">{instanceId}</span>
						</div>
						<div className="grid grid-cols-2 gap-2">
							<span className="text-purple-400">Mutation Status:</span>
							<span className="text-purple-200">{mutationStatus}</span>
						</div>
						<div className="grid grid-cols-2 gap-2">
							<span className="text-purple-400">Manual Retry Count:</span>
							<span className="text-purple-200">{retryCount} / {maxManualRetries}</span>
						</div>
						<div className="grid grid-cols-2 gap-2">
							<span className="text-purple-400">Auto Retry Max:</span>
							<span className="text-purple-200">{MAX_RETRY_ATTEMPTS}</span>
						</div>
						{retryProgress && (
							<div className="grid grid-cols-2 gap-2">
								<span className="text-purple-400">Auto Retry Progress:</span>
								<span className="text-purple-200">
									Attempt {retryProgress.attempt}/{retryProgress.maxAttempts}
									{retryProgress.isWaiting ? ` (waiting ${retryProgress.delayMs}ms)` : ""}
								</span>
							</div>
						)}
						{timing.startTime > 0 && (
							<>
								<div className="grid grid-cols-2 gap-2">
									<span className="text-purple-400">Start Time:</span>
									<span className="text-purple-200">
										{new Date(timing.startTime).toISOString()}
									</span>
								</div>
								{timing.duration !== null && (
									<div className="grid grid-cols-2 gap-2">
										<span className="text-purple-400">Duration:</span>
										<span className="text-purple-200">{timing.duration}ms</span>
									</div>
								)}
							</>
						)}
						{validation && (
							<>
								<div className="mt-2 border-t border-purple-500/20 pt-2">
									<span className="text-purple-400">Validation Response:</span>
								</div>
								<div className="grid grid-cols-2 gap-2">
									<span className="text-purple-400">Valid:</span>
									<span className={validation.valid ? "text-green-400" : "text-red-400"}>
										{String(validation.valid)}
									</span>
								</div>
								<div className="grid grid-cols-2 gap-2">
									<span className="text-purple-400">Errors:</span>
									<span className="text-purple-200">{validation.errors?.length ?? 0}</span>
								</div>
								<div className="grid grid-cols-2 gap-2">
									<span className="text-purple-400">Warnings:</span>
									<span className="text-purple-200">{validation.warnings?.length ?? 0}</span>
								</div>
								<div className="grid grid-cols-2 gap-2">
									<span className="text-purple-400">Conflicts:</span>
									<span className="text-purple-200">{validation.conflicts?.length ?? 0}</span>
								</div>
								{hasSilentFailure && (
									<div
										className="mt-2 rounded-lg p-2"
										style={{
											backgroundColor: SEMANTIC_COLORS.warning.bg,
											color: SEMANTIC_COLORS.warning.text,
										}}
									>
										Silent Failure Detected: valid=false with 0 errors
									</div>
								)}
							</>
						)}
						{error && (
							<div className="mt-2 border-t border-purple-500/20 pt-2">
								<span className="text-purple-400">Error Details:</span>
								<pre className="mt-1 overflow-auto rounded-lg bg-black/30 p-2 text-red-300">
									{error.message}
								</pre>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
};
