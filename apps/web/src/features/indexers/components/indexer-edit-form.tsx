"use client";

import type { ProwlarrIndexerField } from "@arr/shared";
import { Check, Hash, Power, Settings } from "lucide-react";
import { useCallback } from "react";
import { Input } from "../../../components/ui/input";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { isSensitiveField } from "../lib/indexers-utils";

// ============================================================================
// Types
// ============================================================================

const NON_EDITABLE_TYPES = new Set(["info", "password", "hidden"]);
const NON_EDITABLE_NAMES = new Set(["baseUrl", "baseSettings", "definitionFile"]);

const isEditableField = (field: ProwlarrIndexerField): boolean => {
	if (isSensitiveField(field)) return false;
	if (field.type && NON_EDITABLE_TYPES.has(field.type)) return false;
	if (NON_EDITABLE_NAMES.has(field.name)) return false;
	return true;
};

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Toggle switch — compact on/off indicator
 */
const ToggleSwitch = ({
	checked,
	onChange,
	color,
}: {
	checked: boolean;
	onChange: (value: boolean) => void;
	color: string;
}) => (
	<button
		type="button"
		onClick={() => onChange(!checked)}
		className="relative h-5 w-9 rounded-full transition-colors duration-200 shrink-0"
		style={{
			backgroundColor: checked ? color : "rgba(var(--border), 0.4)",
		}}
	>
		<span
			className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200"
			style={{
				transform: checked ? "translateX(16px)" : "translateX(2px)",
			}}
		/>
	</button>
);

/**
 * Themed checkbox for boolean fields
 */
const ThemedCheckbox = ({
	checked,
	onChange,
	color,
}: {
	checked: boolean;
	onChange: () => void;
	color: string;
}) => (
	<button
		type="button"
		onClick={onChange}
		className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] transition-all duration-150 shrink-0"
		style={{
			backgroundColor: checked ? color : "transparent",
			border: `1.5px solid ${checked ? color : "rgba(var(--border), 0.5)"}`,
			boxShadow: checked ? `0 0 6px ${color}30` : "none",
		}}
	>
		{checked && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
	</button>
);

/**
 * Editable field — renders the appropriate input based on field type
 */
const EditableField = ({
	field,
	value,
	onChange,
}: {
	field: ProwlarrIndexerField;
	value: string | number | boolean | null | undefined;
	onChange: (name: string, newValue: string | number | boolean | null) => void;
}) => {
	const { gradient: themeGradient } = useThemeGradient();
	const fieldLabel = field.label ?? field.name;
	const fieldType = (field.type ?? "").toLowerCase();
	const fieldId = `indexer-field-${field.name}`;

	// Checkbox / boolean toggle
	if (fieldType === "checkbox" || typeof value === "boolean") {
		const checked = value === true;
		return (
			<div className="space-y-1 py-0.5">
				<label className="flex items-center gap-2.5 cursor-pointer group">
					<ThemedCheckbox
						checked={checked}
						onChange={() => onChange(field.name, !checked)}
						color={themeGradient.from}
					/>
					<span className="text-[13px] font-medium text-foreground/80 group-hover:text-foreground transition-colors">
						{fieldLabel}
					</span>
				</label>
				{field.helpText && (
					<p className="text-[10px] text-muted-foreground/50 leading-relaxed ml-[30px]">
						{field.helpText}
					</p>
				)}
			</div>
		);
	}

	// Select / dropdown
	if (fieldType === "select" && field.selectOptions && field.selectOptions.length > 0) {
		return (
			<div className="space-y-1.5">
				<label
					htmlFor={fieldId}
					className="text-[11px] font-medium text-muted-foreground/60 block"
				>
					{fieldLabel}
				</label>
				<select
					id={fieldId}
					value={value?.toString() ?? ""}
					onChange={(e) => {
						const raw = e.target.value;
						const numVal = Number(raw);
						onChange(field.name, !Number.isNaN(numVal) && raw.trim() !== "" ? numVal : raw);
					}}
					className="h-9 w-full rounded-lg bg-card/40 text-foreground text-[13px] px-3 focus:outline-none transition-all appearance-none"
					style={{
						border: "1px solid rgba(var(--border), 0.3)",
					}}
				>
					{field.selectOptions.map((opt) => (
						<option key={String(opt.value)} value={String(opt.value)}>
							{opt.name}
							{opt.hint ? ` — ${opt.hint}` : ""}
						</option>
					))}
				</select>
				{field.helpText && (
					<p className="text-[10px] text-muted-foreground/50 leading-relaxed">{field.helpText}</p>
				)}
			</div>
		);
	}

	// Number input
	if (fieldType === "number" || (typeof value === "number" && fieldType !== "textbox")) {
		return (
			<div className="space-y-1.5">
				<label
					htmlFor={fieldId}
					className="text-[11px] font-medium text-muted-foreground/60 block"
				>
					{fieldLabel}
				</label>
				<Input
					id={fieldId}
					type="number"
					value={value === null || value === undefined ? "" : String(value)}
					onChange={(e) => {
						const raw = e.target.value;
						if (raw.trim().length === 0) {
							onChange(field.name, null);
							return;
						}
						const parsed = Number(raw);
						if (!Number.isNaN(parsed)) {
							onChange(field.name, parsed);
						}
					}}
					className="h-9 rounded-lg border-border/30 bg-card/40 text-foreground text-[13px] focus:ring-1"
				/>
				{field.helpText && (
					<p className="text-[10px] text-muted-foreground/50 leading-relaxed">{field.helpText}</p>
				)}
			</div>
		);
	}

	// Default: text input
	return (
		<div className="space-y-1.5">
			<label
				htmlFor={fieldId}
				className="text-[11px] font-medium text-muted-foreground/60 block"
			>
				{fieldLabel}
			</label>
			<Input
				id={fieldId}
				type="text"
				value={value === null || value === undefined ? "" : String(value)}
				onChange={(e) => onChange(field.name, e.target.value)}
				className="h-9 rounded-lg border-border/30 bg-card/40 text-foreground text-[13px] focus:ring-1"
			/>
			{field.helpText && (
				<p className="text-[10px] text-muted-foreground/50 leading-relaxed">{field.helpText}</p>
			)}
		</div>
	);
};

// ============================================================================
// Main Component
// ============================================================================

/**
 * Indexer Edit Form — Refined controls
 *
 * Two zones:
 * 1. Core controls — Enable toggle + Priority input (always visible)
 * 2. Configuration fields — Dynamic inputs from Prowlarr (text, number, checkbox, select)
 *
 * Sensitive fields are excluded. Boolean fields render inline as checkboxes.
 */
export const IndexerEditForm = ({
	formEnable,
	formPriority,
	onEnableChange,
	onPriorityChange,
	fields,
	fieldValues,
	onFieldChange,
}: {
	formEnable: boolean;
	formPriority: number | undefined;
	onEnableChange: (enabled: boolean) => void;
	onPriorityChange: (priority: number | undefined) => void;
	fields?: ProwlarrIndexerField[];
	fieldValues?: Map<string, string | number | boolean | null>;
	onFieldChange?: (name: string, value: string | number | boolean | null) => void;
}) => {
	const { gradient: themeGradient } = useThemeGradient();

	const editableFields = (fields ?? []).filter(isEditableField);
	const booleanFields = editableFields.filter(
		(f) => (f.type ?? "").toLowerCase() === "checkbox" || typeof f.value === "boolean",
	);
	const nonBooleanFields = editableFields.filter(
		(f) => (f.type ?? "").toLowerCase() !== "checkbox" && typeof f.value !== "boolean",
	);

	const getFieldValue = useCallback(
		(field: ProwlarrIndexerField) => {
			if (fieldValues?.has(field.name)) {
				return fieldValues.get(field.name) ?? null;
			}
			return field.value ?? null;
		},
		[fieldValues],
	);

	const handleFieldChange = useCallback(
		(name: string, value: string | number | boolean | null) => {
			onFieldChange?.(name, value);
		},
		[onFieldChange],
	);

	return (
		<div className="space-y-5">
			{/* Core controls */}
			<div className="flex flex-wrap items-center gap-6">
				{/* Enable toggle */}
				<div className="flex items-center gap-3">
					<Power
						className="h-4 w-4"
						style={{
							color: formEnable
								? SEMANTIC_COLORS.success.from
								: "rgba(var(--muted-foreground), 0.3)",
						}}
					/>
					<ToggleSwitch
						checked={formEnable}
						onChange={onEnableChange}
						color={SEMANTIC_COLORS.success.from}
					/>
					<span className="text-[13px] font-medium text-foreground/80">
						{formEnable ? "Enabled" : "Disabled"}
					</span>
				</div>

				{/* Separator */}
				<span className="w-px h-5 bg-border/20" />

				{/* Priority */}
				<div className="flex items-center gap-2.5">
					<Hash className="h-3.5 w-3.5 text-muted-foreground/40" />
					<span className="text-[11px] font-medium text-muted-foreground/50">
						Priority
					</span>
					<Input
						type="number"
						value={formPriority === undefined ? "" : formPriority.toString()}
						onChange={(event) => {
							const raw = event.target.value;
							if (raw.trim().length === 0) {
								onPriorityChange(undefined);
								return;
							}
							const parsed = Number(raw);
							if (!Number.isNaN(parsed)) {
								onPriorityChange(parsed);
							}
						}}
						className="h-8 w-20 rounded-lg border-border/30 bg-card/40 text-foreground text-[13px] text-center font-mono focus:ring-1"
					/>
				</div>
			</div>

			{/* Configuration fields */}
			{editableFields.length > 0 && (
				<div className="space-y-4 pt-3 border-t border-border/15">
					<div className="flex items-center gap-2">
						<Settings className="h-3.5 w-3.5" style={{ color: themeGradient.from }} />
						<span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/50">
							Configuration
						</span>
					</div>

					{/* Non-boolean fields in grid */}
					{nonBooleanFields.length > 0 && (
						<div className="grid gap-4 sm:grid-cols-2">
							{nonBooleanFields.map((field) => (
								<EditableField
									key={field.name}
									field={field}
									value={getFieldValue(field)}
									onChange={handleFieldChange}
								/>
							))}
						</div>
					)}

					{/* Boolean fields inline */}
					{booleanFields.length > 0 && (
						<div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
							{booleanFields.map((field) => (
								<EditableField
									key={field.name}
									field={field}
									value={getFieldValue(field)}
									onChange={handleFieldChange}
								/>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
};
