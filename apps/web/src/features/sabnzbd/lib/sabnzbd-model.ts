"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import { POLLING_ACTIVE, POLLING_STANDARD } from "../../../lib/polling-intervals";

export type SabLibrary = {
	service: "sonarr" | "radarr";
	title: string;
	instanceLabel: string;
};

export type SabJob = {
	nzoId: string;
	name: string;
	status: string;
	size: string;
	sizeLeft: string;
	timeLeft: string;
	percentage: string;
	category: string;
	priority: string;
	library: SabLibrary | null;
};

export type SabHistoryItem = {
	nzoId: string;
	name: string;
	status: string;
	size: string;
	completedAt: string;
	failMessage: string;
	category: string;
	library: SabLibrary | null;
};

export type SabAttention = {
	id: string;
	severity: "warning" | "critical";
	title: string;
	detail: string;
};

export type SabInstance = {
	id: string;
	label: string;
	reachable: boolean;
	version: string;
	paused: boolean;
	status: string;
	speed: string;
	kbPerSec: number;
	sizeLeft: string;
	timeLeft: string;
	diskFree: string;
	diskTotal: string;
	queueCount: number;
	pausedJobs: number;
	failedRecent: number;
	categories: string[];
	queue: SabJob[];
	history: SabHistoryItem[];
	queueCoverage: "complete" | "partial" | "unavailable";
	historyCoverage: "complete" | "partial" | "unavailable";
	warnings: Array<{ text: string }>;
	attention: SabAttention[];
	error?: string;
};

export type SabOverview = {
	configured: boolean;
	instances: SabInstance[];
};

export type SabCorrelation = {
	coverage: "complete" | "partial";
	matches: Record<string, SabLibrary>;
};

export const sabKeys = {
	overview: ["sabnzbd", "overview"] as const,
	history: (instanceId: string, start: number) =>
		["sabnzbd", "history", instanceId, start] as const,
};

export type SabHistoryPage = {
	items: SabHistoryItem[];
	start: number;
	limit: number;
	total: number;
	coverage: "complete" | "partial";
};

export function useSabHistory(instanceId: string, start: number) {
	return useQuery({
		queryKey: sabKeys.history(instanceId, start),
		queryFn: () =>
			apiRequest<SabHistoryPage>(
				`/api/sabnzbd/${encodeURIComponent(instanceId)}/history?start=${start}&limit=20`,
			),
		enabled: Boolean(instanceId),
		refetchInterval: POLLING_STANDARD,
	});
}

export function useSabCorrelation(instanceId: string) {
	return useQuery({
		queryKey: ["sabnzbd", "correlation", instanceId],
		queryFn: () =>
			apiRequest<SabCorrelation>(`/api/sabnzbd/${encodeURIComponent(instanceId)}/correlation`),
		enabled: Boolean(instanceId),
		refetchInterval: false,
	});
}

export function useSabOverview() {
	return useQuery({
		queryKey: sabKeys.overview,
		queryFn: () => apiRequest<SabOverview>("/api/sabnzbd"),
		refetchInterval: POLLING_ACTIVE,
	});
}

export type SabActionResult = {
	outcome: "verified" | "unconfirmed" | "refused";
	message: string;
	replacementId?: string;
};

export type SabJobAction = {
	instanceId: string;
	nzoId: string;
	action: "pause" | "resume" | "delete" | "priority" | "category";
	priority?: "-1" | "0" | "1" | "2";
	category?: string;
	confirmed?: boolean;
};

export function useSabJobAction() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ instanceId, nzoId, action, priority, category, confirmed }: SabJobAction) =>
			apiRequest<SabActionResult>(
				`/api/sabnzbd/${encodeURIComponent(instanceId)}/jobs/${encodeURIComponent(nzoId)}`,
				{
					method: "POST",
					json: { action, priority, category, confirmed },
				},
			),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: sabKeys.overview }),
	});
}

export function useSabGlobalAction() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, action }: { id: string; action: "pause" | "resume" }) =>
			apiRequest<SabActionResult>(`/api/sabnzbd/${encodeURIComponent(id)}/${action}`, {
				method: "POST",
			}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: sabKeys.overview }),
	});
}

export function useSabHistoryAction() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({
			instanceId,
			nzoId,
			action,
		}: {
			instanceId: string;
			nzoId: string;
			action: "retry" | "remove";
		}) =>
			apiRequest<SabActionResult>(
				`/api/sabnzbd/${encodeURIComponent(instanceId)}/history/${encodeURIComponent(nzoId)}/${action}`,
				{
					method: "POST",
					...(action === "remove" ? { json: { confirmed: true } } : {}),
				},
			),
		onSuccess: (_result, variables) => {
			queryClient.invalidateQueries({ queryKey: sabKeys.overview });
			queryClient.invalidateQueries({ queryKey: ["sabnzbd", "history", variables.instanceId] });
		},
	});
}

export const PRIORITY_OPTIONS: Array<{ value: "-1" | "0" | "1" | "2"; label: string }> = [
	{ value: "2", label: "Force" },
	{ value: "1", label: "High" },
	{ value: "0", label: "Normal" },
	{ value: "-1", label: "Low" },
];

export function priorityValue(raw: string): "-1" | "0" | "1" | "2" {
	if (raw === "-1" || raw === "0" || raw === "1" || raw === "2") return raw;
	const lowered = raw.toLowerCase();
	if (lowered.includes("force")) return "2";
	if (lowered.includes("high")) return "1";
	if (lowered.includes("low")) return "-1";
	return "0";
}
