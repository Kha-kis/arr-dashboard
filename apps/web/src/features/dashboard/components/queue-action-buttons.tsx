"use client";

import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, Tag, Trash2, ChevronDown } from "lucide-react";
import { cn } from "../../../lib/utils";
import { Button } from "../../../components/ui/button";
import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";

export type QueueAction = "retry" | "manualImport" | "remove" | "category";

type RemoveOption = {
	id: string;
	label: string;
	description: string;
	options: QueueActionOptions;
};

const REMOVE_OPTIONS: RemoveOption[] = [
	{
		id: "remove-keep-client",
		label: "Remove (keep in download client)",
		description: "Remove from Sonarr/Radarr but leave the download in your client.",
		options: { removeFromClient: false, blocklist: false, search: false },
	},
	{
		id: "remove-delete-client",
		label: "Remove & delete from download client",
		description: "Remove the queue item and delete the active download.",
		options: { removeFromClient: true, blocklist: false, search: false },
	},
	{
		id: "blocklist-keep-client",
		label: "Blocklist release",
		description: "Blocklist the release and remove it from the queue.",
		options: { removeFromClient: false, blocklist: true, search: false },
	},
	{
		id: "blocklist-delete-client",
		label: "Blocklist & delete download",
		description: "Blocklist the release and delete the active download.",
		options: { removeFromClient: true, blocklist: true, search: false },
	},
	{
		id: "blocklist-search",
		label: "Blocklist, delete & search again",
		description: "Blocklist the release, delete the download, then search for an alternative.",
		options: { removeFromClient: true, blocklist: true, search: true },
	},
];

interface RemoveMenuProps {
	label: string;
	disabled?: boolean;
	fullWidth?: boolean;
	variant?: "ghost" | "pill";
	buttonClassName?: string;
	onSelect: (options: QueueActionOptions) => void;
}

const RemoveActionMenu = ({
	label,
	disabled,
	fullWidth,
	variant = "ghost",
	buttonClassName,
	onSelect,
}: RemoveMenuProps) => {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const handleClick = (event: MouseEvent) => {
			const target = event.target as Node;
			if (!containerRef.current?.contains(target)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const handleKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [open]);

	const handleSelect = (option: RemoveOption) => {
		onSelect(option.options);
		setOpen(false);
	};

	const toggleMenu = () => {
		if (!disabled) setOpen((prev) => !prev);
	};

	const triggerContent = (
		<>
			<Trash2 className="h-4 w-4" />
			<span>{label}</span>
			<ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", open && "rotate-180")} />
		</>
	);

	return (
		<div ref={containerRef} className={cn("relative", fullWidth && "w-full")}>
			{variant === "pill" ? (
				<button
					type="button"
					onClick={toggleMenu}
					disabled={disabled}
					className={cn(
						"group inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium uppercase tracking-wide transition-all duration-300",
						"border-red-500/30 text-red-400 bg-red-500/5",
						"hover:border-red-500/50 hover:bg-red-500/10 hover:shadow-sm hover:shadow-red-500/10",
						disabled && "cursor-not-allowed opacity-50",
						fullWidth && "w-full justify-between",
						buttonClassName
					)}
				>
					{triggerContent}
				</button>
			) : (
				<button
					type="button"
					onClick={toggleMenu}
					disabled={disabled}
					className={cn(
						"group inline-flex h-9 items-center justify-center gap-2 rounded-full border px-4 text-xs font-medium transition-all duration-300",
						"border-border/50 bg-card/50 text-muted-foreground backdrop-blur-sm",
						"hover:border-red-500/30 hover:bg-red-500/5 hover:text-red-400",
						disabled && "cursor-not-allowed opacity-50",
						fullWidth && "w-full"
					)}
					aria-label="Remove"
				>
					{triggerContent}
				</button>
			)}

			{/* Dropdown menu */}
			{open && (
				<div className="absolute right-0 top-full z-30 mt-2 w-80 animate-in fade-in slide-in-from-top-2 duration-200">
					<div className="rounded-xl border border-border/50 bg-card/95 backdrop-blur-xl p-2 shadow-xl shadow-black/20">
						<div className="flex flex-col gap-1">
							{REMOVE_OPTIONS.map((option) => (
								<button
									key={option.id}
									type="button"
									onClick={() => handleSelect(option)}
									className="group w-full rounded-lg px-3 py-2.5 text-left transition-all duration-200 hover:bg-red-500/10"
								>
									<p className="text-sm font-medium text-foreground group-hover:text-red-400 transition-colors">
										{option.label}
									</p>
									<p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
										{option.description}
									</p>
								</button>
							))}
						</div>
					</div>
				</div>
			)}
		</div>
	);
};

interface QueueActionButtonsProps {
	onAction: (action: QueueAction, options?: QueueActionOptions) => void;
	disabled?: boolean;
	showChangeCategory?: boolean;
	fullWidth?: boolean;
	primaryAction?: Extract<QueueAction, "retry" | "manualImport">;
	primaryDisabled?: boolean;
}

/**
 * Premium action buttons with theme-aware primary button styling
 */
export const QueueActionButtons = ({
	onAction,
	disabled,
	showChangeCategory,
	fullWidth,
	primaryAction,
	primaryDisabled,
}: QueueActionButtonsProps) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	const secondaryButtonClass = cn(
		"inline-flex h-9 items-center justify-center gap-2 rounded-full border px-4 text-xs font-medium transition-all duration-300",
		"border-border/50 bg-card/50 text-muted-foreground backdrop-blur-sm",
		"hover:border-border hover:bg-card hover:text-foreground",
		fullWidth && "w-full"
	);

	return (
		<div className={cn("flex flex-col gap-2 sm:flex-row sm:justify-end", fullWidth && "w-full")}>
			{/* Primary action button with theme gradient */}
			{primaryAction && (
				<button
					type="button"
					onClick={() => onAction(primaryAction)}
					disabled={disabled || primaryDisabled}
					className={cn(
						"group inline-flex h-9 items-center justify-center gap-2 rounded-full px-4 text-xs font-medium text-white transition-all duration-300",
						"disabled:cursor-not-allowed disabled:opacity-50",
						fullWidth && "w-full"
					)}
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
						boxShadow: !(disabled || primaryDisabled) ? `0 4px 12px -2px ${themeGradient.glow}` : undefined,
					}}
					aria-label={primaryAction === "manualImport" ? "Manual import" : "Retry"}
				>
					{primaryAction === "manualImport" ? (
						<Download className="h-4 w-4 transition-transform duration-300 group-hover:scale-110" />
					) : (
						<RefreshCw className="h-4 w-4 transition-transform duration-300 group-hover:rotate-180" />
					)}
					<span>{primaryAction === "manualImport" ? "Manual Import" : "Retry"}</span>
				</button>
			)}

			{/* Remove action menu */}
			<RemoveActionMenu
				label="Remove"
				disabled={disabled}
				fullWidth={fullWidth}
				onSelect={(options) => onAction("remove", options)}
			/>

			{/* Change category button */}
			{showChangeCategory && (
				<button
					type="button"
					onClick={() => onAction("category")}
					disabled={disabled}
					className={secondaryButtonClass}
					aria-label="Change category"
				>
					<Tag className="h-4 w-4" />
					<span>Change Category</span>
				</button>
			)}
		</div>
	);
};

export { RemoveActionMenu, REMOVE_OPTIONS as REMOVE_ACTION_OPTIONS };
