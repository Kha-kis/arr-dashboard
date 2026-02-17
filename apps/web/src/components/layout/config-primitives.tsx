/**
 * Shared Config UI Primitives
 *
 * Reusable form primitives for configuration panels across the app.
 * Used by hunting-config, queue-cleaner-config, and auto-import-section.
 */

import { HelpCircle } from "lucide-react";
import { SEMANTIC_COLORS } from "@/lib/theme-gradients";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { Switch } from "@/components/ui";

// ============================================================================
// Tooltip
// ============================================================================

export const Tooltip = ({ text }: { text: string }) => (
	<div className="group relative inline-flex">
		<HelpCircle className="h-3.5 w-3.5 text-muted-foreground/50 hover:text-muted-foreground cursor-help" />
		<div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-xs text-foreground bg-popover border border-border rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 w-64 z-50 pointer-events-none">
			{text}
			<div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-border" />
		</div>
	</div>
);

// ============================================================================
// ToggleSwitch
// ============================================================================

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

// ============================================================================
// ToggleRow
// ============================================================================

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

// ============================================================================
// ConfigInput
// ============================================================================

export const ConfigInput = ({
	label,
	description,
	value,
	onChange,
	type = "number",
	min,
	max,
	suffix,
	id,
}: {
	label: string;
	description?: string;
	value: number | string;
	onChange: (value: number) => void;
	type?: "text" | "number";
	min?: number;
	max?: number;
	suffix?: string;
	id?: string;
}) => {
	const generatedId = `config-input-${label.toLowerCase().replace(/\s+/g, "-")}`;
	const inputId = id ?? generatedId;

	return (
		<div className="space-y-1">
			<label htmlFor={inputId} className="text-xs font-medium text-muted-foreground block">
				{label}
			</label>
			<div className="flex items-center gap-2">
				<input
					id={inputId}
					type={type}
					className="w-24 rounded-lg border border-border/50 bg-card/50 px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1"
					value={value}
					onChange={(e) => {
						const parsed = Number.parseInt(e.target.value, 10);
						if (!Number.isNaN(parsed)) {
							const clamped =
								min !== undefined && max !== undefined
									? Math.max(min, Math.min(max, parsed))
									: parsed;
							onChange(clamped);
						}
					}}
					min={min}
					max={max}
				/>
				{suffix && (
					<span className="text-xs text-muted-foreground whitespace-nowrap">{suffix}</span>
				)}
			</div>
			{description && <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>}
		</div>
	);
};

// ============================================================================
// ConfigSection
// ============================================================================

interface ConfigSectionProps {
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	title: string;
	description: string;
	enabled: boolean;
	onToggle: (enabled: boolean) => void;
	children?: React.ReactNode;
	/** "themed" uses gradient icon + shadcn Switch; "simple" uses plain icon + ToggleSwitch */
	variant?: "themed" | "simple";
}

export const ConfigSection = ({
	icon: Icon,
	title,
	description,
	enabled,
	onToggle,
	children,
	variant = "themed",
}: ConfigSectionProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const isThemed = variant === "themed";

	return (
		<div className={isThemed ? "space-y-4" : "space-y-3"}>
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					{isThemed ? (
						<div
							className="flex h-8 w-8 items-center justify-center rounded-lg"
							style={{
								background: enabled
									? `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`
									: "rgba(100, 116, 139, 0.1)",
								border: enabled
									? `1px solid ${themeGradient.from}30`
									: "1px solid rgba(100, 116, 139, 0.2)",
							}}
						>
							<Icon
								className="h-4 w-4"
								style={{ color: enabled ? themeGradient.from : "rgb(148, 163, 184)" }}
							/>
						</div>
					) : (
						<Icon className="h-4 w-4 text-muted-foreground" />
					)}
					<div>
						<h4 className={isThemed ? "font-medium" : "text-sm font-medium text-foreground"}>
							{title}
						</h4>
						<p className="text-xs text-muted-foreground">{description}</p>
					</div>
				</div>
				{isThemed ? (
					<Switch checked={enabled} onCheckedChange={onToggle} />
				) : (
					<ToggleSwitch checked={enabled} onChange={onToggle} label={title} />
				)}
			</div>

			{enabled && children && (
				<div
					className={
						isThemed
							? "pl-4 border-l-2 transition-colors"
							: "pl-7 space-y-3 border-l-2 border-border/30 ml-2"
					}
					style={isThemed ? { borderColor: `${themeGradient.from}50` } : undefined}
				>
					{children}
				</div>
			)}
		</div>
	);
};
