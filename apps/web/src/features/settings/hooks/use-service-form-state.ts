import type { ServiceInstanceSummary } from "@arr/shared";
import { useState } from "react";
import type { ServiceFormState } from "../lib/settings-utils";
import { defaultFormState } from "../lib/settings-utils";

/**
 * Hook for managing service form state
 */
export const useServiceFormState = () => {
	const [selectedServiceForEdit, setSelectedServiceForEdit] =
		useState<ServiceInstanceSummary | null>(null);
	const [formState, setFormState] = useState<ServiceFormState>(defaultFormState("sonarr"));

	const resetForm = (service: ServiceFormState["service"]) => {
		setFormState(defaultFormState(service));
		setSelectedServiceForEdit(null);
	};

	const handleEdit = (service: ServiceInstanceSummary) => {
		setSelectedServiceForEdit(service);
		setFormState({
			label: service.label,
			baseUrl: service.baseUrl,
			externalUrl: service.externalUrl ?? "",
			apiKey: "",
			service: service.service,
			enabled: service.enabled,
			isDefault: service.isDefault,
			tags: service.tags.map((tag) => tag.name).join(", "),
			storageGroupId: service.storageGroupId ?? "",
			// qui-only fields. Older `ServiceInstanceSummary` shapes (before
			// these were added to the API response) may not include them —
			// fall back to safe defaults so editing a pre-existing record
			// doesn't blank the form.
			hasLocalFilesystemAccess:
				(service as Partial<{ hasLocalFilesystemAccess: boolean }>).hasLocalFilesystemAccess ??
				false,
			pathPrefix: (service as Partial<{ pathPrefix: string | null }>).pathPrefix ?? "",
		});
	};

	return {
		selectedServiceForEdit,
		formState,
		setFormState,
		resetForm,
		handleEdit,
	};
};
