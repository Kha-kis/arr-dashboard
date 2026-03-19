"use client";

import type { ProwlarrIndexer, ProwlarrIndexerDetails } from "@arr/shared";
import {
	AlertCircle,
	ChevronDown,
	Loader2,
	Pencil,
	RefreshCw,
	Save,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PremiumSkeleton } from "../../../components/layout/premium-components";
import { useIndexerDetailsQuery } from "../../../hooks/api/useSearch";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getErrorMessage } from "../../../lib/error-utils";
import { PROTOCOL_COLORS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { IndexerConfigurationFields } from "./indexer-configuration-fields";
import { IndexerDetailsInfo } from "./indexer-details-info";
import { IndexerEditForm } from "./indexer-edit-form";

/**
 * Details Panel — Expandable console below the row
 *
 * Design: protocol-tinted gradient wash at top fading to transparent,
 * creating visual connection to the row's accent color. Three states:
 * loading (skeleton), error (compact alert), content (info + config + edit).
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
	const { gradient: themeGradient } = useThemeGradient();

	const { data, isLoading, error, refetch, isFetching } = useIndexerDetailsQuery(
		expanded ? instanceId : null,
		expanded ? indexer.id : null,
		expanded,
		indexer.health,
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
	const [fieldValues, setFieldValues] = useState<Map<string, string | number | boolean | null>>(
		() => new Map(),
	);

	const handleFieldChange = useCallback((name: string, value: string | number | boolean | null) => {
		setFieldValues((prev) => {
			const next = new Map(prev);
			next.set(name, value);
			return next;
		});
	}, []);

	useEffect(() => {
		if (!expanded) {
			setIsEditing(false);
			setLocalError(null);
			setFormEnable(initialEnable);
			setFormPriority(initialPriority ?? undefined);
			setFieldValues(new Map());
			return;
		}

		setFormEnable(initialEnable);
		setFormPriority(initialPriority ?? undefined);
		setFieldValues(new Map());
		setLocalError(null);
	}, [expanded, initialEnable, initialPriority]);

	if (!expanded) {
		return null;
	}

	const protocolColor =
		indexer.protocol === "torrent" ? PROTOCOL_COLORS.torrent : PROTOCOL_COLORS.usenet;

	const detailError = error ? getErrorMessage(error, "Unable to load indexer settings.") : null;
	const isLoadingState = isLoading && !detail.fields && !detail.stats;

	const handleStartEditing = () => {
		setFormEnable(initialEnable);
		setFormPriority(initialPriority ?? undefined);
		setFieldValues(new Map());
		setIsEditing(true);
		setLocalError(null);
	};

	const handleCancelEditing = () => {
		setFormEnable(initialEnable);
		setFormPriority(initialPriority ?? undefined);
		setFieldValues(new Map());
		setIsEditing(false);
		setLocalError(null);
	};

	const handleSaveChanges = async () => {
		setIsSaving(true);
		setLocalError(null);

		const mergedFields = (detail.fields ?? []).map((field) => {
			if (fieldValues.has(field.name)) {
				return { ...field, value: fieldValues.get(field.name) ?? null };
			}
			return field;
		});

		const payload: ProwlarrIndexerDetails = {
			...detail,
			id: detail.id ?? indexer.id,
			instanceId: detail.instanceId ?? instanceId,
			instanceName: detail.instanceName ?? indexer.instanceName ?? "",
			instanceUrl: detail.instanceUrl ?? indexer.instanceUrl,
			enable: formEnable,
			priority: formPriority ?? detail.priority ?? undefined,
			fields: mergedFields,
		};

		try {
			await onUpdate(instanceId, indexer.id, payload);
			setIsEditing(false);
			setFieldValues(new Map());
		} catch (err) {
			const message = getErrorMessage(err, "Failed to update indexer");
			setLocalError(message);
		} finally {
			setIsSaving(false);
		}
	};

	return (
		<div
			className="relative overflow-hidden animate-in slide-in-from-top-1 fade-in duration-300"
			style={{
				borderLeft: `3px solid ${protocolColor}20`,
			}}
		>
			{/* Protocol-tinted gradient wash */}
			<div
				className="absolute inset-0 pointer-events-none"
				style={{
					background: `linear-gradient(180deg, ${protocolColor}06 0%, transparent 40%)`,
				}}
			/>

			<div className="relative px-5 pl-7 pb-5 pt-3 space-y-4">
				{/* Loading State */}
				{isLoadingState ? (
					<div className="space-y-3 py-2">
						<div className="flex items-center gap-3">
							<PremiumSkeleton variant="line" className="h-4 w-28" />
							<PremiumSkeleton variant="line" className="h-4 w-20" style={{ animationDelay: "60ms" }} />
							<PremiumSkeleton variant="line" className="h-4 w-16" style={{ animationDelay: "120ms" }} />
						</div>
						<div className="grid gap-3 sm:grid-cols-3">
							{["s1", "s2", "s3"].map((id, i) => (
								<PremiumSkeleton
									key={id}
									variant="line"
									className="h-12 rounded-lg"
									style={{ animationDelay: `${(i + 2) * 60}ms` }}
								/>
							))}
						</div>
						<div className="flex gap-3">
							<PremiumSkeleton variant="line" className="h-20 w-20 rounded-full" style={{ animationDelay: "300ms" }} />
							<div className="flex-1 space-y-2">
								<PremiumSkeleton variant="line" className="h-4 w-3/4" style={{ animationDelay: "360ms" }} />
								<PremiumSkeleton variant="line" className="h-4 w-1/2" style={{ animationDelay: "420ms" }} />
							</div>
						</div>
					</div>
				) : detailError ? (
					/* Error State */
					<div
						className="rounded-lg border p-3 animate-in fade-in duration-200"
						style={{
							backgroundColor: SEMANTIC_COLORS.error.bg,
							borderColor: SEMANTIC_COLORS.error.border,
						}}
					>
						<div className="flex items-center gap-2.5">
							<AlertCircle
								className="h-4 w-4 shrink-0"
								style={{ color: SEMANTIC_COLORS.error.from }}
							/>
							<p className="text-sm font-medium flex-1" style={{ color: SEMANTIC_COLORS.error.text }}>
								{detailError}
							</p>
							<button
								type="button"
								onClick={() => void refetch()}
								disabled={isFetching}
								className="shrink-0 rounded-md p-1.5 transition-colors hover:bg-white/5 disabled:opacity-40"
								title="Retry"
							>
								<RefreshCw
									className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`}
									style={{ color: SEMANTIC_COLORS.error.text }}
								/>
							</button>
						</div>
					</div>
				) : (
					<>
						{/* Floating action bar */}
						<div className="flex items-center justify-between gap-3">
							<div className="flex items-center gap-2 text-[11px] text-muted-foreground/45">
								<ChevronDown className="h-3 w-3" />
								{isEditing ? (
									<span style={{ color: themeGradient.from }}>Editing configuration</span>
								) : (
									"Click Edit to modify. Sensitive fields can only be changed in Prowlarr."
								)}
							</div>

							<div className="flex items-center gap-1 shrink-0">
								{/* Refresh */}
								<button
									type="button"
									onClick={() => void refetch()}
									disabled={isFetching}
									className="rounded-md p-1.5 text-muted-foreground/40 hover:text-foreground hover:bg-card/60 transition-all disabled:opacity-30"
									title="Refresh details"
								>
									<RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
								</button>

								{isEditing ? (
									<>
										<button
											type="button"
											onClick={handleCancelEditing}
											disabled={isSaving}
											className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-card/60 transition-all disabled:opacity-30"
										>
											<X className="h-3 w-3" />
											Cancel
										</button>
										<button
											type="button"
											onClick={handleSaveChanges}
											disabled={isSaving}
											className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-all disabled:opacity-40 hover:brightness-110"
											style={{
												background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
												boxShadow: `0 2px 8px ${themeGradient.from}30`,
											}}
										>
											{isSaving ? (
												<>
													<Loader2 className="h-3 w-3 animate-spin" />
													Saving…
												</>
											) : (
												<>
													<Save className="h-3 w-3" />
													Save Changes
												</>
											)}
										</button>
									</>
								) : (
									<button
										type="button"
										onClick={handleStartEditing}
										className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-all hover:bg-card/60"
										style={{ color: themeGradient.from }}
									>
										<Pencil className="h-3 w-3" />
										Edit
									</button>
								)}
							</div>
						</div>

						{/* Save error */}
						{localError && (
							<div
								className="rounded-md px-3 py-2 text-xs font-medium flex items-center gap-2 animate-in fade-in slide-in-from-top-1 duration-200"
								style={{
									backgroundColor: SEMANTIC_COLORS.error.bg,
									color: SEMANTIC_COLORS.error.text,
									borderLeft: `3px solid ${SEMANTIC_COLORS.error.from}`,
								}}
							>
								<AlertCircle className="h-3.5 w-3.5 shrink-0" />
								{localError}
							</div>
						)}

						{/* Content */}
						{isEditing ? (
							<div
								className="rounded-xl border p-5 transition-all animate-in fade-in slide-in-from-top-1 duration-200"
								style={{
									backgroundColor: `${themeGradient.from}05`,
									borderColor: `${themeGradient.from}18`,
									boxShadow: `inset 0 1px 0 ${themeGradient.from}08`,
								}}
							>
								<IndexerEditForm
									formEnable={formEnable}
									formPriority={formPriority}
									onEnableChange={setFormEnable}
									onPriorityChange={setFormPriority}
									fields={detail.fields}
									fieldValues={fieldValues}
									onFieldChange={handleFieldChange}
								/>
							</div>
						) : (
							<>
								<IndexerDetailsInfo detail={detail} indexer={indexer} />

								{detail.fields && detail.fields.length > 0 && (
									<IndexerConfigurationFields fields={detail.fields} />
								)}
							</>
						)}
					</>
				)}
			</div>
		</div>
	);
};
