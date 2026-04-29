"use client";

import type {
	ArrServiceForLabelSync,
	CreatePlexLabelSyncRuleRequest,
	PlexLabelSyncRule,
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
import {
	useCreatePlexLabelSyncRule,
	useUpdatePlexLabelSyncRule,
} from "../../../hooks/api/usePlexLabelSync";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";

interface RuleDialogProps {
	rule: PlexLabelSyncRule | null;
	onClose: () => void;
}

interface FormState {
	name: string;
	enabled: boolean;
	arrService: ArrServiceForLabelSync;
	arrInstanceId: string; // empty string means "all instances"
	arrTagName: string;
	plexInstanceId: string;
	plexLabel: string;
}

const initialForm = (rule: PlexLabelSyncRule | null): FormState => ({
	name: rule?.name ?? "",
	enabled: rule?.enabled ?? true,
	arrService: rule?.arrService ?? "sonarr",
	arrInstanceId: rule?.arrInstanceId ?? "",
	arrTagName: rule?.arrTagName ?? "",
	plexInstanceId: rule?.plexInstanceId ?? "",
	plexLabel: rule?.plexLabel ?? "",
});

export const RuleDialog = ({ rule, onClose }: RuleDialogProps) => {
	const isEdit = rule !== null;
	const [form, setForm] = useState<FormState>(initialForm(rule));
	const [submitError, setSubmitError] = useState<string | null>(null);

	const { data: services = [] } = useServicesQuery();
	const arrInstances = useMemo(
		() => services.filter((s) => s.service.toLowerCase() === form.arrService && s.enabled),
		[services, form.arrService],
	);
	const plexInstances = useMemo(
		() => services.filter((s) => s.service.toLowerCase() === "plex" && s.enabled),
		[services],
	);

	const createMutation = useCreatePlexLabelSyncRule();
	const updateMutation = useUpdatePlexLabelSyncRule();
	const isPending = createMutation.isPending || updateMutation.isPending;

	const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
		setForm((prev) => ({ ...prev, [key]: value }));
		setSubmitError(null);
	};

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setSubmitError(null);

		if (!form.name.trim() || !form.arrTagName.trim() || !form.plexLabel.trim()) {
			setSubmitError("Name, *arr tag, and Plex label are required.");
			return;
		}
		if (!form.plexInstanceId) {
			setSubmitError("Pick a Plex instance to apply the label on.");
			return;
		}

		const payload: CreatePlexLabelSyncRuleRequest = {
			name: form.name.trim(),
			enabled: form.enabled,
			arrService: form.arrService,
			arrInstanceId: form.arrInstanceId || null,
			arrTagName: form.arrTagName.trim(),
			plexInstanceId: form.plexInstanceId,
			plexLabel: form.plexLabel.trim(),
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
						Maps a Sonarr or Radarr tag to a Plex label. Items carrying the *arr tag get the Plex
						label applied to their matching item (matched by TMDB ID).
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

					{/* Arr service + instance */}
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<label htmlFor="arr-service" className="text-sm font-medium">
								*arr service
							</label>
							<select
								id="arr-service"
								value={form.arrService}
								onChange={(e) => {
									update("arrService", e.target.value as ArrServiceForLabelSync);
									update("arrInstanceId", ""); // reset instance when service changes
								}}
								className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
							>
								<option value="sonarr">Sonarr</option>
								<option value="radarr">Radarr</option>
							</select>
						</div>
						<div className="space-y-1.5">
							<label htmlFor="arr-instance" className="text-sm font-medium">
								*arr instance
							</label>
							<select
								id="arr-instance"
								value={form.arrInstanceId}
								onChange={(e) => update("arrInstanceId", e.target.value)}
								className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
							>
								<option value="">All {form.arrService} instances</option>
								{arrInstances.map((s) => (
									<option key={s.id} value={s.id}>
										{s.label}
									</option>
								))}
							</select>
						</div>
					</div>

					{/* Tag name */}
					<div className="space-y-1.5">
						<label htmlFor="arr-tag" className="text-sm font-medium">
							*arr tag name
						</label>
						<Input
							id="arr-tag"
							value={form.arrTagName}
							onChange={(e) => update("arrTagName", e.target.value)}
							placeholder="e.g., kids"
							maxLength={120}
							required
						/>
						<p className="text-xs text-muted-foreground">
							The exact tag name as configured in the *arr UI. Case-sensitive.
						</p>
					</div>

					{/* Plex instance + label */}
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<label htmlFor="plex-instance" className="text-sm font-medium">
								Plex instance
							</label>
							<select
								id="plex-instance"
								value={form.plexInstanceId}
								onChange={(e) => update("plexInstanceId", e.target.value)}
								className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
								required
							>
								<option value="">Select a Plex instance…</option>
								{plexInstances.map((s) => (
									<option key={s.id} value={s.id}>
										{s.label}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-1.5">
							<label htmlFor="plex-label" className="text-sm font-medium">
								Plex label
							</label>
							<Input
								id="plex-label"
								value={form.plexLabel}
								onChange={(e) => update("plexLabel", e.target.value)}
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
