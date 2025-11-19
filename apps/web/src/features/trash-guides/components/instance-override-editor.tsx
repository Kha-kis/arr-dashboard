"use client";

import { useState, useEffect } from "react";
import {
	Dialog,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogContent,
	DialogFooter,
} from "../../../components/ui/dialog";
import { Skeleton } from "../../../components/ui";
import {
	AlertCircle,
	Settings,
	RotateCcw,
	Save,
	Trash2,
	CheckCircle2,
} from "lucide-react";
import {
	useInstanceOverrides,
	useUpdateInstanceOverrides,
	useDeleteInstanceOverrides,
} from "../../../hooks/api/useInstanceOverrides";
import { cn } from "../../../lib/utils";

interface CustomFormatOverrideRow {
	trashId: string;
	name: string;
	baseScore: number;
	overrideScore?: number;
	enabled: boolean;
}

interface InstanceOverrideEditorProps {
	open: boolean;
	onClose: () => void;
	templateId: string | null;
	templateName?: string;
	instanceId: string | null;
	instanceLabel?: string;
	customFormats: Array<{
		trashId: string;
		name: string;
		scoreOverride: number;
	}>;
}

export const InstanceOverrideEditor = ({
	open,
	onClose,
	templateId,
	templateName,
	instanceId,
	instanceLabel,
	customFormats,
}: InstanceOverrideEditorProps) => {
	const { data, isLoading, error } = useInstanceOverrides(templateId, instanceId);
	const updateMutation = useUpdateInstanceOverrides();
	const deleteMutation = useDeleteInstanceOverrides();

	const [editedOverrides, setEditedOverrides] = useState<CustomFormatOverrideRow[]>([]);
	const [hasChanges, setHasChanges] = useState(false);

	// Initialize edited overrides when data loads
	useEffect(() => {
		if (data && customFormats.length > 0) {
			const overrides = data.overrides || {};
			const scoreOverrides = overrides.scoreOverrides || {};
			const cfOverrides = overrides.cfOverrides || {};

			const rows: CustomFormatOverrideRow[] = customFormats.map((cf) => ({
				trashId: cf.trashId,
				name: cf.name,
				baseScore: cf.scoreOverride,
				overrideScore: scoreOverrides[cf.trashId],
				enabled: cfOverrides[cf.trashId]?.enabled ?? true,
			}));

			setEditedOverrides(rows);
			setHasChanges(false);
		}
	}, [data, customFormats]);

	const handleScoreChange = (trashId: string, value: string) => {
		const numValue = value === "" ? undefined : Number.parseInt(value, 10);

		setEditedOverrides((prev) =>
			prev.map((row) =>
				row.trashId === trashId
					? { ...row, overrideScore: numValue }
					: row,
			),
		);
		setHasChanges(true);
	};

	const handleEnabledChange = (trashId: string, enabled: boolean) => {
		setEditedOverrides((prev) =>
			prev.map((row) =>
				row.trashId === trashId ? { ...row, enabled } : row,
			),
		);
		setHasChanges(true);
	};

	const handleResetToBase = (trashId: string) => {
		setEditedOverrides((prev) =>
			prev.map((row) =>
				row.trashId === trashId
					? { ...row, overrideScore: undefined, enabled: true }
					: row,
			),
		);
		setHasChanges(true);
	};

	const handleResetAll = () => {
		setEditedOverrides((prev) =>
			prev.map((row) => ({
				...row,
				overrideScore: undefined,
				enabled: true,
			})),
		);
		setHasChanges(true);
	};

	const handleSave = async () => {
		if (!templateId || !instanceId) return;

		const scoreOverrides: Record<string, number> = {};
		const cfOverrides: Record<string, { enabled: boolean }> = {};

		for (const row of editedOverrides) {
			// Only include score overrides that differ from base
			if (row.overrideScore !== undefined && row.overrideScore !== row.baseScore) {
				scoreOverrides[row.trashId] = row.overrideScore;
			}

			// Only include CF overrides if disabled
			if (!row.enabled) {
				cfOverrides[row.trashId] = { enabled: false };
			}
		}

		try {
			await updateMutation.mutateAsync({
				templateId,
				instanceId,
				payload: {
					scoreOverrides: Object.keys(scoreOverrides).length > 0 ? scoreOverrides : undefined,
					cfOverrides: Object.keys(cfOverrides).length > 0 ? cfOverrides : undefined,
				},
			});
			setHasChanges(false);
		} catch (err) {
			console.error("Failed to save instance overrides:", err);
		}
	};

	const handleDeleteAll = async () => {
		if (!templateId || !instanceId) return;

		try {
			await deleteMutation.mutateAsync({ templateId, instanceId });
			setEditedOverrides((prev) =>
				prev.map((row) => ({
					...row,
					overrideScore: undefined,
					enabled: true,
				})),
			);
			setHasChanges(false);
		} catch (err) {
			console.error("Failed to delete instance overrides:", err);
		}
	};

	const totalOverrides = editedOverrides.filter(
		(row) => row.overrideScore !== undefined || !row.enabled,
	).length;

	return (
		<Dialog open={open} onOpenChange={onClose} size="xl">
			<DialogHeader>
				<DialogTitle>
					<div className="flex items-center gap-2">
						<Settings className="h-5 w-5" />
						Instance Overrides
					</div>
				</DialogTitle>
				<DialogDescription>
					Customize Custom Format scores and enable/disable CFs for this instance
					{templateName && ` - Template: "${templateName}"`}
					{instanceLabel && ` → Instance: "${instanceLabel}"`}
				</DialogDescription>
			</DialogHeader>

			<DialogContent className="space-y-4">
				{isLoading && (
					<div className="space-y-4">
						<Skeleton className="h-12 w-full" />
						<Skeleton className="h-64 w-full" />
					</div>
				)}

				{error && (
					<div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4">
						<div className="flex items-start gap-3">
							<AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
							<div>
								<p className="text-sm font-medium text-fg">
									Failed to load instance overrides
								</p>
								<p className="text-sm text-fg-muted mt-1">
									{error instanceof Error ? error.message : "Please try again"}
								</p>
							</div>
						</div>
					</div>
				)}

				{data && editedOverrides.length > 0 && (
					<>
						{/* Summary Stats */}
						<div className="rounded-lg border border-border bg-bg-subtle p-4">
							<div className="flex items-center justify-between">
								<div>
									<p className="text-sm font-medium text-fg">
										Active Overrides: {totalOverrides} / {editedOverrides.length}
									</p>
									<p className="text-xs text-fg-muted mt-1">
										Customize scores and enable/disable Custom Formats for this instance only
									</p>
								</div>
								<button
									type="button"
									onClick={handleResetAll}
									disabled={updateMutation.isPending || totalOverrides === 0}
									className="flex items-center gap-2 rounded bg-white/10 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/20 disabled:opacity-50"
									title="Reset all to template defaults"
								>
									<RotateCcw className="h-3 w-3" />
									Reset All
								</button>
							</div>
						</div>

						{/* Custom Format Override Table */}
						<div className="space-y-2">
							<h3 className="text-sm font-medium text-fg">Custom Format Overrides</h3>
							<div className="max-h-96 overflow-y-auto border border-border rounded-lg">
								<table className="w-full text-sm">
									<thead className="bg-bg-subtle sticky top-0">
										<tr>
											<th className="text-left p-3 font-medium text-fg">Enabled</th>
											<th className="text-left p-3 font-medium text-fg">Custom Format</th>
											<th className="text-center p-3 font-medium text-fg">Base Score</th>
											<th className="text-center p-3 font-medium text-fg">Override Score</th>
											<th className="text-center p-3 font-medium text-fg">Actions</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-border">
										{editedOverrides.map((row) => {
											const hasOverride = row.overrideScore !== undefined || !row.enabled;
											return (
												<tr
													key={row.trashId}
													className={cn(
														"transition",
														hasOverride && "bg-primary/5",
													)}
												>
													<td className="p-3">
														<input
															type="checkbox"
															checked={row.enabled}
															onChange={(e) => handleEnabledChange(row.trashId, e.target.checked)}
															className="w-4 h-4 rounded border-border"
														/>
													</td>
													<td className="p-3">
														<span className={cn(
															"text-sm",
															!row.enabled && "text-fg-muted line-through",
														)}>
															{row.name}
														</span>
													</td>
													<td className="p-3 text-center">
														<span className="text-sm text-fg-muted">{row.baseScore}</span>
													</td>
													<td className="p-3">
														<input
															type="number"
															value={row.overrideScore ?? ""}
															onChange={(e) => handleScoreChange(row.trashId, e.target.value)}
															placeholder={row.baseScore.toString()}
															disabled={!row.enabled}
															className="w-20 px-2 py-1 text-center rounded border border-border bg-bg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
														/>
													</td>
													<td className="p-3 text-center">
														<button
															type="button"
															onClick={() => handleResetToBase(row.trashId)}
															disabled={!hasOverride}
															className="inline-flex items-center gap-1 rounded bg-white/10 px-2 py-1 text-xs font-medium text-white transition hover:bg-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
															title="Reset to template default"
														>
															<RotateCcw className="h-3 w-3" />
														</button>
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						</div>

						{/* Changes Indicator */}
						{hasChanges && (
							<div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
								<p className="text-sm text-amber-700 dark:text-amber-300">
									You have unsaved changes. Click "Save Overrides" to apply them.
								</p>
							</div>
						)}
					</>
				)}
			</DialogContent>

			<DialogFooter>
				<button
					type="button"
					onClick={handleDeleteAll}
					disabled={deleteMutation.isPending || totalOverrides === 0}
					className="mr-auto px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 transition-colors disabled:opacity-50"
					title="Delete all instance overrides"
				>
					<Trash2 className="inline h-4 w-4 mr-1" />
					Delete All
				</button>

				<button
					type="button"
					onClick={onClose}
					className="px-4 py-2 text-sm font-medium text-fg-muted hover:text-fg transition-colors"
				>
					{hasChanges ? "Cancel" : "Close"}
				</button>

				<button
					type="button"
					onClick={handleSave}
					disabled={!hasChanges || updateMutation.isPending}
					className="px-4 py-2 text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors flex items-center gap-2"
				>
					{updateMutation.isPending ? (
						<>
							<div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
							Saving...
						</>
					) : (
						<>
							<Save className="h-4 w-4" />
							Save Overrides
						</>
					)}
				</button>
			</DialogFooter>
		</Dialog>
	);
};
