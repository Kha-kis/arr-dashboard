/**
 * Queue Cleaner Config - UI Components
 *
 * Domain-specific components for queue cleaner configuration.
 * Shared primitives (Tooltip, ToggleSwitch, ToggleRow, ConfigInput) are
 * re-exported from @/components/layout/config-primitives.
 */

import { Plus, X } from "lucide-react";
import { Button } from "../../../components/ui";
import { WHITELIST_TYPES } from "../lib/constants";
import type { WhitelistPattern } from "../lib/queue-cleaner-types";

// Re-export shared primitives for backward compatibility
export { Tooltip, ToggleSwitch, ToggleRow, ConfigInput, ConfigSection } from "../../../components/layout/config-primitives";

// ============================================================================
// RuleSection (domain-specific — uses ToggleSwitch + plain styling)
// ============================================================================

import { ToggleSwitch } from "../../../components/layout/config-primitives";

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

// ============================================================================
// WhitelistEditor (domain-specific)
// ============================================================================

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
