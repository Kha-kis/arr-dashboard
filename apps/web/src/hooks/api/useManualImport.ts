"use client";

import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ManualImportCandidate, ManualImportSubmission } from "@arr/shared";
import { fetchManualImportCandidates, submitManualImport } from "../../lib/api-client/dashboard";

const manualImportKey = (params: {
  instanceId: string;
  service: "sonarr" | "radarr";
  downloadId?: string;
  folder?: string;
  seriesId?: number;
  seasonNumber?: number;
  filterExistingFiles?: boolean;
}) => [
  "manualImport",
  params.service,
  params.instanceId,
  params.downloadId ?? null,
  params.folder ?? null,
  params.seriesId ?? null,
  params.seasonNumber ?? null,
  params.filterExistingFiles ?? true,
];

export const useManualImportQuery = (params: {
  instanceId: string;
  service: "sonarr" | "radarr";
  downloadId?: string;
  folder?: string;
  enabled?: boolean;
}) => {
  const queryKey = useMemo(
    () => manualImportKey({
      instanceId: params.instanceId,
      service: params.service,
      downloadId: params.downloadId,
      folder: params.folder,
      filterExistingFiles: true,
    }),
    [params.instanceId, params.service, params.downloadId, params.folder],
  );

  const query = useQuery({
    queryKey,
    enabled: Boolean(params.instanceId && params.service && params.enabled !== false),
    queryFn: () =>
      fetchManualImportCandidates({
        instanceId: params.instanceId,
        service: params.service,
        downloadId: params.downloadId,
        folder: params.folder,
      }),
  });

  const candidates = query.data?.candidates ?? [];

  return {
    ...query,
    candidates,
  };
};

export const useManualImportMutation = () => {
  const queryClient = useQueryClient();

  const mutation = useMutation<void, Error, ManualImportSubmission>({
    mutationFn: (payload) => submitManualImport(payload),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: manualImportKey({
        instanceId: variables.instanceId,
        service: variables.service,
        downloadId: variables.files[0]?.downloadId,
      }) });
    },
  });

  return mutation;
};

export const useManualImportHelpers = () => {
  const findInitialSelection = useCallback((candidates: ManualImportCandidate[]): ManualImportCandidate | undefined => {
    return candidates.find((candidate) => Boolean(candidate.downloadId));
  }, []);

  return {
    findInitialSelection,
  };
};
