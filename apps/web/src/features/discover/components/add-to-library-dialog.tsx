"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
	DiscoverAddRequest,
	DiscoverSearchResult,
	DiscoverSearchType,
	DiscoverResultInstanceState,
} from "@arr/shared";
import type { ServiceInstanceSummary } from "@arr/shared";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import { useDiscoverOptionsQuery } from "../../../hooks/api/useDiscover";

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

const SELECT_CLASS =
	"w-full rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm text-fg hover:border-border-hover focus:border-border-focus focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-bg";
const OPTION_STYLE = {} as const;

export const AddToLibraryDialog: React.FC<AddToLibraryDialogProps> = ({
	open,
	result,
	type,
	instances,
	onClose,
	onSubmit,
	submitting = false,
}) => {
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

	return (
		<div className="fixed inset-0 z-modal-backdrop flex items-center justify-center bg-black/60 backdrop-blur-sm px-4 py-8">
			<div className="relative w-full max-w-2xl rounded-2xl bg-bg-subtle/98 backdrop-blur-xl p-8 shadow-2xl ring-1 ring-border">
				<button
					type="button"
					className="absolute right-4 top-4 text-sm text-fg-muted hover:text-fg"
					onClick={onClose}
					disabled={submitting}
				>
					Close
				</button>
				<div className="mb-6 space-y-2">
					<p className="text-xs uppercase tracking-[0.4em] text-fg-subtle">Add to Library</p>
					<h2 className="text-2xl font-semibold text-fg">
						{result.title}
						{result.year ? <span className="ml-2 text-fg-muted">({result.year})</span> : null}
					</h2>
					{result.overview ? (
						<p className="text-sm leading-relaxed text-fg-muted line-clamp-3">{result.overview}</p>
					) : null}
				</div>

				<form onSubmit={handleSubmit} className="space-y-6">
					{noInstances ? (
						<div className="rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200">
							Configure a {type === "movie" ? "Radarr" : "Sonarr"} instance in Settings before
							adding items.
						</div>
					) : null}
					<div className="grid gap-4 md:grid-cols-2">
						<div className="space-y-2">
							<label className="text-xs uppercase tracking-widest text-fg-subtle">Instance</label>
							<select
								className={SELECT_CLASS}
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
								<option value="" disabled style={OPTION_STYLE}>
									Select instance
								</option>
								{targetInstances.map((instance) => {
									const state = getInstanceState(result, instance.id);
									return (
										<option key={instance.id} value={instance.id} style={OPTION_STYLE}>
											{instance.label} {state?.exists ? "(Already in library)" : ""}
										</option>
									);
								})}
							</select>
						</div>

						<div className="space-y-2">
							<label className="text-xs uppercase tracking-widest text-fg-subtle">
								Quality Profile
							</label>
							<select
								className={SELECT_CLASS}
								value={qualityProfileId ?? ""}
								onChange={(event) => setQualityProfileId(Number(event.target.value))}
								disabled={submitting || loadingOptions || !options}
								required
							>
								<option value="" disabled style={OPTION_STYLE}>
									{loadingOptions ? "Loading..." : "Select quality profile"}
								</option>
								{options?.qualityProfiles.map((profile) => (
									<option key={profile.id} value={profile.id} style={OPTION_STYLE}>
										{profile.name}
									</option>
								))}
							</select>
						</div>

						{type === "series" ? (
							<div className="space-y-2">
								<label className="text-xs uppercase tracking-widest text-fg-subtle">
									Language Profile
								</label>
								<select
									className={SELECT_CLASS}
									value={languageProfileId ?? ""}
									onChange={(event) => setLanguageProfileId(Number(event.target.value))}
									disabled={submitting || loadingOptions || !options?.languageProfiles?.length}
									required
								>
									<option value="" disabled style={OPTION_STYLE}>
										{options?.languageProfiles?.length
											? "Select language profile"
											: "No language profiles"}
									</option>
									{options?.languageProfiles?.map((profile) => (
										<option key={profile.id} value={profile.id} style={OPTION_STYLE}>
											{profile.name}
										</option>
									))}
								</select>
							</div>
						) : null}

						<div className="space-y-2">
							<label className="text-xs uppercase tracking-widest text-fg-subtle">
								Root Folder
							</label>
							<select
								className={SELECT_CLASS}
								value={rootFolderPath}
								onChange={(event) => setRootFolderPath(event.target.value)}
								disabled={submitting || loadingOptions || !options}
								required
							>
								<option value="" disabled style={OPTION_STYLE}>
									{loadingOptions ? "Loading..." : "Select root folder"}
								</option>
								{options?.rootFolders.map((folder) => (
									<option key={folder.path} value={folder.path} style={OPTION_STYLE}>
										{folder.path}
									</option>
								))}
							</select>
						</div>
					</div>

					<div className="grid gap-3 md:grid-cols-2">
						<label className="flex items-center justify-between rounded-xl bg-bg-muted/30 px-4 py-3 text-sm text-fg">
							<span className="font-medium">Monitor future releases</span>
							<input
								type="checkbox"
								className="h-4 w-4 rounded border-border bg-bg-muted accent-accent"
								checked={monitored}
								onChange={(event) => setMonitored(event.target.checked)}
								disabled={submitting || noInstances}
							/>
						</label>

						<label className="flex items-center justify-between rounded-xl bg-bg-muted/30 px-4 py-3 text-sm text-fg">
							<span className="font-medium">Search on add</span>
							<input
								type="checkbox"
								className="h-4 w-4 rounded border-border bg-bg-muted accent-accent"
								checked={searchOnAdd}
								onChange={(event) => setSearchOnAdd(event.target.checked)}
								disabled={submitting || noInstances}
							/>
						</label>

						{type === "series" ? (
							<label className="flex items-center justify-between rounded-xl bg-bg-muted/30 px-4 py-3 text-sm text-fg">
								<span className="font-medium">Create season folders</span>
								<input
									type="checkbox"
									className="h-4 w-4 rounded border-border bg-bg-muted accent-accent"
									checked={seasonFolder}
									onChange={(event) => setSeasonFolder(event.target.checked)}
									disabled={submitting || noInstances}
								/>
							</label>
						) : null}

						{alreadyAdded ? (
							<div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
								Already added on this instance.
							</div>
						) : null}
					</div>

					<div className="flex items-center justify-end gap-3 pt-2">
						<Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={disableSubmit}
							className={cn(disableSubmit && "cursor-not-allowed opacity-60")}
						>
							{submitting ? "Adding..." : alreadyAdded ? "Already Added" : "Add to Library"}
						</Button>
					</div>
				</form>
			</div>
		</div>
	);
};
