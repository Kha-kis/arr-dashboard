"use client";

import { Input } from "../../../components/ui/input";
import { CheckCircle2, Hash } from "lucide-react";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

/**
 * Premium Indexer Edit Form
 *
 * Form for editing indexer enable status and priority with:
 * - Theme-aware checkbox styling
 * - Premium input styling
 * - Inline layout for compact display
 */
export const IndexerEditForm = ({
	formEnable,
	formPriority,
	onEnableChange,
	onPriorityChange,
}: {
	formEnable: boolean;
	formPriority: number | undefined;
	onEnableChange: (enabled: boolean) => void;
	onPriorityChange: (priority: number | undefined) => void;
}) => {
	const { gradient: _themeGradient } = useThemeGradient();

	return (
		<div className="flex flex-wrap items-center gap-6">
			{/* Enable Toggle */}
			<label className="flex items-center gap-3 cursor-pointer group">
				<button
					type="button"
					onClick={() => onEnableChange(!formEnable)}
					className="flex h-6 w-6 items-center justify-center rounded-lg transition-all duration-200"
					style={{
						backgroundColor: formEnable
							? SEMANTIC_COLORS.success.from
							: "rgba(var(--muted), 0.3)",
						border: `1px solid ${formEnable ? SEMANTIC_COLORS.success.from : "rgba(var(--border), 0.5)"}`,
					}}
				>
					{formEnable && <CheckCircle2 className="h-4 w-4 text-white" />}
				</button>
				<span className="text-sm font-medium text-foreground group-hover:text-foreground/80 transition-colors">
					{formEnable ? "Enabled" : "Disabled"}
				</span>
			</label>

			{/* Priority Input */}
			<div className="flex items-center gap-3">
				<div className="flex items-center gap-2">
					<Hash className="h-4 w-4 text-muted-foreground" />
					<span className="text-xs uppercase tracking-wider font-medium text-muted-foreground">
						Priority
					</span>
				</div>
				<Input
					type="number"
					value={formPriority === undefined ? "" : formPriority.toString()}
					onChange={(event) => {
						const raw = event.target.value;
						if (raw.trim().length === 0) {
							onPriorityChange(undefined);
							return;
						}
						const parsed = Number(raw);
						if (!Number.isNaN(parsed)) {
							onPriorityChange(parsed);
						}
					}}
					className="h-9 w-24 rounded-lg border-border/50 bg-card/50 text-foreground focus:ring-1"
					style={{
						borderColor: "rgba(var(--border), 0.5)",
					}}
				/>
			</div>
		</div>
	);
};
