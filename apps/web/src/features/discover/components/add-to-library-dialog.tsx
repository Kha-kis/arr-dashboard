"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import type {
	DiscoverAddRequest,
	DiscoverSearchResult,
	DiscoverSearchType,
	DiscoverResultInstanceState,
} from "@arr/shared";
import type { ServiceInstanceSummary } from "@arr/shared";
import { X, Film, Tv, Loader2, Plus, CheckCircle2, AlertTriangle, FolderOpen, Settings2, Search, Clock } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import { useDiscoverOptionsQuery } from "../../../hooks/api/useDiscover";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

interface AddToLibraryDialogProps {
	open: boolean;
	result: DiscoverSearchResult | null;
	type: DiscoverSearchType;
	instances: ServiceInstanceSummary[];
	onClose: () => void;
	onSubmit: (payload: DiscoverAddRequest) => Promise<void> | void;
	submitting?: boolean;
}

const getInstanceState = (
	result: DiscoverSearchResult | null,
	instanceId: string,
): DiscoverResultInstanceState | undefined =>
	result?.instanceStates.find((state) => state.instanceId === instanceId);

/**
 * Radarr minimum availability options
 * Controls when a movie is considered "available" for download
 */
const MINIMUM_AVAILABILITY_OPTIONS = [
	{ value: "announced", label: "Announced", description: "As soon as the movie is announced" },
	{ value: "inCinemas", label: "In Cinemas", description: "When the movie is in theaters" },
	{ value: "released", label: "Released", description: "When physically/digitally released" },
] as const;

/**
 * Sonarr series type options
 * Controls how episodes are matched and numbered
 */
const SERIES_TYPE_OPTIONS = [
	{ value: "standard", label: "Standard", description: "Normal TV shows (S01E01)" },
	{ value: "daily", label: "Daily", description: "Daily shows like talk shows (2024-01-15)" },
	{ value: "anime", label: "Anime", description: "Anime with absolute numbering (Episode 123)" },
] as const;

/**
 * Premium Add to Library Dialog
 *
 * Modal for adding content to library with:
 * - Glassmorphic backdrop and container
 * - Theme-aware form controls
 * - Premium toggle switches
 * - Animated entrance/exit
 */
export const AddToLibraryDialog: React.FC<AddToLibraryDialogProps> = ({
	open,
	result,
	type,
	instances,
	onClose,
	onSubmit,
	submitting = false,
}) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [focusedSelect, setFocusedSelect] = useState<string | null>(null);
	const focusTrapRef = useFocusTrap<HTMLDivElement>(open, onClose);

	const targetInstances = useMemo(
		() =>
			instances.filter((instance) =>
				type === "movie" ? instance.service === "radarr" : instance.service === "sonarr",
			),
		[instances, type],
	);

	const noInstances = targetInstances.length === 0;

	const [instanceId, setInstanceId] = useState<string | null>(null);
	const [qualityProfileId, setQualityProfileId] = useState<number | null>(null);
	const [rootFolderPath, setRootFolderPath] = useState<string>("");
	const [languageProfileId, setLanguageProfileId] = useState<number | null>(null);
	const [monitored, setMonitored] = useState(true);
	const [searchOnAdd, setSearchOnAdd] = useState(true);
	const [seasonFolder, setSeasonFolder] = useState(true);
	const [minimumAvailability, setMinimumAvailability] = useState<string>("announced");
	const [seriesType, setSeriesType] = useState<string>("standard");

	const selectedInstance = useMemo(
		() => instances.find((instance) => instance.id === instanceId),
		[instances, instanceId],
	);

	const lastAppliedDefaultsRef = useRef<string | null>(null);

	useEffect(() => {
		if (!open) {
			setQualityProfileId(null);
			setRootFolderPath("");
			setLanguageProfileId(null);
			setMonitored(true);
			setSearchOnAdd(true);
			setSeasonFolder(true);
			setMinimumAvailability("announced");
			setSeriesType("standard");
			return;
		}

		const preferred = targetInstances.find((instance) => {
			const existing = getInstanceState(result, instance.id);
			return !existing?.exists;
		});

		setInstanceId((previous) => previous ?? preferred?.id ?? targetInstances[0]?.id ?? null);
	}, [open, targetInstances, result]);

	useEffect(() => {
		if (!open || !instanceId) {
			return;
		}

		lastAppliedDefaultsRef.current = null;
		setQualityProfileId(null);
		setRootFolderPath("");
		setLanguageProfileId(null);

		if (type === "series") {
			if (
				selectedInstance &&
				selectedInstance.defaultSeasonFolder !== null &&
				selectedInstance.defaultSeasonFolder !== undefined
			) {
				setSeasonFolder(Boolean(selectedInstance.defaultSeasonFolder));
			} else {
				setSeasonFolder(true);
			}
		}
	}, [instanceId, open, type, selectedInstance]);

	const { data: options, isLoading: loadingOptions } = useDiscoverOptionsQuery(
		instanceId,
		type,
		open,
	);

	useEffect(() => {
		if (!options || !instanceId) {
			return;
		}

		const hasAppliedForInstance = lastAppliedDefaultsRef.current === instanceId;

		if (!hasAppliedForInstance) {
			const desiredQuality = selectedInstance?.defaultQualityProfileId ?? null;
			if (
				desiredQuality !== null &&
				options.qualityProfiles.some((profile) => profile.id === desiredQuality)
			) {
				setQualityProfileId(desiredQuality);
			} else if (options.qualityProfiles.length > 0) {
				setQualityProfileId(options.qualityProfiles[0]!.id);
			} else {
				setQualityProfileId(null);
			}

			const desiredRoot = selectedInstance?.defaultRootFolderPath ?? null;
			if (desiredRoot && options.rootFolders.some((folder) => folder.path === desiredRoot)) {
				setRootFolderPath(desiredRoot);
			} else if (options.rootFolders.length > 0) {
				setRootFolderPath(options.rootFolders[0]!.path);
			} else {
				setRootFolderPath("");
			}

			if (type === "series") {
				const desiredLanguage = selectedInstance?.defaultLanguageProfileId ?? null;
				if (
					desiredLanguage !== null &&
					options.languageProfiles?.some((profile) => profile.id === desiredLanguage)
				) {
					setLanguageProfileId(desiredLanguage);
				} else if (options.languageProfiles && options.languageProfiles.length > 0) {
					setLanguageProfileId(options.languageProfiles[0]!.id);
				} else {
					setLanguageProfileId(null);
				}

				if (
					selectedInstance &&
					selectedInstance.defaultSeasonFolder !== null &&
					selectedInstance.defaultSeasonFolder !== undefined
				) {
					setSeasonFolder(Boolean(selectedInstance.defaultSeasonFolder));
				}
			}

			lastAppliedDefaultsRef.current = instanceId;
			return;
		}

		if (
			qualityProfileId !== null &&
			!options.qualityProfiles.some((profile) => profile.id === qualityProfileId)
		) {
			setQualityProfileId(options.qualityProfiles[0]?.id ?? null);
		}

		if (rootFolderPath && !options.rootFolders.some((folder) => folder.path === rootFolderPath)) {
			setRootFolderPath(options.rootFolders[0]?.path ?? "");
		}

		if (
			type === "series" &&
			languageProfileId !== null &&
			!(options.languageProfiles ?? []).some((profile) => profile.id === languageProfileId)
		) {
			setLanguageProfileId(options.languageProfiles?.[0]?.id ?? null);
		}
	}, [
		options,
		instanceId,
		selectedInstance,
		type,
		qualityProfileId,
		rootFolderPath,
		languageProfileId,
	]);

	if (!open || !result) {
		return null;
	}

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (
			!instanceId ||
			!qualityProfileId ||
			!rootFolderPath ||
			(type === "series" && !languageProfileId) ||
			noInstances
		) {
			return;
		}

		const payload: DiscoverAddRequest = {
			instanceId,
			payload:
				type === "movie"
					? {
							type: "movie",
							title: result.title ?? "Untitled",
							tmdbId: result.remoteIds?.tmdbId,
							imdbId: result.remoteIds?.imdbId,
							year: result.year,
							qualityProfileId,
							rootFolderPath,
							monitored,
							searchOnAdd,
							minimumAvailability,
						}
					: {
							type: "series",
							title: result.title ?? "Untitled",
							tvdbId: result.remoteIds?.tvdbId,
							tmdbId: result.remoteIds?.tmdbId,
							qualityProfileId,
							languageProfileId: languageProfileId ?? undefined,
							rootFolderPath,
							monitored,
							searchOnAdd,
							seasonFolder,
							seriesType,
						},
		};

		await onSubmit(payload);
	};

	const existingState = instanceId ? getInstanceState(result, instanceId) : undefined;
	const alreadyAdded = Boolean(existingState?.exists);
	const disableSubmit =
		submitting ||
		alreadyAdded ||
		noInstances ||
		!instanceId ||
		!qualityProfileId ||
		!rootFolderPath ||
		(type === "series" && !languageProfileId);

	const selectClassName = cn(
		"w-full rounded-xl border bg-card/50 backdrop-blur-xs px-4 py-3 text-sm text-foreground",
		"hover:border-border transition-all duration-200",
		"focus:outline-hidden appearance-none cursor-pointer"
	);

	const getSelectStyle = (id: string): React.CSSProperties => {
		const isFocused = focusedSelect === id;
		return {
			borderColor: isFocused ? themeGradient.from : "hsl(var(--border) / 0.5)",
			boxShadow: isFocused ? `0 0 0 1px ${themeGradient.from}` : undefined,
		};
	};

	return (
		<div
			className="fixed inset-0 z-modal-backdrop flex items-center justify-center px-4 py-8 animate-in fade-in duration-200"
			role="dialog"
			aria-modal="true"
			aria-labelledby="add-to-library-title"
		>
			{/* Backdrop */}
			<div
				className="absolute inset-0 bg-black/70 backdrop-blur-xs"
				onClick={onClose}
			/>

			{/* Dialog */}
			<div
				ref={focusTrapRef}
				className="relative w-full max-w-2xl rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl p-8 shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
				style={{
					boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${themeGradient.from}10`,
				}}
			>
				{/* Close Button */}
				<button
					type="button"
					className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
					onClick={onClose}
					disabled={submitting}
					aria-label="Close dialog"
				>
					<X className="h-4 w-4" />
				</button>

				{/* Header */}
				<div className="mb-6 space-y-3">
					<div className="flex items-center gap-3">
						<div
							className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							{type === "movie" ? (
								<Film className="h-5 w-5" style={{ color: themeGradient.from }} />
							) : (
								<Tv className="h-5 w-5" style={{ color: themeGradient.from }} />
							)}
						</div>
						<div>
							<p className="text-xs uppercase tracking-[0.2em] text-muted-foreground font-medium">
								Add to Library
							</p>
							<h2 id="add-to-library-title" className="text-xl font-semibold text-foreground">
								{result.title}
								{result.year && (
									<span className="ml-2 text-muted-foreground font-normal">({result.year})</span>
								)}
							</h2>
						</div>
					</div>
					{result.overview && (
						<p className="text-sm leading-relaxed text-muted-foreground line-clamp-2">
							{result.overview}
						</p>
					)}
				</div>

				<form onSubmit={handleSubmit} className="space-y-6">
					{/* No Instances Warning */}
					{noInstances && (
						<div
							className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm"
							style={{
								backgroundColor: SEMANTIC_COLORS.warning.bg,
								border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
							}}
						>
							<AlertTriangle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.warning.from }} />
							<p className="text-muted-foreground">
								Configure a{" "}
								<span className="font-medium text-foreground">
									{type === "movie" ? "Radarr" : "Sonarr"}
								</span>{" "}
								instance in Settings before adding items.
							</p>
						</div>
					)}

					{/* Form Grid */}
					<div className="grid gap-4 md:grid-cols-2">
						{/* Instance Select */}
						<div className="space-y-2">
							<label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium">
								<Settings2 className="h-3 w-3" />
								Instance
							</label>
							<select
								className={selectClassName}
								style={getSelectStyle("instance")}
								onFocus={() => setFocusedSelect("instance")}
								onBlur={() => setFocusedSelect(null)}
								value={instanceId ?? ""}
								onChange={(event) => {
									setInstanceId(event.target.value);
									setQualityProfileId(null);
									setRootFolderPath("");
									setLanguageProfileId(null);
								}}
								disabled={submitting || noInstances}
								required
							>
								<option value="" disabled>
									Select instance
								</option>
								{targetInstances.map((instance) => {
									const state = getInstanceState(result, instance.id);
									return (
										<option key={instance.id} value={instance.id}>
											{instance.label} {state?.exists ? "(Already in library)" : ""}
										</option>
									);
								})}
							</select>
						</div>

						{/* Quality Profile Select */}
						<div className="space-y-2">
							<label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium">
								Quality Profile
							</label>
							<select
								className={selectClassName}
								style={getSelectStyle("quality")}
								onFocus={() => setFocusedSelect("quality")}
								onBlur={() => setFocusedSelect(null)}
								value={qualityProfileId ?? ""}
								onChange={(event) => setQualityProfileId(Number(event.target.value))}
								disabled={submitting || loadingOptions || !options}
								required
							>
								<option value="" disabled>
									{loadingOptions ? "Loading..." : "Select quality profile"}
								</option>
								{options?.qualityProfiles.map((profile) => (
									<option key={profile.id} value={profile.id}>
										{profile.name}
									</option>
								))}
							</select>
						</div>

						{/* Language Profile (Series only) */}
						{type === "series" && (
							<div className="space-y-2">
								<label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium">
									Language Profile
								</label>
								<select
									className={selectClassName}
									style={getSelectStyle("language")}
									onFocus={() => setFocusedSelect("language")}
									onBlur={() => setFocusedSelect(null)}
									value={languageProfileId ?? ""}
									onChange={(event) => setLanguageProfileId(Number(event.target.value))}
									disabled={submitting || loadingOptions || !options?.languageProfiles?.length}
									required
								>
									<option value="" disabled>
										{options?.languageProfiles?.length
											? "Select language profile"
											: "No language profiles"}
									</option>
									{options?.languageProfiles?.map((profile) => (
										<option key={profile.id} value={profile.id}>
											{profile.name}
										</option>
									))}
								</select>
							</div>
						)}

						{/* Root Folder Select */}
						<div className="space-y-2">
							<label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium">
								<FolderOpen className="h-3 w-3" />
								Root Folder
							</label>
							<select
								className={selectClassName}
								style={getSelectStyle("rootFolder")}
								onFocus={() => setFocusedSelect("rootFolder")}
								onBlur={() => setFocusedSelect(null)}
								value={rootFolderPath}
								onChange={(event) => setRootFolderPath(event.target.value)}
								disabled={submitting || loadingOptions || !options}
								required
							>
								<option value="" disabled>
									{loadingOptions ? "Loading..." : "Select root folder"}
								</option>
								{options?.rootFolders.map((folder) => (
									<option key={folder.path} value={folder.path}>
										{folder.path}
									</option>
								))}
							</select>
						</div>

						{/* Minimum Availability Select (Movies only) */}
						{type === "movie" && (
							<div className="space-y-2">
								<label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium">
									<Clock className="h-3 w-3" />
									Minimum Availability
								</label>
								<select
									className={selectClassName}
									style={getSelectStyle("minimumAvailability")}
									onFocus={() => setFocusedSelect("minimumAvailability")}
									onBlur={() => setFocusedSelect(null)}
									value={minimumAvailability}
									onChange={(event) => setMinimumAvailability(event.target.value)}
									disabled={submitting || noInstances}
								>
									{MINIMUM_AVAILABILITY_OPTIONS.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
							</div>
						)}

						{/* Series Type Select (Series only) */}
						{type === "series" && (
							<div className="space-y-2">
								<label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium">
									<Tv className="h-3 w-3" />
									Series Type
								</label>
								<select
									className={selectClassName}
									style={getSelectStyle("seriesType")}
									onFocus={() => setFocusedSelect("seriesType")}
									onBlur={() => setFocusedSelect(null)}
									value={seriesType}
									onChange={(event) => setSeriesType(event.target.value)}
									disabled={submitting || noInstances}
								>
									{SERIES_TYPE_OPTIONS.map((option) => (
										<option key={option.value} value={option.value}>
											{option.label}
										</option>
									))}
								</select>
							</div>
						)}
					</div>

					{/* Toggle Options */}
					<div className="grid gap-3 md:grid-cols-2">
						{/* Monitor Toggle */}
						<label
							className="flex items-center justify-between rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs px-4 py-3 cursor-pointer transition-colors hover:border-border/80"
						>
							<span className="text-sm font-medium text-foreground">Monitor future releases</span>
							<div
								className={cn(
									"relative h-6 w-11 rounded-full transition-colors duration-200",
									monitored ? "" : "bg-muted/50"
								)}
								style={monitored ? { background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})` } : undefined}
							>
								<div
									className={cn(
										"absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
										monitored ? "translate-x-6" : "translate-x-1"
									)}
								/>
							</div>
							<input
								type="checkbox"
								className="sr-only"
								checked={monitored}
								onChange={(event) => setMonitored(event.target.checked)}
								disabled={submitting || noInstances}
							/>
						</label>

						{/* Search on Add Toggle */}
						<label
							className="flex items-center justify-between rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs px-4 py-3 cursor-pointer transition-colors hover:border-border/80"
						>
							<span className="flex items-center gap-2 text-sm font-medium text-foreground">
								<Search className="h-4 w-4 text-muted-foreground" />
								Search on add
							</span>
							<div
								className={cn(
									"relative h-6 w-11 rounded-full transition-colors duration-200",
									searchOnAdd ? "" : "bg-muted/50"
								)}
								style={searchOnAdd ? { background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})` } : undefined}
							>
								<div
									className={cn(
										"absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
										searchOnAdd ? "translate-x-6" : "translate-x-1"
									)}
								/>
							</div>
							<input
								type="checkbox"
								className="sr-only"
								checked={searchOnAdd}
								onChange={(event) => setSearchOnAdd(event.target.checked)}
								disabled={submitting || noInstances}
							/>
						</label>

						{/* Season Folder Toggle (Series only) */}
						{type === "series" && (
							<label
								className="flex items-center justify-between rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs px-4 py-3 cursor-pointer transition-colors hover:border-border/80"
							>
								<span className="flex items-center gap-2 text-sm font-medium text-foreground">
									<FolderOpen className="h-4 w-4 text-muted-foreground" />
									Create season folders
								</span>
								<div
									className={cn(
										"relative h-6 w-11 rounded-full transition-colors duration-200",
										seasonFolder ? "" : "bg-muted/50"
									)}
									style={seasonFolder ? { background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})` } : undefined}
								>
									<div
										className={cn(
											"absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
											seasonFolder ? "translate-x-6" : "translate-x-1"
										)}
									/>
								</div>
								<input
									type="checkbox"
									className="sr-only"
									checked={seasonFolder}
									onChange={(event) => setSeasonFolder(event.target.checked)}
									disabled={submitting || noInstances}
								/>
							</label>
						)}

						{/* Already Added Notice */}
						{alreadyAdded && (
							<div
								className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm col-span-full md:col-span-1"
								style={{
									backgroundColor: SEMANTIC_COLORS.success.bg,
									border: `1px solid ${SEMANTIC_COLORS.success.border}`,
									color: SEMANTIC_COLORS.success.text,
								}}
							>
								<CheckCircle2 className="h-4 w-4 shrink-0" />
								Already added on this instance
							</div>
						)}
					</div>

					{/* Actions */}
					<div className="flex items-center justify-end gap-3 pt-4 border-t border-border/30">
						<Button
							type="button"
							variant="ghost"
							onClick={onClose}
							disabled={submitting}
							className="rounded-xl"
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={disableSubmit}
							className={cn(
								"gap-2 rounded-xl font-medium transition-all duration-200",
								disableSubmit && "opacity-50 cursor-not-allowed"
							)}
							style={
								!disableSubmit
									? {
											background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
											boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
										}
									: alreadyAdded
										? {
												backgroundColor: SEMANTIC_COLORS.success.bg,
												border: `1px solid ${SEMANTIC_COLORS.success.border}`,
												color: SEMANTIC_COLORS.success.text,
											}
										: undefined
							}
						>
							{submitting ? (
								<>
									<Loader2 className="h-4 w-4 animate-spin" />
									Adding...
								</>
							) : alreadyAdded ? (
								<>
									<CheckCircle2 className="h-4 w-4" />
									Already Added
								</>
							) : (
								<>
									<Plus className="h-4 w-4" />
									Add to Library
								</>
							)}
						</Button>
					</div>
				</form>
			</div>
		</div>
	);
};
