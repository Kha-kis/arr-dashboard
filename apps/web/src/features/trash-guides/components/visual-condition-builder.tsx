/**
 * Visual Condition Builder Component
 *
 * Build regex patterns visually without regex knowledge
 * - Field selection (Release Name, Source, Resolution, etc.)
 * - Operator selection (Contains, Starts With, Matches, etc.)
 * - Value input
 * - Live pattern generation
 * - Multiple conditions with AND/OR logic
 */

"use client";

import { useState, useMemo } from "react";
import { Button, Alert, AlertDescription, Select, SelectOption, Input } from "../../../components/ui";
import { Plus, Trash2, Info, Code } from "lucide-react";

interface Condition {
	id: string;
	field: string;
	operator: string;
	value: string;
	caseSensitive: boolean;
}

interface VisualConditionBuilderProps {
	initialPattern?: string;
	onPatternChange: (pattern: string) => void;
	onClose?: () => void;
}

const FIELDS = [
	{ value: "releaseTitle", label: "Release Name", description: "Full release/file name" },
	{ value: "source", label: "Source", description: "BluRay, WEB-DL, HDTV, etc." },
	{ value: "resolution", label: "Resolution", description: "720p, 1080p, 2160p, etc." },
	{ value: "hdr", label: "HDR Format", description: "HDR10, DV, HDR10+, HLG" },
	{ value: "audio", label: "Audio Codec", description: "DTS-HD, TrueHD, FLAC, AAC, etc." },
	{ value: "videoCodec", label: "Video Codec", description: "x264, x265, HEVC, AVC, etc." },
	{ value: "releaseGroup", label: "Release Group", description: "FraMeSToR, NTb, etc." },
	{ value: "edition", label: "Edition", description: "Director's Cut, Extended, etc." },
];

const OPERATORS = [
	{ value: "contains", label: "Contains", pattern: (v: string, cs: boolean) => cs ? v : `(?i)${v}` },
	{ value: "notContains", label: "Does Not Contain", pattern: (v: string, cs: boolean) => `^(?!.*(${cs ? v : `(?i)${v}`})).*$` },
	{ value: "startsWith", label: "Starts With", pattern: (v: string, cs: boolean) => `^${cs ? v : `(?i)${v}`}` },
	{ value: "endsWith", label: "Ends With", pattern: (v: string, cs: boolean) => `${cs ? v : `(?i)${v}`}$` },
	{ value: "equals", label: "Equals (Exact)", pattern: (v: string, cs: boolean) => `^${cs ? v : `(?i)${v}`}$` },
	{ value: "matches", label: "Matches Pattern (Regex)", pattern: (v: string) => v },
	{ value: "wordBoundary", label: "Word (Standalone)", pattern: (v: string, cs: boolean) => `\\b${cs ? v : `(?i)${v}`}\\b` },
	{ value: "isEmpty", label: "Is Empty", pattern: () => "^$" },
	{ value: "isNotEmpty", label: "Is Not Empty", pattern: () => ".+" },
];

// Common value presets for different fields
const FIELD_PRESETS: Record<string, string[]> = {
	resolution: ["720p", "1080p", "2160p", "4320p", "480p", "576p"],
	hdr: ["HDR10", "HDR10Plus", "HDR10\\+", "Dolby.?Vision", "\\bDV\\b", "HLG"],
	source: ["BluRay", "WEB-DL", "WEBRip", "HDTV", "REMUX", "DVD", "BR-DISK"],
	audio: ["DTS-HD\\.MA", "TrueHD", "FLAC", "AAC", "DD\\+", "EAC3", "Atmos", "DTS-X"],
	videoCodec: ["x264", "x265", "HEVC", "AVC", "H\\.264", "H\\.265", "VP9", "AV1"],
	edition: ["Director.*Cut", "Extended", "Unrated", "IMAX", "Remastered", "Theatrical"],
};

export function VisualConditionBuilder({
	initialPattern = "",
	onPatternChange,
	onClose,
}: VisualConditionBuilderProps) {
	const [conditions, setConditions] = useState<Condition[]>([
		{
			id: Date.now().toString(),
			field: "releaseTitle",
			operator: "contains",
			value: "",
			caseSensitive: false,
		},
	]);
	const [logicOperator, setLogicOperator] = useState<"AND" | "OR">("AND");

	// Generate regex pattern from conditions
	const generatedPattern = useMemo(() => {
		const validConditions = conditions.filter(c => c.value.trim() || c.operator === "isEmpty" || c.operator === "isNotEmpty");

		if (validConditions.length === 0) {
			return "";
		}

		const patterns = validConditions.map(condition => {
			const operator = OPERATORS.find(op => op.value === condition.operator);
			if (!operator) return "";

			const escapedValue = condition.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return operator.pattern(condition.operator === "matches" ? condition.value : escapedValue, condition.caseSensitive);
		});

		if (patterns.length === 1) {
			return patterns[0];
		}

		// Combine with AND/OR logic
		if (logicOperator === "AND") {
			// For AND, use positive lookahead for each condition
			return patterns.map(p => `(?=.*${p})`).join("") + ".*";
		} else {
			// For OR, just join with pipe
			return patterns.join("|");
		}
	}, [conditions, logicOperator]);

	// Apply generated pattern
	const applyPattern = () => {
		if (generatedPattern) {
			onPatternChange(generatedPattern);
			onClose?.();
		}
	};

	// Add new condition
	const addCondition = () => {
		setConditions([
			...conditions,
			{
				id: Date.now().toString(),
				field: "releaseTitle",
				operator: "contains",
				value: "",
				caseSensitive: false,
			},
		]);
	};

	// Remove condition
	const removeCondition = (id: string) => {
		if (conditions.length > 1) {
			setConditions(conditions.filter(c => c.id !== id));
		}
	};

	// Update condition
	const updateCondition = (id: string, updates: Partial<Condition>) => {
		setConditions(conditions.map(c =>
			c.id === id ? { ...c, ...updates } : c
		));
	};

	// Insert preset value
	const insertPreset = (conditionId: string, presetValue: string) => {
		updateCondition(conditionId, { value: presetValue });
	};

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h4 className="text-sm font-medium text-fg">Visual Condition Builder</h4>
				{onClose && (
					<Button size="sm" variant="ghost" onClick={onClose}>
						Close
					</Button>
				)}
			</div>

			<Alert>
				<Info className="h-4 w-4" />
				<AlertDescription className="text-xs">
					Build conditions visually. Each condition is converted to a regex pattern.
					Combine multiple conditions with AND/OR logic.
				</AlertDescription>
			</Alert>

			{/* Logic Operator (if multiple conditions) */}
			{conditions.length > 1 && (
				<div className="flex items-center gap-3 pb-2 border-b border-border/30">
					<span className="text-sm text-fg-muted">Combine conditions with:</span>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant={logicOperator === "AND" ? "primary" : "secondary"}
							onClick={() => setLogicOperator("AND")}
						>
							AND (All must match)
						</Button>
						<Button
							size="sm"
							variant={logicOperator === "OR" ? "primary" : "secondary"}
							onClick={() => setLogicOperator("OR")}
						>
							OR (Any can match)
						</Button>
					</div>
				</div>
			)}

			{/* Conditions */}
			<div className="space-y-3">
				{conditions.map((condition, index) => {
					const field = FIELDS.find(f => f.value === condition.field);
					const presets = FIELD_PRESETS[condition.field] || [];
					const showValueInput = !["isEmpty", "isNotEmpty"].includes(condition.operator);

					return (
						<div key={condition.id} className="rounded border border-border/30 p-3 space-y-3">
							{/* Header */}
							<div className="flex items-center justify-between">
								<span className="text-xs font-medium text-fg-muted">
									Condition {index + 1}
								</span>
								{conditions.length > 1 && (
									<Button
										size="sm"
										variant="ghost"
										onClick={() => removeCondition(condition.id)}
									>
										<Trash2 className="h-4 w-4" />
									</Button>
								)}
							</div>

							{/* Field Selection */}
							<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
								<div>
									<label className="block text-xs font-medium text-fg-muted mb-1">
										Field
									</label>
									<Select
										value={condition.field}
										onChange={(e) => updateCondition(condition.id, { field: e.target.value })}
										className="w-full"
									>
										{FIELDS.map(field => (
											<SelectOption key={field.value} value={field.value}>
												{field.label}
											</SelectOption>
										))}
									</Select>
									{field && (
										<p className="text-xs text-fg-muted mt-1">{field.description}</p>
									)}
								</div>

								{/* Operator Selection */}
								<div>
									<label className="block text-xs font-medium text-fg-muted mb-1">
										Operator
									</label>
									<Select
										value={condition.operator}
										onChange={(e) => updateCondition(condition.id, { operator: e.target.value })}
										className="w-full"
									>
										{OPERATORS.map(op => (
											<SelectOption key={op.value} value={op.value}>
												{op.label}
											</SelectOption>
										))}
									</Select>
								</div>
							</div>

							{/* Value Input */}
							{showValueInput && (
								<div>
									<label className="block text-xs font-medium text-fg-muted mb-1">
										Value
									</label>
									<Input
										type="text"
										value={condition.value}
										onChange={(e) => updateCondition(condition.id, { value: e.target.value })}
										className="w-full"
										placeholder={condition.operator === "matches" ? "Enter regex pattern..." : "Enter value..."}
									/>

									{/* Presets */}
									{presets.length > 0 && (
										<div className="mt-2">
											<p className="text-xs text-fg-muted mb-1">Quick Values:</p>
											<div className="flex flex-wrap gap-1">
												{presets.map((preset) => (
													<button
														key={preset}
														onClick={() => insertPreset(condition.id, preset)}
														className="px-2 py-1 text-xs rounded bg-bg-subtle/60 text-fg hover:bg-bg-subtle transition"
													>
														{preset}
													</button>
												))}
											</div>
										</div>
									)}
								</div>
							)}

							{/* Case Sensitive Toggle */}
							{showValueInput && condition.operator !== "matches" && (
								<div className="flex items-center gap-2">
									<input
										type="checkbox"
										id={`case-${condition.id}`}
										checked={condition.caseSensitive}
										onChange={(e) => updateCondition(condition.id, { caseSensitive: e.target.checked })}
										className="h-4 w-4 rounded border-border bg-bg-hover text-primary focus:ring-primary cursor-pointer"
									/>
									<label htmlFor={`case-${condition.id}`} className="text-sm text-fg cursor-pointer">
										Case sensitive
									</label>
								</div>
							)}
						</div>
					);
				})}
			</div>

			{/* Add Condition Button */}
			<Button
				size="sm"
				variant="secondary"
				onClick={addCondition}
				className="w-full"
			>
				<Plus className="h-4 w-4 mr-2" />
				Add Condition
			</Button>

			{/* Generated Pattern Preview */}
			{generatedPattern && (
				<div className="rounded bg-bg-subtle/40 p-3 border border-border/30">
					<div className="flex items-center gap-2 mb-2">
						<Code className="h-4 w-4 text-fg-muted" />
						<span className="text-xs font-medium text-fg-muted">Generated Pattern:</span>
					</div>
					<code className="text-xs font-mono text-fg break-all">
						{generatedPattern}
					</code>
				</div>
			)}

			{/* Actions */}
			<div className="flex justify-end gap-2 pt-2 border-t border-border/30">
				{onClose && (
					<Button variant="secondary" onClick={onClose}>
						Cancel
					</Button>
				)}
				<Button
					onClick={applyPattern}
					disabled={!generatedPattern}
				>
					Apply Pattern
				</Button>
			</div>
		</div>
	);
}
