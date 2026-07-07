"use client";

/**
 * Composer — criteria condition editor (library-cleanup / auto-tag).
 *
 * The authoring counterpart of {@link RuleDocumentView}: it edits the CONDITION
 * half of a criteria rule as a {@link CriteriaEditorState}, which the dialog
 * down-converts to a v0 payload on save. It generalizes the existing cleanup
 * dialog's composite builder (single OR all/any group) and reuses the SAME
 * per-kind param editor (`ConditionParamsFields` + `getDefaultConditionParams`)
 * so the composer's field UX is identical to the per-domain dialog's — no
 * second, drifting editor.
 *
 * Notifications author `field_match` predicates, not criteria kinds, so that
 * surface gets its own editor in a later slice; this component is criteria-only.
 */

import type { CleanupFieldOptionsResponse, CleanupRuleType } from "@arr/shared";
import { useRef } from "react";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import {
	ConditionParamsFields,
	getDefaultConditionParams,
} from "../../rule-criteria/components/condition-params-fields";
import { humanizeKind } from "../lib/describe-predicate";
import type { CriteriaEditorState, EditorCondition } from "../lib/rule-document-editor";

interface CriteriaConditionEditorProps {
	state: CriteriaEditorState;
	onChange: (next: CriteriaEditorState) => void;
	/** Kind ids legal for the rule's context (from CONTEXT_KINDS). */
	legalKinds: readonly string[];
	fieldOptions: CleanupFieldOptionsResponse | undefined;
	fieldOptionsLoading: boolean;
	inputClass: string;
	labelClass: string;
}

const DEFAULT_KIND = "age";

export function CriteriaConditionEditor({
	state,
	onChange,
	legalKinds,
	fieldOptions,
	fieldOptionsLoading,
	inputClass,
	labelClass,
}: CriteriaConditionEditorProps) {
	const { gradient } = useThemeGradient();
	// Monotonic id source for new rows — stable React keys without Date.now.
	const nextId = useRef(0);
	const makeCondition = (kind: string = DEFAULT_KIND): EditorCondition => ({
		id: `new-${nextId.current++}`,
		kind,
		params: getDefaultConditionParams(kind as CleanupRuleType),
	});

	// Kind picker options, context-driven + humanized (no duplicated 52-entry
	// label map — the read viewer humanizes the same way).
	const kindOptions = [...legalKinds]
		.map((kind) => ({ value: kind, label: humanizeKind(kind) }))
		.sort((a, b) => a.label.localeCompare(b.label));

	const setMode = (mode: CriteriaEditorState["mode"]) => {
		if (mode === state.mode) return;
		if (mode === "single") {
			// Collapse to the first condition (seed one if somehow empty).
			onChange({ ...state, mode, conditions: [state.conditions[0] ?? makeCondition()] });
		} else {
			// Promote the current single condition into the group's first row.
			onChange({
				...state,
				mode,
				conditions: state.conditions.length ? state.conditions : [makeCondition()],
			});
		}
	};

	const updateCondition = (id: string, patch: Partial<EditorCondition>) => {
		onChange({
			...state,
			conditions: state.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)),
		});
	};

	const changeKind = (id: string, kind: string) => {
		// New kind → seed its defaults (stale params from the old kind would fail
		// the new kind's schema).
		updateCondition(id, { kind, params: getDefaultConditionParams(kind as CleanupRuleType) });
	};

	const addCondition = () => {
		onChange({ ...state, conditions: [...state.conditions, makeCondition()] });
	};

	const removeCondition = (id: string) => {
		onChange({ ...state, conditions: state.conditions.filter((c) => c.id !== id) });
	};

	const toggleStyle = (active: boolean) =>
		active
			? { borderColor: gradient.from, backgroundColor: gradient.fromLight, color: gradient.from }
			: { borderColor: "var(--color-border)" };

	const renderRow = (cond: EditorCondition, index: number, removable: boolean) => (
		<div key={cond.id} className="space-y-2 rounded-lg border border-border/50 bg-card/20 p-3">
			<div className="flex items-center justify-between">
				<span className="text-xs font-medium text-muted-foreground">
					{state.mode === "composite" ? `Condition ${index + 1}` : "Condition"}
				</span>
				{removable && (
					<button
						type="button"
						onClick={() => removeCondition(cond.id)}
						className="text-xs text-muted-foreground transition-colors hover:text-destructive"
					>
						Remove
					</button>
				)}
			</div>
			<select
				value={cond.kind}
				onChange={(e) => changeKind(cond.id, e.target.value)}
				className={inputClass}
			>
				{kindOptions.map((opt) => (
					<option key={opt.value} value={opt.value}>
						{opt.label}
					</option>
				))}
			</select>
			<ConditionParamsFields
				ruleType={cond.kind as CleanupRuleType}
				params={cond.params}
				onParamsChange={(params) => updateCondition(cond.id, { params })}
				fieldOptions={fieldOptions}
				fieldOptionsLoading={fieldOptionsLoading}
				inputClass={inputClass}
				labelClass={labelClass}
			/>
		</div>
	);

	return (
		<div className="space-y-3">
			{/* Mode toggle */}
			<div>
				<span className={labelClass}>Match</span>
				<div className="mt-1.5 flex gap-2">
					<button
						type="button"
						onClick={() => setMode("single")}
						className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-200"
						style={toggleStyle(state.mode === "single")}
					>
						Single condition
					</button>
					<button
						type="button"
						onClick={() => setMode("composite")}
						className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-200"
						style={toggleStyle(state.mode === "composite")}
					>
						Multiple conditions
					</button>
				</div>
			</div>

			{/* all/any operator (composite only) */}
			{state.mode === "composite" && (
				<div>
					<span className={labelClass}>Require</span>
					<div className="mt-1.5 flex gap-2">
						{(["all", "any"] as const).map((op) => (
							<button
								key={op}
								type="button"
								onClick={() => onChange({ ...state, operator: op })}
								className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-200"
								style={toggleStyle(state.operator === op)}
							>
								{op === "all" ? "All conditions (AND)" : "Any condition (OR)"}
							</button>
						))}
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{state.operator === "all"
							? "The item must match every condition below."
							: "The item matches if any condition below matches."}
					</p>
				</div>
			)}

			{/* Condition rows */}
			<div className="space-y-2">
				{state.mode === "single"
					? state.conditions[0] && renderRow(state.conditions[0], 0, false)
					: state.conditions.map((cond, i) => renderRow(cond, i, state.conditions.length > 1))}
			</div>

			{state.mode === "composite" && (
				<button
					type="button"
					onClick={addCondition}
					className="w-full rounded-lg border border-dashed border-border/50 px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground"
				>
					+ Add condition
				</button>
			)}
		</div>
	);
}
