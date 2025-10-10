"use client";

import type { ServiceInstanceSummary } from "@arr/shared";
import { Button } from "../../../components/ui/button";
import { Alert, AlertDescription } from "../../../components/ui";
import { useIncognitoMode, getLinuxUrl } from "../../../lib/incognito";

/**
 * Props for the ServiceInstanceCard component
 */
interface ServiceInstanceCardProps {
	/** The service instance to display */
	instance: ServiceInstanceSummary;
	/** Handler for test connection button */
	onTestConnection: (instance: ServiceInstanceSummary) => void;
	/** Handler for edit button */
	onEdit: (instance: ServiceInstanceSummary) => void;
	/** Handler for toggle default button */
	onToggleDefault: (instance: ServiceInstanceSummary) => void;
	/** Handler for toggle enabled button */
	onToggleEnabled: (instance: ServiceInstanceSummary) => void;
	/** Handler for delete button */
	onDelete: (instance: ServiceInstanceSummary) => void;
	/** Whether the connection test is currently running for this instance */
	isTesting: boolean;
	/** Whether mutations are pending */
	mutationPending: boolean;
	/** Test result to display (if any) */
	testResult?: {
		id: string;
		success: boolean;
		message: string;
	} | null;
}

/**
 * Displays a single service instance card with action buttons
 */
export const ServiceInstanceCard = ({
	instance,
	onTestConnection,
	onEdit,
	onToggleDefault,
	onToggleEnabled,
	onDelete,
	isTesting,
	mutationPending,
	testResult,
}: ServiceInstanceCardProps) => {
	const [incognitoMode] = useIncognitoMode();

	return (
		<div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/5 p-4">
			<div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
				<div>
					<div className="flex items-center gap-3">
						<span className="rounded-md bg-white/10 px-2 py-1 text-xs uppercase text-white/60">
							{instance.service}
						</span>
						<h3 className="text-base font-semibold text-white">{instance.label}</h3>
					</div>
					<p className="text-xs text-white/50">
						{incognitoMode ? getLinuxUrl(instance.baseUrl) : instance.baseUrl}
					</p>
					<p className="text-xs text-white/50">
						Tags:{" "}
						{instance.tags.length === 0 ? "-" : instance.tags.map((tag) => tag.name).join(", ")}
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button
						variant="secondary"
						onClick={() => onTestConnection(instance)}
						disabled={isTesting}
					>
						{isTesting ? "Testing..." : "Test"}
					</Button>
					<Button variant="secondary" onClick={() => onEdit(instance)}>
						Edit
					</Button>
					<Button
						variant={instance.isDefault ? "secondary" : "ghost"}
						onClick={() => onToggleDefault(instance)}
						disabled={mutationPending}
					>
						{instance.isDefault ? "Default" : "Make default"}
					</Button>
					<Button
						variant="ghost"
						onClick={() => onToggleEnabled(instance)}
						disabled={mutationPending}
					>
						{instance.enabled ? "Disable" : "Enable"}
					</Button>
					<Button variant="danger" onClick={() => onDelete(instance)} disabled={mutationPending}>
						Delete
					</Button>
				</div>
			</div>
			{testResult && testResult.id === instance.id && (
				<Alert variant={testResult.success ? "success" : "danger"}>
					<AlertDescription>{testResult.message}</AlertDescription>
				</Alert>
			)}
		</div>
	);
};
