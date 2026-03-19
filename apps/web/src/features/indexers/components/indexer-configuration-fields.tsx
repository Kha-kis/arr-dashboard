"use client";

import type { ProwlarrIndexerField } from "@arr/shared";
import { Check, Copy, Eye, EyeOff, Lock, Settings } from "lucide-react";
import { useCallback, useState } from "react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { formatFieldValue, isSensitiveField } from "../lib/indexers-utils";

/**
 * Configuration field row — clean inline layout
 */
const FieldRow = ({
	field,
	index,
	sensitive,
	revealed,
}: {
	field: ProwlarrIndexerField;
	index: number;
	sensitive: boolean;
	revealed: boolean;
}) => {
	const [copied, setCopied] = useState(false);
	const displayValue = formatFieldValue(field.name, field.value);
	const masked = sensitive && !revealed;

	const handleCopy = useCallback(() => {
		if (!field.value) return;
		void navigator.clipboard.writeText(String(field.value)).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}, [field.value]);

	return (
		<div
			className="group py-2.5 animate-in fade-in duration-200"
			style={{
				animationDelay: `${index * 25}ms`,
				animationFillMode: "backwards",
			}}
		>
			<div className="flex items-start gap-3">
				{/* Label */}
				<div className="w-[140px] sm:w-[180px] shrink-0 pt-0.5">
					<p className="text-[11px] font-medium text-muted-foreground/60 leading-tight">
						{field.label ?? field.name}
					</p>
				</div>

				{/* Value */}
				<div className="flex-1 min-w-0 flex items-center gap-2">
					{sensitive && <Lock className="h-3 w-3 text-muted-foreground/30 shrink-0" />}
					<p className={`text-[13px] font-medium leading-tight min-w-0 ${masked ? "select-none" : ""}`}>
						{masked ? (
							<span className="text-muted-foreground/30 tracking-[0.2em] font-mono text-xs">
								{"●".repeat(Math.min(displayValue.length, 20))}
							</span>
						) : (
							<span className="text-foreground/90 break-all">{displayValue}</span>
						)}
					</p>
					{sensitive && field.value != null && (
						<button
							type="button"
							onClick={handleCopy}
							className="shrink-0 rounded-md p-1 text-muted-foreground/30 hover:text-foreground hover:bg-card/60 transition-all opacity-0 group-hover:opacity-100"
							title={copied ? "Copied!" : "Copy value"}
						>
							{copied ? (
								<Check className="h-3 w-3 text-green-500" />
							) : (
								<Copy className="h-3 w-3" />
							)}
						</button>
					)}
				</div>
			</div>

			{/* Help text — full description below the key-value row */}
			{field.helpText && (
				<p className="text-[10px] text-muted-foreground/40 leading-relaxed mt-1 ml-[152px] sm:ml-[192px]">
					{field.helpText}
				</p>
			)}
		</div>
	);
};

/**
 * Configuration Fields — Refined row layout
 *
 * Clean list of key-value rows with:
 * - Normal fields shown immediately
 * - Sensitive fields behind a toggle
 * - Copy button appears on hover for sensitive values
 * - Subtle dividers between rows
 */
export const IndexerConfigurationFields = ({ fields }: { fields: ProwlarrIndexerField[] }) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [showSensitive, setShowSensitive] = useState(false);

	const normalFields: ProwlarrIndexerField[] = [];
	const sensitiveFields: ProwlarrIndexerField[] = [];
	for (const field of fields) {
		if (isSensitiveField(field)) {
			sensitiveFields.push(field);
		} else {
			normalFields.push(field);
		}
	}

	if (normalFields.length === 0 && sensitiveFields.length === 0) {
		return null;
	}

	return (
		<div
			className="rounded-lg border border-border/20 bg-card/20 p-4 animate-in fade-in duration-300"
			style={{ animationDelay: "250ms", animationFillMode: "backwards" }}
		>
			{/* Header */}
			<div className="flex items-center justify-between mb-1">
				<div className="flex items-center gap-2">
					<Settings className="h-3.5 w-3.5" style={{ color: themeGradient.from }} />
					<span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/50">
						Configuration
					</span>
					<span className="text-[10px] text-muted-foreground/30 font-mono">
						{normalFields.length + sensitiveFields.length}
					</span>
				</div>

				{sensitiveFields.length > 0 && (
					<button
						type="button"
						onClick={() => setShowSensitive((prev) => !prev)}
						className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-all hover:bg-card/60"
						style={{
							color: showSensitive ? themeGradient.from : undefined,
						}}
					>
						{showSensitive ? (
							<>
								<EyeOff className="h-3 w-3" />
								Hide secrets
							</>
						) : (
							<>
								<Eye className="h-3 w-3" />
								{sensitiveFields.length} secret{sensitiveFields.length !== 1 ? "s" : ""}
							</>
						)}
					</button>
				)}
			</div>

			{/* Normal fields */}
			{normalFields.length > 0 && (
				<div className="divide-y divide-border/10">
					{normalFields.map((field, index) => (
						<FieldRow
							key={field.name}
							field={field}
							index={index}
							sensitive={false}
							revealed
						/>
					))}
				</div>
			)}

			{/* Sensitive fields */}
			{showSensitive && sensitiveFields.length > 0 && (
				<div className="mt-2 pt-2 border-t border-border/15 animate-in fade-in slide-in-from-top-1 duration-200">
					<div className="flex items-center gap-1.5 mb-1 px-0.5">
						<Lock className="h-2.5 w-2.5 text-muted-foreground/30" />
						<span className="text-[10px] text-muted-foreground/35">
							Hover to copy — these values are read-only in the dashboard
						</span>
					</div>
					<div className="divide-y divide-border/10">
						{sensitiveFields.map((field, index) => (
							<FieldRow
								key={field.name}
								field={field}
								index={index}
								sensitive
								revealed={showSensitive}
							/>
						))}
					</div>
				</div>
			)}
		</div>
	);
};
