"use client";

import type {
	AutoTagRule,
	CreateAutoTagRuleRequest,
	RuleType,
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
import { useCreateAutoTagRule, useUpdateAutoTagRule } from "../../../hooks/api/useAutoTag";
import { useCleanupFieldOptions } from "../../../hooks/api/useLibraryCleanup";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import {
	ConditionParamsFields,
	getDefaultConditionParams,
} from "../../library-cleanup/components/condition-params-fields";

interface RuleDialogProps {
	rule: AutoTagRule | null;
	onClose: () => void;
}

interface FormState {
	name: string;
	enabled: boolean;
	tagName: string;
	ruleType: RuleType;
	parameters: Record<string, unknown>;
	instanceFilter: string[]; // empty = all *arr instances
}

const DEFAULT_RULE_TYPE: RuleType = "genre";

const initialForm = (rule: AutoTagRule | null): FormState => ({
	name: rule?.name ?? "",
	enabled: rule?.enabled ?? true,
	tagName: rule?.tagName ?? "",
	ruleType: rule?.ruleType ?? DEFAULT_RULE_TYPE,
	parameters:
		rule?.parameters && Object.keys(rule.parameters).length > 0
			? rule.parameters
			: getDefaultConditionParams(DEFAULT_RULE_TYPE),
	instanceFilter: rule?.instanceFilter ?? [],
});

const inputClass =
	"w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const labelClass = "text-sm font-medium";

// Curated subset of rule types most useful for auto-tagging *arr items.
// Full ruleTypeSchema enum has 50+ values; v1 picks the ones that fire
// against `LibraryCache` rows without needing Plex/Jellyfin/Seerr/Tautulli
// prefetch. Watch-state and Plex metadata rules will work too — they just
// require those services to be configured. Added them here for parity.
const RULE_TYPE_OPTIONS: Array<{ value: RuleType; label: string; group: string }> = [
	{ value: "genre", label: "Genre", group: "Metadata" },
	{ value: "year_range", label: "Year (range)", group: "Metadata" },
	{ value: "rating", label: "TMDB rating", group: "Metadata" },
	{ value: "imdb_rating", label: "IMDB rating", group: "Metadata" },
	{ value: "language", label: "Language", group: "Metadata" },
	{ value: "runtime", label: "Runtime", group: "Metadata" },
	{ value: "status", label: "Status", group: "Metadata" },
	{ value: "tag_match", label: "Existing tag match", group: "Metadata" },

	{ value: "video_codec", label: "Video codec", group: "File" },
	{ value: "audio_codec", label: "Audio codec", group: "File" },
	{ value: "audio_channels", label: "Audio channels", group: "File" },
	{ value: "resolution", label: "Resolution", group: "File" },
	{ value: "hdr_type", label: "HDR type", group: "File" },
	{ value: "release_group", label: "Release group", group: "File" },
	{ value: "custom_format_score", label: "Custom format score", group: "File" },
	{ value: "size", label: "File size", group: "File" },
	{ value: "no_file", label: "No file present", group: "File" },
	{ value: "file_path", label: "File path (regex)", group: "File" },

	{ value: "age", label: "Age (since added)", group: "Lifecycle" },
	{ value: "unmonitored", label: "Unmonitored", group: "Lifecycle" },
	{ value: "quality_profile", label: "Quality profile", group: "Lifecycle" },

	{ value: "plex_label", label: "Plex label", group: "Plex" },
	{ value: "plex_collection", label: "Plex collection", group: "Plex" },
	{ value: "plex_last_watched", label: "Plex last watched", group: "Plex" },
	{ value: "plex_watch_count", label: "Plex watch count", group: "Plex" },
	{ value: "plex_added_at", label: "Plex added (date)", group: "Plex" },
];

export const RuleDialog = ({ rule, onClose }: RuleDialogProps) => {
	const isEdit = rule !== null;
	const [form, setForm] = useState<FormState>(initialForm(rule));
	const [submitError, setSubmitError] = useState<string | null>(null);

	const { data: services = [] } = useServicesQuery();
	const arrInstances = useMemo(
		() =>
			(services as ServiceInstanceSummary[]).filter(
				(s) =>
					s.enabled &&
					(s.service.toLowerCase() === "sonarr" || s.service.toLowerCase() === "radarr"),
			),
		[services],
	);

	const fieldOptionsQuery = useCleanupFieldOptions();

	const createMutation = useCreateAutoTagRule();
	const updateMutation = useUpdateAutoTagRule();
	const isPending = createMutation.isPending || updateMutation.isPending;

	const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
		setForm((prev) => ({ ...prev, [key]: value }));
		setSubmitError(null);
	};

	const onRuleTypeChange = (next: RuleType) => {
		// Replace params with the new rule type's defaults so the backend
		// validation passes on save.
		setForm((prev) => ({
			...prev,
			ruleType: next,
			parameters: getDefaultConditionParams(next),
		}));
		setSubmitError(null);
	};

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setSubmitError(null);

		if (!form.name.trim() || !form.tagName.trim()) {
			setSubmitError("Rule name and tag name are required.");
			return;
		}

		const payload: CreateAutoTagRuleRequest = {
			name: form.name.trim(),
			enabled: form.enabled,
			tagName: form.tagName.trim(),
			ruleType: form.ruleType,
			parameters: form.parameters,
			instanceFilter: form.instanceFilter.length > 0 ? form.instanceFilter : null,
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

	const toggleInstance = (id: string) => {
		setForm((prev) => ({
			...prev,
			instanceFilter: prev.instanceFilter.includes(id)
				? prev.instanceFilter.filter((x) => x !== id)
				: [...prev.instanceFilter, id],
		}));
		setSubmitError(null);
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Edit Auto-Tag Rule" : "New Auto-Tag Rule"}</DialogTitle>
					<DialogDescription>
						Apply a tag to Sonarr/Radarr items matching the criteria. Auto-tagging seeds the source
						tag — pair with a Label Sync rule to mirror it onto Plex/Jellyfin labels.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="space-y-4">
					{/* Name + enabled */}
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<label htmlFor="rule-name" className={labelClass}>
								Rule name
							</label>
							<Input
								id="rule-name"
								value={form.name}
								onChange={(e) => update("name", e.target.value)}
								placeholder="e.g., Tag kids movies"
								maxLength={120}
								required
							/>
						</div>
						<div className="space-y-1.5">
							<label htmlFor="tag-name" className={labelClass}>
								Tag to apply
							</label>
							<Input
								id="tag-name"
								value={form.tagName}
								onChange={(e) => update("tagName", e.target.value)}
								placeholder="e.g., kids"
								maxLength={120}
								required
							/>
						</div>
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

					{/* Instance scope */}
					<div className="space-y-1.5">
						<label className={labelClass}>Apply to instances</label>
						<div className="flex flex-wrap gap-2">
							{arrInstances.length === 0 ? (
								<span className="text-xs text-muted-foreground">
									No enabled Sonarr/Radarr instances configured.
								</span>
							) : (
								arrInstances.map((s) => {
									const checked = form.instanceFilter.includes(s.id);
									return (
										<button
											key={s.id}
											type="button"
											onClick={() => toggleInstance(s.id)}
											className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${checked ? "bg-primary/10 border-primary text-primary" : "border-border/50 text-muted-foreground hover:bg-muted/30"}`}
										>
											{s.label} ({s.service.toLowerCase()})
										</button>
									);
								})
							)}
						</div>
						<p className="text-xs text-muted-foreground">
							Leave empty to apply to all enabled Sonarr + Radarr instances.
						</p>
					</div>

					{/* Rule type selector */}
					<div className="space-y-1.5">
						<label htmlFor="rule-type" className={labelClass}>
							Match criteria
						</label>
						<select
							id="rule-type"
							value={form.ruleType}
							onChange={(e) => onRuleTypeChange(e.target.value as RuleType)}
							className={inputClass}
						>
							{Object.entries(groupBy(RULE_TYPE_OPTIONS, (o) => o.group)).map(
								([group, options]) => (
									<optgroup key={group} label={group}>
										{options.map((opt) => (
											<option key={opt.value} value={opt.value}>
												{opt.label}
											</option>
										))}
									</optgroup>
								),
							)}
						</select>
					</div>

					{/* Per-rule-type params */}
					<div className="rounded-md border border-border/50 bg-muted/10 p-3 space-y-3">
						<ConditionParamsFields
							ruleType={form.ruleType}
							params={form.parameters}
							onParamsChange={(p) => update("parameters", p)}
							fieldOptions={fieldOptionsQuery.data}
							fieldOptionsLoading={fieldOptionsQuery.isLoading}
							inputClass={inputClass}
							labelClass={labelClass}
						/>
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

function groupBy<T, K extends string>(items: readonly T[], key: (item: T) => K): Record<K, T[]> {
	const result = {} as Record<K, T[]>;
	for (const item of items) {
		const k = key(item);
		if (!result[k]) result[k] = [];
		result[k].push(item);
	}
	return result;
}
