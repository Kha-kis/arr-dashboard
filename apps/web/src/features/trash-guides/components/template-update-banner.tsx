"use client";

import { useState } from "react";
import { RefreshCw, Clock, AlertCircle, CheckCircle2 } from "lucide-react";
import { useSyncTemplate } from "../../../hooks/api/useTemplateUpdates";
import type { TemplateUpdateInfo } from "../../../lib/api-client/trash-guides";
import { cn } from "../../../lib/utils";
import { TemplateDiffModal } from "./template-diff-modal";

interface TemplateUpdateBannerProps {
	update: TemplateUpdateInfo;
	onSyncSuccess?: () => void;
}

export const TemplateUpdateBanner = ({
	update,
	onSyncSuccess,
}: TemplateUpdateBannerProps) => {
	const [showDetails, setShowDetails] = useState(false);
	const [showDiffModal, setShowDiffModal] = useState(false);
	const syncTemplate = useSyncTemplate();

	const handleViewChanges = () => {
		setShowDiffModal(true);
	};

	const handleDiffModalClose = () => {
		setShowDiffModal(false);
	};

	const getSyncStrategyLabel = (strategy: string) => {
		switch (strategy) {
			case "auto":
				return "Auto-sync";
			case "notify":
				return "Notify only";
			case "manual":
				return "Manual";
			default:
				return strategy;
		}
	};

	const getSyncStrategyColor = (strategy: string) => {
		switch (strategy) {
			case "auto":
				return "text-green-600 dark:text-green-400";
			case "notify":
				return "text-blue-600 dark:text-blue-400";
			case "manual":
				return "text-gray-600 dark:text-gray-400";
			default:
				return "";
		}
	};

	return (
		<div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-4">
			<div className="flex items-start justify-between gap-4">
				<div className="flex items-start gap-3 flex-1">
					<RefreshCw className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2 flex-wrap">
							<p className="text-sm font-medium text-fg">Update Available</p>
							{update.hasUserModifications && (
								<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300 text-xs font-medium">
									<AlertCircle className="h-3 w-3" />
									Modified
								</span>
							)}
							<span
								className={cn(
									"inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium",
									getSyncStrategyColor(update.syncStrategy),
								)}
							>
								{getSyncStrategyLabel(update.syncStrategy)}
							</span>
							{update.canAutoSync && (
								<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-500/10 text-green-700 dark:text-green-300 text-xs font-medium">
									<CheckCircle2 className="h-3 w-3" />
									Can auto-sync
								</span>
							)}
						</div>

						<p className="text-sm text-fg-muted mt-1">
							TRaSH Guides has new changes for this template
						</p>

						{showDetails && (
							<div className="mt-3 space-y-2 text-xs text-fg-muted">
								<div className="flex items-center gap-2">
									<Clock className="h-3 w-3" />
									<span>
										Current commit:{" "}
										<code className="px-1 py-0.5 rounded bg-bg-subtle text-fg font-mono">
											{update.currentCommit?.substring(0, 8) || "unknown"}
										</code>
									</span>
								</div>
								<div className="flex items-center gap-2">
									<RefreshCw className="h-3 w-3" />
									<span>
										Latest commit:{" "}
										<code className="px-1 py-0.5 rounded bg-bg-subtle text-fg font-mono">
											{update.latestCommit.substring(0, 8)}
										</code>
									</span>
								</div>
							</div>
						)}
					</div>
				</div>

				<div className="flex items-center gap-2 shrink-0">
					<button
						type="button"
						onClick={() => setShowDetails(!showDetails)}
						className="px-3 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-500/10 rounded-md transition-colors"
					>
						{showDetails ? "Hide" : "Details"}
					</button>
					<button
						type="button"
						onClick={handleViewChanges}
						className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 rounded-md transition-colors"
					>
						View Changes
					</button>
				</div>
			</div>

			<TemplateDiffModal
				open={showDiffModal}
				onClose={handleDiffModalClose}
				templateId={showDiffModal ? update.templateId : null}
				templateName={update.templateName}
				onSyncSuccess={() => {
					handleDiffModalClose();
					onSyncSuccess?.();
				}}
			/>
		</div>
	);
};
