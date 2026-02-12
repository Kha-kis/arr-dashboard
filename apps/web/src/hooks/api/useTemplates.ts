"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateTemplateRequest, UpdateTemplateRequest } from "@arr/shared";
import {
	fetchTemplates,
	fetchTemplate,
	createTemplate,
	updateTemplate,
	deleteTemplate,
	duplicateTemplate,
	importTemplate,
	exportTemplate,
	fetchTemplateStats,
	type TemplateListResponse,
	type TemplateResponse,
	type TemplateStatsResponse,
	importEnhancedTemplate,
	type EnhancedImportTemplatePayload,
} from "../../lib/api-client/trash-guides";

// ============================================================================
// Query Key Constants
// ============================================================================

/**
 * Query key prefix for templates queries.
 * Used for invalidation to match all template queries regardless of params.
 * The actual query key is ["trash-guides", "templates", params], so this prefix will match all variations.
 */
export const TEMPLATES_QUERY_KEY = ["trash-guides", "templates"] as const;

// ============================================================================
// Query Hooks
// ============================================================================

/**
 * Hook to fetch all templates with optional filtering, searching, and sorting
 */
export const useTemplates = (params?: {
	serviceType?: "RADARR" | "SONARR";
	includeDeleted?: boolean;
	search?: string;
	sortBy?: "name" | "createdAt" | "updatedAt" | "usageCount";
	sortOrder?: "asc" | "desc";
	limit?: number;
	offset?: number;
}) =>
	useQuery<TemplateListResponse>({
		queryKey: ["trash-guides", "templates", params],
		queryFn: () => fetchTemplates(params),
		staleTime: 2 * 60 * 1000, // 2 minutes
		refetchOnMount: true,
	});

/**
 * Hook to fetch a single template by ID
 */
export const useTemplate = (templateId: string | null) =>
	useQuery<TemplateResponse>({
		queryKey: ["trash-guides", "template", templateId],
		queryFn: () => fetchTemplate(templateId!),
		enabled: !!templateId,
		staleTime: 5 * 60 * 1000, // 5 minutes
	});

/**
 * Hook to fetch template statistics
 */
export const useTemplateStats = (templateId: string | null) =>
	useQuery<TemplateStatsResponse>({
		queryKey: ["template-stats", templateId],
		queryFn: () => fetchTemplateStats(templateId!),
		enabled: !!templateId,
		staleTime: 1 * 60 * 1000, // 1 minute
	});

// ============================================================================
// Mutation Hooks
// ============================================================================

/**
 * Hook to create a new template
 */
export const useCreateTemplate = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (payload: CreateTemplateRequest) => createTemplate(payload),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
		},
	});
};

/**
 * Hook to update an existing template
 */
export const useUpdateTemplate = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ templateId, payload }: { templateId: string; payload: UpdateTemplateRequest }) =>
			updateTemplate(templateId, payload),
		onSuccess: (_, variables) => {
			void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
			void queryClient.invalidateQueries({ queryKey: ["trash-guides", "template", variables.templateId] });
		},
	});
};

/**
 * Hook to delete a template
 */
export const useDeleteTemplate = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (templateId: string) => deleteTemplate(templateId),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
		},
	});
};

/**
 * Hook to duplicate a template
 */
export const useDuplicateTemplate = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ templateId, newName }: { templateId: string; newName: string }) =>
			duplicateTemplate(templateId, newName),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
		},
	});
};

/**
 * Hook to import a template
 */
export const useImportTemplate = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (jsonData: string) => importTemplate(jsonData),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
		},
	});
};

/**
 * Hook to import a template with enhanced options (validation, conflict resolution)
 */
export const useEnhancedImportTemplate = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (payload: EnhancedImportTemplatePayload) => importEnhancedTemplate(payload),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY });
		},
	});
};

/**
 * Hook to export a template as JSON
 * Returns the template JSON as a string
 */
export const useExportTemplate = () => {
	return useMutation({
		mutationFn: (templateId: string) => exportTemplate(templateId),
	});
};
