"use client";

import { useEffect, useState } from "react";
import type { ProwlarrIndexer, ProwlarrIndexerDetails } from "@arr/shared";
import { useIndexerDetailsQuery } from "../../../hooks/api/useSearch";
import { IndexerDetailsInfo } from "./indexer-details-info";
import { IndexerEditForm } from "./indexer-edit-form";
import { IndexerConfigurationFields } from "./indexer-configuration-fields";
import {
	RefreshCw,
	Loader2,
	AlertCircle,
	Pencil,
	X,
	Save,
	Info,
} from "lucide-react";
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

/**
 * Premium Indexer Details Panel
 *
 * Expandable panel showing detailed indexer information with:
 * - Glassmorphic styling with theme border
 * - Animated expand/collapse
 * - Edit mode with save/cancel actions
 * - Premium loading and error states
 */
export const IndexerDetailsPanel = ({
	instanceId,
	indexer,
	expanded,
	onUpdate,
}: {
	instanceId: string;
	indexer: ProwlarrIndexer;
	expanded: boolean;
	onUpdate: (
		instanceId: string,
		indexerId: number,
		payload: ProwlarrIndexerDetails,
	) => Promise<ProwlarrIndexerDetails>;
}) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	const { data, isLoading, error, refetch, isFetching } = useIndexerDetailsQuery(
		expanded ? instanceId : null,
		expanded ? indexer.id : null,
		expanded,
	);

	const detail = data ?? {
		id: indexer.id,
		name: indexer.name,
		instanceId,
		instanceName: indexer.instanceName ?? indexer.instanceId ?? "",
		instanceUrl: indexer.instanceUrl,
		enable: indexer.enable,
		priority: indexer.priority,
		tags: indexer.tags,
		protocol: indexer.protocol,
		capabilities: indexer.capabilities,
	};

	const initialEnable = detail.enable ?? indexer.enable ?? false;
	const initialPriority = detail.priority ?? indexer.priority ?? 0;

	const [isEditing, setIsEditing] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	const [formEnable, setFormEnable] = useState(initialEnable);
	const [formPriority, setFormPriority] = useState<number | undefined>(
		initialPriority ?? undefined,
	);

	useEffect(() => {
		if (!expanded) {
			setIsEditing(false);
			setLocalError(null);
			setFormEnable(initialEnable);
			setFormPriority(initialPriority ?? undefined);
			return;
		}

		setFormEnable(initialEnable);
		setFormPriority(initialPriority ?? undefined);
		setLocalError(null);
	}, [expanded, initialEnable, initialPriority]);

	if (!expanded) {
		return null;
	}

	const detailError =
		error instanceof Error ? error.message : error ? "Unable to load indexer settings." : null;
	const isLoadingState = isLoading && !detail.fields && !detail.stats;

	const handleStartEditing = () => {
		setFormEnable(initialEnable);
		setFormPriority(initialPriority ?? undefined);
		setIsEditing(true);
		setLocalError(null);
	};

	const handleCancelEditing = () => {
		setFormEnable(initialEnable);
		setFormPriority(initialPriority ?? undefined);
		setIsEditing(false);
		setLocalError(null);
	};

	const handleSaveChanges = async () => {
		setIsSaving(true);
		setLocalError(null);

		const payload: ProwlarrIndexerDetails = {
			...detail,
			id: detail.id ?? indexer.id,
			instanceId: detail.instanceId ?? instanceId,
			instanceName: detail.instanceName ?? indexer.instanceName ?? "",
			instanceUrl: detail.instanceUrl ?? indexer.instanceUrl,
			enable: formEnable,
			priority: formPriority ?? detail.priority ?? undefined,
			fields: detail.fields ?? [],
		};

		try {
			await onUpdate(instanceId, indexer.id, payload);
			setIsEditing(false);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Failed to update indexer";
			setLocalError(message);
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<div
			className="rounded-b-xl border border-t-0 p-5 space-y-5 animate-in slide-in-from-top-2 duration-200"
			style={{
				backgroundColor: "rgba(var(--card), 0.4)",
				borderColor: `${themeGradient.from}40`,
			}}
		>
			{/* Loading State */}
			{isLoadingState ? (
				<div className="flex items-center justify-center py-8">
					<div
						className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
						style={{ borderColor: `${themeGradient.from}40`, borderTopColor: "transparent" }}
					/>
					<span className="ml-3 text-sm text-muted-foreground">Loading indexer settings...</span>
				</div>
			) : detailError ? (
				/* Error State */
				<div
					className="rounded-xl border p-4"
					style={{
						backgroundColor: SEMANTIC_COLORS.error.bg,
						borderColor: SEMANTIC_COLORS.error.border,
					}}
				>
					<div className="flex items-start gap-3">
						<AlertCircle className="h-5 w-5 shrink-0 mt-0.5" style={{ color: SEMANTIC_COLORS.error.from }} />
						<div className="flex-1">
							<p className="font-medium" style={{ color: SEMANTIC_COLORS.error.text }}>
								{detailError}
							</p>
							<button
								type="button"
								onClick={() => void refetch()}
								disabled={isFetching}
								className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
								style={{
									backgroundColor: `${SEMANTIC_COLORS.error.from}15`,
									color: SEMANTIC_COLORS.error.text,
								}}
							>
								<RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
								{isFetching ? "Retrying..." : "Retry"}
							</button>
						</div>
					</div>
				</div>
			) : (
				<>
					{/* Header with Actions */}
					<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
						<IndexerDetailsInfo detail={detail} indexer={indexer} />

						{/* Action Buttons */}
						<div className="flex flex-col gap-2 sm:items-end shrink-0">
							<div className="flex flex-wrap items-center gap-2">
								{/* Refresh Button */}
								<button
									type="button"
									onClick={() => void refetch()}
									disabled={isFetching}
									className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-card/80"
									style={{
										border: "1px solid rgba(var(--border), 0.5)",
									}}
								>
									<RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
									{isFetching ? "Refreshing..." : "Refresh"}
								</button>

								{isEditing ? (
									<>
										{/* Cancel Button */}
										<button
											type="button"
											onClick={handleCancelEditing}
											disabled={isSaving}
											className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-card/80"
											style={{
												border: "1px solid rgba(var(--border), 0.5)",
											}}
										>
											<X className="h-4 w-4" />
											Cancel
										</button>

										{/* Save Button */}
										<button
											type="button"
											onClick={handleSaveChanges}
											disabled={isSaving}
											className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
											style={{
												background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
												boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
											}}
										>
											{isSaving ? (
												<>
													<Loader2 className="h-4 w-4 animate-spin" />
													Saving...
												</>
											) : (
												<>
													<Save className="h-4 w-4" />
													Save changes
												</>
											)}
										</button>
									</>
								) : (
									/* Edit Button */
									<button
										type="button"
										onClick={handleStartEditing}
										className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200"
										style={{
											backgroundColor: `${themeGradient.from}15`,
											border: `1px solid ${themeGradient.from}30`,
											color: themeGradient.from,
										}}
									>
										<Pencil className="h-4 w-4" />
										Edit
									</button>
								)}
							</div>

							{/* Local Error Display */}
							{localError && (
								<p
									className="text-sm flex items-center gap-1.5"
									style={{ color: SEMANTIC_COLORS.error.from }}
								>
									<AlertCircle className="h-3.5 w-3.5" />
									{localError}
								</p>
							)}
						</div>
					</div>

					{/* Edit Form or Read-Only Notice */}
					{isEditing ? (
						<div
							className="rounded-xl border p-4"
							style={{
								backgroundColor: `${themeGradient.from}08`,
								borderColor: `${themeGradient.from}30`,
							}}
						>
							<IndexerEditForm
								formEnable={formEnable}
								formPriority={formPriority}
								onEnableChange={setFormEnable}
								onPriorityChange={setFormPriority}
							/>
						</div>
					) : (
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<Info className="h-3.5 w-3.5" />
							<p>
								Advanced configuration remains read-only here. Use the Prowlarr interface for
								additional changes.
							</p>
						</div>
					)}

					{/* Configuration Fields */}
					{detail.fields && detail.fields.length > 0 && (
						<IndexerConfigurationFields fields={detail.fields} />
					)}
				</>
			)}
		</div>
	);
};
