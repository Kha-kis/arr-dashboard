"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button";
import { useManualImportQuery, useManualImportMutation } from "../../../hooks/api/useManualImport";
import type {
  ManualImportModalProps,
  ManualImportCandidateUnion,
  ManualImportSubmissionFile,
} from "../types";
import {
  candidateDisplayPath,
  candidateKey,
  describeCandidate,
  describeRejections,
  describeQuality,
  describeLanguages,
  extractDownloadId,
  formatFileSize,
  isSonarrCandidate,
  isRadarrCandidate,
  describeEpisode,
} from "../helpers";
import { useManualImportStore, getSelectionForCandidate, hasValidSelections } from "../store";
import { cn } from "../../../lib/utils";

const backdropClasses = "fixed inset-0 z-40 flex items-center justify-center bg-slate-950/85 backdrop-blur";
const panelClasses = "relative z-50 flex max-h-[90vh] w-full max-w-5xl flex-col gap-5 overflow-hidden rounded-2xl border border-white/10 bg-slate-950/95 p-6 shadow-xl";

const statusToneClasses: Record<"ready" | "warning" | "error", string> = {
  ready: "text-emerald-300",
  warning: "text-amber-300",
  error: "text-red-300",
};

const importModeOptions = [
  { value: "auto", label: "Auto (match ARR settings)" },
  { value: "move", label: "Move" },
  { value: "copy", label: "Copy" },
] as const;

type ImportMode = (typeof importModeOptions)[number]["value"];

export const ManualImportModal = ({
  instanceId,
  instanceName,
  service,
  downloadId,
  folder,
  open,
  onOpenChange,
  onCompleted,
}: ManualImportModalProps) => {
  const { selections, toggleSelection, updateSelection, clear } = useManualImportStore();
  const [selectionError, setSelectionError] = useState<string | undefined>();
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>("auto");

  const query = useManualImportQuery({
    instanceId,
    service,
    downloadId,
    folder,
    enabled: open,
  });

  const mutation = useManualImportMutation();

  const candidates = query.candidates;

  const rejectionCount = useMemo(
    () => candidates.filter((candidate) => Boolean(describeRejections(candidate))).length,
    [candidates],
  );

  const selectionsForService = useMemo(
    () => Object.values(selections).filter((selection) => selection.service === service),
    [selections, service],
  );

  const selectedCount = selectionsForService.length;

  const buildSubmissionDefaults = useCallback(
    (candidate: ManualImportCandidateUnion):
      | {
          downloadId: string;
          values: ManualImportSubmissionFile;
        }
      | null => {
      const resolvedDownloadId = extractDownloadId(candidate) ?? downloadId;
      if (!resolvedDownloadId) {
        return null;
      }

      const defaults: ManualImportSubmissionFile = {
        path: candidate.path,
        folderName: candidate.folderName ?? "",
        downloadId: resolvedDownloadId,
        quality: candidate.quality,
        languages: candidate.languages,
        releaseGroup: candidate.releaseGroup ?? undefined,
        indexerFlags:
          typeof candidate.indexerFlags === "number" && Number.isFinite(candidate.indexerFlags)
            ? candidate.indexerFlags
            : 0,
        releaseType: candidate.releaseType ?? undefined,
      };

      if (isSonarrCandidate(candidate)) {
        const seriesId = candidate.series?.id;
        const episodeIds =
          candidate.episodes
            ?.map((episode) => episode?.id)
            .filter((id): id is number => typeof id === "number") ?? [];

        if (typeof seriesId === "number" && episodeIds.length > 0) {
          defaults.seriesId = seriesId;
          defaults.episodeIds = episodeIds;
        }

        if (typeof candidate.episodeFileId === "number") {
          defaults.episodeFileId = candidate.episodeFileId;
        }
      } else if (isRadarrCandidate(candidate)) {
        const movieId = candidate.movie?.id;
        if (typeof movieId === "number") {
          defaults.movieId = movieId;
        }
        if (typeof candidate.movieFileId === "number") {
          defaults.movieFileId = candidate.movieFileId;
        }
      }

      return { downloadId: resolvedDownloadId, values: defaults };
    },
    [downloadId],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    clear();
    setSelectionError(undefined);
    setShowSelectedOnly(false);
    setImportMode("auto");
  }, [open, clear, instanceId, service, downloadId, folder]);

  useEffect(() => {
    if (!open || query.isLoading) {
      return;
    }
    const available = candidates.filter((candidate) => !describeRejections(candidate));
    if (available.length === 1) {
      const candidate = available[0];
      if (!candidate) {
        return;
      }
      if (!getSelectionForCandidate(selections, candidate)) {
        const defaults = buildSubmissionDefaults(candidate);
        if (defaults) {
          toggleSelection(candidate, instanceId, defaults.downloadId, defaults.values);
        }
      }
    }
  }, [
    open,
    query.isLoading,
    candidates,
    selections,
    buildSubmissionDefaults,
    toggleSelection,
    instanceId,
  ]);

  const visibleCandidates = useMemo(() => {
    let list = candidates;
    if (showSelectedOnly) {
      list = list.filter((candidate) => Boolean(getSelectionForCandidate(selections, candidate)));
    }
    return list;
  }, [candidates, showSelectedOnly, selections]);

  const totalCandidates = candidates.length;
  const visibleCount = visibleCandidates.length;

  const handleClose = useCallback(
    (next: boolean) => {
      if (!next) {
        clear();
        setSelectionError(undefined);
      }
      onOpenChange(next);
    },
    [clear, onOpenChange],
  );

  const handleToggleCandidate = useCallback(
    (candidate: ManualImportCandidateUnion) => {
      const defaults = buildSubmissionDefaults(candidate);
      if (!defaults) {
        setSelectionError(
          "ARR did not expose a download identifier for this download. Use the ARR UI instead.",
        );
        return;
      }
      setSelectionError(undefined);
      toggleSelection(candidate, instanceId, defaults.downloadId, defaults.values);
    },
    [buildSubmissionDefaults, toggleSelection, instanceId],
  );

  const handleToggleEpisode = useCallback(
    (candidate: ManualImportCandidateUnion, episodeId: number) => {
      updateSelection(candidate, (current) => {
        const currentIds = Array.isArray(current.values.episodeIds) ? current.values.episodeIds : [];
        const next = currentIds.includes(episodeId)
          ? currentIds.filter((id) => id !== episodeId)
          : [...currentIds, episodeId];
        next.sort((a, b) => a - b);
        return {
          ...current,
          values: {
            ...current.values,
            episodeIds: next,
          },
        };
      });
    },
    [updateSelection],
  );

  const handleSelectAllEpisodes = useCallback(
    (candidate: ManualImportCandidateUnion) => {
      if (!isSonarrCandidate(candidate) || !candidate.episodes) {
        return;
      }
      const ids = candidate.episodes
        .map((episode) => episode?.id)
        .filter((id): id is number => typeof id === "number");
      if (ids.length === 0) {
        return;
      }
      const unique = Array.from(new Set(ids)).sort((a, b) => a - b);
      updateSelection(candidate, (current) => ({
        ...current,
        values: {
          ...current.values,
          episodeIds: unique,
        },
      }));
    },
    [updateSelection],
  );

  const handleClearEpisodes = useCallback(
    (candidate: ManualImportCandidateUnion) => {
      updateSelection(candidate, (current) => ({
        ...current,
        values: {
          ...current.values,
          episodeIds: [],
        },
      }));
    },
    [updateSelection],
  );

  const handleSubmit = async () => {
    setSelectionError(undefined);

    const selectionsForThisService = Object.values(selections).filter(
      (selection) => selection.service === service,
    );

    if (selectionsForThisService.length === 0) {
      setSelectionError("Select at least one file to import.");
      return;
    }

    if (!hasValidSelections(selections, service)) {
      setSelectionError("At least one selected file is missing required mappings.");
      return;
    }

    try {
      await mutation.mutateAsync({
        instanceId,
        service,
        importMode,
        files: selectionsForThisService.map((selection) => selection.values),
      });
      const importedCount = selectionsForThisService.length;
      clear();
      onOpenChange(false);
      onCompleted?.({ status: "success", imported: importedCount });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Manual import failed.";
      setSelectionError(message);
    }
  };

  if (!open) {
    return null;
  }

  return (
    <div className={backdropClasses}>
      <div className={panelClasses}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">Manual Import - {instanceName}</h2>
            <p className="text-xs text-white/60">
              {downloadId
                ? `Download: ${downloadId}`
                : folder
                  ? `Folder: ${folder}`
                  : "Interactive manual import"}
            </p>
          </div>
          <Button variant="ghost" onClick={() => handleClose(false)} disabled={mutation.isPending}>
            Close
          </Button>
        </div>

        {query.isError && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            Failed to fetch manual import candidates.
            {" "}
            {query.error instanceof Error ? query.error.message : ""}
          </div>
        )}

        {selectionError && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {selectionError}
          </div>
        )}

        <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-sm text-white/80">
          <div className="flex flex-wrap items-center gap-3 text-xs text-white/60">
            <span>Total files: {totalCandidates}</span>
            <span>Visible: {visibleCount}</span>
            <span>Selected: {selectedCount}</span>
            {rejectionCount > 0 && <span>{rejectionCount} rejected</span>}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex flex-col gap-1 text-xs uppercase text-white/50">
              Import mode
              <select
                value={importMode}
                onChange={(event) => setImportMode(event.target.value as ImportMode)}
                className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                disabled={mutation.isPending}
              >
                {importModeOptions.map((option) => (
                  <option key={option.value} value={option.value} className="bg-slate-900 text-white">
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-white/70">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={showSelectedOnly}
                onChange={(event) => setShowSelectedOnly(event.target.checked)}
                disabled={mutation.isPending}
              />
              Show selected only
            </label>
          </div>
        </div>

        <div className="flex max-h-[420px] flex-col gap-2 overflow-y-auto pr-1">
          {query.isLoading && (
            <div className="rounded-md border border-white/10 bg-white/5 px-3 py-6 text-center text-sm text-white/60">
              Loading manual import candidates...
            </div>
          )}

          {!query.isLoading && visibleCandidates.length === 0 && (
            <div className="rounded-md border border-dashed border-white/10 bg-white/5 px-3 py-6 text-center text-sm text-white/60">
              No files match the current filters.
            </div>
          )}

          {visibleCandidates.map((candidate) => {
            const key = candidateKey(candidate);
            const selection = getSelectionForCandidate(selections, candidate);
            const selected = Boolean(selection);
            const rejection = describeRejections(candidate);
            const downloadAvailable = Boolean(extractDownloadId(candidate) ?? downloadId);
            const qualityLabel = describeQuality(candidate.quality);
            const languageLabel = describeLanguages(candidate.languages);
            const sizeLabel =
              typeof candidate.size === "number" && candidate.size > 0 ? formatFileSize(candidate.size) : "";
            const releaseGroup = candidate.releaseGroup;

            const mappingSummary = isSonarrCandidate(candidate)
              ? candidate.series?.title ?? "Unmapped series"
              : isRadarrCandidate(candidate)
                ? candidate.movie?.title ?? "Unmapped movie"
                : "Unknown";

            const episodeIds =
              selection && Array.isArray(selection.values.episodeIds) ? selection.values.episodeIds : [];

            let statusTone: "ready" | "warning" | "error" = "ready";
            let statusText = "Ready to import";

            if (!downloadAvailable) {
              statusTone = "error";
              statusText = "Download identifier not available.";
            } else if (rejection) {
              statusTone = "warning";
              statusText = rejection;
            } else if (selected && isSonarrCandidate(candidate) && episodeIds.length === 0) {
              statusTone = "warning";
              statusText = "Select at least one episode before importing.";
            } else if (selected && isRadarrCandidate(candidate) && selection?.values.movieId === undefined) {
              statusTone = "warning";
              statusText = "Movie mapping is missing.";
            }

            const chips = [qualityLabel, sizeLabel, languageLabel, releaseGroup].filter(
              (value): value is string => Boolean(value),
            );

            const episodes = isSonarrCandidate(candidate) && candidate.episodes ? candidate.episodes : [];

            return (
              <div
                key={key}
                className={cn(
                  "rounded-xl border border-white/10 bg-white/5 p-4 transition",
                  selected && "border-white/40",
                  rejection && "border-amber-500/40",
                  !downloadAvailable && "border-red-500/40",
                )}
              >
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_10rem] lg:items-start">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4"
                      checked={selected}
                      onChange={() => handleToggleCandidate(candidate)}
                      disabled={!downloadAvailable || mutation.isPending}
                    />
                    <div className="min-w-0 space-y-2">
                      <div className="space-y-1">
                        <p className="font-medium text-white">{describeCandidate(candidate)}</p>
                        <p className="break-words text-xs text-white/60">{candidateDisplayPath(candidate)}</p>
                      </div>
                      {chips.length > 0 && (
                        <div className="flex flex-wrap gap-2 text-xs text-white/60">
                          {chips.map((chip, index) => (
                            <span
                              key={`${key}:chip:${index}`}
                              className="rounded-full border border-white/15 px-2 py-0.5"
                            >
                              {chip}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2 text-sm text-white/80">
                    <div>
                      <p className="text-xs uppercase text-white/50">Mapping</p>
                      <p>{mappingSummary}</p>
                    </div>
                    {selected && isSonarrCandidate(candidate) && episodes.length > 0 && (
                      <div className="space-y-2 rounded-md border border-white/10 bg-slate-900/50 p-3 text-xs text-white/70">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span>Episodes</span>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              className="text-sky-300 hover:underline disabled:opacity-50"
                              onClick={() => handleSelectAllEpisodes(candidate)}
                              disabled={mutation.isPending}
                            >
                              Select all
                            </button>
                            <button
                              type="button"
                              className="text-sky-300 hover:underline disabled:opacity-50"
                              onClick={() => handleClearEpisodes(candidate)}
                              disabled={mutation.isPending}
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                        <div className="grid gap-1 sm:grid-cols-2">
                          {episodes.map((episode) => {
                            const episodeId = typeof episode?.id === "number" ? episode.id : undefined;
                            if (episodeId === undefined) {
                              return null;
                            }
                            const checked = episodeIds.includes(episodeId);
                            return (
                              <label
                                key={`${key}:episode:${episodeId}`}
                                className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-white/80"
                              >
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5"
                                  checked={checked}
                                  onChange={() => handleToggleEpisode(candidate, episodeId)}
                                  disabled={mutation.isPending}
                                />
                                <span className="truncate text-xs">{describeEpisode(episode as Parameters<typeof describeEpisode>[0])}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-3 text-xs text-white/60">
                    <span className={statusToneClasses[statusTone]}>{statusText}</span>
                    <Button
                      variant={selected ? "secondary" : "ghost"}
                      className="px-3 py-2 text-xs"
                      onClick={() => handleToggleCandidate(candidate)}
                      disabled={!downloadAvailable || mutation.isPending}
                    >
                      {selected ? "Selected" : "Select"}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="text-xs text-white/50">
            {rejectionCount > 0 ? "Some files may require manual mapping." : ""}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => handleClose(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={mutation.isPending || selectedCount === 0}
            >
              {mutation.isPending ? "Importing..." : "Import selected"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ManualImportModal;








