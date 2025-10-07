import { useEffect } from "react";
import type { ManualImportCandidateUnion } from "../types";
import { describeRejections } from "../helpers";
import { getSelectionForCandidate } from "../store";
import { buildSubmissionDefaults } from "../lib/submission-builder";

/**
 * Hook that auto-selects a single available candidate on mount
 */
export const useAutoSelection = (
  open: boolean,
  isLoading: boolean,
  candidates: ManualImportCandidateUnion[],
  selections: Record<string, unknown>,
  instanceId: string,
  downloadId?: string,
  toggleSelection?: (
    candidate: ManualImportCandidateUnion,
    instanceId: string,
    downloadId: string,
    values: unknown,
  ) => void,
) => {
  useEffect(() => {
    if (!open || isLoading || !toggleSelection) {
      return;
    }
    const available = candidates.filter(
      (candidate) => !describeRejections(candidate),
    );
    if (available.length === 1) {
      const candidate = available[0];
      if (!candidate) {
        return;
      }
      if (!getSelectionForCandidate(selections, candidate)) {
        const defaults = buildSubmissionDefaults(candidate, downloadId);
        if (defaults) {
          toggleSelection(
            candidate,
            instanceId,
            defaults.downloadId,
            defaults.values,
          );
        }
      }
    }
  }, [
    open,
    isLoading,
    candidates,
    selections,
    instanceId,
    downloadId,
    toggleSelection,
  ]);
};
