"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  LibraryEpisodeMonitorRequest,
  LibraryEpisodeSearchRequest,
  LibraryEpisodesResponse,
  LibraryService,
  LibraryToggleMonitorRequest,
  LibrarySeasonSearchRequest,
  LibraryMovieSearchRequest,
  LibrarySeriesSearchRequest,
  MultiInstanceLibraryResponse,
} from "@arr/shared";

import {
  fetchEpisodes,
  fetchLibrary,
  searchLibraryEpisode,
  searchLibraryMovie,
  searchLibrarySeason,
  searchLibrarySeries,
  toggleEpisodeMonitoring,
  toggleLibraryMonitoring
} from "../../lib/api-client/library";

interface LibraryQueryOptions {
  service?: LibraryService;
  instanceId?: string;
  enabled?: boolean;
}

export const useLibraryQuery = (options: LibraryQueryOptions = {}) =>
  useQuery<MultiInstanceLibraryResponse>({
    queryKey: ["library", { service: options.service, instanceId: options.instanceId }],
    queryFn: () => fetchLibrary({ service: options.service, instanceId: options.instanceId }),
    enabled: options.enabled ?? true,
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

export const useLibraryMonitorMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, LibraryToggleMonitorRequest>({
    mutationFn: toggleLibraryMonitoring,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["discover", "search"] });
    },
  });
};

export const useLibrarySeasonSearchMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, LibrarySeasonSearchRequest>({
    mutationFn: searchLibrarySeason,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
};


export const useLibraryMovieSearchMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, LibraryMovieSearchRequest>({
    mutationFn: searchLibraryMovie,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
};



export const useLibrarySeriesSearchMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, LibrarySeriesSearchRequest>({
    mutationFn: searchLibrarySeries,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
};

interface EpisodesQueryOptions {
  instanceId: string;
  seriesId: number | string;
  seasonNumber?: number;
  enabled?: boolean;
}

export const useEpisodesQuery = (options: EpisodesQueryOptions) =>
  useQuery<LibraryEpisodesResponse>({
    queryKey: ["library", "episodes", {
      instanceId: options.instanceId,
      seriesId: options.seriesId,
      seasonNumber: options.seasonNumber,
    }],
    queryFn: () => fetchEpisodes({
      instanceId: options.instanceId,
      seriesId: options.seriesId,
      seasonNumber: options.seasonNumber,
    }),
    enabled: options.enabled ?? true,
    staleTime: 60 * 1000,
  });

export const useLibraryEpisodeSearchMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, LibraryEpisodeSearchRequest>({
    mutationFn: searchLibraryEpisode,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["library", "episodes"] });
    },
  });
};

export const useLibraryEpisodeMonitorMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, LibraryEpisodeMonitorRequest>({
    mutationFn: toggleEpisodeMonitoring,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["library", "episodes"] });
    },
  });
};

