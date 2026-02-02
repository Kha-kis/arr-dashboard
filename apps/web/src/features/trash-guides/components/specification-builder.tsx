"use client";

import { useState } from "react";
import { Plus, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "../../../components/ui";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

/**
 * Common specification implementation types for Sonarr/Radarr custom formats.
 */
const IMPLEMENTATION_TYPES = [
	{ value: "ReleaseTitleSpecification", label: "Release Title" },
	{ value: "SourceSpecification", label: "Source" },
	{ value: "ResolutionSpecification", label: "Resolution" },
	{ value: "QualityModifierSpecification", label: "Quality Modifier" },
	{ value: "IndexerFlagSpecification", label: "Indexer Flag" },
	{ value: "LanguageSpecification", label: "Language" },
	{ value: "ReleaseGroupSpecification", label: "Release Group" },
	{ value: "SizeSpecification", label: "Size" },
	{ value: "EditionSpecification", label: "Edition" },
	{ value: "CustomFormatSpecification", label: "Custom Format" },
] as const;

export interface SpecificationData {
	name: string;
	implementation: string;
	negate: boolean;
	required: boolean;
	fields: Record<string, unknown>;
}

interface SpecificationBuilderProps {
	specifications: SpecificationData[];
	onChange: (specs: SpecificationData[]) => void;
}

export function SpecificationBuilder({ specifications, onChange }: SpecificationBuilderProps) {
	const { gradient } = useThemeGradient();
	const [expandedIndex, setExpandedIndex] = useState<number | null>(
		specifications.length === 0 ? null : 0,
	);

	const addSpecification = () => {
		const newSpec: SpecificationData = {
			name: "",
			implementation: "ReleaseTitleSpecification",
			negate: false,
			required: false,
			fields: { value: "" },
		};
		onChange([...specifications, newSpec]);
		setExpandedIndex(specifications.length);
	};

	const removeSpecification = (index: number) => {
		const updated = specifications.filter((_, i) => i !== index);
		onChange(updated);
		if (expandedIndex === index) {
			setExpandedIndex(null);
		} else if (expandedIndex !== null && expandedIndex > index) {
			setExpandedIndex(expandedIndex - 1);
		}
	};

	const updateSpecification = (index: number, updates: Partial<SpecificationData>) => {
		const updated = specifications.map((spec, i) =>
			i === index ? { ...spec, ...updates } : spec,
		);
		onChange(updated);
	};

	const updateField = (specIndex: number, fieldName: string, fieldValue: unknown) => {
		const spec = specifications[specIndex];
		if (!spec) return;
		const updatedFields = { ...spec.fields, [fieldName]: fieldValue };
		updateSpecification(specIndex, { fields: updatedFields });
	};

	const removeField = (specIndex: number, fieldName: string) => {
		const spec = specifications[specIndex];
		if (!spec) return;
		const { [fieldName]: _, ...rest } = spec.fields;
		updateSpecification(specIndex, { fields: rest });
	};

	const addField = (specIndex: number) => {
		const spec = specifications[specIndex];
		if (!spec) return;
		const existingKeys = Object.keys(spec.fields);
		let newKey = "value";
		let counter = 1;
		while (existingKeys.includes(newKey)) {
			newKey = `field${counter}`;
			counter++;
		}
		updateField(specIndex, newKey, "");
	};

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<label className="text-sm font-medium text-foreground">
					Specifications ({specifications.length})
				</label>
				<Button
					variant="outline"
					size="sm"
					onClick={addSpecification}
					className="gap-1.5"
				>
					<Plus className="h-3.5 w-3.5" />
					Add Spec
				</Button>
			</div>

			{specifications.length === 0 && (
				<div className="rounded-lg border border-dashed border-border/50 p-6 text-center text-sm text-muted-foreground">
					No specifications yet. Click &quot;Add Spec&quot; to define matching rules.
				</div>
			)}

			<div className="space-y-2">
				{specifications.map((spec, index) => {
					const isExpanded = expandedIndex === index;

					return (
						<div
							key={index}
							className="rounded-lg border border-border/50 bg-card/50 transition-all"
							style={isExpanded ? { borderColor: gradient.fromMuted } : undefined}
						>
							{/* Spec header */}
							<div
								className="flex items-center gap-2 p-3 cursor-pointer"
								onClick={() => setExpandedIndex(isExpanded ? null : index)}
							>
								{isExpanded ? (
									<ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
								) : (
									<ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
								)}
								<span className="flex-1 text-sm font-medium text-foreground truncate">
									{spec.name || `Specification ${index + 1}`}
								</span>
								<span className="text-xs text-muted-foreground shrink-0">
									{IMPLEMENTATION_TYPES.find(t => t.value === spec.implementation)?.label || spec.implementation}
								</span>
								{spec.negate && (
									<span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-medium text-red-400">
										Negate
									</span>
								)}
								{spec.required && (
									<span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
										Required
									</span>
								)}
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										removeSpecification(index);
									}}
									className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition"
									title="Remove specification"
								>
									<Trash2 className="h-3.5 w-3.5" />
								</button>
							</div>

							{/* Spec body */}
							{isExpanded && (
								<div className="border-t border-border/50 p-3 space-y-3">
									{/* Name */}
									<div>
										<label className="text-xs text-muted-foreground">Name</label>
										<input
											type="text"
											value={spec.name}
											onChange={(e) => updateSpecification(index, { name: e.target.value })}
											placeholder="e.g., Must contain 'REMUX'"
											className="mt-1 w-full rounded border border-border/50 bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary/50"
										/>
									</div>

									{/* Implementation type */}
									<div>
										<label className="text-xs text-muted-foreground">Type</label>
										<select
											value={spec.implementation}
											onChange={(e) =>
												updateSpecification(index, { implementation: e.target.value })
											}
											className="mt-1 w-full rounded border border-border/50 bg-background px-3 py-1.5 text-sm text-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary/50"
										>
											{IMPLEMENTATION_TYPES.map((type) => (
												<option key={type.value} value={type.value}>
													{type.label}
												</option>
											))}
											{/* Allow custom implementation types not in our list */}
											{!IMPLEMENTATION_TYPES.some(t => t.value === spec.implementation) && (
												<option value={spec.implementation}>{spec.implementation}</option>
											)}
										</select>
									</div>

									{/* Toggles */}
									<div className="flex items-center gap-4">
										<label className="flex items-center gap-2 text-sm cursor-pointer">
											<input
												type="checkbox"
												checked={spec.negate}
												onChange={(e) =>
													updateSpecification(index, { negate: e.target.checked })
												}
												className="h-4 w-4 rounded border-border bg-muted text-primary focus:ring-primary"
											/>
											<span className="text-foreground">Negate</span>
										</label>
										<label className="flex items-center gap-2 text-sm cursor-pointer">
											<input
												type="checkbox"
												checked={spec.required}
												onChange={(e) =>
													updateSpecification(index, { required: e.target.checked })
												}
												className="h-4 w-4 rounded border-border bg-muted text-primary focus:ring-primary"
											/>
											<span className="text-foreground">Required</span>
										</label>
									</div>

									{/* Fields */}
									<div className="space-y-2">
										<div className="flex items-center justify-between">
											<label className="text-xs text-muted-foreground">
												Fields ({Object.keys(spec.fields).length})
											</label>
											<button
												type="button"
												onClick={() => addField(index)}
												className="text-xs text-primary hover:text-primary/80 transition"
											>
												+ Add field
											</button>
										</div>
										{Object.entries(spec.fields).map(([key, value]) => (
											<div key={key} className="flex items-center gap-2">
												<input
													type="text"
													value={key}
													onChange={(e) => {
														const newKey = e.target.value;
														if (newKey === key) return;
														const newFields = { ...spec.fields };
														delete newFields[key];
														newFields[newKey] = value;
														updateSpecification(index, { fields: newFields });
													}}
													className="w-1/3 rounded border border-border/50 bg-background px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary/50"
													placeholder="Field name"
												/>
												<input
													type="text"
													value={typeof value === "string" ? value : JSON.stringify(value)}
													onChange={(e) => updateField(index, key, e.target.value)}
													className="flex-1 rounded border border-border/50 bg-background px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary/50"
													placeholder="Value"
												/>
												<button
													type="button"
													onClick={() => removeField(index, key)}
													className="rounded p-1 text-muted-foreground hover:text-destructive transition"
													title="Remove field"
												>
													<Trash2 className="h-3 w-3" />
												</button>
											</div>
										))}
									</div>
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
