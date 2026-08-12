"use client";

/**
 * Composer — create/edit dialog for a library-cleanup rule (charter §5.2, the
 * flagship WRITE path — it authors live media-deletion rules).
 *
 * Flow: author the CONDITION half as a v1 document ({@link CriteriaConditionEditor})
 * plus the core action fields, then on save validate strictly, down-convert the
 * document to the v0 payload the EXISTING route accepts (`serializeCriteria
 * DocumentToV0`), and POST/PUT via the existing cleanup api-client. The live
 * evaluator keeps reading v0 — the composer writes the SAME rows the per-domain
 * dialog would (round-trip parity, PR-3a).
 *
 * Action scope (ratified 2026-07-07): core action only — action + retentionMode
 * + name + enabled. Advanced filters (service/instance/tag/title/plex-library)
 * and rejection-memory are managed in the full Library Cleanup surface; the PUT
 * route's `!== undefined` discipline PRESERVES them across a composer edit, and
 * create defaults them. Hence the note + deep link below.
 */

import type { CleanupAction, CreateCleanupRule, UpdateCleanupRule } from "@arr/shared";
import { CONTEXT_KINDS } from "@arr/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Save, ShieldOff } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
	useCleanupConfig,
	useCleanupFieldOptions,
	useCreateCleanupRule,
	useUpdateCleanupRule,
} from "@/hooks/api/useLibraryCleanup";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { getErrorMessage } from "@/lib/error-utils";
import { automationKeys } from "@/lib/query-keys";
import { getInputStyles } from "@/lib/theme-input-styles";
import { useAutomationRules } from "../../../hooks/api/useAutomation";
import { getDefaultConditionParams } from "../../rule-criteria/components/condition-params-fields";
import {
	type CriteriaEditorState,
	decomposeCriteriaDocument,
	toCriteriaV0Payload,
} from "../lib/rule-document-editor";
import { CriteriaConditionEditor } from "./criteria-condition-editor";

interface CleanupRuleComposerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Rule id to edit; omit/null for create mode. */
	editRuleId?: string | null;
}

const ACTIONS: Array<{ value: CleanupAction; label: string; hint: string }> = [
	{ value: "delete", label: "Delete", hint: "Remove the item entirely from the ARR instance." },
	{
		value: "unmonitor",
		label: "Unmonitor",
		hint: "Set the item unmonitored (keeps files and data).",
	},
	{
		value: "delete_files",
		label: "Delete Files",
		hint: "Delete files but keep the item in the library.",
	},
];

function freshEditorState(): CriteriaEditorState {
	return {
		mode: "single",
		operator: "all",
		conditions: [{ id: "seed-0", kind: "age", params: getDefaultConditionParams("age") }],
	};
}

export function CleanupRuleComposerDialog({
	open,
	onOpenChange,
	editRuleId,
}: CleanupRuleComposerDialogProps) {
	const { gradient } = useThemeGradient();
	const queryClient = useQueryClient();
	const isEdit = !!editRuleId;

	const { data: automation } = useAutomationRules();
	const { data: config } = useCleanupConfig();
	const { data: fieldOptions, isLoading: fieldOptionsLoading } = useCleanupFieldOptions();
	const createRule = useCreateCleanupRule();
	const updateRule = useUpdateCleanupRule();

	// The two edit data sources, joined by id: the automation read API supplies
	// the normalized v1 document (conditions); the cleanup config supplies the
	// action half the read API deliberately omits (name/enabled come from either).
	const summary = useMemo(
		() =>
			editRuleId
				? automation?.rules.find((r) => r.context === "library-cleanup" && r.id === editRuleId)
				: undefined,
		[automation, editRuleId],
	);
	const configRule = useMemo(
		() => (editRuleId ? config?.rules.find((r) => r.id === editRuleId) : undefined),
		[config, editRuleId],
	);

	// Edit mode needs BOTH joined sources before the form is meaningful: the
	// automation summary (conditions) AND the config rule (action + the defaulted
	// fields we must echo back — see the save comment). Initializing or saving
	// before configRule resolves would prefill composer DEFAULTS (action:"delete",
	// retentionMode:false) and write them over the stored values — on a media-
	// deletion rule, silently flipping e.g. "unmonitor" → "delete". So we gate.
	const editDataReady = !isEdit || (Boolean(summary) && Boolean(configRule));

	const [name, setName] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [action, setAction] = useState<CleanupAction>("delete");
	const [retentionMode, setRetentionMode] = useState(false);
	const [targetScope, setTargetScope] = useState<"series" | "episode">("series");
	const [episodeWatchCount, setEpisodeWatchCount] = useState(1);
	const [editorState, setEditorState] = useState<CriteriaEditorState>(freshEditorState);
	const [error, setError] = useState<string | null>(null);

	const legalKinds = useMemo(() => [...CONTEXT_KINDS["library-cleanup"]], []);

	// Prefill on open. In edit mode this runs once the joined rule resolves
	// (editDataReady) — never with partial data, so it can't seed defaults that a
	// later save would persist, and can't wipe in-progress edits on late load
	// (the form isn't shown until ready).
	useEffect(() => {
		if (!open) return;
		if (isEdit && !editDataReady) return;
		setError(null);
		if (isEdit) {
			setTargetScope(configRule?.targetScope ?? "series");
			const loadedEpisodeCount = configRule?.parameters.count;
			setEpisodeWatchCount(typeof loadedEpisodeCount === "number" ? loadedEpisodeCount : 1);
			setName(summary?.name ?? configRule?.name ?? "");
			setEnabled(summary?.enabled ?? configRule?.enabled ?? true);
			setAction((configRule?.action as CleanupAction) ?? "delete");
			setRetentionMode(configRule?.retentionMode ?? false);
			// The document is the v1 source of truth for conditions; if the stored
			// rule was unparseable (document null) we fall back to a fresh editor so
			// the operator can re-author rather than see a broken form.
			setEditorState(
				summary?.document ? decomposeCriteriaDocument(summary.document) : freshEditorState(),
			);
		} else {
			setName("");
			setEnabled(true);
			setAction("delete");
			setRetentionMode(false);
			setTargetScope("series");
			setEpisodeWatchCount(1);
			setEditorState(freshEditorState());
		}
	}, [open, isEdit, editDataReady, summary, configRule]);

	const inputStyles = getInputStyles(gradient);
	const inputClass = `${inputStyles.base} focus:outline-hidden`;
	const labelClass = "mb-1 block text-xs text-muted-foreground";

	const isSaving = createRule.isPending || updateRule.isPending;
	const selectTargetScope = (scope: "series" | "episode") => {
		if (isEdit || scope === targetScope) return;
		setTargetScope(scope);
		if (scope === "episode") {
			setRetentionMode(false);
			setEpisodeWatchCount(1);
			setEditorState({
				mode: "single",
				operator: "all",
				conditions: [
					{
						id: "episode-watch-count",
						kind: "plex_watch_count",
						params: { operator: "greater_than", count: 1 },
					},
				],
			});
		}
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (isSaving) return;

		if (!name.trim()) {
			setError("Give the rule a name.");
			return;
		}

		// Validate + down-convert the v1 document to the v0 route payload. The
		// full condition quartet (ruleType/parameters/operator/conditions) is
		// ALWAYS sent together so switching single↔composite clears any stale
		// operator/conditions the engine's composite discriminator would honor.
		// Not destructured: reading `.error`/`.payload` off the result preserves
		// the discriminated-union narrowing (payload is defined after the guard).
		const effectiveEditorState: CriteriaEditorState =
			targetScope === "episode"
				? {
						mode: "single",
						operator: "all",
						conditions: [
							{
								id: "episode-watch-count",
								kind: "plex_watch_count",
								params: { operator: "greater_than", count: episodeWatchCount },
							},
						],
					}
				: editorState;
		const result = toCriteriaV0Payload(effectiveEditorState, "library-cleanup");
		if (!result.payload) {
			setError(result.error ?? "This rule isn't valid yet.");
			return;
		}
		const payload = result.payload;
		setError(null);

		// The composer owns name/enabled/action/retentionMode + the full condition
		// quartet from the serializer.
		//
		// Preservation of the fields the composer does NOT edit is subtle:
		//  - Fields WITHOUT a schema default (serviceFilter, instanceFilter,
		//    excludeTags, excludeTitles, plexLibraryFilter, rejectionMemoryDays)
		//    can be omitted — the PUT route's `!== undefined` discipline keeps the
		//    stored value.
		//  - Fields WITH a `.default()` CANNOT simply be omitted: updateCleanup-
		//    RuleSchema = base.partial(), and `.partial()` does NOT strip
		//    `.default()`, so an absent `priority` (default 0) or
		//    `useGlobalRejectionMemory` (default true) is RE-INJECTED by Zod and
		//    would overwrite the stored value. So on edit we echo those two back
		//    from the loaded rule (editDataReady guarantees it's present).
		// Cast mirrors the per-domain dialog: the serializer types ruleType/
		// conditions as `string` (v0 payload shape) and the schema output type
		// demands its defaulted fields — validation proved the kind legal.
		const conditionHalf = {
			ruleType: payload.ruleType,
			parameters: payload.parameters,
			operator: payload.operator,
			conditions: payload.conditions,
		};
		const episodeScopeFields =
			targetScope === "episode"
				? { targetScope, serviceFilter: ["sonarr"], plexLibraryFilter: null }
				: { targetScope };

		try {
			if (isEdit && editRuleId && configRule) {
				const update = {
					name: name.trim(),
					enabled,
					action,
					retentionMode: targetScope === "episode" ? false : retentionMode,
					// Echo back the defaulted fields the composer doesn't edit, so
					// base.partial()'s re-injected defaults can't clobber them.
					priority: configRule.priority,
					useGlobalRejectionMemory: configRule.useGlobalRejectionMemory,
					...conditionHalf,
					...episodeScopeFields,
				};
				await updateRule.mutateAsync({ id: editRuleId, data: update as UpdateCleanupRule });
			} else {
				const create = {
					name: name.trim(),
					enabled,
					action,
					retentionMode: targetScope === "episode" ? false : retentionMode,
					...conditionHalf,
					...episodeScopeFields,
				};
				await createRule.mutateAsync(create as CreateCleanupRule);
			}
			// The mutation hooks invalidate the cleanup config; the Automation tab
			// reads its own key, so refresh it too.
			await queryClient.invalidateQueries({ queryKey: automationKeys.all });
			onOpenChange(false);
		} catch (err) {
			setError(getErrorMessage(err, "Could not save the rule."));
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Edit Cleanup Rule" : "New Cleanup Rule"}</DialogTitle>
					<DialogDescription>
						Author the matching conditions and action. This writes a real Library Cleanup rule.
					</DialogDescription>
				</DialogHeader>

				{isEdit && !editDataReady ? (
					// Don't render the form until the joined rule data has loaded —
					// otherwise the fields would show composer defaults, not the rule.
					<div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
						Loading rule…
					</div>
				) : (
					<form
						onSubmit={handleSubmit}
						className="mt-2 space-y-5"
						onFocus={(e) => {
							const t = e.target;
							if (
								(t instanceof HTMLInputElement && t.type !== "checkbox") ||
								t instanceof HTMLSelectElement
							) {
								inputStyles.applyFocus(t);
							}
						}}
						onBlur={(e) => {
							const t = e.target;
							if (
								(t instanceof HTMLInputElement && t.type !== "checkbox") ||
								t instanceof HTMLSelectElement
							) {
								inputStyles.removeFocus(t);
							}
						}}
					>
						{/* Name */}
						<label className="block">
							<span className={labelClass}>Rule name</span>
							<input
								type="text"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="e.g., Old low-rated movies"
								required
								className={inputClass}
							/>
						</label>

						{/* Enabled */}
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium">Enabled</span>
							<Switch
								checked={enabled}
								onCheckedChange={setEnabled}
								style={enabled ? { backgroundColor: gradient.from } : undefined}
							/>
						</div>

						<div>
							<span className={labelClass}>Target</span>
							<div className="mt-1.5 grid grid-cols-2 gap-2">
								{(["series", "episode"] as const).map((scope) => (
									<button
										key={scope}
										type="button"
										onClick={() => selectTargetScope(scope)}
										disabled={isEdit}
										aria-pressed={targetScope === scope}
										title={
											isEdit ? "Target scope cannot be changed while editing a rule" : undefined
										}
										className="rounded-lg border px-3 py-2 text-left text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-60"
										style={
											targetScope === scope
												? {
														borderColor: gradient.from,
														backgroundColor: gradient.fromLight,
														color: gradient.from,
													}
												: { borderColor: "var(--color-border)" }
										}
									>
										{scope === "series" ? "Series" : "Episodes"}
									</button>
								))}
							</div>
							{isEdit && (
								<p className="mt-2 text-xs text-muted-foreground">
									Target scope cannot be changed while editing. Create a new rule to use a different
									scope.
								</p>
							)}
							{targetScope === "episode" && (
								<p className="mt-1 text-xs text-muted-foreground">
									Episodes are a Sonarr-only workflow using Plex watch count.
								</p>
							)}
						</div>

						{/* Retention mode */}
						{targetScope === "series" && (
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<ShieldOff className="h-4 w-4 text-emerald-400" />
									<div>
										<span className="text-sm font-medium">Retention rule</span>
										<p className="text-xs text-muted-foreground">
											Protects matching items from other rules
										</p>
									</div>
								</div>
								<Switch
									checked={retentionMode}
									onCheckedChange={setRetentionMode}
									style={retentionMode ? { backgroundColor: "rgb(16 185 129)" } : undefined}
								/>
							</div>
						)}

						{/* Action */}
						<div>
							<span className={labelClass}>Action when matched</span>
							<div className="mt-1.5 flex gap-2">
								{ACTIONS.map((a) => (
									<button
										key={a.value}
										type="button"
										onClick={() => setAction(a.value)}
										className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-200"
										style={
											action === a.value
												? {
														borderColor: gradient.from,
														backgroundColor: gradient.fromLight,
														color: gradient.from,
													}
												: { borderColor: "var(--color-border)" }
										}
									>
										{a.label}
									</button>
								))}
							</div>
							<p className="mt-1 text-xs text-muted-foreground">
								{targetScope === "episode"
									? action === "delete"
										? "Unmonitor the exact Sonarr episode, then delete its verified episode file. The series and other episodes remain."
										: action === "unmonitor"
											? "Unmonitor only the exact Sonarr episode and keep its file."
											: "Delete only the exact verified episode file. The episode remains monitored, so Sonarr may download it again."
									: ACTIONS.find((a) => a.value === action)?.hint}
							</p>
						</div>

						{/* Conditions */}
						{targetScope === "series" ? (
							<div className="space-y-3 rounded-xl border border-border/50 bg-card/30 p-4 backdrop-blur-sm">
								<span className="text-sm font-medium">Conditions</span>
								<CriteriaConditionEditor
									state={editorState}
									onChange={setEditorState}
									legalKinds={legalKinds}
									fieldOptions={fieldOptions}
									fieldOptionsLoading={fieldOptionsLoading}
									inputClass={inputClass}
									labelClass={labelClass}
								/>
							</div>
						) : (
							<div className="space-y-3 rounded-xl border border-border/50 bg-card/30 p-4 text-sm">
								<span className="font-medium">Plex Watch Count</span>
								<div className="flex gap-2">
									<label className="block flex-1">
										<span className={labelClass}>Operator</span>
										<select value="greater_than" disabled className={inputClass}>
											<option value="greater_than">Greater than</option>
										</select>
									</label>
									<label className="block w-24">
										<span className={labelClass}>Count</span>
										<input
											type="number"
											value={episodeWatchCount}
											onChange={(event) => setEpisodeWatchCount(Number(event.target.value))}
											min={0}
											className={inputClass}
										/>
									</label>
								</div>
								<p className="mt-1 text-xs text-muted-foreground">
									Episode rules always use a greater-than Plex watch count and cannot be composite
									or retention rules.
								</p>
							</div>
						)}

						{/* Advanced-filters disclosure (they live in the full surface) */}
						<Link
							href="/library-cleanup"
							className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
						>
							<ExternalLink className="h-3 w-3" aria-hidden="true" />
							Advanced filters (services, instances, tags, titles, Plex libraries) and rejection
							memory are managed in Library Cleanup
						</Link>

						{error && (
							<div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
								{error}
							</div>
						)}

						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={() => onOpenChange(false)}
								className="rounded-lg border border-border/50 px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={isSaving}
								className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-60"
								style={{
									background: `linear-gradient(to right, ${gradient.from}, ${gradient.to})`,
								}}
							>
								{isSaving ? (
									<Loader2 className="h-4 w-4 animate-spin" />
								) : (
									<Save className="h-4 w-4" />
								)}
								{isEdit ? "Save changes" : "Create rule"}
							</button>
						</div>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
