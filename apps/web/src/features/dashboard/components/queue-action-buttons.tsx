"use client";

import { useState } from "react";
import { Download, RefreshCw, Tag, Trash2, ChevronDown } from "lucide-react";
import { cn } from "../../../lib/utils";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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

	const triggerContent = (
		<>
			<Trash2 className="h-4 w-4" />
			<span>{label}</span>
			<ChevronDown
				className={cn("h-3.5 w-3.5 transition-transform duration-200", open && "rotate-180")}
			/>
		</>
	);

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild disabled={disabled}>
				{variant === "pill" ? (
					<button
						type="button"
						className={cn(
							"group inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium uppercase tracking-wide transition-all duration-300",
							"border-red-500/30 text-red-400 bg-red-500/5",
							"hover:border-red-500/50 hover:bg-red-500/10 hover:shadow-sm hover:shadow-red-500/10",
							disabled && "cursor-not-allowed opacity-50",
							fullWidth && "w-full justify-between",
							buttonClassName,
						)}
					>
						{triggerContent}
					</button>
				) : (
					<button
						type="button"
						className={cn(
							"group inline-flex h-9 items-center justify-center gap-2 rounded-full border px-4 text-xs font-medium transition-all duration-300",
							"border-border/50 bg-card/50 text-muted-foreground backdrop-blur-xs",
							"hover:border-red-500/30 hover:bg-red-500/5 hover:text-red-400",
							disabled && "cursor-not-allowed opacity-50",
							fullWidth && "w-full",
						)}
						aria-label="Remove"
					>
						{triggerContent}
					</button>
				)}
			</DropdownMenuTrigger>

			<DropdownMenuContent
				align="end"
				side="bottom"
				sideOffset={8}
				className="w-80 max-w-[calc(100vw-2rem)] rounded-xl border-border/50 bg-card/95 backdrop-blur-xl p-2 shadow-xl shadow-black/20"
			>
				{REMOVE_OPTIONS.map((option) => (
					<DropdownMenuItem
						key={option.id}
						onSelect={() => onSelect(option.options)}
						className="group rounded-lg px-3 py-2.5 cursor-pointer focus:bg-red-500/10"
					>
						<div className="flex flex-col">
							<p className="text-sm font-medium text-foreground group-hover:text-red-400 group-focus:text-red-400 transition-colors">
								{option.label}
							</p>
							<p className="mt-0.5 text-[11px] text-muted-foreground leading-relaxed">
								{option.description}
							</p>
						</div>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
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
	const { gradient: themeGradient } = useThemeGradient();

	const secondaryButtonClass = cn(
		"inline-flex h-9 items-center justify-center gap-2 rounded-full border px-4 text-xs font-medium transition-all duration-300",
		"border-border/50 bg-card/50 text-muted-foreground backdrop-blur-xs",
		"hover:border-border hover:bg-card hover:text-foreground",
		fullWidth && "w-full",
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
						fullWidth && "w-full",
					)}
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
						boxShadow: !(disabled || primaryDisabled)
							? `0 4px 12px -2px ${themeGradient.glow}`
							: undefined,
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
