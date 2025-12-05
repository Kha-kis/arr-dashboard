/**
 * Dashboard Data Hook
 *
 * Manages data fetching and aggregation for dashboard view.
 * Centralizes services and queue data loading.
 */

import { useMemo } from "react";
import { useCurrentUser } from "../../../hooks/api/useAuth";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useMultiInstanceQueueQuery } from "../../../hooks/api/useDashboard";

/**
 * Hook for dashboard data management
 *
 * @returns Dashboard data including services, queue items, and loading states
 */
export const useDashboardData = () => {
	const { data: currentUser, isLoading: userLoading, error: userError } = useCurrentUser();

	const servicesQuery = useServicesQuery({ enabled: Boolean(currentUser) });
	const services = useMemo(() => servicesQuery.data ?? [], [servicesQuery.data]);
	const servicesLoading = servicesQuery.isLoading;

	const queueQuery = useMultiInstanceQueueQuery();
	const queueAggregated = useMemo(
		() => queueQuery.data?.aggregated ?? [],
		[queueQuery.data?.aggregated],
	);
	const queueInstances = useMemo(
		() => queueQuery.data?.instances ?? [],
		[queueQuery.data?.instances],
	);

	const totalQueueItems = queueQuery.data?.totalCount ?? queueAggregated.length;

	const isLoading = userLoading || (servicesLoading && Boolean(currentUser));

	// Group services by type for summary cards
	const groupedByService = useMemo(() => {
		const groups: Record<string, number> = {};
		for (const instance of services) {
			groups[instance.service] = (groups[instance.service] ?? 0) + 1;
		}
		return groups;
	}, [services]);

	// Extract unique instances from queue for filter options
	const instanceOptions = useMemo(() => {
		const seen = new Map<string, string>();
		for (const instance of queueInstances) {
			seen.set(instance.instanceId, instance.instanceName);
		}
		return Array.from(seen.entries()).map(([value, label]) => ({
			value,
			label,
		}));
	}, [queueInstances]);

	// Extract unique statuses from queue for filter options
	const statusOptions = useMemo(() => {
		const map = new Map<string, string>();
		for (const item of queueAggregated) {
			const label = item.status ?? "Pending";
			const value = label.toLowerCase();
			if (!map.has(value)) {
				map.set(value, label);
			}
		}
		return Array.from(map.entries()).map(([value, label]) => ({
			value,
			label,
		}));
	}, [queueAggregated]);

	return {
		// User state
		currentUser,
		userLoading,
		userError,

		// Services state
		services,
		servicesLoading,
		servicesRefetch: servicesQuery.refetch,
		groupedByService,

		// Queue state
		queueAggregated,
		queueInstances,
		totalQueueItems,
		queueLoading: queueQuery.isLoading,
		queueRefetch: queueQuery.refetch,

		// Filter options
		instanceOptions,
		statusOptions,

		// Combined loading state
		isLoading,
	};
};
