"use client";

import { Server } from "lucide-react";
import type { ServiceInstanceSummary } from "@arr/shared";
import {
	PremiumSection,
	PremiumEmptyState,
	PremiumSkeleton,
} from "../../../components/layout";
import { ServiceInstanceCard } from "./service-instance-card";

/**
 * Props for the ServicesTab component
 */
interface ServicesTabProps {
	/** List of service instances */
	services: ServiceInstanceSummary[];
	/** Whether services are loading */
	isLoading: boolean;
	/** Handler for test connection */
	onTestConnection: (instance: ServiceInstanceSummary) => void;
	/** Handler for edit */
	onEdit: (instance: ServiceInstanceSummary) => void;
	/** Handler for toggle default */
	onToggleDefault: (instance: ServiceInstanceSummary) => void;
	/** Handler for toggle enabled */
	onToggleEnabled: (instance: ServiceInstanceSummary) => void;
	/** Handler for delete */
	onDelete: (instance: ServiceInstanceSummary) => void;
	/** ID of instance currently being tested */
	testingConnection: string | null;
	/** Test result */
	testResult: {
		id: string;
		success: boolean;
		message: string;
	} | null;
	/** Whether mutations are pending */
	mutationPending: boolean;
}

/**
 * Premium Services Tab
 *
 * Displays list of configured service instances with:
 * - Glassmorphic section wrapper
 * - Staggered animation for cards
 * - Premium empty state
 */
export const ServicesTab = ({
	services,
	isLoading,
	onTestConnection,
	onEdit,
	onToggleDefault,
	onToggleEnabled,
	onDelete,
	testingConnection,
	testResult,
	mutationPending,
}: ServicesTabProps) => {
	// Loading state
	if (isLoading) {
		return (
			<PremiumSection
				title="Configured Instances"
				description="Manage all Sonarr, Radarr, and Prowlarr connections"
				icon={Server}
			>
				<div className="space-y-4">
					{Array.from({ length: 3 }).map((_, i) => (
						<PremiumSkeleton
							key={i}
							variant="card"
							className="h-24"
							style={{ animationDelay: `${i * 50}ms` }}
						/>
					))}
				</div>
			</PremiumSection>
		);
	}

	// Empty state
	if (services.length === 0) {
		return (
			<PremiumSection
				title="Configured Instances"
				description="Manage all Sonarr, Radarr, and Prowlarr connections"
				icon={Server}
			>
				<PremiumEmptyState
					icon={Server}
					title="No services configured"
					description="Add your first Sonarr, Radarr, or Prowlarr instance using the form on the right."
				/>
			</PremiumSection>
		);
	}

	return (
		<PremiumSection
			title="Configured Instances"
			description="Manage all Sonarr, Radarr, and Prowlarr connections"
			icon={Server}
		>
			<div className="space-y-4">
				{services.map((instance, index) => (
					<ServiceInstanceCard
						key={instance.id}
						instance={instance}
						onTestConnection={onTestConnection}
						onEdit={onEdit}
						onToggleDefault={onToggleDefault}
						onToggleEnabled={onToggleEnabled}
						onDelete={onDelete}
						isTesting={testingConnection === instance.id}
						mutationPending={mutationPending}
						testResult={testResult}
						animationDelay={index * 50}
					/>
				))}
			</div>
		</PremiumSection>
	);
};
