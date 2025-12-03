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

import { Code, Info, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
	Alert,
	AlertDescription,
	Button,
	Input,
	Select,
	SelectOption,
} from "../../../components/ui";

interface Condition {
	id: string;
	field: string;
	operator: string;
	value: string;
	caseSensitive: boolean;
}

interface VisualConditionBuilderProps {
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
	{
		value: "contains",
		label: "Contains",
		pattern: (v: string, cs: boolean) => (cs ? v : `(?i)${v}`),
	},
	{
		value: "notContains",
		label: "Does Not Contain",
		pattern: (v: string, cs: boolean) => (cs ? `^(?!.*${v}).*$` : `(?i)^(?!.*${v}).*$`),
	},
	{
		value: "startsWith",
		label: "Starts With",
		pattern: (v: string, cs: boolean) => (cs ? `^${v}` : `(?i)^${v}`),
	},
	{
		value: "endsWith",
		label: "Ends With",
		pattern: (v: string, cs: boolean) => (cs ? `${v}$` : `(?i)${v}$`),
	},
	{
		value: "equals",
		label: "Equals (Exact)",
		pattern: (v: string, cs: boolean) => (cs ? `^${v}$` : `(?i)^${v}$`),
	},
	{ value: "matches", label: "Matches Pattern (Regex)", pattern: (v: string) => v },
	{
		value: "wordBoundary",
		label: "Word (Standalone)",
		pattern: (v: string, cs: boolean) => (cs ? `\\b${v}\\b` : `(?i)\\b${v}\\b`),
	},
	{ value: "isEmpty", label: "Is Empty", pattern: () => "^$" },
	{ value: "isNotEmpty", label: "Is Not Empty", pattern: () => ".+" },
];

// Counter for generating unique condition IDs (avoids collisions with rapid additions)
let conditionIdCounter = 0;

// Common value presets for different fields
const FIELD_PRESETS: Record<string, string[]> = {
	resolution: ["720p", "1080p", "2160p", "4320p", "480p", "576p"],
	hdr: ["HDR10", "HDR10Plus", "HDR10\\+", "Dolby.?Vision", "\\bDV\\b", "HLG"],
	source: ["BluRay", "WEB-DL", "WEBRip", "HDTV", "REMUX", "DVD", "BR-DISK"],
	audio: ["DTS-HD\\.MA", "TrueHD", "FLAC", "AAC", "DD\\+", "EAC3", "Atmos", "DTS-X"],
	videoCodec: ["x264", "x265", "HEVC", "AVC", "H\\.264", "H\\.265", "VP9", "AV1"],
	edition: ["Director.*Cut", "Extended", "Unrated", "IMAX", "Remastered", "Theatrical"],
};

export function VisualConditionBuilder({ onPatternChange, onClose }: VisualConditionBuilderProps) {
	const [conditions, setConditions] = useState<Condition[]>(() => [
		{
			id: `condition-${++conditionIdCounter}-${Date.now()}`,
			field: "releaseTitle",
			operator: "contains",
			value: "",
			caseSensitive: false,
		},
	]);
	const [logicOperator, setLogicOperator] = useState<"AND" | "OR">("AND");

	// Positional operators that cannot use lookahead approach (use anchors in pattern)
	const POSITIONAL_OPERATORS = ["startsWith", "endsWith", "equals"];

	// Operators that use anchors in their patterns and break when wrapped in lookaheads
	// These need special handling for AND combinations
	const ANCHOR_OPERATORS = ["notContains", "isEmpty"];

	// Generate regex pattern from conditions
	const { generatedPattern, hasPositionalAnd, hasMixedCaseSensitivity } = useMemo(() => {
		const validConditions = conditions.filter(
			(c) => c.value.trim() || c.operator === "isEmpty" || c.operator === "isNotEmpty",
		);

		if (validConditions.length === 0) {
			return { generatedPattern: "", hasPositionalAnd: false, hasMixedCaseSensitivity: false };
		}

		const patterns = validConditions.map((condition) => {
			const operator = OPERATORS.find((op) => op.value === condition.operator);
			if (!operator) return "";

			const escapedValue = condition.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return operator.pattern(
				condition.operator === "matches" ? condition.value : escapedValue,
				condition.caseSensitive,
			);
		});

		if (patterns.length === 1) {
			return {
				generatedPattern: patterns[0],
				hasPositionalAnd: false,
				hasMixedCaseSensitivity: false,
			};
		}

		// Combine with AND/OR logic
		if (logicOperator === "AND") {
			// Check if any condition uses positional operators
			const hasPositional = validConditions.some((c) => POSITIONAL_OPERATORS.includes(c.operator));

			if (hasPositional) {
				// Cannot synthesize a single regex for AND with positional operators
				// Build a composed pattern when possible, otherwise signal that function-based matching is needed

				// Analyze the conditions to see if we can compose a valid anchored pattern
				const startsWithConditions = validConditions.filter((c) => c.operator === "startsWith");
				const endsWithConditions = validConditions.filter((c) => c.operator === "endsWith");
				const equalsConditions = validConditions.filter((c) => c.operator === "equals");
				const containsConditions = validConditions.filter((c) => c.operator === "contains");
				const otherConditions = validConditions.filter(
					(c) => !["startsWith", "endsWith", "equals", "contains"].includes(c.operator),
				);

				// If multiple startsWith, endsWith, or equals, or mixed equals with others - impossible to AND
				if (
					startsWithConditions.length > 1 ||
					endsWithConditions.length > 1 ||
					equalsConditions.length > 1 ||
					(equalsConditions.length > 0 &&
						(startsWithConditions.length > 0 ||
							endsWithConditions.length > 0 ||
							containsConditions.length > 0)) ||
					otherConditions.length > 0
				) {
					// Cannot synthesize - return a marker pattern that signals function-based matching needed
					return {
						generatedPattern: patterns.join(" && "),
						hasPositionalAnd: true,
						hasMixedCaseSensitivity: false,
					};
				}

				// Build composed pattern with per-segment case sensitivity using inline flags
				const allConditions = [
					...startsWithConditions,
					...containsConditions,
					...endsWithConditions,
				];

				// Detect mixed case sensitivity: some case-sensitive, some case-insensitive
				const caseSensitiveConditions = allConditions.filter((c) => c.caseSensitive);
				const caseInsensitiveConditions = allConditions.filter((c) => !c.caseSensitive);
				const hasMixed = caseSensitiveConditions.length > 0 && caseInsensitiveConditions.length > 0;

				// If mixed case sensitivity, we cannot compose a valid single regex pattern
				// because inline flags like (?i:...) don't work reliably across all regex engines
				// and the global (?i) flag would incorrectly affect all segments
				if (hasMixed) {
					return {
						generatedPattern: patterns.join(" && "),
						hasPositionalAnd: false,
						hasMixedCaseSensitivity: true,
					};
				}

				// All conditions have the same case sensitivity - safe to use global flag
				const useGlobalCaseInsensitive = caseInsensitiveConditions.length > 0;
				let composed = useGlobalCaseInsensitive ? "(?i)" : "";

				// Start anchor if startsWith present
				const startsWithCond = startsWithConditions[0];
				if (startsWithCond) {
					const escapedValue = startsWithCond.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					composed += `^${escapedValue}`;
				} else {
					composed += "^";
				}

				// Add .* and contains patterns
				for (const c of containsConditions) {
					const escapedValue = c.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					composed += `.*${escapedValue}`;
				}

				// End anchor if endsWith present
				const endsWithCond = endsWithConditions[0];
				if (endsWithCond) {
					const escapedValue = endsWithCond.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					composed += `.*${escapedValue}$`;
				} else {
					composed += ".*$";
				}

				return {
					generatedPattern: composed,
					hasPositionalAnd: false,
					hasMixedCaseSensitivity: false,
				};
			}

			// Check if any condition uses anchor-based operators (notContains, isEmpty)
			// These cannot be wrapped in lookaheads as the anchors break
			const hasAnchorOperators = validConditions.some((c) =>
				ANCHOR_OPERATORS.includes(c.operator),
			);

			if (hasAnchorOperators) {
				// Cannot synthesize - return a marker pattern that signals function-based matching needed
				return {
					generatedPattern: patterns.join(" && "),
					hasPositionalAnd: true,
					hasMixedCaseSensitivity: false,
				};
			}

			// No positional or anchor operators - safe to use lookahead approach
			// But first check for mixed case sensitivity
			const caseSensitiveCount = validConditions.filter((c) => c.caseSensitive).length;
			const caseInsensitiveCount = validConditions.filter((c) => !c.caseSensitive).length;
			const hasMixedCase = caseSensitiveCount > 0 && caseInsensitiveCount > 0;

			if (hasMixedCase) {
				// Cannot reliably combine mixed case sensitivity in lookaheads
				// because (?i) flag behavior varies across regex engines
				return {
					generatedPattern: patterns.join(" && "),
					hasPositionalAnd: false,
					hasMixedCaseSensitivity: true,
				};
			}

			return {
				generatedPattern: patterns.map((p) => `(?=.*${p})`).join("") + ".*",
				hasPositionalAnd: false,
				hasMixedCaseSensitivity: false,
			};
		} else {
			// For OR, just join with pipe
			return {
				generatedPattern: patterns.join("|"),
				hasPositionalAnd: false,
				hasMixedCaseSensitivity: false,
			};
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
				id: `condition-${++conditionIdCounter}-${Date.now()}`,
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
			setConditions(conditions.filter((c) => c.id !== id));
		}
	};

	// Update condition
	const updateCondition = (id: string, updates: Partial<Condition>) => {
		setConditions(conditions.map((c) => (c.id === id ? { ...c, ...updates } : c)));
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
					Build conditions visually. Each condition is converted to a regex pattern. Combine
					multiple conditions with AND/OR logic.
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
					const field = FIELDS.find((f) => f.value === condition.field);
					const presets = FIELD_PRESETS[condition.field] || [];
					const showValueInput = !["isEmpty", "isNotEmpty"].includes(condition.operator);

					return (
						<div key={condition.id} className="rounded border border-border/30 p-3 space-y-3">
							{/* Header */}
							<div className="flex items-center justify-between">
								<span className="text-xs font-medium text-fg-muted">Condition {index + 1}</span>
								{conditions.length > 1 && (
									<Button size="sm" variant="ghost" onClick={() => removeCondition(condition.id)}>
										<Trash2 className="h-4 w-4" />
									</Button>
								)}
							</div>

							{/* Field Selection */}
							<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
								<div>
									<label className="block text-xs font-medium text-fg-muted mb-1">Field</label>
									<Select
										value={condition.field}
										onChange={(e) => updateCondition(condition.id, { field: e.target.value })}
										className="w-full"
									>
										{FIELDS.map((field) => (
											<SelectOption key={field.value} value={field.value}>
												{field.label}
											</SelectOption>
										))}
									</Select>
									{field && <p className="text-xs text-fg-muted mt-1">{field.description}</p>}
								</div>

								{/* Operator Selection */}
								<div>
									<label className="block text-xs font-medium text-fg-muted mb-1">Operator</label>
									<Select
										value={condition.operator}
										onChange={(e) => updateCondition(condition.id, { operator: e.target.value })}
										className="w-full"
									>
										{OPERATORS.map((op) => (
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
									<label className="block text-xs font-medium text-fg-muted mb-1">Value</label>
									<Input
										type="text"
										value={condition.value}
										onChange={(e) => updateCondition(condition.id, { value: e.target.value })}
										className="w-full"
										placeholder={
											condition.operator === "matches" ? "Enter regex pattern..." : "Enter value..."
										}
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
										onChange={(e) =>
											updateCondition(condition.id, { caseSensitive: e.target.checked })
										}
										className="h-4 w-4 rounded border-border bg-bg-hover text-primary focus:ring-primary cursor-pointer"
									/>
									<label
										htmlFor={`case-${condition.id}`}
										className="text-sm text-fg cursor-pointer"
									>
										Case sensitive
									</label>
								</div>
							)}
						</div>
					);
				})}
			</div>

			{/* Add Condition Button */}
			<Button size="sm" variant="secondary" onClick={addCondition} className="w-full">
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
					<code className="text-xs font-mono text-fg break-all">{generatedPattern}</code>
					{hasPositionalAnd && (
						<Alert className="mt-3">
							<Info className="h-4 w-4" />
							<AlertDescription className="text-xs">
								<strong>Note:</strong> This combination of AND conditions with positional operators
								(Starts With, Ends With, Equals) cannot be expressed as a single regex pattern. The
								pattern shown uses &quot;&amp;&amp;&quot; notation to indicate multiple conditions
								that must all match. Consider using OR logic, or simplify to compatible conditions.
							</AlertDescription>
						</Alert>
					)}
					{hasMixedCaseSensitivity && (
						<Alert className="mt-3">
							<Info className="h-4 w-4" />
							<AlertDescription className="text-xs">
								<strong>Mixed Case Sensitivity:</strong> Your conditions have different case
								sensitivity settings which cannot be combined into a single regex pattern. Either
								make all conditions case-sensitive or all case-insensitive, or use OR logic to keep
								them separate.
							</AlertDescription>
						</Alert>
					)}
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
					disabled={!generatedPattern || hasPositionalAnd || hasMixedCaseSensitivity}
				>
					Apply Pattern
				</Button>
			</div>
		</div>
	);
}
