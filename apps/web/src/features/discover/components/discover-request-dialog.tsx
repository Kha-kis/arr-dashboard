"use client";

import { useState, useCallback, useMemo } from "react";
import {
	X,
	Send,
	Check,
	CheckCheck,
	Loader2,
	Monitor,
	Layers,
	Server,
	ChevronDown,
	FolderOpen,
	Sliders,
} from "lucide-react";
import type { SeerrDiscoverResult, SeerrSeasonSummary } from "@arr/shared";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import {
	useCreateSeerrRequest,
	useSeerrRequestOptions,
	useSeerrTvDetails,
} from "../../../hooks/api/useSeerr";
import { getDisplayTitle } from "../lib/seerr-image-utils";
import { toast } from "sonner";

// Sentinel value for "use Seerr's default" in dropdowns
const USE_DEFAULT = "__default__";

interface DiscoverRequestDialogProps {
	item: SeerrDiscoverResult;
	instanceId: string;
	onClose: () => void;
}

export const DiscoverRequestDialog: React.FC<DiscoverRequestDialogProps> = ({
	item,
	instanceId,
	onClose,
}) => {
	const { gradient: themeGradient } = useThemeGradient();
	const focusTrapRef = useFocusTrap<HTMLDivElement>(true, onClose);
	const createRequest = useCreateSeerrRequest();
	const isMovie = item.mediaType === "movie";
	const title = getDisplayTitle(item);

	// Fetch request options (servers, profiles, root folders)
	const optionsQuery = useSeerrRequestOptions(instanceId, item.mediaType);
	const allServers = useMemo(() => optionsQuery.data?.servers ?? [], [optionsQuery.data?.servers]);

	// Split servers into regular and 4K
	const regularServers = useMemo(() => allServers.filter((s) => !s.server.is4k), [allServers]);
	const fourKServers = useMemo(() => allServers.filter((s) => s.server.is4k), [allServers]);
	const has4k = fourKServers.length > 0;

	// For TV, fetch details to get season list
	const tvQuery = useSeerrTvDetails(instanceId, !isMovie ? item.id : 0);
	const seasons = useMemo(
		() =>
			!isMovie
				? (tvQuery.data?.seasons ?? []).filter((s) => s.seasonNumber > 0)
				: [],
		[isMovie, tvQuery.data?.seasons],
	);

	// State
	const [is4k, setIs4k] = useState(false);
	const [selectedSeasons, setSelectedSeasons] = useState<Set<number>>(new Set());
	const [selectedServerId, setSelectedServerId] = useState<number | undefined>(undefined);
	const [selectedProfileId, setSelectedProfileId] = useState<number | undefined>(undefined);
	const [selectedRootFolder, setSelectedRootFolder] = useState<string | undefined>(undefined);

	// Active servers based on 4K toggle
	const activeServers = is4k ? fourKServers : regularServers;

	// Determine the active server (selected or default)
	const activeServer = useMemo(() => {
		if (activeServers.length === 0) return undefined;
		if (selectedServerId) {
			return activeServers.find((s) => s.server.id === selectedServerId);
		}
		return activeServers.find((s) => s.server.isDefault) ?? activeServers[0];
	}, [activeServers, selectedServerId]);

	const toggleSeason = useCallback((seasonNumber: number) => {
		setSelectedSeasons((prev) => {
			const next = new Set(prev);
			if (next.has(seasonNumber)) {
				next.delete(seasonNumber);
			} else {
				next.add(seasonNumber);
			}
			return next;
		});
	}, []);

	const selectAllSeasons = useCallback(() => {
		setSelectedSeasons(new Set(seasons.map((s) => s.seasonNumber)));
	}, [seasons]);

	const deselectAllSeasons = useCallback(() => {
		setSelectedSeasons(new Set());
	}, []);

	const canSubmit = isMovie || selectedSeasons.size > 0;

	const handleSubmit = useCallback(async () => {
		try {
			await createRequest.mutateAsync({
				instanceId,
				payload: {
					mediaId: item.id,
					mediaType: item.mediaType,
					is4k: has4k ? is4k : undefined,
					...(isMovie ? {} : { seasons: Array.from(selectedSeasons) }),
					...(selectedServerId ? { serverId: selectedServerId } : {}),
					...(selectedProfileId ? { profileId: selectedProfileId } : {}),
					...(selectedRootFolder ? { rootFolder: selectedRootFolder } : {}),
				},
			});
			toast.success(`${title} has been requested successfully.`);
			onClose();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to submit request");
		}
	}, [
		createRequest,
		instanceId,
		item.id,
		item.mediaType,
		has4k,
		is4k,
		isMovie,
		selectedSeasons,
		selectedServerId,
		selectedProfileId,
		selectedRootFolder,
		title,
		onClose,
	]);

	// Reset overrides when switching 4K
	const handle4kToggle = useCallback((checked: boolean) => {
		setIs4k(checked);
		setSelectedServerId(undefined);
		setSelectedProfileId(undefined);
		setSelectedRootFolder(undefined);
	}, []);

	return (
		<div
			className="fixed inset-0 z-modal flex items-center justify-center p-4 animate-in fade-in duration-200"
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-labelledby="request-dialog-title"
		>
			<div className="absolute inset-0 bg-black/60 backdrop-blur-xs" />

			<div
				ref={focusTrapRef}
				className="relative w-full max-w-md max-h-[80vh] overflow-y-auto rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300 scrollbar-none"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="flex items-center justify-between p-5 border-b border-border/30">
					<div className="space-y-1 min-w-0">
						<h3 id="request-dialog-title" className="text-lg font-semibold text-foreground truncate">
							Request {isMovie ? "Movie" : "TV Show"}
						</h3>
						<p className="text-sm text-muted-foreground truncate">{title}</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:text-foreground hover:bg-card/60"
						aria-label="Close"
					>
						<X className="h-5 w-5" />
					</button>
				</div>

				{/* Body */}
				<div className="p-5 space-y-5">
					{/* Season picker (TV only) */}
					{!isMovie && (
						<div className="space-y-3">
							<div className="flex items-center justify-between">
								<h4 className="text-sm font-medium text-foreground flex items-center gap-2">
									<Layers className="h-4 w-4 text-muted-foreground" />
									Select Seasons
								</h4>
								<div className="flex items-center gap-2">
									<button
										type="button"
										onClick={selectAllSeasons}
										className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground hover:bg-card/60"
									>
										<CheckCheck className="h-3 w-3" />
										All
									</button>
									<button
										type="button"
										onClick={deselectAllSeasons}
										className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground hover:bg-card/60"
									>
										<X className="h-3 w-3" />
										None
									</button>
								</div>
							</div>

							{tvQuery.isLoading ? (
								<div className="flex items-center justify-center py-6">
									<Loader2
										className="h-5 w-5 animate-spin"
										style={{ color: themeGradient.from }}
									/>
								</div>
							) : (
								<div className="space-y-1.5 max-h-[240px] overflow-y-auto pr-1 scrollbar-none">
									{seasons.map((season) => (
										<SeasonRow
											key={season.seasonNumber}
											season={season}
											isSelected={selectedSeasons.has(season.seasonNumber)}
											onToggle={() => toggleSeason(season.seasonNumber)}
											themeFrom={themeGradient.from}
										/>
									))}
								</div>
							)}
						</div>
					)}

					{/* 4K toggle — only show if a 4K server is configured */}
					{has4k && (
						<ToggleRow
							icon={Monitor}
							label="Request in 4K"
							checked={is4k}
							onChange={handle4kToggle}
							themeFrom={themeGradient.from}
						/>
					)}

					{/* Server / Quality / Root Folder options */}
					{optionsQuery.isLoading ? (
						<div className="flex items-center justify-center py-4">
							<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
						</div>
					) : (
						activeServer && (
							<div className="space-y-3">
								{/* Server selector (only if multiple servers for this 4K mode) */}
								{activeServers.length > 1 && (
									<SelectField
										icon={Server}
										label="Server"
										value={activeServer.server.id.toString()}
										onChange={(v) => {
											setSelectedServerId(Number(v));
											setSelectedProfileId(undefined);
											setSelectedRootFolder(undefined);
										}}
										options={activeServers.map((s) => ({
											value: s.server.id.toString(),
											label: s.server.name,
										}))}
										themeFrom={themeGradient.from}
									/>
								)}

								{/* Quality Profile */}
								{activeServer.profiles.length > 0 && (
									<SelectField
										icon={Sliders}
										label="Quality Profile"
										value={selectedProfileId?.toString() ?? USE_DEFAULT}
										onChange={(v) =>
											setSelectedProfileId(v === USE_DEFAULT ? undefined : Number(v))
										}
										options={[
											{ value: USE_DEFAULT, label: "Default" },
											...activeServer.profiles.map((p) => ({
												value: p.id.toString(),
												label: p.name,
											})),
										]}
										themeFrom={themeGradient.from}
									/>
								)}

								{/* Root Folder */}
								{activeServer.rootFolders.length > 0 && (
									<SelectField
										icon={FolderOpen}
										label="Root Folder"
										value={selectedRootFolder ?? USE_DEFAULT}
										onChange={(v) =>
											setSelectedRootFolder(v === USE_DEFAULT ? undefined : v)
										}
										options={[
											{ value: USE_DEFAULT, label: "Default" },
											...activeServer.rootFolders.map((f) => ({
												value: f.path,
												label: f.path,
											})),
										]}
										themeFrom={themeGradient.from}
									/>
								)}
							</div>
						)
					)}
				</div>

				{/* Footer */}
				<div className="flex items-center justify-end gap-3 p-5 border-t border-border/30">
					<button
						type="button"
						onClick={onClose}
						className="rounded-xl border border-border/50 bg-card/40 px-4 py-2 text-sm font-medium text-foreground transition-all hover:bg-card/60"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleSubmit}
						disabled={!canSubmit || createRequest.isPending}
						className="flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium text-white transition-all hover:scale-105 disabled:opacity-50 disabled:hover:scale-100"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							boxShadow: `0 4px 16px -4px ${themeGradient.glow}`,
						}}
					>
						{createRequest.isPending ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<Send className="h-4 w-4" />
						)}
						{createRequest.isPending ? "Submitting..." : "Submit Request"}
					</button>
				</div>
			</div>
		</div>
	);
};

// ============================================================================
// Reusable Sub-Components
// ============================================================================

interface ToggleRowProps {
	icon: React.FC<{ className?: string }>;
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
	themeFrom: string;
}

const ToggleRow: React.FC<ToggleRowProps> = ({ icon: Icon, label, checked, onChange, themeFrom }) => (
	<label className="flex items-center justify-between rounded-xl border border-border/50 bg-card/40 px-4 py-3 cursor-pointer transition-colors hover:bg-card/60">
		<div className="flex items-center gap-2">
			<Icon className="h-4 w-4 text-muted-foreground" />
			<span className="text-sm font-medium text-foreground">{label}</span>
		</div>
		<div className="relative">
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				className="sr-only"
			/>
			<div
				className="h-6 w-11 rounded-full transition-colors duration-200"
				style={{ backgroundColor: checked ? themeFrom : "var(--border)" }}
			/>
			<div
				className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200"
				style={{ transform: checked ? "translateX(1.25rem)" : "translateX(0)" }}
			/>
		</div>
	</label>
);

interface SelectFieldProps {
	icon: React.FC<{ className?: string }>;
	label: string;
	value: string;
	onChange: (value: string) => void;
	options: { value: string; label: string }[];
	themeFrom: string;
}

const SelectField: React.FC<SelectFieldProps> = ({
	icon: Icon,
	label,
	value,
	onChange,
	options,
	themeFrom,
}) => (
	<div className="space-y-1.5">
		<label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
			<Icon className="h-3.5 w-3.5" />
			{label}
		</label>
		<div className="relative">
			<select
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="w-full appearance-none rounded-lg border border-border/50 bg-card/40 px-3 py-2 pr-8 text-sm text-foreground transition-colors hover:bg-card/60 focus:outline-none"
				style={{ borderColor: `${themeFrom}30` }}
			>
				{options.map((opt) => (
					<option key={opt.value} value={opt.value}>
						{opt.label}
					</option>
				))}
			</select>
			<ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
		</div>
	</div>
);

interface SeasonRowProps {
	season: SeerrSeasonSummary;
	isSelected: boolean;
	onToggle: () => void;
	themeFrom: string;
}

const SeasonRow: React.FC<SeasonRowProps> = ({ season, isSelected, onToggle, themeFrom }) => (
	<button
		type="button"
		onClick={onToggle}
		className="flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all duration-150"
		style={{
			borderColor: isSelected ? `${themeFrom}40` : "var(--border)",
			backgroundColor: isSelected ? `${themeFrom}08` : "transparent",
		}}
	>
		<div
			className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-all duration-150"
			style={{
				borderColor: isSelected ? themeFrom : "var(--border)",
				backgroundColor: isSelected ? themeFrom : "transparent",
			}}
		>
			{isSelected && <Check className="h-3 w-3 text-white" />}
		</div>

		<div className="flex-1 min-w-0">
			<p className="text-sm font-medium text-foreground truncate">
				{season.name || `Season ${season.seasonNumber}`}
			</p>
		</div>

		<span className="text-xs text-muted-foreground shrink-0">
			{season.episodeCount} ep{season.episodeCount !== 1 ? "s" : ""}
		</span>
	</button>
);
