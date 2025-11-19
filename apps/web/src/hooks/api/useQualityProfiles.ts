"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
	QualityProfilesResponse,
	ImportQualityProfilePayload,
	ImportQualityProfileResponse,
	UpdateQualityProfileTemplatePayload,
} from "../../lib/api-client/trash-guides";
import {
	fetchQualityProfiles,
	fetchQualityProfileDetails,
	importQualityProfile,
	updateQualityProfileTemplate,
} from "../../lib/api-client/trash-guides";

/**
 * Hook to fetch TRaSH Guides quality profiles for a service
 */
export const useQualityProfiles = (serviceType: "RADARR" | "SONARR") =>
	useQuery<QualityProfilesResponse>({
		queryKey: ["quality-profiles", serviceType],
		queryFn: () => fetchQualityProfiles(serviceType),
		staleTime: 10 * 60 * 1000, // 10 minutes
	});

/**
 * Hook to fetch detailed quality profile by trash_id
 */
export const useQualityProfileDetails = (
	serviceType: "RADARR" | "SONARR",
	trashId: string,
	enabled = true,
) =>
	useQuery({
		queryKey: ["quality-profile-details", serviceType, trashId],
		queryFn: () => fetchQualityProfileDetails(serviceType, trashId),
		enabled: enabled && !!trashId,
		staleTime: 10 * 60 * 1000, // 10 minutes
	});

/**
 * Hook to import quality profile as template
 */
export const useImportQualityProfile = () => {
	const queryClient = useQueryClient();

	return useMutation<ImportQualityProfileResponse, Error, ImportQualityProfilePayload>({
		mutationFn: (payload) => importQualityProfile(payload),
		onSuccess: () => {
			// Invalidate templates query to show newly created template
			void queryClient.invalidateQueries({ queryKey: ["templates"] });
		},
	});
};

/**
 * Hook to import quality profile with wizard selections
 */
export const useImportQualityProfileWizard = () => {
	const queryClient = useQueryClient();

	return useMutation<ImportQualityProfileResponse, Error, ImportQualityProfilePayload & {
		selectedCFGroups: string[];
		customFormatSelections: Record<string, any>;
	}>({
		mutationFn: (payload) => importQualityProfile(payload),
		onSuccess: () => {
			// Invalidate templates query to show newly created template
			void queryClient.invalidateQueries({ queryKey: ["templates"] });
		},
	});
};

/**
 * Hook to update quality profile template with wizard selections
 */
export const useUpdateQualityProfileTemplate = () => {
	const queryClient = useQueryClient();

	return useMutation<ImportQualityProfileResponse, Error, UpdateQualityProfileTemplatePayload & {
		selectedCFGroups: string[];
		customFormatSelections: Record<string, any>;
	}>({
		mutationFn: (payload) => updateQualityProfileTemplate(payload),
		onSuccess: () => {
			// Invalidate templates query to show updated template
			void queryClient.invalidateQueries({ queryKey: ["templates"] });
		},
	});
};
