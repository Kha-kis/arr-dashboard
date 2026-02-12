/**
 * Auto-Import Section Component
 *
 * Enhanced auto-import configuration with pattern visibility.
 * Shows safe patterns (built-in + custom) and never-import patterns.
 * Extracted from queue-cleaner-config.tsx for maintainability.
 */

"use client";

import { useState } from "react";
import {
	Plus,
	Sparkles,
	ChevronDown,
	ChevronUp,
	CheckCircle2,
	Ban,
	FileText,
	X,
} from "lucide-react";
import { Button } from "../../../components/ui";
import {
	MIN_AUTO_IMPORT_ATTEMPTS,
	MAX_AUTO_IMPORT_ATTEMPTS,
	MIN_AUTO_IMPORT_COOLDOWN_MINS,
	MAX_AUTO_IMPORT_COOLDOWN_MINS,
	AUTO_IMPORT_SAFE_PATTERNS,
	AUTO_IMPORT_NEVER_PATTERNS,
} from "../lib/constants";
import type { QueueCleanerConfigUpdate } from "../lib/queue-cleaner-types";
import { ToggleRow, ConfigInput } from "./queue-cleaner-config-ui";

export const AutoImportSection = ({
	formData,
	updateField,
}: {
	formData: QueueCleanerConfigUpdate;
	updateField: <K extends keyof QueueCleanerConfigUpdate>(key: K, value: QueueCleanerConfigUpdate[K]) => void;
}) => {
	const [showSafePatterns, setShowSafePatterns] = useState(false);
	const [showNeverPatterns, setShowNeverPatterns] = useState(false);

	// Parse custom safe patterns from JSON
	const customSafePatterns: string[] = (() => {
		const json = formData.autoImportCustomPatterns;
		if (!json) return [];
		try {
			const parsed = JSON.parse(json);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	})();

	// Parse custom never patterns from JSON
	const customNeverPatterns: string[] = (() => {
		const json = formData.autoImportNeverPatterns;
		if (!json) return [];
		try {
			const parsed = JSON.parse(json);
			return Array.isArray(parsed) ? parsed : [];
		} catch {
			return [];
		}
	})();

	const updateCustomSafePatterns = (patterns: string[]) => {
		updateField("autoImportCustomPatterns", patterns.length > 0 ? JSON.stringify(patterns) : null);
	};

	const updateCustomNeverPatterns = (patterns: string[]) => {
		updateField("autoImportNeverPatterns", patterns.length > 0 ? JSON.stringify(patterns) : null);
	};

	const addCustomSafePattern = (pattern: string) => {
		const trimmed = pattern.trim().toLowerCase();
		if (trimmed && !customSafePatterns.includes(trimmed) && !AUTO_IMPORT_SAFE_PATTERNS.includes(trimmed as typeof AUTO_IMPORT_SAFE_PATTERNS[number])) {
			updateCustomSafePatterns([...customSafePatterns, trimmed]);
		}
	};

	const removeCustomSafePattern = (index: number) => {
		updateCustomSafePatterns(customSafePatterns.filter((_, i) => i !== index));
	};

	const addCustomNeverPattern = (pattern: string) => {
		const trimmed = pattern.trim().toLowerCase();
		if (trimmed && !customNeverPatterns.includes(trimmed) && !AUTO_IMPORT_NEVER_PATTERNS.includes(trimmed as typeof AUTO_IMPORT_NEVER_PATTERNS[number])) {
			updateCustomNeverPatterns([...customNeverPatterns, trimmed]);
		}
	};

	const removeCustomNeverPattern = (index: number) => {
		updateCustomNeverPatterns(customNeverPatterns.filter((_, i) => i !== index));
	};

	return (
		<div className="space-y-3 pt-3 border-t border-border/30">
			{/* Header */}
			<div className="flex items-center gap-2">
				<Sparkles className="h-4 w-4 text-amber-500" />
				<h6 className="text-xs font-semibold text-foreground">Auto-Import (Experimental)</h6>
			</div>

			{/* Main toggle */}
			<ToggleRow
				label="Try auto-import before removal"
				description="Attempt to import completed downloads via ARR API before falling back to removal"
				checked={formData.autoImportEnabled ?? false}
				onChange={(v) => updateField("autoImportEnabled", v)}
			/>

			{formData.autoImportEnabled && (
				<div className="space-y-4 pl-1">
					{/* Safe patterns mode toggle with enhanced description */}
					<div className="space-y-2">
						<ToggleRow
							label="Safe patterns only"
							description={
								formData.autoImportSafeOnly ?? true
									? "ON: Only imports items matching safe patterns below (recommended)"
									: "OFF: Attempts import on ANY pending/blocked item (use with caution)"
							}
							checked={formData.autoImportSafeOnly ?? true}
							onChange={(v) => updateField("autoImportSafeOnly", v)}
						/>
					</div>

					{/* Safe Patterns Section (Collapsible) */}
					<div className="border border-border/30 rounded-lg overflow-hidden">
						<button
							type="button"
							className="w-full flex items-center justify-between p-2.5 bg-card/30 hover:bg-card/50 transition-colors"
							onClick={() => setShowSafePatterns(!showSafePatterns)}
						>
							<div className="flex items-center gap-2">
								<CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
								<span className="text-xs font-medium text-foreground">
									Safe Patterns ({AUTO_IMPORT_SAFE_PATTERNS.length + customSafePatterns.length})
								</span>
							</div>
							{showSafePatterns ? (
								<ChevronUp className="h-4 w-4 text-muted-foreground" />
							) : (
								<ChevronDown className="h-4 w-4 text-muted-foreground" />
							)}
						</button>

						{showSafePatterns && (
							<div className="p-2.5 space-y-3 border-t border-border/20 bg-card/20">
								<p className="text-[10px] text-muted-foreground">
									Items matching these patterns CAN be auto-imported. Built-in patterns are based on common ARR status messages.
								</p>

								{/* Built-in patterns */}
								<div className="space-y-1">
									<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Built-in</span>
									<div className="flex flex-wrap gap-1">
										{AUTO_IMPORT_SAFE_PATTERNS.map((pattern) => (
											<span
												key={pattern}
												className="inline-flex items-center px-2 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
											>
												{pattern}
											</span>
										))}
									</div>
								</div>

								{/* Custom patterns */}
								<div className="space-y-1.5">
									<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Custom</span>
									{customSafePatterns.length > 0 ? (
										<div className="flex flex-wrap gap-1">
											{customSafePatterns.map((pattern, index) => (
												<span
													key={pattern}
													className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20"
												>
													{pattern}
													<button
														type="button"
														onClick={() => removeCustomSafePattern(index)}
														className="hover:text-red-400 transition-colors"
													>
														<X className="h-2.5 w-2.5" />
													</button>
												</span>
											))}
										</div>
									) : (
										<p className="text-[10px] text-muted-foreground/50 italic">No custom patterns added</p>
									)}

									{/* Add custom pattern input */}
									<div className="flex gap-1.5 mt-2">
										<input
											type="text"
											placeholder="Add custom pattern..."
											className="flex-1 rounded-md border border-border/50 bg-card/50 px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
											onKeyDown={(e) => {
												if (e.key === "Enter") {
													e.preventDefault();
													const input = e.currentTarget;
													addCustomSafePattern(input.value);
													input.value = "";
												}
											}}
										/>
										<Button
											variant="secondary"
											size="sm"
											className="h-6 px-2 text-[10px]"
											onClick={(e) => {
												const input = e.currentTarget.previousElementSibling as HTMLInputElement;
												if (input?.value) {
													addCustomSafePattern(input.value);
													input.value = "";
												}
											}}
										>
											<Plus className="h-3 w-3" />
										</Button>
									</div>
								</div>
							</div>
						)}
					</div>

					{/* Never-Import Patterns Section (Collapsible) */}
					<div className="border border-border/30 rounded-lg overflow-hidden">
						<button
							type="button"
							className="w-full flex items-center justify-between p-2.5 bg-card/30 hover:bg-card/50 transition-colors"
							onClick={() => setShowNeverPatterns(!showNeverPatterns)}
						>
							<div className="flex items-center gap-2">
								<Ban className="h-3.5 w-3.5 text-red-500" />
								<span className="text-xs font-medium text-foreground">
									Never Import ({AUTO_IMPORT_NEVER_PATTERNS.length + customNeverPatterns.length})
								</span>
							</div>
							{showNeverPatterns ? (
								<ChevronUp className="h-4 w-4 text-muted-foreground" />
							) : (
								<ChevronDown className="h-4 w-4 text-muted-foreground" />
							)}
						</button>

						{showNeverPatterns && (
							<div className="p-2.5 space-y-3 border-t border-border/20 bg-card/20">
								<p className="text-[10px] text-muted-foreground">
									Items matching these patterns are BLOCKED from auto-import. These will never be attempted.
								</p>

								{/* Built-in never patterns */}
								<div className="space-y-1">
									<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Built-in</span>
									<div className="flex flex-wrap gap-1">
										{AUTO_IMPORT_NEVER_PATTERNS.map((pattern) => (
											<span
												key={pattern}
												className="inline-flex items-center px-2 py-0.5 rounded text-[10px] bg-red-500/10 text-red-400 border border-red-500/20"
											>
												{pattern}
											</span>
										))}
									</div>
								</div>

								{/* Custom never patterns */}
								<div className="space-y-1.5">
									<span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Custom</span>
									{customNeverPatterns.length > 0 ? (
										<div className="flex flex-wrap gap-1">
											{customNeverPatterns.map((pattern, index) => (
												<span
													key={pattern}
													className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-orange-500/10 text-orange-400 border border-orange-500/20"
												>
													{pattern}
													<button
														type="button"
														onClick={() => removeCustomNeverPattern(index)}
														className="hover:text-red-400 transition-colors"
													>
														<X className="h-2.5 w-2.5" />
													</button>
												</span>
											))}
										</div>
									) : (
										<p className="text-[10px] text-muted-foreground/50 italic">No custom patterns added</p>
									)}

									{/* Add custom never pattern input */}
									<div className="flex gap-1.5 mt-2">
										<input
											type="text"
											placeholder="Add pattern to block..."
											className="flex-1 rounded-md border border-border/50 bg-card/50 px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
											onKeyDown={(e) => {
												if (e.key === "Enter") {
													e.preventDefault();
													const input = e.currentTarget;
													addCustomNeverPattern(input.value);
													input.value = "";
												}
											}}
										/>
										<Button
											variant="secondary"
											size="sm"
											className="h-6 px-2 text-[10px]"
											onClick={(e) => {
												const input = e.currentTarget.previousElementSibling as HTMLInputElement;
												if (input?.value) {
													addCustomNeverPattern(input.value);
													input.value = "";
												}
											}}
										>
											<Plus className="h-3 w-3" />
										</Button>
									</div>
								</div>
							</div>
						)}
					</div>

					{/* Settings */}
					<div className="space-y-3 pt-2">
						<ConfigInput
							label="Max Import Attempts"
							description="Stop trying after this many failed attempts per item"
							value={formData.autoImportMaxAttempts ?? 2}
							onChange={(v) => updateField("autoImportMaxAttempts", v)}
							min={MIN_AUTO_IMPORT_ATTEMPTS}
							max={MAX_AUTO_IMPORT_ATTEMPTS}
							suffix="attempts"
						/>
						<ConfigInput
							label="Retry Cooldown"
							description="Wait this long between import attempts on the same item"
							value={formData.autoImportCooldownMins ?? 30}
							onChange={(v) => updateField("autoImportCooldownMins", v)}
							min={MIN_AUTO_IMPORT_COOLDOWN_MINS}
							max={MAX_AUTO_IMPORT_COOLDOWN_MINS}
							suffix="mins"
						/>
					</div>

					{/* How it works info box */}
					<div className="text-xs text-muted-foreground p-2.5 rounded-lg bg-card/30 border border-border/30 space-y-1.5">
						<div className="flex items-center gap-1.5">
							<FileText className="h-3.5 w-3.5" />
							<span className="font-medium">How auto-import works:</span>
						</div>
						<ol className="list-decimal list-inside space-y-0.5 ml-1 text-[11px]">
							<li>Detects items stuck in import pending/blocked state</li>
							<li>Checks eligibility (safe patterns, cooldown, max attempts)</li>
							<li>Triggers import via ARR&apos;s manual import API</li>
							<li>If import fails, falls back to normal removal behavior</li>
						</ol>
					</div>
				</div>
			)}
		</div>
	);
};
