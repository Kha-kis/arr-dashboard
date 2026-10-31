"use client";

import type { RuleCondition } from "@arr/shared";

type ValueDraft =
	| { type: "text"; raw: string }
	| { type: "number"; raw: string }
	| { type: "list"; entries: Array<{ key: number; value: string }> };

export interface ConditionDraft {
	key: number;
	field: string;
	customField: boolean;
	operator: RuleCondition["operator"];
	value: ValueDraft;
	valueConfirmed: boolean;
}

const FIELD_OPTIONS = [
	{ value: "eventType", label: "Event Type" },
	{ value: "title", label: "Title" },
	{ value: "body", label: "Body" },
];

const OPERATOR_OPTIONS: Array<{ value: RuleCondition["operator"]; label: string }> = [
	{ value: "equals", label: "equals" },
	{ value: "not_equals", label: "not equals" },
	{ value: "contains", label: "contains" },
	{ value: "greater_than", label: "greater than" },
	{ value: "in", label: "in (list)" },
];

function isBuiltInField(field: string) {
	return FIELD_OPTIONS.some((option) => option.value === field);
}

export function createConditionDraft(
	condition: RuleCondition,
	key: number,
	nextEntryKey: () => number,
	valueConfirmed = true,
): ConditionDraft {
	return {
		key,
		field: condition.field,
		customField: !isBuiltInField(condition.field),
		operator: condition.operator,
		value: Array.isArray(condition.value)
			? {
					type: "list",
					entries: condition.value.map((value) => ({ key: nextEntryKey(), value })),
				}
			: {
					type: typeof condition.value === "number" ? "number" : "text",
					raw: String(condition.value),
				},
		valueConfirmed,
	};
}

// Serialization validates the whole draft and emits only the public DTO.
// Blank strings/lists are literal values; confirmation is a local new-row gate.
export function serializeConditions(drafts: ConditionDraft[]): RuleCondition[] | null {
	const conditions: RuleCondition[] = [];
	for (const draft of drafts) {
		if (!draft.field || !draft.valueConfirmed) return null;
		let value: RuleCondition["value"];
		if (draft.value.type === "list") {
			value = draft.value.entries.map((entry) => entry.value);
		} else if (draft.value.type === "text") {
			value = draft.value.raw;
		} else {
			const raw = draft.value.raw.trim();
			// Complete decimal/exponent input only: Number("") is not a user's zero.
			if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return null;
			value = Number(raw);
			if (!Number.isFinite(value)) return null;
		}
		conditions.push({ field: draft.field, operator: draft.operator, value });
	}
	return conditions.length > 0 ? conditions : null;
}

function displayedValue(value: ValueDraft) {
	return value.type === "list" ? value.entries.map((entry) => entry.value).join(",") : value.raw;
}

function convertValue(
	value: ValueDraft,
	type: ValueDraft["type"],
	nextEntryKey: () => number,
): ValueDraft {
	if (type === value.type) return value;
	const raw = displayedValue(value);
	return type === "list" ? { type, entries: [{ key: nextEntryKey(), value: raw }] } : { type, raw };
}

interface Props {
	draft: ConditionDraft;
	incognitoMode: boolean;
	inputClass: string;
	nextEntryKey: () => number;
	onChange: (draft: ConditionDraft) => void;
}

export function NotificationRuleConditionEditor({
	draft,
	incognitoMode,
	inputClass,
	nextEntryKey,
	onChange,
}: Props) {
	const update = (patch: Partial<ConditionDraft>) => {
		if (incognitoMode) return;
		onChange({ ...draft, ...patch });
	};
	const literalField = draft.field !== "" && !isBuiltInField(draft.field);
	const valueDraft = draft.value;
	const controlClass = `${inputClass} min-w-0 w-full`;
	const buttonClass =
		"rounded-md border border-border/50 px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50";

	return (
		<div className="min-w-0 flex-1 space-y-2">
			<div className="grid gap-2 sm:grid-cols-3">
				<select
					aria-label="Condition field"
					value={incognitoMode ? "" : draft.field}
					disabled={incognitoMode}
					onChange={(event) =>
						update({ field: event.target.value, customField: event.target.value === "" })
					}
					className={controlClass}
				>
					{incognitoMode ? (
						<option value="">Hidden in incognito mode</option>
					) : (
						<option value="">Metadata/custom</option>
					)}
					{FIELD_OPTIONS.map((field) => (
						<option key={field.value} value={field.value}>
							{field.label}
						</option>
					))}
					{!incognitoMode && literalField && <option value={draft.field}>{draft.field}</option>}
				</select>
				<select
					aria-label="Condition operator"
					value={incognitoMode ? "" : draft.operator}
					disabled={incognitoMode}
					onChange={(event) => {
						if (incognitoMode) return;
						const operator = event.target.value as RuleCondition["operator"];
						update({
							operator,
							value:
								operator === "in" ? convertValue(valueDraft, "list", nextEntryKey) : valueDraft,
						});
					}}
					className={controlClass}
				>
					{incognitoMode && <option value="">Hidden in incognito mode</option>}
					{OPERATOR_OPTIONS.map((operator) => (
						<option key={operator.value} value={operator.value}>
							{operator.label}
						</option>
					))}
				</select>
				<select
					aria-label="Value type"
					value={incognitoMode ? "" : valueDraft.type}
					disabled={incognitoMode}
					onChange={(event) => {
						if (incognitoMode) return;
						update({
							value: convertValue(
								valueDraft,
								event.target.value as ValueDraft["type"],
								nextEntryKey,
							),
							valueConfirmed: true,
						});
					}}
					className={controlClass}
				>
					{incognitoMode && <option value="">Hidden in incognito mode</option>}
					<option value="text">Text</option>
					<option value="number">Number</option>
					<option value="list">List</option>
				</select>
			</div>
			{draft.customField && (
				<div className="space-y-1">
					<input
						aria-label="Field path"
						value={incognitoMode ? "" : draft.field}
						disabled={incognitoMode}
						onChange={(event) => update({ field: event.target.value })}
						placeholder="metadata.key"
						className={controlClass}
					/>
					<p className="text-xs text-muted-foreground">
						Metadata keys depend on the event. metadata.literal.key uses the literal key
						literal.key. Unknown or absent fields never match.
					</p>
				</div>
			)}
			{valueDraft.type === "list" ? (
				<div className="space-y-2">
					{valueDraft.entries.map((entry) => (
						<div key={entry.key} className="flex gap-2">
							<input
								aria-label="List value"
								value={incognitoMode ? "" : entry.value}
								disabled={incognitoMode}
								onChange={(event) =>
									update({
										value: {
											type: "list",
											entries: valueDraft.entries.map((item) =>
												item.key === entry.key ? { ...item, value: event.target.value } : item,
											),
										},
										valueConfirmed: true,
									})
								}
								placeholder="Value"
								className={controlClass}
							/>
							<button
								type="button"
								disabled={incognitoMode}
								onClick={() =>
									update({
										value: {
											type: "list",
											entries: valueDraft.entries.filter((item) => item.key !== entry.key),
										},
										valueConfirmed: true,
									})
								}
								className={buttonClass}
							>
								Remove value
							</button>
						</div>
					))}
					<button
						type="button"
						disabled={incognitoMode}
						onClick={() => {
							if (incognitoMode) return;
							const entry = { key: nextEntryKey(), value: "" };
							update({
								value: { type: "list", entries: [...valueDraft.entries, entry] },
								valueConfirmed: true,
							});
						}}
						className={buttonClass}
					>
						Add value
					</button>
					<p className="text-xs text-muted-foreground">
						Each entry is literal; commas and spaces are preserved. An empty membership list matches
						nothing.
					</p>
				</div>
			) : (
				<input
					aria-label="Condition value"
					type="text"
					inputMode={valueDraft.type === "number" ? "decimal" : undefined}
					value={incognitoMode ? "" : valueDraft.raw}
					disabled={incognitoMode}
					onChange={(event) =>
						update({ value: { ...valueDraft, raw: event.target.value }, valueConfirmed: true })
					}
					placeholder="Value"
					className={controlClass}
				/>
			)}
			{draft.operator === "in" && valueDraft.type !== "list" && (
				<p className="text-xs text-muted-foreground">
					A scalar membership value does not match. Choose List to explicitly convert it to one
					literal entry.
				</p>
			)}
			<p className="text-xs text-muted-foreground">
				Type changes convert the displayed value: scalar to one list entry; list to comma-joined
				text or number input. Empty values are literal conditions, not ignored placeholders.
			</p>
			{!draft.valueConfirmed && (
				<button
					type="button"
					disabled={incognitoMode}
					onClick={() => update({ valueConfirmed: true })}
					className={buttonClass}
				>
					Keep empty value
				</button>
			)}
		</div>
	);
}
