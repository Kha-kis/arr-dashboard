"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";

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
	warnings: Array<{ text: string }>;
	attention: SabAttention[];
	error?: string;
};

export type SabOverview = {
	configured: boolean;
	instances: SabInstance[];
};

export const sabKeys = {
	overview: ["sabnzbd", "overview"] as const,
};

export function useSabOverview() {
	return useQuery({
		queryKey: sabKeys.overview,
		queryFn: () => apiRequest<SabOverview>("/api/sabnzbd"),
		refetchInterval: 5000,
	});
}

export type SabJobAction = {
	instanceId: string;
	nzoId: string;
	action: "pause" | "resume" | "delete" | "retry" | "priority" | "category";
	priority?: "-1" | "0" | "1" | "2";
	category?: string;
};

export function useSabJobAction() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ instanceId, nzoId, action, priority, category }: SabJobAction) =>
			apiRequest(`/api/sabnzbd/${instanceId}/jobs/${encodeURIComponent(nzoId)}`, {
				method: "POST",
				json: { action, priority, category },
			}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: sabKeys.overview }),
	});
}

export function useSabGlobalAction() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ id, action }: { id: string; action: "pause" | "resume" }) =>
			apiRequest(`/api/sabnzbd/${id}/${action}`, { method: "POST" }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: sabKeys.overview }),
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
