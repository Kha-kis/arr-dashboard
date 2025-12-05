"use client";

import type { ServiceInstanceSummary } from "@arr/shared";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	CardDescription,
} from "../../../components/ui/card";
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
 * Displays list of configured service instances
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
	return (
		<Card>
			<CardHeader>
				<CardTitle>Configured Instances</CardTitle>
				<CardDescription>Manage all Sonarr, Radarr, and Prowlarr connections</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{isLoading ? (
					<p className="text-sm text-fg-muted">Loading services...</p>
				) : services.length === 0 ? (
					<p className="text-sm text-fg-muted">No services configured yet.</p>
				) : (
					<div className="space-y-3">
						{services.map((instance) => (
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
							/>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
};
