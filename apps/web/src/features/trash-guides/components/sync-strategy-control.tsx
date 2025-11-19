"use client";

import { Info } from "lucide-react";

interface SyncStrategyControlProps {
	value: "auto" | "manual" | "notify";
	onChange: (value: "auto" | "manual" | "notify") => void;
	disabled?: boolean;
}

export const SyncStrategyControl = ({
	value,
	onChange,
	disabled,
}: SyncStrategyControlProps) => {
	const strategies = [
		{
			value: "auto" as const,
			label: "Auto-sync",
			description: "Automatically sync when updates are available (only if no custom modifications)",
			color: "text-green-600 dark:text-green-400",
			bgColor: "bg-green-500/10",
			borderColor: "border-green-500/30",
		},
		{
			value: "notify" as const,
			label: "Notify only",
			description: "Show notification when updates are available, but don't auto-sync",
			color: "text-blue-600 dark:text-blue-400",
			bgColor: "bg-blue-500/10",
			borderColor: "border-blue-500/30",
		},
		{
			value: "manual" as const,
			label: "Manual",
			description: "Never check for updates, all syncing must be done manually",
			color: "text-gray-600 dark:text-gray-400",
			bgColor: "bg-gray-500/10",
			borderColor: "border-gray-500/30",
		},
	];

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<label className="text-sm font-medium text-fg">
					TRaSH Guides Sync Strategy
				</label>
				<div className="group relative">
					<Info className="h-4 w-4 text-fg-muted cursor-help" />
					<div className="invisible group-hover:visible absolute left-0 top-6 z-10 w-64 rounded-lg border border-white/10 bg-bg p-3 text-xs text-fg-muted shadow-lg">
						<p>
							Controls how this template handles TRaSH Guides updates from
							GitHub.
						</p>
						<p className="mt-2">
							Note: Auto-sync will only work if the template has no custom
							modifications.
						</p>
					</div>
				</div>
			</div>

			<div className="space-y-2">
				{strategies.map((strategy) => (
					<button
						key={strategy.value}
						type="button"
						onClick={() => onChange(strategy.value)}
						disabled={disabled}
						className={`w-full text-left rounded-lg border p-3 transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
							value === strategy.value
								? `${strategy.borderColor} ${strategy.bgColor}`
								: "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10"
						}`}
					>
						<div className="flex items-start justify-between gap-3">
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2">
									<span
										className={`text-sm font-medium ${
											value === strategy.value ? strategy.color : "text-fg"
										}`}
									>
										{strategy.label}
									</span>
									{value === strategy.value && (
										<span className="text-xs text-fg-muted">(Current)</span>
									)}
								</div>
								<p className="text-xs text-fg-muted mt-1">
									{strategy.description}
								</p>
							</div>
							<input
								type="radio"
								checked={value === strategy.value}
								onChange={() => onChange(strategy.value)}
								disabled={disabled}
								className="mt-0.5 h-4 w-4 shrink-0"
							/>
						</div>
					</button>
				))}
			</div>

			{value === "auto" && (
				<div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
					<p className="text-xs text-fg-muted">
						<strong className="text-amber-600 dark:text-amber-400">
							Note:
						</strong>{" "}
						Auto-sync is also controlled by the system-wide{" "}
						<code className="px-1 py-0.5 rounded bg-bg-subtle text-fg font-mono text-xs">
							TRASH_AUTO_SYNC_ENABLED
						</code>{" "}
						environment variable. Both must be enabled for auto-sync to work.
					</p>
				</div>
			)}
		</div>
	);
};
