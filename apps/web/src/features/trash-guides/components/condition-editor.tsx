"use client";

/**
 * Condition Editor Component
 *
 * Allows users to enable/disable and edit individual custom format specifications
 * - Toggle individual conditions on/off
 * - View and edit regex patterns
 * - Test patterns against sample text
 * - Visual builder for non-technical users
 */

import { useState } from "react";
import {
	Settings,
	TestTube,
	Eye,
	EyeOff,
	CheckCircle,
	AlertCircle,
} from "lucide-react";
import { Input, Button } from "../../../components/ui";
import { PatternTester } from "./pattern-tester";

interface Specification {
	name: string;
	implementation: string;
	negate: boolean;
	required: boolean;
	fields: Record<string, unknown>;
	enabled?: boolean; // User override - undefined means use default
}

interface ConditionEditorProps {
	customFormatId: string;
	customFormatName: string;
	specifications: Specification[];
	onChange: (specs: Specification[]) => void;
	readonly?: boolean;
}

export function ConditionEditor({
	customFormatId,
	customFormatName,
	specifications: initialSpecs,
	onChange,
	readonly = false,
}: ConditionEditorProps) {
	const [specifications, setSpecifications] = useState<Specification[]>(
		initialSpecs.map(spec => ({
			...spec,
			enabled: spec.enabled ?? true, // Default to enabled
		}))
	);
	const [editingSpec, setEditingSpec] = useState<number | null>(null);
	const [testingSpec, setTestingSpec] = useState<number | null>(null);

	const enabledCount = specifications.filter(s => s.enabled).length;
	const totalCount = specifications.length;

	// Toggle specification on/off
	const toggleSpecification = (index: number) => {
		if (readonly) return;

		const updated = [...specifications];
		const spec = updated[index];
		if (spec) {
			updated[index] = {
				...spec,
				enabled: !spec.enabled,
			};
			setSpecifications(updated);
			onChange(updated);
		}
	};

	// Update specification fields
	const updateSpecification = (index: number, fields: Record<string, unknown>) => {
		if (readonly) return;

		const updated = [...specifications];
		const spec = updated[index];
		if (spec) {
			updated[index] = {
				...spec,
				fields: { ...spec.fields, ...fields },
			};
			setSpecifications(updated);
			onChange(updated);
		}
	};

	// Get pattern from specification fields and return both value and key name
	const getPattern = (spec: Specification): { value: string; key: string } => {
		if (spec.implementation === "ReleaseTitleSpecification") {
			return {
				value: String(spec.fields.value || ""),
				key: "value",
			};
		}
		// Check which key exists - prefer pattern if both exist, otherwise use whichever is present
		if ("pattern" in spec.fields && spec.fields.pattern !== undefined) {
			return {
				value: String(spec.fields.pattern || ""),
				key: "pattern",
			};
		}
		if ("value" in spec.fields && spec.fields.value !== undefined) {
			return {
				value: String(spec.fields.value || ""),
				key: "value",
			};
		}
		// Default to "value" if neither exists
		return {
			value: "",
			key: "value",
		};
	};

	// Check if pattern is valid regex
	const isValidPattern = (pattern: string): boolean => {
		if (!pattern) return false;
		try {
			new RegExp(pattern);
			return true;
		} catch {
			return false;
		}
	};

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="border-b border-border/30 pb-3">
				<h3 className="text-lg font-semibold text-foregroundflex items-center gap-2">
					<Settings className="h-5 w-5" />
					{customFormatName}
				</h3>
				<p className="text-sm text-muted-foreground mt-1">
					{enabledCount} of {totalCount} conditions enabled
				</p>
			</div>

			{/* Specifications Table */}
			<div className="space-y-2">
				{specifications.map((spec, index) => {
					const patternInfo = getPattern(spec);
					const pattern = patternInfo.value;
					const patternKey = patternInfo.key;
					const isValid = isValidPattern(pattern);
					const isEditing = editingSpec === index;
					const isTesting = testingSpec === index;

					return (
						<div
							key={index}
							className={`rounded border transition-all ${
								spec.enabled
									? "border-border/40 bg-card/20"
									: "border-border/20 bg-card/10 opacity-50"
							}`}
						>
							{/* Main Row */}
							<div className="flex items-center gap-3 p-3">
								{/* Checkbox */}
								<input
									type="checkbox"
									checked={spec.enabled ?? true}
									onChange={() => toggleSpecification(index)}
									disabled={readonly || spec.required}
									className="h-4 w-4 rounded border-border/50 bg-muted text-primary focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
								/>

								{/* Name and Badges */}
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2">
										<span className="font-medium text-foregroundtext-sm">
											{spec.name}
										</span>
										{spec.required && (
											<span className="inline-flex items-center rounded bg-red-500/20 px-1.5 py-0.5 text-xs font-medium text-red-300">
												Required
											</span>
										)}
										{spec.negate && (
											<span className="inline-flex items-center rounded bg-amber-500/20 px-1.5 py-0.5 text-xs font-medium text-amber-300">
												NOT
											</span>
										)}
									</div>

									{/* Pattern Display */}
									{pattern && (
										<div className="mt-1 flex items-center gap-2">
											<code className="text-xs font-mono text-muted-foreground truncate">
												{pattern}
											</code>
											{isValid ? (
												<CheckCircle className="h-3 w-3 text-green-400 shrink-0" />
											) : (
												<AlertCircle className="h-3 w-3 text-red-400 shrink-0" />
											)}
										</div>
									)}
								</div>

								{/* Action Buttons */}
								{!readonly && spec.enabled && (
									<div className="flex items-center gap-1">
										<Button
											variant="ghost"
											size="sm"
											onClick={() => setTestingSpec(isTesting ? null : index)}
											title="Test pattern"
										>
											<TestTube className="h-4 w-4" />
										</Button>
										<Button
											variant="ghost"
											size="sm"
											onClick={() => setEditingSpec(isEditing ? null : index)}
											title={isEditing ? "Close editor" : "Edit pattern"}
										>
											{isEditing ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
										</Button>
									</div>
								)}
							</div>

							{/* Pattern Editor */}
							{isEditing && !readonly && spec.enabled && (
								<div className="border-t border-border/30 p-3 bg-card/30">
									<label className="block text-xs font-medium text-muted-foreground mb-2">
										Regex Pattern
									</label>
									<textarea
										value={pattern}
										onChange={(e) => {
											// Write back to the same key that was read from
											updateSpecification(index, {
												[patternKey]: e.target.value,
											});
										}}
										rows={2}
										className="w-full rounded-xl border border-border bg-card px-4 py-3 text-xs font-mono text-foregroundplaceholder:text-muted-foreground/60 transition-all duration-200 hover:border-border/80 hover:bg-card/80 focus:border-primary focus:outline-hidden focus:ring-2 focus:ring-primary/20 focus:bg-card/80"
										placeholder="Enter regex pattern..."
									/>
									<p className="text-xs text-muted-foreground mt-2">
										Use <code className="px-1 py-0.5 rounded bg-card/60">\b</code> for word boundaries,
										<code className="px-1 py-0.5 rounded bg-card/60">.*</code> for any characters,
										<code className="px-1 py-0.5 rounded bg-card/60">|</code> for OR
									</p>
								</div>
							)}

							{/* Pattern Tester */}
							{isTesting && spec.enabled && (
								<div className="border-t border-border/30 p-3 bg-card/30">
									<PatternTester
										pattern={pattern}
										negate={spec.negate}
										onClose={() => setTestingSpec(null)}
									/>
								</div>
							)}
						</div>
					);
				})}
			</div>

			{/* Footer Actions */}
			{!readonly && (
				<div className="flex items-center justify-between pt-2 border-t border-border/30">
					<div className="text-sm text-muted-foreground">
						{enabledCount === totalCount ? (
							<span className="text-green-400">All conditions enabled</span>
						) : enabledCount === 0 ? (
							<span className="text-red-400">All conditions disabled</span>
						) : (
							<span>
								<span className="font-medium text-foreground">{enabledCount}</span> / {totalCount} enabled
							</span>
						)}
					</div>

					<div className="flex gap-2">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								const updated = specifications.map(s => ({ ...s, enabled: true }));
								setSpecifications(updated);
								onChange(updated);
							}}
						>
							Enable All
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								const updated = specifications.map(s =>
									s.required ? s : { ...s, enabled: false }
								);
								setSpecifications(updated);
								onChange(updated);
							}}
						>
							Disable Optional
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}
