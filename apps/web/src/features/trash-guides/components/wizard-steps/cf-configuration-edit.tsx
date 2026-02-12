/**
 * CF Configuration - Edit Mode
 *
 * Renders the edit-mode UI for modifying existing template configurations.
 * This is a render-only component extracted from cf-configuration.tsx.
 *
 * Security: All HTML content is sanitized via SanitizedHtml component (DOMPurify wrapper).
 */

"use client";

import {
	Alert,
	AlertDescription,
	Card,
	CardHeader,
	CardTitle,
	CardDescription,
	CardContent,
} from "../../../../components/ui";
import {
	ChevronLeft,
	ChevronRight,
	Info,
	Settings,
} from "lucide-react";
import { SanitizedHtml } from "../sanitized-html";
import { useThemeGradient } from "../../../../hooks/useThemeGradient";
import { ConditionEditor } from "../condition-editor";

interface CFSelectionState {
	selected: boolean;
	scoreOverride?: number;
	conditionsEnabled: Record<string, boolean>;
}

interface ConditionEditorTarget {
	trashId: string;
	format: any;
}

interface CFConfigurationEditProps {
	qualityProfile: { name: string };
	selections: Record<string, CFSelectionState>;
	onSelectionsChange: React.Dispatch<
		React.SetStateAction<Record<string, CFSelectionState>>
	>;
	selectedCount: number;
	mandatoryCFs: any[];
	cfGroups: any[];
	availableFormats?: any[];
	searchQuery: string;
	onToggleCF: (cfTrashId: string, isRequired?: boolean) => void;
	onUpdateScore: (cfTrashId: string, score: string) => void;
	resolveScore: (cf: any, fallback?: number) => number;
	onNext: () => void;
	onBack?: () => void;
	conditionEditorFormat: ConditionEditorTarget | null;
	onConditionEditorOpen: (target: ConditionEditorTarget) => void;
	onConditionEditorClose: () => void;
}

const EditCFCard = ({
	cf,
	isFromProfile,
	selection,
	themeGradient,
	resolveScore,
	onToggle,
	onUpdateScore,
	onOpenConditionEditor,
}: {
	cf: any;
	isFromProfile: boolean;
	selection: CFSelectionState | undefined;
	themeGradient: { from: string; fromLight: string };
	resolveScore: (cf: any, fallback?: number) => number;
	onToggle: () => void;
	onUpdateScore: (score: string) => void;
	onOpenConditionEditor: () => void;
}) => {
	const scoreOverride = selection?.scoreOverride;
	const isRequired = cf.required === true;
	const resolvedDefaultScore = resolveScore(cf, cf.defaultScore ?? cf.score);

	return (
		<div className="rounded-lg p-4 border border-border/50 bg-card transition-all hover:border-primary/50 hover:shadow-md">
			<div className="flex items-start gap-3">
				<input
					type="checkbox"
					checked={selection?.selected ?? false}
					onChange={onToggle}
					className="mt-1 h-5 w-5 rounded border-border/50 bg-card text-primary focus:ring-2 focus:ring-primary/50 cursor-pointer transition"
				/>
				<div className="flex-1">
					<div className="flex items-center gap-2 mb-2">
						<span className="font-medium text-foreground">
							{cf.displayName || cf.name}
						</span>
						{isRequired && (
							<span
								className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300"
								title="TRaSH Guides recommends this CF as required"
							>
								⭐ TRaSH Required
							</span>
						)}
						{isFromProfile && !isRequired && (
							<span className="inline-flex items-center gap-1 rounded bg-green-500/20 px-2 py-0.5 text-xs font-medium text-green-300">
								From Profile
							</span>
						)}
						{scoreOverride !== undefined && (
							<span
								className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium"
								style={{
									backgroundColor: themeGradient.fromLight,
									color: themeGradient.from,
								}}
							>
								Custom Score
							</span>
						)}
					</div>

					<div className="space-y-2">
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<span>
								Current: {scoreOverride ?? resolvedDefaultScore}
							</span>
							{cf.originalConfig?.trash_scores && (
								<span>
									• TRaSH Default: {resolvedDefaultScore}
								</span>
							)}
						</div>

						<div className="flex items-center gap-2 flex-wrap">
							<button
								type="button"
								onClick={onOpenConditionEditor}
								className="inline-flex items-center gap-1 rounded bg-card px-2 py-1 text-xs font-medium text-foreground transition hover:bg-muted"
								title="Advanced condition editing"
							>
								<Settings className="h-3 w-3" />
								Advanced
							</button>
							<label className="text-sm text-muted-foreground">
								Override Score:
							</label>
							<input
								type="number"
								value={scoreOverride ?? ""}
								onChange={(e) => onUpdateScore(e.target.value)}
								placeholder={resolvedDefaultScore.toString()}
								className="w-20 rounded border border-border/50 bg-background px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary/50 transition"
							/>
							{scoreOverride !== undefined && (
								<button
									type="button"
									onClick={() => onUpdateScore("")}
									className="text-xs text-primary hover:text-primary/80 transition"
									title="Reset to template default"
								>
									↺ Reset
								</button>
							)}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
};

export const CFConfigurationEdit = ({
	qualityProfile,
	selections,
	onSelectionsChange,
	selectedCount,
	mandatoryCFs,
	cfGroups,
	availableFormats,
	searchQuery,
	onToggleCF,
	onUpdateScore,
	resolveScore,
	onNext,
	onBack,
	conditionEditorFormat,
	onConditionEditorOpen,
	onConditionEditorClose,
}: CFConfigurationEditProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	// Separate profile CFs from additional CFs
	const profileCFIds = new Set(mandatoryCFs.map((cf: any) => cf.trash_id));
	const profileCFs = mandatoryCFs.filter(
		(cf: any) => selections[cf.trash_id]?.selected,
	);

	const additionalCFs = Object.entries(selections)
		.filter(
			([trashId, sel]) => sel?.selected && !profileCFIds.has(trashId),
		)
		.map(([trashId]) => {
			for (const group of cfGroups) {
				const foundCF = group.custom_formats?.find(
					(c: any) =>
						(typeof c === "string" ? c : c.trash_id) === trashId,
				);
				if (foundCF) {
					return typeof foundCF === "string"
						? { trash_id: foundCF, name: foundCF }
						: foundCF;
				}
			}

			if (availableFormats) {
				const foundInAvailable = availableFormats.find(
					(cf: any) => cf.trash_id === trashId,
				);
				if (foundInAvailable) {
					const resolvedScore = resolveScore(foundInAvailable);
					return {
						trash_id: foundInAvailable.trash_id,
						name: foundInAvailable.name,
						displayName: foundInAvailable.displayName,
						description: foundInAvailable.description,
						score: resolvedScore,
						defaultScore: resolvedScore,
						originalConfig: foundInAvailable.originalConfig,
					};
				}
			}

			return { trash_id: trashId, name: trashId };
		});

	return (
		<div className="space-y-6 animate-in fade-in duration-500">
			{/* Header */}
			<Card className="border-primary/30 bg-primary/5">
				<CardHeader>
					<CardTitle>Edit Template Configuration</CardTitle>
					<CardDescription>
						Modify custom formats from the quality profile or add
						additional formats. {selectedCount} custom formats
						selected.
					</CardDescription>
				</CardHeader>
			</Card>

			{/* Quality Profile CFs */}
			<div className="space-y-3">
				<div className="flex items-center justify-between">
					<h3 className="text-lg font-medium text-foreground">
						Quality Profile Custom Formats
					</h3>
					<span className="text-sm text-muted-foreground">
						{profileCFs.length} formats
					</span>
				</div>
				<p className="text-sm text-muted-foreground">
					These custom formats come from the TRaSH Guides quality
					profile &quot;{qualityProfile.name}&quot;. You can adjust
					scores or disable them.
				</p>

				{profileCFs.length > 0 ? (
					<div className="space-y-2">
						{profileCFs.map((cf: any) => (
							<EditCFCard
								key={cf.trash_id}
								cf={cf}
								isFromProfile={true}
								selection={selections[cf.trash_id]}
								themeGradient={themeGradient}
								resolveScore={resolveScore}
								onToggle={() =>
									onToggleCF(
										cf.trash_id,
										cf.required === true,
									)
								}
								onUpdateScore={(score) =>
									onUpdateScore(cf.trash_id, score)
								}
								onOpenConditionEditor={() =>
									onConditionEditorOpen({
										trashId: cf.trash_id,
										format: cf,
									})
								}
							/>
						))}
					</div>
				) : (
					<Alert>
						<Info className="h-4 w-4" />
						<AlertDescription>
							All quality profile formats have been removed. Click
							&quot;Add More Formats&quot; to browse available
							formats.
						</AlertDescription>
					</Alert>
				)}
			</div>

			{/* Additional CFs */}
			{additionalCFs.length > 0 && (
				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<h3 className="text-lg font-medium text-foreground">
							Additional Custom Formats
						</h3>
						<span className="text-sm text-muted-foreground">
							{additionalCFs.length} formats
						</span>
					</div>
					<p className="text-sm text-muted-foreground">
						These custom formats were added beyond the quality
						profile&apos;s defaults.
					</p>

					<div className="space-y-2">
						{additionalCFs.map((cf: any) => (
							<EditCFCard
								key={cf.trash_id}
								cf={cf}
								isFromProfile={false}
								selection={selections[cf.trash_id]}
								themeGradient={themeGradient}
								resolveScore={resolveScore}
								onToggle={() =>
									onToggleCF(
										cf.trash_id,
										cf.required === true,
									)
								}
								onUpdateScore={(score) =>
									onUpdateScore(cf.trash_id, score)
								}
								onOpenConditionEditor={() =>
									onConditionEditorOpen({
										trashId: cf.trash_id,
										format: cf,
									})
								}
							/>
						))}
					</div>
				</div>
			)}

			{/* Browse Custom Formats Section */}
			{availableFormats && (
				<div className="space-y-4">
					<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
						<h3 className="text-lg font-semibold text-foreground">
							<span className="flex flex-col sm:inline-flex sm:items-center sm:gap-2">
								<span>Browse Custom Formats</span>
								<span className="text-sm font-normal text-muted-foreground">
									(Add additional custom formats to your
									template)
								</span>
							</span>
						</h3>
						<span className="text-sm text-muted-foreground whitespace-nowrap">
							{availableFormats.length} formats available
						</span>
					</div>

					<Card
						className="border"
						style={{
							borderColor: themeGradient.fromMuted,
							backgroundColor: themeGradient.fromLight,
						}}
					>
						<CardHeader>
							<CardTitle className="text-base">
								Available Custom Formats
							</CardTitle>
							<CardDescription>
								Select additional custom formats to add to your
								template. Formats already in your template are
								hidden.
							</CardDescription>
						</CardHeader>
						<CardContent>
							<div className="space-y-2">
								{availableFormats
									.filter((cf: any) => {
										const isInTemplate =
											mandatoryCFs?.some(
												(mandatoryCF: any) =>
													mandatoryCF.trash_id ===
													cf.trash_id,
											);
										if (isInTemplate) return false;

										const isSelected =
											selections[cf.trash_id]
												?.selected ?? false;
										if (isSelected) return false;
										if (searchQuery) {
											const search =
												searchQuery.toLowerCase();
											return (
												cf.name
													?.toLowerCase()
													.includes(search) ||
												cf.displayName
													?.toLowerCase()
													.includes(search) ||
												cf.description
													?.toLowerCase()
													.includes(search)
											);
										}
										return true;
									})
									.map((cf: any) => {
										const isSelected =
											selections[cf.trash_id]
												?.selected ?? false;
										const scoreOverride =
											selections[cf.trash_id]
												?.scoreOverride;
										const displayScore = resolveScore(
											cf,
											cf.score,
										);
										const isRequired =
											cf.required === true;
										return (
											<div
												key={cf.trash_id}
												className="rounded-lg p-4 border border-border/50 bg-card transition-all hover:border-primary/50 hover:bg-muted hover:shadow-md cursor-pointer"
												role="button"
												tabIndex={0}
												onClick={() =>
													onToggleCF(
														cf.trash_id,
														isRequired,
													)
												}
												onKeyDown={(e) => {
													if (
														e.key === "Enter" ||
														e.key === " "
													) {
														e.preventDefault();
														onToggleCF(
															cf.trash_id,
															isRequired,
														);
													}
												}}
												aria-pressed={isSelected}
												aria-label={`${isSelected ? "Deselect" : "Select"} custom format: ${cf.displayName || cf.name}`}
											>
												<div className="flex items-start gap-3">
													<input
														type="checkbox"
														checked={isSelected}
														onChange={() =>
															onToggleCF(
																cf.trash_id,
																isRequired,
															)
														}
														className="mt-1 h-4 w-4 rounded border-border bg-muted text-primary focus:ring-primary focus:ring-offset-0 cursor-pointer"
														onClick={(e) =>
															e.stopPropagation()
														}
													/>
													<div className="flex-1">
														<div className="flex items-center gap-2 mb-2">
															<span className="font-medium text-foreground">
																{cf.displayName ||
																	cf.name}
															</span>
														</div>
														{cf.description && (
															<details
																className="mb-2 group"
																onClick={(e) =>
																	e.stopPropagation()
																}
															>
																<summary className="cursor-pointer text-xs text-primary hover:text-primary/80 transition flex items-center gap-1">
																	<span className="group-open:rotate-90 transition-transform">
																		▶
																	</span>
																	<span>
																		What is
																		this?
																	</span>
																</summary>
																<SanitizedHtml
																	html={cf.description}
																	className="mt-2 pl-4 text-sm text-muted-foreground prose prose-invert prose-sm max-w-none"
																/>
															</details>
														)}
														{isSelected && (
															<div className="flex items-center gap-2">
																<label className="text-xs text-muted-foreground">
																	Score
																	(Default:{" "}
																	{displayScore}
																	):
																</label>
																<input
																	type="number"
																	value={
																		scoreOverride ??
																		""
																	}
																	onChange={(
																		e,
																	) =>
																		onUpdateScore(
																			cf.trash_id,
																			e
																				.target
																				.value,
																		)
																	}
																	placeholder={String(
																		displayScore,
																	)}
																	className="w-24 rounded border border-border bg-muted px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary"
																	onClick={(
																		e,
																	) =>
																		e.stopPropagation()
																	}
																/>
																{scoreOverride !==
																	undefined && (
																	<button
																		type="button"
																		onClick={(
																			e,
																		) => {
																			e.stopPropagation();
																			onUpdateScore(
																				cf.trash_id,
																				"",
																			);
																		}}
																		className="text-xs text-primary hover:text-primary/80 transition"
																		title="Reset to default"
																	>
																		↺ Reset
																	</button>
																)}
															</div>
														)}
													</div>
												</div>
											</div>
										);
									})}
							</div>
						</CardContent>
					</Card>
				</div>
			)}

			{/* Navigation */}
			<div className="flex items-center justify-between border-t border-border/50 pt-6">
				{onBack && (
					<button
						type="button"
						onClick={onBack}
						className="inline-flex items-center gap-2 rounded-lg bg-muted px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted/80"
					>
						<ChevronLeft className="h-4 w-4" />
						Back
					</button>
				)}
				<div className="flex-1" />
				<button
					type="button"
					onClick={onNext}
					disabled={selectedCount === 0}
					className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
				>
					Continue to Review
					<ChevronRight className="h-4 w-4" />
				</button>
			</div>

			{/* Condition Editor Modal */}
			{conditionEditorFormat &&
				(() => {
					const selection =
						selections[conditionEditorFormat.trashId];

					const format = conditionEditorFormat.format as any;
					const specs =
						format.originalConfig?.specifications ||
						format.specifications ||
						[];

					const specificationsWithEnabled = specs.map(
						(spec: any) => ({
							...spec,
							enabled:
								selection?.conditionsEnabled?.[spec.name] !==
								false,
						}),
					);

					return (
						<div
							className="fixed inset-0 z-popover flex items-center justify-center bg-background/80 backdrop-blur-xs"
							role="dialog"
							aria-modal="true"
							aria-label="Condition Editor"
						>
							<div className="relative w-full max-w-4xl max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-card p-6">
								<button
									type="button"
									onClick={onConditionEditorClose}
									className="absolute top-4 right-4 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground z-10"
									aria-label="Close"
								>
									<svg
										className="h-5 w-5"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											strokeLinecap="round"
											strokeLinejoin="round"
											strokeWidth={2}
											d="M6 18L18 6M6 6l12 12"
										/>
									</svg>
								</button>

								<ConditionEditor
									customFormatId={
										conditionEditorFormat.trashId
									}
									customFormatName={
										(conditionEditorFormat.format as any)
											.displayName ||
										(conditionEditorFormat.format as any)
											.name
									}
									specifications={specificationsWithEnabled}
									onChange={(updatedSpecs: any) => {
										const conditionsEnabled: Record<
											string,
											boolean
										> = {};
										for (const spec of updatedSpecs) {
											conditionsEnabled[spec.name] =
												spec.enabled !== false;
										}
										onSelectionsChange((prev) => {
											const current = prev[
												conditionEditorFormat.trashId
											] || {
												selected: true,
												conditionsEnabled: {},
											};
											return {
												...prev,
												[conditionEditorFormat.trashId]:
													{
														...current,
														conditionsEnabled,
													},
											};
										});
									}}
								/>
							</div>
						</div>
					);
				})()}
		</div>
	);
};
