/**
 * Queue Cleaner Config - Shared UI Components
 *
 * Reusable form primitives used by InstanceConfigCard and AutoImportSection.
 * Extracted from queue-cleaner-config.tsx for maintainability.
 */

import { HelpCircle, Plus, X } from "lucide-react";
import { Button } from "../../../components/ui";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { WHITELIST_TYPES } from "../lib/constants";
import type { WhitelistPattern } from "../lib/queue-cleaner-types";

export const Tooltip = ({ text }: { text: string }) => (
	<div className="group relative inline-flex">
		<HelpCircle className="h-3.5 w-3.5 text-muted-foreground/50 hover:text-muted-foreground cursor-help" />
		<div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-xs text-foreground bg-popover border border-border rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 w-64 z-50 pointer-events-none">
			{text}
			<div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-border" />
		</div>
	</div>
);

export const ToggleSwitch = ({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: (value: boolean) => void;
	label?: string;
}) => (
	<button
		type="button"
		role="switch"
		aria-checked={checked}
		aria-label={label}
		className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors"
		style={{
			backgroundColor: checked ? SEMANTIC_COLORS.success.text : "rgba(128, 128, 128, 0.3)",
		}}
		onClick={() => onChange(!checked)}
	>
		<span
			className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
			style={{ transform: checked ? "translateX(18px)" : "translateX(3px)" }}
		/>
	</button>
);

export const ToggleRow = ({
	label,
	description,
	checked,
	onChange,
}: {
	label: string;
	description: string;
	checked: boolean;
	onChange: (value: boolean) => void;
}) => (
	<div className="flex items-center justify-between">
		<div>
			<span className="text-sm text-foreground">{label}</span>
			<p className="text-xs text-muted-foreground">{description}</p>
		</div>
		<ToggleSwitch checked={checked} onChange={onChange} label={label} />
	</div>
);

export const RuleSection = ({
	icon: Icon,
	title,
	description,
	enabled,
	onToggle,
	children,
}: {
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	title: string;
	description: string;
	enabled: boolean;
	onToggle: (value: boolean) => void;
	children?: React.ReactNode;
}) => (
	<div className="space-y-3">
		<div className="flex items-center justify-between">
			<div className="flex items-center gap-2.5">
				<Icon className="h-4 w-4 text-muted-foreground" />
				<div>
					<h5 className="text-sm font-medium text-foreground">{title}</h5>
					<p className="text-xs text-muted-foreground">{description}</p>
				</div>
			</div>
			<ToggleSwitch checked={enabled} onChange={onToggle} label={title} />
		</div>
		{enabled && children && (
			<div className="pl-7 space-y-3 border-l-2 border-border/30 ml-2">
				{children}
			</div>
		)}
	</div>
);

export const ConfigInput = ({
	label,
	description,
	value,
	onChange,
	min,
	max,
	suffix,
	id,
}: {
	label: string;
	description: string;
	value: number;
	onChange: (value: number) => void;
	min: number;
	max: number;
	suffix: string;
	id?: string;
}) => {
	// Generate stable ID for label-input association (accessibility)
	const generatedId = `config-input-${label.toLowerCase().replace(/\s+/g, "-")}`;
	const inputId = id ?? generatedId;

	return (
		<div>
			<label htmlFor={inputId} className="text-xs font-medium text-foreground block mb-1">
				{label}
			</label>
			<div className="flex items-center gap-2">
				<input
					id={inputId}
					type="number"
					className="w-24 rounded-lg border border-border/50 bg-card/50 px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1"
					value={value}
					onChange={(e) => {
						const parsed = Number.parseInt(e.target.value, 10);
						if (!Number.isNaN(parsed)) {
							onChange(Math.max(min, Math.min(max, parsed)));
						}
					}}
					min={min}
					max={max}
				/>
				<span className="text-xs text-muted-foreground">{suffix}</span>
			</div>
			<p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>
		</div>
	);
};

export const WhitelistEditor = ({
	patterns,
	onChange,
}: {
	patterns: string | null | undefined;
	onChange: (value: string | null) => void;
}) => {
	// Parse patterns from JSON string
	const parsedPatterns: WhitelistPattern[] = (() => {
		if (!patterns) return [];
		try {
			return JSON.parse(patterns) as WhitelistPattern[];
		} catch {
			return [];
		}
	})();

	const addPattern = () => {
		// Generate unique ID for stable React key (prevents reconciliation issues)
		const id = `wp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
		const newPatterns = [
			...parsedPatterns,
			{ type: "tracker" as const, pattern: "", id },
		];
		onChange(JSON.stringify(newPatterns));
	};

	const removePattern = (index: number) => {
		const newPatterns = parsedPatterns.filter((_, i) => i !== index);
		onChange(newPatterns.length > 0 ? JSON.stringify(newPatterns) : null);
	};

	const updatePattern = (index: number, field: keyof WhitelistPattern, value: string) => {
		const newPatterns = [...parsedPatterns];
		const currentPattern = newPatterns[index];
		if (currentPattern) {
			if (field === "type") {
				currentPattern.type = value as WhitelistPattern["type"];
			} else {
				currentPattern.pattern = value;
			}
		}
		onChange(JSON.stringify(newPatterns));
	};

	return (
		<div className="space-y-2">
			{parsedPatterns.map((p, index) => (
				// Use pattern's id if available, fallback to content-based key
				<div key={p.id ?? `${p.type}-${p.pattern}-${index}`} className="flex items-center gap-2">
					<select
						className="rounded-lg border border-border/50 bg-card/50 px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1"
						value={p.type}
						onChange={(e) => updatePattern(index, "type", e.target.value)}
					>
						{WHITELIST_TYPES.map((t) => (
							<option key={t.value} value={t.value}>
								{t.label}
							</option>
						))}
					</select>
					<input
						type="text"
						className="flex-1 rounded-lg border border-border/50 bg-card/50 px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1"
						placeholder="Enter pattern..."
						value={p.pattern}
						onChange={(e) => updatePattern(index, "pattern", e.target.value)}
					/>
					<button
						type="button"
						className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
						onClick={() => removePattern(index)}
						aria-label="Remove pattern"
					>
						<X className="h-4 w-4" />
					</button>
				</div>
			))}
			<Button
				type="button"
				variant="secondary"
				size="sm"
				className="gap-1.5"
				onClick={addPattern}
			>
				<Plus className="h-3.5 w-3.5" />
				Add Pattern
			</Button>
			<p className="text-[10px] text-muted-foreground">
				Items matching any pattern will be excluded from queue cleaning. Patterns are case-insensitive substring matches.
			</p>
		</div>
	);
};
