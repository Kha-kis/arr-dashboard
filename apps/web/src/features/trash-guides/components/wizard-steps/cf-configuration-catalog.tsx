"use client";

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../../../components/ui";
import { SanitizedHtml } from "../sanitized-html";
import type { ThemeGradient } from "../../../../lib/theme-gradients";

interface CFSelection {
	selected: boolean;
	scoreOverride?: number;
	conditionsEnabled: Record<string, boolean>;
}

interface CatalogSectionProps {
	/** The full CF configuration data from the hook */
	data: any;
	/** Current user selections */
	selections: Record<string, CFSelection>;
	/** Toggle a CF on/off */
	onToggleCF: (trashId: string) => void;
	/** Update selection (for score overrides) */
	onUpdateSelection: (trashId: string, update: Partial<CFSelection>) => void;
	/** Resolve the score for a CF using the profile's score set */
	resolveScore: (cf: any, fallback?: number) => number;
}

// ---------- Additional Custom Formats ----------

interface AdditionalCFSectionProps extends CatalogSectionProps {}

export const AdditionalCFSection = ({
	data,
	selections,
	onToggleCF,
	onUpdateSelection,
	resolveScore,
}: AdditionalCFSectionProps) => {
	// Get all selected CFs that are NOT in mandatory or CF groups
	const mandatoryCFIds = new Set(data.mandatoryCFs?.map((cf: any) => cf.trash_id) || []);
	const cfGroupCFIds = new Set<string>();
	data.cfGroups?.forEach((group: any) => {
		group.custom_formats?.forEach((cf: any) => {
			const cfTrashId = typeof cf === 'string' ? cf : cf.trash_id;
			cfGroupCFIds.add(cfTrashId);
		});
	});

	const additionalCFs = Object.entries(selections)
		.filter(([trashId, sel]) =>
			sel?.selected &&
			!mandatoryCFIds.has(trashId) &&
			!cfGroupCFIds.has(trashId)
		)
		.map(([trashId]) => {
			const cf = data.availableFormats?.find((f: any) => f.trash_id === trashId);
			return cf ? { ...cf, trash_id: trashId } : null;
		})
		.filter(Boolean);

	if (additionalCFs.length === 0) return null;

	return (
		<div className="space-y-4">
			<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
				<h3 className="text-lg font-semibold text-foreground">
					<span className="flex flex-col sm:inline-flex sm:items-center sm:gap-2">
						<span>Additional Custom Formats</span>
						<span className="text-sm font-normal text-muted-foreground">
							(Custom formats you&apos;ve added from the catalog)
						</span>
					</span>
				</h3>
				<span className="text-sm text-muted-foreground whitespace-nowrap">
					{additionalCFs.length} format{additionalCFs.length !== 1 ? 's' : ''} added
				</span>
			</div>

			<Card className="border-green-500/30 bg-green-500/5">
				<CardHeader>
					<CardTitle className="text-base flex items-center gap-2">
						<span>✅ Your Additional Selections</span>
					</CardTitle>
					<CardDescription>
						These custom formats were manually added from the catalog. You can adjust scores or remove them.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="space-y-2">
						{additionalCFs.map((cf: any) => {
							const isSelected = selections[cf.trash_id]?.selected ?? false;
							const scoreOverride = selections[cf.trash_id]?.scoreOverride;
							const displayScore = resolveScore(cf, cf.score);

							return (
								<div
									key={cf.trash_id}
									className="rounded-lg p-4 border border-green-500/30 bg-green-500/10 transition-all hover:border-green-500/50 hover:bg-green-500/15 hover:shadow-md"
								>
									<div className="flex items-start gap-3">
										<input
											type="checkbox"
											checked={isSelected}
											onChange={() => onToggleCF(cf.trash_id)}
											className="mt-1 h-5 w-5 rounded border-border/50 bg-card text-green-500 focus:ring-2 focus:ring-green-500/50 cursor-pointer transition"
										/>
										<div className="flex-1">
											<div className="flex items-center gap-2 mb-2">
												<span className="font-medium text-foreground">{cf.displayName || cf.name}</span>
												<span className="inline-flex items-center gap-1 rounded bg-green-500/20 px-2 py-0.5 text-xs font-medium text-green-300">
													➕ Added
												</span>
											</div>

											{cf.description && (
												<details className="mb-2 group" onClick={(e) => e.stopPropagation()}>
													<summary className="cursor-pointer text-xs text-green-400 hover:text-green-300 transition flex items-center gap-1">
														<span className="group-open:rotate-90 transition-transform">▶</span>
														<span>What is this?</span>
													</summary>
													<div className="mt-2 pl-4 text-sm text-muted-foreground prose prose-invert prose-sm max-w-none">
														<SanitizedHtml html={cf.description} />
													</div>
												</details>
											)}

											<div className="flex items-center gap-3 flex-wrap">
												<div className="flex items-center gap-2">
													<label className="text-sm text-muted-foreground">TRaSH Score:</label>
													<span className="text-sm font-medium text-foreground">{displayScore}</span>
												</div>
												<div className="flex items-center gap-2">
													<label className="text-sm text-muted-foreground">Custom Score:</label>
													<input
														type="number"
														value={scoreOverride ?? ""}
														onChange={(e) => {
															const value = e.target.value === "" ? undefined : Number(e.target.value);
															onUpdateSelection(cf.trash_id, { scoreOverride: value });
														}}
														placeholder={`Default: ${displayScore}`}
														className="w-28 rounded border border-border bg-muted px-3 py-1.5 text-sm text-foreground focus:border-green-500 focus:outline-hidden focus:ring-1 focus:ring-green-500"
													/>
												</div>
												<span className="text-xs text-muted-foreground">
													(leave empty to use TRaSH score)
												</span>
											</div>
										</div>
									</div>
								</div>
							);
						})}
					</div>
				</CardContent>
			</Card>
		</div>
	);
};

// ---------- Browse All Custom Formats ----------

interface BrowseCFCatalogProps extends CatalogSectionProps {
	/** Current search query */
	searchQuery: string;
	/** Whether this is a cloned profile */
	isClonedProfile: boolean;
	/** Theme gradient for styling */
	themeGradient: ThemeGradient;
}

export const BrowseCFCatalog = ({
	data,
	selections,
	onToggleCF,
	onUpdateSelection,
	resolveScore,
	searchQuery,
	isClonedProfile,
	themeGradient,
}: BrowseCFCatalogProps) => {
	if (!data.availableFormats || data.availableFormats.length === 0) return null;

	const filterCF = (cf: any) => {
		// Hide formats already in template (mandatory or in groups)
		const isInMandatory = data.mandatoryCFs?.some((mandatoryCF: any) => mandatoryCF.trash_id === cf.trash_id);
		if (isInMandatory) return false;

		// Hide formats in CF groups
		const isInGroups = data.cfGroups?.some((group: any) =>
			group.custom_formats?.some((groupCF: any) =>
				(typeof groupCF === 'string' ? groupCF : groupCF.trash_id) === cf.trash_id
			)
		);
		if (isInGroups) return false;

		// Hide already selected formats
		const isSelected = selections[cf.trash_id]?.selected ?? false;
		if (isSelected) return false;

		// Apply search filter
		if (searchQuery) {
			const search = searchQuery.toLowerCase();
			return (
				cf.name?.toLowerCase().includes(search) ||
				cf.displayName?.toLowerCase().includes(search) ||
				cf.description?.toLowerCase().includes(search)
			);
		}

		return true;
	};

	const availableCount = data.availableFormats.filter(filterCF).length;

	return (
		<div className="space-y-4">
			<div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
				<h3 className="text-lg font-semibold text-foreground">
					<span className="flex flex-col sm:inline-flex sm:items-center sm:gap-2">
						<span>{isClonedProfile ? "Browse Instance Custom Formats" : "Browse All Custom Formats"}</span>
						<span className="text-sm font-normal text-muted-foreground">
							{isClonedProfile
								? "(Add additional formats from the instance's catalog)"
								: "(Add any additional custom formats to your template)"
							}
						</span>
					</span>
				</h3>
				<span className="text-sm text-muted-foreground whitespace-nowrap">
					{availableCount} formats available
				</span>
			</div>

			<Card
				className="border"
				style={isClonedProfile ? {
					borderColor: "rgb(59 130 246 / 0.3)",
					backgroundColor: "rgb(59 130 246 / 0.05)",
				} : {
					borderColor: themeGradient.fromMuted,
					backgroundColor: themeGradient.fromLight,
				}}
			>
				<CardHeader>
					<CardTitle className="text-base">
						{isClonedProfile ? "Instance Custom Formats Catalog" : "Additional Custom Formats Catalog"}
					</CardTitle>
					<CardDescription>
						{isClonedProfile
							? "Browse and select any additional custom formats from your instance. Formats already in your template are hidden."
							: "Browse and select any additional custom formats from the TRaSH Guides catalog. Formats already in your template are hidden."
						}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="space-y-2 max-h-96 overflow-y-auto">
						{data.availableFormats
							.filter(filterCF)
							.map((cf: any) => {
								const isSelected = selections[cf.trash_id]?.selected ?? false;
								const scoreOverride = selections[cf.trash_id]?.scoreOverride;
								const displayScore = resolveScore(cf, cf.score);

								return (
									<div
										key={cf.trash_id}
										className={`rounded-lg p-3 border border-border/50 bg-card transition-all hover:bg-muted hover:shadow-md cursor-pointer ${
											isClonedProfile ? "hover:border-blue-500/50" : "hover:border-purple-500/50"
										}`}
										onClick={() => onToggleCF(cf.trash_id)}
									>
										<div className="flex items-start gap-3">
											<input
												type="checkbox"
												checked={isSelected}
												onChange={() => onToggleCF(cf.trash_id)}
												className={`mt-1 h-4 w-4 rounded border-border bg-muted focus:ring-offset-0 cursor-pointer ${
													isClonedProfile ? "text-blue-500 focus:ring-blue-500" : "text-purple-500 focus:ring-purple-500"
												}`}
												onClick={(e) => e.stopPropagation()}
											/>
											<div className="flex-1">
												<div className="flex items-center gap-2 mb-2">
													<span className="font-medium text-foreground">{cf.displayName || cf.name}</span>
													<span className="text-xs text-muted-foreground">
														(Score: {displayScore})
													</span>
												</div>

												{cf.description && (
													<details className="mb-2 group" onClick={(e) => e.stopPropagation()}>
														<summary className={`cursor-pointer text-xs transition flex items-center gap-1 ${
															isClonedProfile ? "text-blue-400 hover:text-blue-300" : "text-purple-400 hover:text-purple-300"
														}`}>
															<span className="group-open:rotate-90 transition-transform">▶</span>
															<span>What is this?</span>
														</summary>
														<div className="mt-2 pl-4 text-sm text-muted-foreground prose prose-invert prose-sm max-w-none">
															<SanitizedHtml html={cf.description} />
														</div>
													</details>
												)}

												{isSelected && (
													<div className="flex items-center gap-2 mt-2">
														<label className="text-xs text-muted-foreground">Custom Score:</label>
														<input
															type="number"
															value={scoreOverride ?? ""}
															onChange={(e) => {
																const value = e.target.value === "" ? undefined : Number(e.target.value);
																onUpdateSelection(cf.trash_id, { scoreOverride: value });
															}}
															onClick={(e) => e.stopPropagation()}
															placeholder={`Default: ${displayScore}`}
															className={`w-24 rounded border border-border bg-muted px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 ${
																isClonedProfile ? "focus:border-blue-500 focus:ring-blue-500" : "focus:border-purple-500 focus:ring-purple-500"
															}`}
														/>
														<span className="text-xs text-muted-foreground">
															(leave empty for default: {displayScore})
														</span>
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
	);
};
