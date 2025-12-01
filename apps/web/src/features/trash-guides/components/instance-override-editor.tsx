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
import { Skeleton, Button } from "../../../components/ui";
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
import { toast } from "sonner";

interface CustomFormatOverrideRow {
	trashId: string;
	name: string;
	defaultScore: number; // Score from the template (TRaSH Guides default)
	overrideScore?: number; // Custom score for this instance (optional)
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
		defaultScore: number; // Original score from TRaSH Guides template
		instanceOverrideScore?: number; // Current instance-specific override (if any)
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
	const { data, isLoading, error, refetch } = useInstanceOverrides(templateId, instanceId);
	const updateMutation = useUpdateInstanceOverrides();
	const deleteMutation = useDeleteInstanceOverrides();

	const [editedOverrides, setEditedOverrides] = useState<CustomFormatOverrideRow[]>([]);
	const [hasChanges, setHasChanges] = useState(false);

	// Initialize edited overrides when data loads
	// Merge customFormats (default scores) with saved overrides from API
	useEffect(() => {
		if (customFormats.length > 0) {
			const overrides = data?.overrides || {};
			const scoreOverrides = overrides.scoreOverrides || {};
			const cfOverrides = overrides.cfOverrides || {};

			const rows: CustomFormatOverrideRow[] = customFormats.map((cf) => ({
				trashId: cf.trashId,
				name: cf.name,
				defaultScore: cf.defaultScore, // TRaSH Guides template default
				overrideScore: scoreOverrides[cf.trashId], // Saved instance override (if any)
				enabled: cfOverrides[cf.trashId]?.enabled ?? true,
			}));

			setEditedOverrides(rows);
			setHasChanges(false);
		}
	}, [data, customFormats]);

	const handleScoreChange = (trashId: string, value: string) => {
		// Parse the value with strict integer validation
		// Empty string means undefined (clear the override)
		// Only accept strings that match integer-only pattern
		let numValue: number | undefined;

		if (value === "") {
			numValue = undefined;
		} else if (/^-?\d+$/.test(value)) {
			// Valid integer pattern - convert and verify
			const parsed = Number(value);
			if (Number.isFinite(parsed) && Number.isInteger(parsed)) {
				numValue = parsed;
			} else {
				numValue = undefined;
			}
		} else {
			// Invalid input (contains decimals, letters, etc.)
			numValue = undefined;
		}

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
			// Only include score overrides that differ from default
			if (row.overrideScore !== undefined && row.overrideScore !== row.defaultScore) {
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
			// Refetch to ensure we have the latest data from the server
			await refetch();
			setHasChanges(false);
			toast.success("Instance overrides saved successfully");
		} catch (err) {
			console.error("Failed to save instance overrides:", err);
			toast.error("Failed to save instance overrides");
		}
	};

	const handleDeleteAll = async () => {
		if (!templateId || !instanceId) return;

		try {
			await deleteMutation.mutateAsync({ templateId, instanceId });
			// Refetch to ensure we have the latest data from the server
			await refetch();
			setEditedOverrides((prev) =>
				prev.map((row) => ({
					...row,
					overrideScore: undefined,
					enabled: true,
				})),
			);
			setHasChanges(false);
			toast.success("All instance overrides deleted");
		} catch (err) {
			console.error("Failed to delete instance overrides:", err);
			toast.error("Failed to delete instance overrides");
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
								<Button
									variant="secondary"
									size="sm"
									onClick={handleResetAll}
									disabled={updateMutation.isPending || totalOverrides === 0}
									title="Reset all to template defaults"
									className="gap-2"
								>
									<RotateCcw className="h-3 w-3" />
									Reset All
								</Button>
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
											<th className="text-center p-3 font-medium text-fg">Default Score</th>
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
														<span className="text-sm text-fg-muted">{row.defaultScore}</span>
													</td>
													<td className="p-3">
														<input
															type="number"
															value={row.overrideScore ?? ""}
															onChange={(e) => handleScoreChange(row.trashId, e.target.value)}
															placeholder={row.defaultScore.toString()}
															disabled={!row.enabled}
															className="w-20 px-2 py-1 text-center rounded border border-border bg-bg text-sm disabled:opacity-50 disabled:cursor-not-allowed"
														/>
													</td>
													<td className="p-3 text-center">
														<Button
															variant="ghost"
															size="sm"
															onClick={() => handleResetToBase(row.trashId)}
															disabled={!hasOverride}
															title="Reset to template default"
														>
															<RotateCcw className="h-3 w-3" />
														</Button>
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
									You have unsaved changes. Click &quot;Save Overrides&quot; to apply them.
								</p>
							</div>
						)}
					</>
				)}
			</DialogContent>

			<DialogFooter>
				<Button
					variant="danger"
					onClick={handleDeleteAll}
					disabled={deleteMutation.isPending || totalOverrides === 0}
					className="mr-auto gap-1"
					title="Delete all instance overrides"
				>
					<Trash2 className="h-4 w-4" />
					Delete All
				</Button>

				<Button variant="ghost" onClick={onClose}>
					{hasChanges ? "Cancel" : "Close"}
				</Button>

				<Button
					variant="primary"
					onClick={handleSave}
					disabled={!hasChanges || updateMutation.isPending}
					className="gap-2"
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
				</Button>
			</DialogFooter>
		</Dialog>
	);
};
