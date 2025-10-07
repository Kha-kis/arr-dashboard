"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../../components/ui/button";
import { useManualImportQuery } from "../../../hooks/api/useManualImport";
import type { ManualImportModalProps } from "../types";
import { candidateKey, describeRejections } from "../helpers";
import { useManualImportStore, getSelectionForCandidate } from "../store";
import { buildSubmissionDefaults } from "../lib/submission-builder";
import { useEpisodeSelection } from "../hooks/use-episode-selection";
import { useAutoSelection } from "../hooks/use-auto-selection";
import { useImportSubmission } from "../hooks/use-import-submission";
import { CandidateCard } from "./candidate-card";

const backdropClasses =
  "fixed inset-0 z-modal-backdrop flex items-center justify-center bg-black/60 backdrop-blur-sm";
const panelClasses =
  "relative z-modal flex max-h-[90vh] w-full max-w-5xl flex-col gap-5 overflow-hidden rounded-2xl border border-border bg-bg-subtle/98 backdrop-blur-xl p-6 shadow-xl";

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
  const { selections, toggleSelection, clear } = useManualImportStore();
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>("auto");

  const query = useManualImportQuery({
    instanceId,
    service,
    downloadId,
    folder,
    enabled: open,
  });

  const candidates = query.candidates;

  const { toggleEpisode, selectAllEpisodes, clearEpisodes } =
    useEpisodeSelection();

  const { submit, error: selectionError, setError: setSelectionError, isPending } = useImportSubmission({
    instanceId,
    service,
    importMode,
    onSuccess: (importedCount) => {
      clear();
      onOpenChange(false);
      onCompleted?.({ status: "success", imported: importedCount });
    },
  });

  const rejectionCount = useMemo(
    () =>
      candidates.filter((candidate) => Boolean(describeRejections(candidate)))
        .length,
    [candidates],
  );

  const selectionsForService = useMemo(
    () =>
      Object.values(selections).filter(
        (selection) => selection.service === service,
      ),
    [selections, service],
  );

  const selectedCount = selectionsForService.length;

  useAutoSelection(
    open,
    query.isLoading,
    candidates,
    selections,
    instanceId,
    downloadId,
    toggleSelection,
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

  const visibleCandidates = useMemo(() => {
    let list = candidates;
    if (showSelectedOnly) {
      list = list.filter((candidate) =>
        Boolean(getSelectionForCandidate(selections, candidate)),
      );
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
      const defaults = buildSubmissionDefaults(candidate, downloadId);
      if (!defaults) {
        setSelectionError(
          "ARR did not expose a download identifier for this download. Use the ARR UI instead.",
        );
        return;
      }
      setSelectionError(undefined);
      toggleSelection(
        candidate,
        instanceId,
        defaults.downloadId,
        defaults.values,
      );
    },
    [downloadId, toggleSelection, instanceId, setSelectionError],
  );

  const handleSubmit = async () => {
    await submit(selections);
  };

  if (!open) {
    return null;
  }

  return (
    <div className={backdropClasses}>
      <div className={panelClasses}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">
              Manual Import - {instanceName}
            </h2>
            <p className="text-xs text-white/60">
              {downloadId
                ? `Download: ${downloadId}`
                : folder
                  ? `Folder: ${folder}`
                  : "Interactive manual import"}
            </p>
          </div>
          <Button
            variant="ghost"
            onClick={() => handleClose(false)}
            disabled={isPending}
          >
            Close
          </Button>
        </div>

        {query.isError && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            Failed to fetch manual import candidates.{" "}
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
                onChange={(event) =>
                  setImportMode(event.target.value as ImportMode)
                }
                className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                disabled={isPending}
              >
                {importModeOptions.map((option) => (
                  <option
                    key={option.value}
                    value={option.value}
                    className="bg-slate-900 text-white"
                  >
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
                disabled={isPending}
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
            const selection = getSelectionForCandidate(selections, candidate);
            const selected = Boolean(selection);
            const episodeIds =
              selection && Array.isArray(selection.values.episodeIds)
                ? selection.values.episodeIds
                : [];

            return (
              <CandidateCard
                key={candidateKey(candidate)}
                candidate={candidate}
                selected={selected}
                episodeIds={episodeIds}
                downloadId={downloadId}
                onToggle={() => handleToggleCandidate(candidate)}
                onToggleEpisode={(episodeId) =>
                  toggleEpisode(candidate, episodeId)
                }
                onSelectAllEpisodes={() => selectAllEpisodes(candidate)}
                onClearEpisodes={() => clearEpisodes(candidate)}
                disabled={isPending}
              />
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="text-xs text-white/50">
            {rejectionCount > 0 ? "Some files may require manual mapping." : ""}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => handleClose(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={isPending || selectedCount === 0}
            >
              {isPending ? "Importing..." : "Import selected"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ManualImportModal;
