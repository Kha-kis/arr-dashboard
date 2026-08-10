"use client";

import {
	AlertCircle,
	AlertTriangle,
	Bell,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	Edit,
	Hand,
	Package,
	Plus,
	RefreshCw,
	Server,
	Settings,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PremiumSkeleton } from "../../../components/layout/premium-components";
import {
	Button,
	LegacyDialog,
	LegacyDialogContent,
	LegacyDialogDescription,
	LegacyDialogFooter,
	LegacyDialogHeader,
	LegacyDialogTitle,
	NativeSelect,
	SelectOption,
} from "../../../components/ui";
import {
	useDeploymentPreview,
	useExecuteDeployment,
} from "../../../hooks/api/useDeploymentPreview";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { ConflictResolution, DeploymentAction } from "../../../lib/api-client/trash-guides";
import { getErrorMessage } from "../../../lib/error-utils";
import { getLinuxInstanceName, useIncognitoMode } from "../../../lib/incognito";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { InstanceOverrideEditor } from "./instance-override-editor";

interface DeploymentPreviewModalProps {
	open: boolean;
	onClose: () => void;
	templateId: string | null;
	templateName?: string;
	instanceId: string | null;
	instanceLabel?: string;
	onDeploySuccess?: () => void;
}

export const DeploymentPreviewModal = ({
	open,
	onClose,
	templateId,
	templateName,
	instanceId,
	instanceLabel,
	onDeploySuccess,
}: DeploymentPreviewModalProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();
	const displayTemplateName = incognitoMode ? "TRaSH template" : templateName;
	const { data, isLoading, error } = useDeploymentPreview(templateId, instanceId);
	const [expandedConflicts, setExpandedConflicts] = useState<Set<string>>(new Set());
	const [showOverrideEditor, setShowOverrideEditor] = useState(false);
	const [syncStrategy, setSyncStrategy] = useState<"auto" | "manual" | "notify">("notify");
	// Track user's conflict resolution choices: trashId -> resolution
	const [conflictResolutions, setConflictResolutions] = useState<
		Record<string, ConflictResolution>
	>({});
	// Track if conflict resolutions have been initialized to prevent overwriting user selections
	const initializedRef = useRef(false);

	// Initialize syncStrategy from existing deployment (if any) when data loads
	useEffect(() => {
		if (data?.data?.existingSyncStrategy) {
			setSyncStrategy(data.data.existingSyncStrategy);
		}
	}, [data?.data?.existingSyncStrategy]);

	// Initialize conflict resolutions only once when customFormats first arrive
	// Merge with existing state to preserve user selections during background refetches
	useEffect(() => {
		const customFormats = data?.data?.customFormats;
		if (customFormats && customFormats.length > 0) {
			// Only initialize on first load, or merge new conflicts with existing selections
			if (!initializedRef.current) {
				// First initialization: set defaults for all conflicts
				const initialResolutions: Record<string, ConflictResolution> = {};
				for (const cf of customFormats) {
					if (cf.hasConflicts) {
						// Default to use_template (update to match template)
						initialResolutions[cf.trashId] = "use_template";
					}
				}
				setConflictResolutions(initialResolutions);
				initializedRef.current = true;
			} else {
				// Subsequent updates: merge new conflicts with existing user choices
				setConflictResolutions((prev) => {
					const merged = { ...prev };
					for (const cf of customFormats) {
						if (cf.hasConflicts && !(cf.trashId in merged)) {
							// Only add defaults for new conflicts that user hasn't resolved yet
							merged[cf.trashId] = "use_template";
						}
					}
					return merged;
				});
			}
		}
	}, [data?.data?.customFormats]);

	// Reset initialization flag when modal closes or template/instance changes
	useEffect(() => {
		if (!open) {
			initializedRef.current = false;
		}
	}, [open, templateId, instanceId]);

	const toggleConflict = (trashId: string) => {
		setExpandedConflicts((prev) => {
			const next = new Set(prev);
			if (next.has(trashId)) {
				next.delete(trashId);
			} else {
				next.add(trashId);
			}
			return next;
		});
	};

	const getActionIcon = (action: DeploymentAction) => {
		switch (action) {
			case "create":
				return <Plus className="h-4 w-4" style={{ color: SEMANTIC_COLORS.success.from }} />;
			case "update":
				return <Edit className="h-4 w-4" style={{ color: themeGradient.from }} />;
			case "delete":
				return <AlertTriangle className="h-4 w-4" style={{ color: SEMANTIC_COLORS.error.from }} />;
			case "skip":
				return <CheckCircle2 className="h-4 w-4" style={{ color: SEMANTIC_COLORS.info.from }} />;
			default:
				return null;
		}
	};

	const getActionStyles = (action: DeploymentAction): React.CSSProperties => {
		switch (action) {
			case "create":
				return {
					backgroundColor: SEMANTIC_COLORS.success.bg,
					borderColor: SEMANTIC_COLORS.success.border,
					color: SEMANTIC_COLORS.success.text,
				};
			case "update":
				return {
					backgroundColor: themeGradient.fromLight,
					borderColor: themeGradient.fromMuted,
					color: themeGradient.from,
				};
			case "delete":
				return {
					backgroundColor: SEMANTIC_COLORS.error.bg,
					borderColor: SEMANTIC_COLORS.error.border,
					color: SEMANTIC_COLORS.error.text,
				};
			case "skip":
				return {
					backgroundColor: SEMANTIC_COLORS.info.bg,
					borderColor: SEMANTIC_COLORS.info.border,
					color: SEMANTIC_COLORS.info.text,
				};
			default:
				return {};
		}
	};

	const getActionLabel = (action: DeploymentAction) => {
		switch (action) {
			case "create":
				return "New";
			case "update":
				return "Update";
			case "delete":
				return "Delete";
			case "skip":
				return "Skip";
			default:
				return action;
		}
	};

	const deploymentMutation = useExecuteDeployment();

	const handleDeploy = () => {
		if (!templateId || !instanceId || !data?.data.executionToken) return;

		deploymentMutation.mutate(
			{
				templateId,
				instanceId,
				executionToken: data.data.executionToken,
				syncStrategy,
				conflictResolutions:
					Object.keys(conflictResolutions).length > 0 ? conflictResolutions : undefined,
			},
			{
				onSuccess: (response) => {
					if (response.success) {
						onDeploySuccess?.();
						onClose();
					}
				},
			},
		);
	};

	const deploymentUncertain = deploymentMutation.data?.result?.status === "UNCERTAIN";
	// Derive terminal message from mutation state
	const deploymentMessage = deploymentMutation.isError
		? getErrorMessage(deploymentMutation.error, "Failed to execute deployment")
		: deploymentMutation.data && !deploymentMutation.data.success
			? Array.isArray(deploymentMutation.data.result?.errors) &&
				deploymentMutation.data.result.errors.length > 0
				? deploymentMutation.data.result.errors.join(", ")
				: "Deployment failed"
			: null;
	const displayedDeploymentMessage =
		deploymentMessage && incognitoMode
			? "Deployment error details hidden in incognito mode."
			: deploymentMessage;
	const displayedPreviewWarnings = data?.data?.warnings?.length
		? incognitoMode
			? ["Deployment warnings hidden in incognito mode."]
			: data.data.warnings
		: [];
	const hasDeployableChanges = Boolean(
		data?.data &&
			(data.data.summary.totalItems > 0 ||
				data.data.customFormats.some((customFormat) => customFormat.action !== "skip") ||
				data.data.orphanedCustomFormats.length > 0 ||
				(data.data.namingChanges?.length ?? 0) > 0),
	);

	return (
		<LegacyDialog open={open} onOpenChange={onClose} size="xl">
			<LegacyDialogHeader
				icon={<Package className="h-6 w-6" style={{ color: themeGradient.from }} />}
			>
				<div>
					<LegacyDialogTitle>Deployment Preview</LegacyDialogTitle>
					<LegacyDialogDescription>
						Review changes before deploying template to instance
						{displayTemplateName && ` - "${displayTemplateName}"`}
					</LegacyDialogDescription>
				</div>
			</LegacyDialogHeader>

			<LegacyDialogContent className="space-y-4">
				{isLoading && (
					<div className="space-y-4">
						<PremiumSkeleton variant="card" className="h-24 w-full" />
						<PremiumSkeleton
							variant="card"
							className="h-48 w-full"
							style={{ animationDelay: "50ms" }}
						/>
					</div>
				)}

				{error && (
					<div
						className="rounded-xl p-4"
						style={{
							backgroundColor: SEMANTIC_COLORS.error.bg,
							border: `1px solid ${SEMANTIC_COLORS.error.border}`,
						}}
					>
						<div className="flex items-start gap-3">
							<AlertCircle
								className="h-5 w-5 mt-0.5 shrink-0"
								style={{ color: SEMANTIC_COLORS.error.from }}
							/>
							<div>
								<p className="text-sm font-medium text-foreground">
									Failed to load deployment preview
								</p>
								<p className="text-sm text-muted-foreground mt-1">
									{incognitoMode
										? "Preview error details hidden in incognito mode."
										: getErrorMessage(error, "Please try again")}
								</p>
							</div>
						</div>
					</div>
				)}

				{data?.data && (
					<>
						{/* Instance Status */}
						<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4">
							<div className="flex items-center gap-3 mb-3">
								<Server className="h-5 w-5 text-muted-foreground" />
								<div className="flex-1">
									<h3 className="text-sm font-medium text-foreground">Target Instance</h3>
									<p className="text-xs text-muted-foreground">
										{incognitoMode
											? getLinuxInstanceName(data.data.instanceLabel)
											: data.data.instanceLabel}{" "}
										({data.data.instanceServiceType})
									</p>
								</div>
								<div className="flex items-center gap-2">
									{data.data.instanceReachable ? (
										<div
											className="flex items-center gap-2"
											style={{ color: SEMANTIC_COLORS.success.from }}
										>
											<CheckCircle2 className="h-4 w-4" />
											<span className="text-xs font-medium">Connected</span>
										</div>
									) : (
										<div
											className="flex items-center gap-2"
											style={{ color: SEMANTIC_COLORS.error.from }}
										>
											<AlertCircle className="h-4 w-4" />
											<span className="text-xs font-medium">Unreachable</span>
										</div>
									)}
								</div>
							</div>
							<div className="flex items-center justify-between">
								{data.data.instanceVersion && (
									<p className="text-xs text-muted-foreground">
										Version: {data.data.instanceVersion}
									</p>
								)}
								{!incognitoMode && (
									<button
										type="button"
										onClick={() => setShowOverrideEditor(true)}
										className="ml-auto flex items-center gap-2 rounded-xl border border-border/50 bg-card/50 px-3 py-2 text-xs font-medium text-foreground transition hover:bg-card/80"
										title="Customize scores and enable/disable CFs for this instance"
									>
										<Settings className="h-3 w-3" />
										Instance Overrides
									</button>
								)}
							</div>
						</div>

						{/* Sync Strategy Selector */}
						<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4">
							<h3 className="text-sm font-medium text-foreground mb-3">Update Behavior</h3>
							<p className="text-xs text-muted-foreground mb-3">
								Choose how this instance should handle future template updates
							</p>
							<div className="grid grid-cols-1 md:grid-cols-3 gap-2">
								<button
									type="button"
									onClick={() => setSyncStrategy("auto")}
									className="flex items-center gap-3 rounded-xl border p-3 text-left transition"
									style={
										syncStrategy === "auto"
											? {
													borderColor: SEMANTIC_COLORS.success.border,
													backgroundColor: SEMANTIC_COLORS.success.bg,
												}
											: {
													borderColor: "hsl(var(--border) / 0.5)",
												}
									}
								>
									<RefreshCw
										className="h-5 w-5 shrink-0"
										style={{
											color: syncStrategy === "auto" ? SEMANTIC_COLORS.success.from : undefined,
										}}
									/>
									<div>
										<p
											className="text-sm font-medium"
											style={{
												color: syncStrategy === "auto" ? SEMANTIC_COLORS.success.text : undefined,
											}}
										>
											Auto-sync
										</p>
										<p className="text-xs text-muted-foreground">Automatically apply updates</p>
									</div>
								</button>
								<button
									type="button"
									onClick={() => setSyncStrategy("notify")}
									className="flex items-center gap-3 rounded-xl border p-3 text-left transition"
									style={
										syncStrategy === "notify"
											? {
													borderColor: themeGradient.from,
													backgroundColor: themeGradient.fromLight,
												}
											: {
													borderColor: "hsl(var(--border) / 0.5)",
												}
									}
								>
									<Bell
										className="h-5 w-5 shrink-0"
										style={{ color: syncStrategy === "notify" ? themeGradient.from : undefined }}
									/>
									<div>
										<p
											className="text-sm font-medium"
											style={{ color: syncStrategy === "notify" ? themeGradient.from : undefined }}
										>
											Notify
										</p>
										<p className="text-xs text-muted-foreground">Alert me before syncing</p>
									</div>
								</button>
								<button
									type="button"
									onClick={() => setSyncStrategy("manual")}
									className="flex items-center gap-3 rounded-xl border p-3 text-left transition"
									style={
										syncStrategy === "manual"
											? {
													borderColor: SEMANTIC_COLORS.warning.border,
													backgroundColor: SEMANTIC_COLORS.warning.bg,
												}
											: {
													borderColor: "hsl(var(--border) / 0.5)",
												}
									}
								>
									<Hand
										className="h-5 w-5 shrink-0"
										style={{
											color: syncStrategy === "manual" ? SEMANTIC_COLORS.warning.from : undefined,
										}}
									/>
									<div>
										<p
											className="text-sm font-medium"
											style={{
												color: syncStrategy === "manual" ? SEMANTIC_COLORS.warning.text : undefined,
											}}
										>
											Manual
										</p>
										<p className="text-xs text-muted-foreground">Only sync when I choose</p>
									</div>
								</button>
							</div>
						</div>

						{/* Warnings */}
						{displayedPreviewWarnings.length > 0 && (
							<div
								className="rounded-xl p-4"
								style={{
									backgroundColor: SEMANTIC_COLORS.warning.bg,
									border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
								}}
							>
								<div className="flex items-start gap-3">
									<AlertTriangle
										className="h-5 w-5 mt-0.5 shrink-0"
										style={{ color: SEMANTIC_COLORS.warning.from }}
									/>
									<div className="space-y-2">
										{displayedPreviewWarnings.map((warning, idx) => (
											<p
												key={idx}
												className="text-sm"
												style={{ color: SEMANTIC_COLORS.warning.text }}
											>
												{warning}
											</p>
										))}
									</div>
								</div>
							</div>
						)}

						{/* Summary Statistics */}
						<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4">
							<h3 className="text-sm font-medium text-foreground mb-3">Deployment Summary</h3>
							<div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
								<div className="space-y-1">
									<p className="text-xs text-muted-foreground">Total Items</p>
									<p className="text-2xl font-semibold text-foreground">
										{data.data.summary.totalItems}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs" style={{ color: SEMANTIC_COLORS.success.text }}>
										New
									</p>
									<p
										className="text-2xl font-semibold"
										style={{ color: SEMANTIC_COLORS.success.from }}
									>
										{data.data.summary.newCustomFormats}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs" style={{ color: themeGradient.from }}>
										Updates
									</p>
									<p className="text-2xl font-semibold" style={{ color: themeGradient.from }}>
										{data.data.summary.updatedCustomFormats}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs" style={{ color: SEMANTIC_COLORS.info.text }}>
										Unchanged
									</p>
									<p
										className="text-2xl font-semibold"
										style={{ color: SEMANTIC_COLORS.info.from }}
									>
										{data.data.summary.skippedCustomFormats}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs" style={{ color: SEMANTIC_COLORS.warning.text }}>
										Conflicts
									</p>
									<p
										className="text-2xl font-semibold"
										style={{ color: SEMANTIC_COLORS.warning.from }}
									>
										{data.data.summary.totalConflicts}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs" style={{ color: SEMANTIC_COLORS.warning.text }}>
										Score resets
									</p>
									<p
										className="text-2xl font-semibold"
										style={{ color: SEMANTIC_COLORS.warning.from }}
									>
										{data.data.summary.orphanedCustomFormats ?? 0}
									</p>
								</div>
								<div className="space-y-1">
									<p className="text-xs" style={{ color: SEMANTIC_COLORS.info.text }}>
										Unmatched
									</p>
									<p
										className="text-2xl font-semibold"
										style={{ color: SEMANTIC_COLORS.info.from }}
									>
										{data.data.summary.unmatchedCustomFormats ?? 0}
									</p>
								</div>
							</div>

							{data.data.requiresConflictResolution && (
								<div className="mt-3 pt-3 border-t border-border/50">
									<div className="flex items-center gap-2 text-sm">
										<AlertCircle
											className="h-4 w-4"
											style={{ color: SEMANTIC_COLORS.warning.from }}
										/>
										<span className="text-muted-foreground">
											{data.data.summary.unresolvedConflicts} unresolved conflict
											{data.data.summary.unresolvedConflicts !== 1 ? "s" : ""} require attention
										</span>
									</div>
								</div>
							)}
						</div>

						{/* Custom Format Deployment Items */}
						{data.data.customFormats.length > 0 && (
							<div className="space-y-3">
								<h3 className="text-sm font-medium text-foreground">
									Custom Format Changes ({data.data.customFormats.length})
								</h3>
								<div className="space-y-2 max-h-64 overflow-y-auto">
									{data.data.customFormats.map((item, itemIndex) => (
										<div
											key={item.trashId}
											className="rounded-xl border p-3"
											style={getActionStyles(item.action)}
										>
											<div className="flex items-start justify-between gap-3">
												<div className="flex items-start gap-2 flex-1 min-w-0">
													{getActionIcon(item.action)}
													<div className="flex-1 min-w-0">
														<div className="flex items-center gap-2">
															<p className="text-sm font-medium truncate">
																{incognitoMode ? `Custom Format ${itemIndex + 1}` : item.name}
															</p>
															<span className="px-2 py-0.5 rounded-full text-xs font-medium bg-current/10">
																{getActionLabel(item.action)}
															</span>
														</div>
														{item.hasConflicts && (
															<p className="text-xs mt-1 opacity-80">
																{item.conflicts.length} conflict
																{item.conflicts.length !== 1 ? "s" : ""} detected
															</p>
														)}
													</div>
												</div>
											</div>

											{item.hasConflicts && item.conflicts.length > 0 && (
												<div className="mt-3 pt-3 border-t border-current/20">
													<div className="flex items-center justify-between gap-4 mb-2">
														<Button
															variant="ghost"
															size="sm"
															onClick={() => toggleConflict(item.trashId)}
															className="flex items-center gap-1.5 text-xs px-2 py-1 h-auto"
														>
															{expandedConflicts.has(item.trashId) ? (
																<ChevronUp className="h-3.5 w-3.5" />
															) : (
																<ChevronDown className="h-3.5 w-3.5" />
															)}
															View differences
														</Button>
														{/* Conflict resolution selector */}
														<div className="flex items-center gap-2 shrink-0">
															<span className="text-xs text-muted-foreground whitespace-nowrap">
																Action:
															</span>
															<NativeSelect
																value={conflictResolutions[item.trashId] || "use_template"}
																onChange={(e) => {
																	setConflictResolutions((prev) => ({
																		...prev,
																		[item.trashId]: e.target.value as ConflictResolution,
																	}));
																}}
																className="w-[200px] text-sm px-3 py-2"
															>
																<SelectOption value="use_template">Update to template</SelectOption>
																<SelectOption value="keep_existing">Keep existing</SelectOption>
															</NativeSelect>
														</div>
													</div>
													{expandedConflicts.has(item.trashId) && (
														<div className="mt-3 space-y-3 text-xs bg-card/50 rounded-xl p-3 border border-border/50">
															{item.conflicts.map((conflict, idx) => (
																<div key={idx} className="space-y-2">
																	<p className="font-medium text-foreground capitalize">
																		{conflict.conflictType.replace(/_/g, " ")}
																	</p>
																	<div className="grid grid-cols-2 gap-3 text-[11px]">
																		<div
																			className="rounded-xl p-2.5"
																			style={{
																				backgroundColor: SEMANTIC_COLORS.success.bg,
																				border: `1px solid ${SEMANTIC_COLORS.success.border}`,
																			}}
																		>
																			<p
																				className="font-semibold mb-1.5"
																				style={{ color: SEMANTIC_COLORS.success.from }}
																			>
																				Template:
																			</p>
																			<pre className="overflow-auto max-h-48 whitespace-pre-wrap wrap-break-word text-muted-foreground font-mono text-[10px]">
																				{incognitoMode
																					? "Conflict details hidden in incognito mode."
																					: typeof conflict.templateValue === "object"
																						? JSON.stringify(conflict.templateValue, null, 2)
																						: String(conflict.templateValue)}
																			</pre>
																		</div>
																		<div
																			className="rounded-xl p-2.5"
																			style={{
																				backgroundColor: SEMANTIC_COLORS.warning.bg,
																				border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
																			}}
																		>
																			<p
																				className="font-semibold mb-1.5"
																				style={{ color: SEMANTIC_COLORS.warning.from }}
																			>
																				Instance:
																			</p>
																			<pre className="overflow-auto max-h-48 whitespace-pre-wrap wrap-break-word text-muted-foreground font-mono text-[10px]">
																				{incognitoMode
																					? "Conflict details hidden in incognito mode."
																					: typeof conflict.instanceValue === "object"
																						? JSON.stringify(conflict.instanceValue, null, 2)
																						: String(conflict.instanceValue)}
																			</pre>
																		</div>
																	</div>
																</div>
															))}
														</div>
													)}
												</div>
											)}
										</div>
									))}
								</div>
							</div>
						)}

						{/* Naming changes */}
						{data.data.namingChanges && data.data.namingChanges.length > 0 && (
							<div className="space-y-3">
								<h3 className="text-sm font-medium text-foreground">
									Naming Changes ({data.data.namingChanges.length})
								</h3>
								<div className="space-y-2">
									{data.data.namingChanges.map((field, index) => (
										<div
											key={field}
											className="rounded-xl border border-border/50 bg-card/30 p-3 text-sm text-foreground"
										>
											{incognitoMode ? `Naming setting ${index + 1}` : field}
										</div>
									))}
								</div>
							</div>
						)}

						{/* Unmatched Custom Formats */}
						{data.data.unmatchedCustomFormats && data.data.unmatchedCustomFormats.length > 0 && (
							<div className="space-y-3">
								<h3 className="text-sm font-medium text-foreground">
									Unmatched Custom Formats ({data.data.unmatchedCustomFormats.length})
								</h3>
								<div className="space-y-2 max-h-48 overflow-y-auto">
									{data.data.unmatchedCustomFormats.map((item, index) => (
										<div
											key={item.instanceId}
											className="rounded-xl border p-3"
											style={{
												backgroundColor: SEMANTIC_COLORS.info.bg,
												borderColor: SEMANTIC_COLORS.info.border,
											}}
										>
											<div className="flex items-start gap-2">
												<AlertCircle
													className="h-4 w-4 mt-0.5 shrink-0"
													style={{ color: SEMANTIC_COLORS.info.from }}
												/>
												<div className="flex-1 min-w-0">
													<p
														className="text-sm font-medium truncate"
														style={{ color: SEMANTIC_COLORS.info.text }}
													>
														{incognitoMode ? `Unmatched Custom Format ${index + 1}` : item.name}
													</p>
													<p className="text-xs mt-1" style={{ color: SEMANTIC_COLORS.info.from }}>
														{incognitoMode
															? "Match details hidden in incognito mode."
															: item.reason}
													</p>
												</div>
											</div>
										</div>
									))}
								</div>
							</div>
						)}

						{/* Previously Managed Custom Formats */}
						{data.data.orphanedCustomFormats.length > 0 && (
							<div className="space-y-3">
								<h3 className="text-sm font-medium text-foreground">
									Managed Custom Formats Reset to Zero ({data.data.orphanedCustomFormats.length})
								</h3>
								<p className="text-xs text-muted-foreground">
									These formats are no longer in the template. Deployment will reset their scores to
									0.
								</p>
								<div className="max-h-48 space-y-2 overflow-y-auto">
									{data.data.orphanedCustomFormats.map((orphan, index) => (
										<div
											key={orphan.instanceId}
											className="flex items-center justify-between gap-4 rounded-xl border p-3"
											style={{
												backgroundColor: SEMANTIC_COLORS.warning.bg,
												borderColor: SEMANTIC_COLORS.warning.border,
											}}
										>
											<span className="min-w-0 truncate text-sm font-medium text-foreground">
												{incognitoMode ? `Orphaned Custom Format ${index + 1}` : orphan.name}
											</span>
											<span
												className="shrink-0 font-mono text-sm"
												style={{ color: SEMANTIC_COLORS.warning.text }}
											>
												{orphan.score} → 0
											</span>
										</div>
									))}
								</div>
							</div>
						)}

						{/* No Changes Message */}
						{!hasDeployableChanges && (
							<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-8 text-center">
								<CheckCircle2
									className="h-12 w-12 mx-auto mb-3"
									style={{ color: SEMANTIC_COLORS.success.from }}
								/>
								<p className="text-sm font-medium text-foreground">Instance is up to date</p>
								<p className="text-xs text-muted-foreground mt-1">
									No changes needed for this deployment
								</p>
							</div>
						)}
					</>
				)}
			</LegacyDialogContent>

			<LegacyDialogFooter>
				{displayedDeploymentMessage && (
					<div
						className="flex items-start gap-2 rounded-xl p-3 mr-auto"
						style={{
							backgroundColor: deploymentUncertain
								? SEMANTIC_COLORS.warning.bg
								: SEMANTIC_COLORS.error.bg,
							border: `1px solid ${deploymentUncertain ? SEMANTIC_COLORS.warning.border : SEMANTIC_COLORS.error.border}`,
						}}
					>
						<AlertTriangle
							className="h-5 w-5 mt-0.5 shrink-0"
							style={{
								color: deploymentUncertain
									? SEMANTIC_COLORS.warning.from
									: SEMANTIC_COLORS.error.from,
							}}
						/>
						<div>
							<p className="text-sm font-medium text-foreground">
								{deploymentUncertain ? "Deployment Result Needs Review" : "Deployment Failed"}
							</p>
							<p className="text-sm text-muted-foreground mt-1">{displayedDeploymentMessage}</p>
						</div>
					</div>
				)}
				<Button
					variant="ghost"
					onClick={onClose}
					disabled={deploymentMutation.isPending}
					className="rounded-xl"
				>
					Cancel
				</Button>
				<Button
					onClick={handleDeploy}
					disabled={
						!data?.data ||
						!data.data.canDeploy ||
						!hasDeployableChanges ||
						deploymentMutation.isPending
					}
					className="gap-2 rounded-xl font-medium"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
						boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
					}}
				>
					{deploymentMutation.isPending ? (
						<>
							<div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
							Deploying...
						</>
					) : (
						"Deploy to Instance"
					)}
				</Button>
			</LegacyDialogFooter>

			{/* Instance Override Editor Modal */}
			{showOverrideEditor && !incognitoMode && data?.data && templateId && instanceId && (
				<InstanceOverrideEditor
					open={showOverrideEditor}
					onClose={() => setShowOverrideEditor(false)}
					templateId={templateId}
					templateName={templateName}
					instanceId={instanceId}
					instanceLabel={instanceLabel}
					customFormats={data.data.customFormats.map((cf) => ({
						trashId: cf.trashId,
						name: cf.name,
						defaultScore: cf.defaultScore ?? 0,
						instanceOverrideScore: cf.instanceOverrideScore,
					}))}
				/>
			)}
		</LegacyDialog>
	);
};
