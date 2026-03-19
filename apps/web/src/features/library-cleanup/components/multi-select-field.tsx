"use client";

import { Check, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useThemeGradient } from "@/hooks/useThemeGradient";

// ============================================================================
// Types
// ============================================================================

interface MultiSelectFieldProps {
	label: string;
	options: string[];
	selected: string[];
	onChange: (values: string[]) => void;
	loading?: boolean;
	inputClass: string;
	labelClass: string;
}

// ============================================================================
// Component
// ============================================================================

export function MultiSelectField({
	label,
	options,
	selected,
	onChange,
	loading,
	inputClass,
	labelClass,
}: MultiSelectFieldProps) {
	const { gradient } = useThemeGradient();
	const [filter, setFilter] = useState("");

	const filtered = useMemo(() => {
		if (!filter) return options;
		const lower = filter.toLowerCase();
		return options.filter((o) => o.toLowerCase().includes(lower));
	}, [options, filter]);

	const toggle = (value: string) => {
		onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
	};

	const selectAll = () => {
		const merged = new Set([...selected, ...filtered]);
		onChange([...merged]);
	};

	const clearAll = () => {
		if (filter) {
			// Only deselect filtered items
			const filteredSet = new Set(filtered);
			onChange(selected.filter((v) => !filteredSet.has(v)));
		} else {
			onChange([]);
		}
	};

	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between">
				<span className={labelClass}>{label}</span>
				{selected.length > 0 && (
					<span
						className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
						style={{ backgroundColor: `${gradient.from}20`, color: gradient.from }}
					>
						{selected.length} selected
					</span>
				)}
			</div>

			{loading ? (
				<div className="space-y-1.5">
					<div className="h-8 rounded-md bg-muted/30 animate-pulse" />
					<div className="h-24 rounded-md bg-muted/30 animate-pulse" />
				</div>
			) : options.length === 0 ? (
				<p className="text-xs text-muted-foreground italic py-2">
					No values found in your library. Sync your library first.
				</p>
			) : (
				<>
					{/* Search filter */}
					{options.length > 6 && (
						<div className="relative">
							<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
							<input
								type="text"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
								placeholder={`Filter ${label.toLowerCase()}...`}
								className={`${inputClass} pl-8 pr-7`}
							/>
							{filter && (
								<button
									type="button"
									onClick={() => setFilter("")}
									className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
								>
									<X className="h-3.5 w-3.5" />
								</button>
							)}
						</div>
					)}

					{/* Quick actions */}
					<div className="flex gap-2 text-[11px]">
						<button
							type="button"
							onClick={selectAll}
							className="text-muted-foreground hover:text-foreground transition-colors"
						>
							Select all{filter ? " visible" : ""}
						</button>
						<span className="text-border">|</span>
						<button
							type="button"
							onClick={clearAll}
							className="text-muted-foreground hover:text-foreground transition-colors"
						>
							Clear{filter ? " visible" : ""}
						</button>
					</div>

					{/* Checkbox list */}
					<div className="max-h-36 overflow-y-auto rounded-md border border-border/30 bg-background/30 p-1.5 space-y-0.5">
						{filtered.length === 0 ? (
							<p className="text-xs text-muted-foreground italic py-1 px-1">
								No matches for &ldquo;{filter}&rdquo;
							</p>
						) : (
							filtered.map((value) => {
								const isSelected = selected.includes(value);
								return (
									<label
										key={value}
										className="flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer text-sm hover:bg-muted/30 transition-colors"
									>
										<span
											className="flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors"
											style={
												isSelected
													? {
															backgroundColor: gradient.from,
															borderColor: gradient.from,
														}
													: { borderColor: "var(--border)" }
											}
										>
											{isSelected && <Check className="h-3 w-3 text-white" />}
										</span>
										<input
											type="checkbox"
											checked={isSelected}
											onChange={() => toggle(value)}
											className="sr-only"
										/>
										<span className="truncate">{value}</span>
									</label>
								);
							})
						)}
					</div>
				</>
			)}
		</div>
	);
}
