"use client";

/** Notification-only condition editor: flat `field_match` rows joined by AND. */

import { useRef } from "react";
import type {
	NotificationEditorCondition,
	NotificationEditorState,
} from "../lib/notification-rule-editor";

const FIELD_OPTIONS = [
	{ value: "eventType", label: "Event type" },
	{ value: "title", label: "Title" },
	{ value: "body", label: "Body" },
] as const;

const OPERATOR_OPTIONS = [
	{ value: "equals", label: "Equals" },
	{ value: "not_equals", label: "Does not equal" },
	{ value: "contains", label: "Contains" },
	{ value: "greater_than", label: "Greater than" },
	{ value: "in", label: "Is one of" },
] as const;

interface FieldMatchConditionEditorProps {
	state: NotificationEditorState;
	onChange: (next: NotificationEditorState) => void;
	inputClass: string;
	labelClass: string;
}

function seedCondition(id: string): NotificationEditorCondition {
	return { id, field: "eventType", operator: "equals", value: "" };
}

export function FieldMatchConditionEditor({
	state,
	onChange,
	inputClass,
	labelClass,
}: FieldMatchConditionEditorProps) {
	const nextId = useRef(0);

	const updateCondition = (id: string, patch: Partial<NotificationEditorCondition>) => {
		onChange({
			conditions: state.conditions.map((condition) =>
				condition.id === id ? { ...condition, ...patch } : condition,
			),
		});
	};

	const changeOperator = (condition: NotificationEditorCondition, operator: string) => {
		const value = operator === "in" ? [] : operator === "greater_than" ? 0 : "";
		updateCondition(condition.id, { operator, value });
	};

	const addCondition = () => {
		onChange({
			conditions: [...state.conditions, seedCondition(`new-${nextId.current++}`)],
		});
	};

	const removeCondition = (id: string) => {
		onChange({ conditions: state.conditions.filter((condition) => condition.id !== id) });
	};

	return (
		<div className="space-y-3">
			<p className="text-xs text-muted-foreground">
				Every condition must match. Notification rules use implicit AND ordering.
			</p>
			<div className="space-y-2">
				{state.conditions.map((condition, index) => (
					<div
						key={condition.id}
						className="space-y-3 rounded-lg border border-border/50 bg-card/20 p-3"
					>
						<div className="flex items-center justify-between">
							<span className="text-xs font-medium text-muted-foreground">
								Condition {index + 1}
							</span>
							{state.conditions.length > 1 && (
								<button
									type="button"
									onClick={() => removeCondition(condition.id)}
									className="text-xs text-muted-foreground transition-colors hover:text-destructive"
								>
									Remove
								</button>
							)}
						</div>

						<div className="grid gap-3 sm:grid-cols-2">
							<label>
								<span className={labelClass}>Field</span>
								<select
									aria-label={`Condition ${index + 1} field`}
									value={condition.field}
									onChange={(event) => updateCondition(condition.id, { field: event.target.value })}
									className={inputClass}
								>
									{!FIELD_OPTIONS.some((option) => option.value === condition.field) && (
										<option value={condition.field}>{condition.field} (existing field)</option>
									)}
									{FIELD_OPTIONS.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
							</label>
							<label>
								<span className={labelClass}>Operator</span>
								<select
									aria-label={`Condition ${index + 1} operator`}
									value={condition.operator}
									onChange={(event) => changeOperator(condition, event.target.value)}
									className={inputClass}
								>
									{OPERATOR_OPTIONS.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
							</label>
						</div>

						<label>
							<span className={labelClass}>
								{condition.operator === "in" ? "Values (comma-separated)" : "Value"}
							</span>
							<input
								aria-label={`Condition ${index + 1} value`}
								type={condition.operator === "greater_than" ? "number" : "text"}
								value={
									Array.isArray(condition.value)
										? condition.value.join(", ")
										: String(condition.value)
								}
								onChange={(event) => {
									const value =
										condition.operator === "in"
											? event.target.value
													.split(",")
													.map((entry) => entry.trim())
													.filter(Boolean)
											: condition.operator === "greater_than"
												? event.target.valueAsNumber
												: event.target.value;
									updateCondition(condition.id, { value });
								}}
								className={inputClass}
							/>
						</label>
					</div>
				))}
			</div>

			<button
				type="button"
				onClick={addCondition}
				className="w-full rounded-lg border border-dashed border-border/50 px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground"
			>
				+ Add condition
			</button>
		</div>
	);
}
