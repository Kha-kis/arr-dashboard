"use client";

import type {
	AutoTagRule,
	CompositeOperator,
	Condition,
	CreateAutoTagRuleRequest,
	RuleType,
	ServiceInstanceSummary,
} from "@arr/shared";
import { Plus, X } from "lucide-react";
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
} from "../../rule-criteria/components/condition-params-fields";

interface RuleDialogProps {
	rule: AutoTagRule | null;
	onClose: () => void;
}

type Mode = "single" | "composite";

// Single-mode rules can pick any rule type EXCEPT "composite" (which is the
// nested-rule discriminator, not a leaf criterion). Composite mode uses
// `Condition[]` whose `ruleType` field has the same exclusion baked in.
type SingleRuleType = Exclude<RuleType, "composite">;

interface FormState {
	name: string;
	enabled: boolean;
	tagName: string;
	mode: Mode;
	// single-mode
	ruleType: SingleRuleType;
	parameters: Record<string, unknown>;
	// composite-mode
	operator: CompositeOperator;
	conditions: Condition[];
	// shared scope
	instanceFilter: string[];
}

const DEFAULT_RULE_TYPE: SingleRuleType = "genre";
const DEFAULT_COMPOSITE_OPERATOR: CompositeOperator = "AND";

const initialForm = (rule: AutoTagRule | null): FormState => {
	const isComposite = rule != null && rule.operator != null && rule.conditions != null;
	return {
		name: rule?.name ?? "",
		enabled: rule?.enabled ?? true,
		tagName: rule?.tagName ?? "",
		mode: isComposite ? "composite" : "single",
		ruleType:
			rule && !isComposite
				? (rule.ruleType as SingleRuleType) // not "composite" since !isComposite
				: DEFAULT_RULE_TYPE,
		parameters:
			rule && !isComposite && Object.keys(rule.parameters).length > 0
				? rule.parameters
				: getDefaultConditionParams(DEFAULT_RULE_TYPE),
		operator: rule?.operator ?? DEFAULT_COMPOSITE_OPERATOR,
		conditions:
			rule?.conditions && rule.conditions.length > 0 ? rule.conditions : [makeBlankCondition()],
		instanceFilter: rule?.instanceFilter ?? [],
	};
};

const inputClass =
	"w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const labelClass = "text-sm font-medium";

const RULE_TYPE_OPTIONS: Array<{ value: SingleRuleType; label: string; group: string }> = [
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

function makeBlankCondition(): Condition {
	return {
		ruleType: DEFAULT_RULE_TYPE,
		parameters: getDefaultConditionParams(DEFAULT_RULE_TYPE),
	};
}

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

	const onSingleRuleTypeChange = (next: SingleRuleType) => {
		setForm((prev) => ({
			...prev,
			ruleType: next,
			parameters: getDefaultConditionParams(next),
		}));
		setSubmitError(null);
	};

	const updateCondition = (index: number, patch: Partial<Condition>) => {
		setForm((prev) => ({
			...prev,
			conditions: prev.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)),
		}));
		setSubmitError(null);
	};

	const onConditionRuleTypeChange = (index: number, next: SingleRuleType) => {
		updateCondition(index, {
			ruleType: next,
			parameters: getDefaultConditionParams(next),
		});
	};

	const addCondition = () => {
		setForm((prev) => ({ ...prev, conditions: [...prev.conditions, makeBlankCondition()] }));
		setSubmitError(null);
	};

	const removeCondition = (index: number) => {
		setForm((prev) => ({
			...prev,
			conditions: prev.conditions.filter((_, i) => i !== index),
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
		if (form.mode === "composite" && form.conditions.length === 0) {
			setSubmitError("Composite rules must have at least one condition.");
			return;
		}

		const payload: CreateAutoTagRuleRequest =
			form.mode === "composite"
				? {
						name: form.name.trim(),
						enabled: form.enabled,
						tagName: form.tagName.trim(),
						ruleType: "composite",
						parameters: {},
						operator: form.operator,
						conditions: form.conditions,
						instanceFilter: form.instanceFilter.length > 0 ? form.instanceFilter : null,
					}
				: {
						name: form.name.trim(),
						enabled: form.enabled,
						tagName: form.tagName.trim(),
						ruleType: form.ruleType,
						parameters: form.parameters,
						operator: null,
						conditions: null,
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
			<DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Edit Auto-Tag Rule" : "New Auto-Tag Rule"}</DialogTitle>
					<DialogDescription>
						Apply a tag to Sonarr/Radarr items matching the criteria. Auto-tagging seeds the source
						tag — pair with a Label Sync rule to mirror it onto Plex/Jellyfin labels.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="space-y-4">
					{/* Name + tag */}
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

					{/* Mode toggle: single vs composite */}
					<div className="space-y-1.5">
						<label className={labelClass}>Match mode</label>
						<div className="inline-flex rounded-md border border-border/50 p-0.5 text-xs">
							<button
								type="button"
								onClick={() => update("mode", "single")}
								className={`px-3 py-1 rounded transition-colors ${form.mode === "single" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/30"}`}
							>
								Single criterion
							</button>
							<button
								type="button"
								onClick={() => update("mode", "composite")}
								className={`px-3 py-1 rounded transition-colors ${form.mode === "composite" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/30"}`}
							>
								Composite (AND / OR)
							</button>
						</div>
						<p className="text-xs text-muted-foreground">
							Composite rules combine multiple criteria.{" "}
							{form.mode === "composite"
								? "All conditions are evaluated against each item and combined with the chosen operator."
								: "Switch to composite mode to combine multiple criteria with AND or OR."}
						</p>
					</div>

					{form.mode === "single" ? (
						<>
							{/* Single rule-type selector */}
							<div className="space-y-1.5">
								<label htmlFor="rule-type" className={labelClass}>
									Match criteria
								</label>
								<select
									id="rule-type"
									value={form.ruleType}
									onChange={(e) => onSingleRuleTypeChange(e.target.value as SingleRuleType)}
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
						</>
					) : (
						<>
							{/* Composite operator */}
							<div className="space-y-1.5">
								<label htmlFor="composite-operator" className={labelClass}>
									Combine conditions with
								</label>
								<select
									id="composite-operator"
									value={form.operator}
									onChange={(e) => update("operator", e.target.value as CompositeOperator)}
									className={inputClass}
								>
									<option value="AND">AND — every condition must match</option>
									<option value="OR">OR — any condition matches</option>
								</select>
							</div>

							{/* Composite conditions list */}
							<div className="space-y-2">
								<label className={labelClass}>Conditions</label>
								{form.conditions.map((cond, index) => (
									<div
										key={index}
										className="rounded-md border border-border/50 bg-muted/10 p-3 space-y-3 relative"
									>
										<div className="flex items-start justify-between gap-2">
											<div className="flex-1 space-y-1.5">
												<label htmlFor={`cond-rt-${index}`} className="text-xs font-medium">
													Condition {index + 1} — match criteria
												</label>
												<select
													id={`cond-rt-${index}`}
													value={cond.ruleType}
													onChange={(e) =>
														onConditionRuleTypeChange(index, e.target.value as SingleRuleType)
													}
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
											{form.conditions.length > 1 && (
												<button
													type="button"
													onClick={() => removeCondition(index)}
													className="mt-6 p-1.5 rounded-md hover:bg-red-500/10 transition-colors"
													title="Remove condition"
												>
													<X className="h-3.5 w-3.5 text-red-500/70" />
												</button>
											)}
										</div>
										<ConditionParamsFields
											ruleType={cond.ruleType}
											params={cond.parameters}
											onParamsChange={(p) => updateCondition(index, { parameters: p })}
											fieldOptions={fieldOptionsQuery.data}
											fieldOptionsLoading={fieldOptionsQuery.isLoading}
											inputClass={inputClass}
											labelClass="text-xs font-medium"
										/>
									</div>
								))}
								<Button
									type="button"
									variant="ghost"
									onClick={addCondition}
									className="w-full justify-center"
								>
									<Plus className="h-3.5 w-3.5 mr-1.5" />
									Add condition
								</Button>
							</div>
						</>
					)}

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
