"use client";

/**
 * Composer — create/edit dialog for an auto-tag rule (charter §5.2, second
 * authoring slice, PR-3c).
 *
 * Same shape as the cleanup composer, minus the cleanup-specific action half:
 * auto-tag's action is a single `tagName`. It reuses the shared criteria editor
 * ({@link CriteriaConditionEditor}), the pure editor/validation layer, and the
 * v1→v0 down-convert — auto-tag shares the criteria vocabulary with cleanup, so
 * `serializeCriteriaDocumentToV0` produces the exact v0 payload the auto-tag
 * route accepts, and the live evaluator keeps reading v0.
 *
 * Two PR-3b lessons carry over; one does NOT:
 *  - editDataReady gate (async join): still needed — `tagName` lives on the full
 *    AutoTagRule (useAutoTagRules), joined by id with the automation summary's
 *    document. Don't render/submit until both load, or a save would seed
 *    defaults over the real values.
 *  - retired-kind edit gate: enforced by the panel (see automation-panel).
 *  - z.partial() default-clobber does NOT apply: auto-tag's update schema has NO
 *    `.default()` fields, so omitted filters parse to `undefined` and the PATCH
 *    route preserves them. No defaulted-field echo needed.
 */

import type { CreateAutoTagRuleRequest, UpdateAutoTagRuleRequest } from "@arr/shared";
import { CONTEXT_KINDS } from "@arr/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Save } from "lucide-react";
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
	useAutoTagRules,
	useCreateAutoTagRule,
	useUpdateAutoTagRule,
} from "@/hooks/api/useAutoTag";
import { useCleanupFieldOptions } from "@/hooks/api/useLibraryCleanup";
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

interface AutoTagRuleComposerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Rule id to edit; omit/null for create mode. */
	editRuleId?: string | null;
}

function freshEditorState(): CriteriaEditorState {
	return {
		mode: "single",
		operator: "all",
		conditions: [{ id: "seed-0", kind: "age", params: getDefaultConditionParams("age") }],
	};
}

export function AutoTagRuleComposerDialog({
	open,
	onOpenChange,
	editRuleId,
}: AutoTagRuleComposerDialogProps) {
	const { gradient } = useThemeGradient();
	const queryClient = useQueryClient();
	const isEdit = !!editRuleId;

	const { data: automation } = useAutomationRules();
	const { data: autoTagRules } = useAutoTagRules();
	const { data: fieldOptions, isLoading: fieldOptionsLoading } = useCleanupFieldOptions();
	const createRule = useCreateAutoTagRule();
	const updateRule = useUpdateAutoTagRule();

	// Join by id: automation summary → v1 document (conditions); the auto-tag rule
	// → the action half (tagName) the read API omits. name/enabled from either.
	const summary = useMemo(
		() =>
			editRuleId
				? automation?.rules.find((r) => r.context === "auto-tag" && r.id === editRuleId)
				: undefined,
		[automation, editRuleId],
	);
	const rule = useMemo(
		() => (editRuleId ? autoTagRules?.find((r) => r.id === editRuleId) : undefined),
		[autoTagRules, editRuleId],
	);

	// Edit mode needs BOTH joined sources before the form is meaningful (see the
	// PR-3b async-join lesson). Initializing/saving before `rule` resolves would
	// prefill an empty tagName and could clear it on save.
	const editDataReady = !isEdit || (Boolean(summary) && Boolean(rule));

	const [name, setName] = useState("");
	const [enabled, setEnabled] = useState(true);
	const [tagName, setTagName] = useState("");
	const [editorState, setEditorState] = useState<CriteriaEditorState>(freshEditorState);
	const [error, setError] = useState<string | null>(null);

	const legalKinds = useMemo(() => [...CONTEXT_KINDS["auto-tag"]], []);

	useEffect(() => {
		if (!open) return;
		if (isEdit && !editDataReady) return;
		setError(null);
		if (isEdit) {
			setName(summary?.name ?? rule?.name ?? "");
			setEnabled(summary?.enabled ?? rule?.enabled ?? true);
			setTagName(rule?.tagName ?? "");
			setEditorState(
				summary?.document ? decomposeCriteriaDocument(summary.document) : freshEditorState(),
			);
		} else {
			setName("");
			setEnabled(true);
			setTagName("");
			setEditorState(freshEditorState());
		}
	}, [open, isEdit, editDataReady, summary, rule]);

	const inputStyles = getInputStyles(gradient);
	const inputClass = `${inputStyles.base} focus:outline-hidden`;
	const labelClass = "mb-1 block text-xs text-muted-foreground";

	const isSaving = createRule.isPending || updateRule.isPending;

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (isSaving) return;

		if (!name.trim()) {
			setError("Give the rule a name.");
			return;
		}
		if (!tagName.trim()) {
			setError("Enter the tag to apply.");
			return;
		}

		// Validate + down-convert the v1 document to the v0 route payload. The full
		// condition quartet is always sent together so switching single↔composite
		// clears any stale operator/conditions.
		const result = toCriteriaV0Payload(editorState, "auto-tag");
		if (!result.payload) {
			setError(result.error ?? "This rule isn't valid yet.");
			return;
		}
		const payload = result.payload;
		setError(null);

		// The composer owns name/enabled/tagName + the condition quartet. The scope
		// filters (serviceFilter/instanceFilter/excludeTags/excludeTitles/
		// plexLibraryFilter) are omitted; auto-tag's update schema has no defaults,
		// so the PATCH route preserves them (no echo needed — unlike cleanup).
		const base = {
			name: name.trim(),
			enabled,
			tagName: tagName.trim(),
			ruleType: payload.ruleType,
			parameters: payload.parameters,
			operator: payload.operator,
			conditions: payload.conditions,
		};

		try {
			if (isEdit && editRuleId) {
				await updateRule.mutateAsync({ id: editRuleId, payload: base as UpdateAutoTagRuleRequest });
			} else {
				await createRule.mutateAsync(base as CreateAutoTagRuleRequest);
			}
			// The auto-tag hooks invalidate autoTagKeys.rules; the Automation tab
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
					<DialogTitle>{isEdit ? "Edit Auto-Tag Rule" : "New Auto-Tag Rule"}</DialogTitle>
					<DialogDescription>
						Author the matching conditions and the tag to apply. This writes a real Auto-Tag rule.
					</DialogDescription>
				</DialogHeader>

				{isEdit && !editDataReady ? (
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
								placeholder="e.g., Tag kids movies"
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

						{/* Action = the tag to apply */}
						<label className="block">
							<span className={labelClass}>Tag to apply</span>
							<input
								type="text"
								value={tagName}
								onChange={(e) => setTagName(e.target.value)}
								placeholder="e.g., kids"
								required
								className={inputClass}
							/>
							<p className="mt-1 text-xs text-muted-foreground">
								Applied to every matching item on its source service.
							</p>
						</label>

						{/* Conditions */}
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

						{/* Advanced-filters disclosure (managed in the full surface) */}
						<Link
							href="/auto-tag"
							className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
						>
							<ExternalLink className="h-3 w-3" aria-hidden="true" />
							Advanced filters (services, instances, tags, titles, Plex libraries) are managed in
							Auto-Tagger
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
