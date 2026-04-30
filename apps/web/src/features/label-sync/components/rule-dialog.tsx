"use client";

import type {
	CreateLabelSyncRuleRequest,
	LabelSyncDestService,
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
import { LABEL_SYNC_SERVICE_OPTIONS } from "../service-registry";

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
	destService: LabelSyncDestService;
	destInstanceId: string;
	destTagName: string;
}

const initialForm = (rule: LabelSyncRule | null): FormState => ({
	name: rule?.name ?? "",
	enabled: rule?.enabled ?? true,
	sourceService: rule?.sourceService ?? "sonarr",
	sourceInstanceId: rule?.sourceInstanceId ?? "",
	sourceTagName: rule?.sourceTagName ?? "",
	destService: rule?.destService ?? "plex",
	destInstanceId: rule?.destInstanceId ?? "",
	destTagName: rule?.destTagName ?? "",
});

export const RuleDialog = ({ rule, onClose }: RuleDialogProps) => {
	const isEdit = rule !== null;
	const [form, setForm] = useState<FormState>(initialForm(rule));
	const [submitError, setSubmitError] = useState<string | null>(null);

	const { data: services = [] } = useServicesQuery();

	// Pre-compute which services have at least one enabled instance so the
	// dropdowns can disable services the user can't actually pick.
	const enabledInstanceCountBySlug = useMemo(() => {
		const counts: Record<string, number> = {};
		for (const s of services as ServiceInstanceSummary[]) {
			if (!s.enabled) continue;
			const slug = s.service.toLowerCase();
			counts[slug] = (counts[slug] ?? 0) + 1;
		}
		return counts;
	}, [services]);

	const sourceInstances = useMemo(
		() =>
			(services as ServiceInstanceSummary[]).filter(
				(s) => s.service.toLowerCase() === form.sourceService && s.enabled,
			),
		[services, form.sourceService],
	);

	const destInstances = useMemo(
		() =>
			(services as ServiceInstanceSummary[]).filter(
				(s) => s.service.toLowerCase() === form.destService && s.enabled,
			),
		[services, form.destService],
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
			destService: form.destService,
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
						Apply a destination tag/label to items carrying a source tag/label. Source and
						destination services can differ or be the same — items are matched across services by
						TMDB ID.
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
								{LABEL_SYNC_SERVICE_OPTIONS.map((opt) => {
									const count = enabledInstanceCountBySlug[opt.matchSlug] ?? 0;
									const disabled = count === 0;
									return (
										<option
											key={opt.value}
											value={opt.value}
											disabled={disabled}
											title={disabled ? `No enabled ${opt.label} instance configured` : undefined}
										>
											{opt.label}
											{disabled ? " — none configured" : ""}
										</option>
									);
								})}
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
								{sourceInstances.map((s) => (
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
							The exact tag/label name as configured in the source service. Case-sensitive.
						</p>
					</div>

					{/* Destination service + instance */}
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<label htmlFor="dest-service" className="text-sm font-medium">
								Destination service
							</label>
							<select
								id="dest-service"
								value={form.destService}
								onChange={(e) => {
									update("destService", e.target.value as LabelSyncDestService);
									update("destInstanceId", "");
								}}
								className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
							>
								{LABEL_SYNC_SERVICE_OPTIONS.map((opt) => {
									const count = enabledInstanceCountBySlug[opt.matchSlug] ?? 0;
									const disabled = count === 0;
									return (
										<option
											key={opt.value}
											value={opt.value}
											disabled={disabled}
											title={disabled ? `No enabled ${opt.label} instance configured` : undefined}
										>
											{opt.label}
											{disabled ? " — none configured" : ""}
										</option>
									);
								})}
							</select>
						</div>
						<div className="space-y-1.5">
							<label htmlFor="dest-instance" className="text-sm font-medium">
								Destination instance
							</label>
							<select
								id="dest-instance"
								value={form.destInstanceId}
								onChange={(e) => update("destInstanceId", e.target.value)}
								className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
								required
							>
								<option value="">Select a {form.destService} instance…</option>
								{destInstances.map((s) => (
									<option key={s.id} value={s.id}>
										{s.label}
									</option>
								))}
							</select>
						</div>
					</div>

					{/* Destination tag/label */}
					<div className="space-y-1.5">
						<label htmlFor="dest-tag" className="text-sm font-medium">
							Destination tag/label
						</label>
						<Input
							id="dest-tag"
							value={form.destTagName}
							onChange={(e) => update("destTagName", e.target.value)}
							placeholder="e.g., Kids"
							maxLength={120}
							required
						/>
						<p className="text-xs text-muted-foreground">
							The tag/label to apply on the destination service. Created automatically on
							Sonarr/Radarr if it doesn't already exist.
						</p>
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
