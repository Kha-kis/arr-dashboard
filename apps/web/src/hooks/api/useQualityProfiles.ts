"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
	QualityProfilesResponse,
	ImportQualityProfilePayload,
	ImportQualityProfileResponse,
	UpdateQualityProfileTemplatePayload,
	CreateClonedTemplatePayload,
	ValidateCFsPayload,
	CFValidationResponse,
	MatchProfilePayload,
	ProfileMatchResult,
} from "../../lib/api-client/trash-guides";
import {
	fetchQualityProfiles,
	fetchQualityProfileDetails,
	importQualityProfile,
	updateQualityProfileTemplate,
	createClonedProfileTemplate,
	validateClonedCFs,
	matchProfileToTrash,
} from "../../lib/api-client/trash-guides";
import { TEMPLATES_QUERY_KEY } from "./useTemplates";

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
			void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
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
		customQualityConfig?: any;
	}>({
		mutationFn: (payload) => importQualityProfile(payload),
		onSuccess: () => {
			// Invalidate templates query to show newly created template
			void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
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
		customQualityConfig?: any;
	}>({
		mutationFn: (payload) => updateQualityProfileTemplate(payload),
		onSuccess: () => {
			// Invalidate templates query to show updated template
			void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
		},
	});
};

/**
 * Hook to create template from cloned profile (instance-based)
 */
export const useCreateClonedProfileTemplate = () => {
	const queryClient = useQueryClient();

	return useMutation<ImportQualityProfileResponse, Error, CreateClonedTemplatePayload>({
		mutationFn: (payload) => createClonedProfileTemplate(payload),
		onSuccess: () => {
			// Invalidate templates query to show newly created template
			void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
		},
	});
};

/**
 * Hook to validate cloned CFs against TRaSH cache
 * Returns match results showing which CFs match TRaSH Guides and with what confidence
 */
export const useValidateClonedCFs = () => {
	return useMutation<CFValidationResponse, Error, ValidateCFsPayload>({
		mutationFn: (payload) => validateClonedCFs(payload),
	});
};

/**
 * Query hook version for fetching CF validation when parameters are known
 */
export const useClonedCFValidation = (
	instanceId: string,
	profileId: number,
	serviceType: "RADARR" | "SONARR",
	enabled = true,
) =>
	useQuery<CFValidationResponse>({
		queryKey: ["cf-validation", instanceId, profileId, serviceType],
		queryFn: () => validateClonedCFs({ instanceId, profileId, serviceType }),
		enabled: enabled && !!instanceId && !!profileId,
		staleTime: 5 * 60 * 1000, // 5 minutes
	});

/**
 * Hook to match profile name to TRaSH Guides quality profiles
 * Returns CF recommendations based on the matched profile
 */
export const useMatchProfileToTrash = () => {
	return useMutation<ProfileMatchResult, Error, MatchProfilePayload>({
		mutationFn: (payload) => matchProfileToTrash(payload),
	});
};

/**
 * Query hook version for profile matching when parameters are known
 * Uses short staleTime to ensure fresh recommendations based on latest TRaSH cache
 */
export const useProfileMatch = (
	profileName: string,
	serviceType: "RADARR" | "SONARR",
	enabled = true,
) =>
	useQuery<ProfileMatchResult>({
		queryKey: ["profile-match", profileName, serviceType],
		queryFn: () => matchProfileToTrash({ profileName, serviceType }),
		enabled: enabled && !!profileName && !!serviceType,
		staleTime: 30 * 1000, // 30 seconds - short to pick up TRaSH cache updates
	});
