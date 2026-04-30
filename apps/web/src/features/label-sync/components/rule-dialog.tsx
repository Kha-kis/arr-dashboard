"use client";

import type {
	CreateLabelSyncRuleRequest,
	LabelSyncRule,
	LabelSyncSourceService,
	ServiceInstanceSummary,
} from "@arr/shared";
import { useMemo, useState } from "react";
import { Button } from "../../../components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { useCreateLabelSyncRule, useUpdateLabelSyncRule } from "../../../hooks/api/useLabelSync";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";

interface RuleDialogProps {
	rule: LabelSyncRule | null;
	onClose: () => void;
}

interface FormState {
	name: string;
	enabled: boolean;
	sourceService: LabelSyncSourceService;
	sourceInstanceId: string; // empty string means "all instances"
	sourceTagName: string;
	destInstanceId: string;
	destTagName: string;
}

const initialForm = (rule: LabelSyncRule | null): FormState => ({
	name: rule?.name ?? "",
	enabled: rule?.enabled ?? true,
	sourceService: rule?.sourceService ?? "sonarr",
	sourceInstanceId: rule?.sourceInstanceId ?? "",
	sourceTagName: rule?.sourceTagName ?? "",
	destInstanceId: rule?.destInstanceId ?? "",
	destTagName: rule?.destTagName ?? "",
});

export const RuleDialog = ({ rule, onClose }: RuleDialogProps) => {
	const isEdit = rule !== null;
	const [form, setForm] = useState<FormState>(initialForm(rule));
	const [submitError, setSubmitError] = useState<string | null>(null);

	const { data: services = [] } = useServicesQuery();
	const sourceInstances = useMemo(
		() =>
			services.filter(
				(s: ServiceInstanceSummary) => s.service.toLowerCase() === form.sourceService && s.enabled,
			),
		[services, form.sourceService],
	);
	const destInstances = useMemo(
		() =>
			services.filter(
				(s: ServiceInstanceSummary) => s.service.toLowerCase() === "plex" && s.enabled,
			),
		[services],
	);

	const createMutation = useCreateLabelSyncRule();
	const updateMutation = useUpdateLabelSyncRule();
	const isPending = createMutation.isPending || updateMutation.isPending;

	const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
		setForm((prev) => ({ ...prev, [key]: value }));
		setSubmitError(null);
	};

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setSubmitError(null);

		if (!form.name.trim() || !form.sourceTagName.trim() || !form.destTagName.trim()) {
			setSubmitError("Name, source tag, and destination label are required.");
			return;
		}
		if (!form.destInstanceId) {
			setSubmitError("Pick a destination instance to apply the label on.");
			return;
		}

		const payload: CreateLabelSyncRuleRequest = {
			name: form.name.trim(),
			enabled: form.enabled,
			sourceService: form.sourceService,
			sourceInstanceId: form.sourceInstanceId || null,
			sourceTagName: form.sourceTagName.trim(),
			destService: "plex",
			destInstanceId: form.destInstanceId,
			destTagName: form.destTagName.trim(),
		};

		try {
			if (isEdit && rule) {
				await updateMutation.mutateAsync({ id: rule.id, payload });
			} else {
				await createMutation.mutateAsync(payload);
			}
			onClose();
		} catch (err) {
			setSubmitError(err instanceof Error ? err.message : "Failed to save rule");
		}
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Edit Rule" : "New Label Sync Rule"}</DialogTitle>
					<DialogDescription>
						Maps a Sonarr or Radarr tag to a Plex label. Items carrying the source tag get the
						destination label applied to their matching item (matched by TMDB ID).
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="space-y-4">
					{/* Name + enabled */}
					<div className="space-y-1.5">
						<label htmlFor="rule-name" className="text-sm font-medium">
							Rule name
						</label>
						<Input
							id="rule-name"
							value={form.name}
							onChange={(e) => update("name", e.target.value)}
							placeholder="e.g., Kids content"
							maxLength={120}
							required
						/>
					</div>

					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={form.enabled}
							onChange={(e) => update("enabled", e.target.checked)}
							className="h-4 w-4"
						/>
						<span>Enabled</span>
					</label>

					{/* Source service + instance */}
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<label htmlFor="source-service" className="text-sm font-medium">
								Source service
							</label>
							<select
								id="source-service"
								value={form.sourceService}
								onChange={(e) => {
									update("sourceService", e.target.value as LabelSyncSourceService);
									update("sourceInstanceId", ""); // reset instance when service changes
								}}
								className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
							>
								<option value="sonarr">Sonarr</option>
								<option value="radarr">Radarr</option>
							</select>
						</div>
						<div className="space-y-1.5">
							<label htmlFor="source-instance" className="text-sm font-medium">
								Source instance
							</label>
							<select
								id="source-instance"
								value={form.sourceInstanceId}
								onChange={(e) => update("sourceInstanceId", e.target.value)}
								className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
							>
								<option value="">All {form.sourceService} instances</option>
								{sourceInstances.map((s: ServiceInstanceSummary) => (
									<option key={s.id} value={s.id}>
										{s.label}
									</option>
								))}
							</select>
						</div>
					</div>

					{/* Source tag name */}
					<div className="space-y-1.5">
						<label htmlFor="source-tag" className="text-sm font-medium">
							Source tag name
						</label>
						<Input
							id="source-tag"
							value={form.sourceTagName}
							onChange={(e) => update("sourceTagName", e.target.value)}
							placeholder="e.g., kids"
							maxLength={120}
							required
						/>
						<p className="text-xs text-muted-foreground">
							The exact tag name as configured in the source service. Case-sensitive.
						</p>
					</div>

					{/* Dest instance + label */}
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<label htmlFor="dest-instance" className="text-sm font-medium">
								Destination (Plex)
							</label>
							<select
								id="dest-instance"
								value={form.destInstanceId}
								onChange={(e) => update("destInstanceId", e.target.value)}
								className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
								required
							>
								<option value="">Select a Plex instance…</option>
								{destInstances.map((s: ServiceInstanceSummary) => (
									<option key={s.id} value={s.id}>
										{s.label}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-1.5">
							<label htmlFor="dest-tag" className="text-sm font-medium">
								Destination label
							</label>
							<Input
								id="dest-tag"
								value={form.destTagName}
								onChange={(e) => update("destTagName", e.target.value)}
								placeholder="e.g., Kids"
								maxLength={120}
								required
							/>
						</div>
					</div>

					{submitError && (
						<div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-500">
							{submitError}
						</div>
					)}

					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose} disabled={isPending}>
							Cancel
						</Button>
						<Button type="submit" disabled={isPending}>
							{isPending ? "Saving…" : isEdit ? "Save changes" : "Create rule"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
};
