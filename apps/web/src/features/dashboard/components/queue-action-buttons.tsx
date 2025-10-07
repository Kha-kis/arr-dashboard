"use client";

import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, Tag, Trash2, ChevronDown } from "lucide-react";
import { cn } from "../../../lib/utils";
import { Button } from "../../../components/ui/button";
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
		if (!open) {
			return;
		}
		const handleClick = (event: MouseEvent) => {
			const target = event.target as Node;
			if (!containerRef.current) {
				return;
			}
			if (containerRef.current.contains(target)) {
				return;
			}
			setOpen(false);
		};
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [open]);

	useEffect(() => {
		if (!open) {
			return;
		}
		const handleKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false);
			}
		};
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [open]);

	const handleSelect = (option: RemoveOption) => {
		onSelect(option.options);
		setOpen(false);
	};

	const toggleMenu = () => {
		if (disabled) {
			return;
		}
		setOpen((prev) => !prev);
	};

	const triggerContent = (
		<>
			<Trash2 className="h-4 w-4" />
			<span>{label}</span>
			<ChevronDown className="h-3.5 w-3.5" />
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
						"inline-flex items-center gap-2 rounded-full border border-red-500/40 px-3 py-1 text-xs uppercase tracking-wide text-red-200 transition hover:border-red-500",
						disabled && "cursor-not-allowed opacity-50",
						fullWidth && "w-full justify-between",
						buttonClassName,
					)}
				>
					{triggerContent}
				</button>
			) : (
				<Button
					variant="ghost"
					className={cn(
						"inline-flex h-9 items-center justify-center gap-2 rounded-full border border-white/15 px-3 text-xs font-medium text-white/80 transition hover:border-white/40",
						fullWidth && "w-full",
					)}
					onClick={toggleMenu}
					disabled={disabled}
					aria-label="Remove"
				>
					{triggerContent}
				</Button>
			)}
			{open && (
				<div className="absolute right-0 top-full z-30 mt-2 w-72 rounded-xl border border-white/10 bg-slate-950/95 p-2 shadow-2xl">
					<div className="flex flex-col gap-1">
						{REMOVE_OPTIONS.map((option) => (
							<button
								key={option.id}
								type="button"
								onClick={() => handleSelect(option)}
								className="w-full rounded-lg px-3 py-2 text-left text-xs text-white/70 transition hover:bg-white/5"
							>
								<p className="text-sm font-semibold text-white">{option.label}</p>
								<p className="mt-0.5 text-[11px] text-white/50">{option.description}</p>
							</button>
						))}
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

const baseButtonClass =
	"inline-flex h-9 items-center justify-center gap-2 rounded-full border border-white/15 px-3 text-xs font-medium text-white/80 transition hover:border-white/40";

export const QueueActionButtons = ({
	onAction,
	disabled,
	showChangeCategory,
	fullWidth,
	primaryAction,
	primaryDisabled,
}: QueueActionButtonsProps) => (
	<div className={cn("flex flex-col gap-2 sm:flex-row sm:justify-end", fullWidth && "w-full")}>
		{primaryAction && (
			<Button
				variant="ghost"
				className={cn(baseButtonClass, fullWidth && "w-full")}
				onClick={() => onAction(primaryAction)}
				disabled={disabled || primaryDisabled}
				aria-label={primaryAction === "manualImport" ? "Manual import" : "Retry"}
			>
				{primaryAction === "manualImport" ? (
					<Download className="h-4 w-4" />
				) : (
					<RefreshCw className="h-4 w-4" />
				)}
				<span>{primaryAction === "manualImport" ? "Manual Import" : "Retry"}</span>
			</Button>
		)}
		<RemoveActionMenu
			label="Remove"
			disabled={disabled}
			fullWidth={fullWidth}
			onSelect={(options) => onAction("remove", options)}
		/>
		{showChangeCategory && (
			<Button
				variant="ghost"
				className={cn(baseButtonClass, fullWidth && "w-full")}
				onClick={() => onAction("category")}
				disabled={disabled}
				aria-label="Change category"
			>
				<Tag className="h-4 w-4" />
				<span>Change Category</span>
			</Button>
		)}
	</div>
);

export { RemoveActionMenu, REMOVE_OPTIONS as REMOVE_ACTION_OPTIONS };
