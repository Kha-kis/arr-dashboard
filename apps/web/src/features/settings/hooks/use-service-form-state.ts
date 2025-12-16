import { useState } from "react";
import type { ServiceInstanceSummary } from "@arr/shared";
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
			apiKey: "",
			service: service.service,
			enabled: service.enabled,
			isDefault: service.isDefault,
			tags: service.tags.map((tag) => tag.name).join(", "),
			defaultQualityProfileId:
				service.defaultQualityProfileId != null ? String(service.defaultQualityProfileId) : "",
			defaultLanguageProfileId:
				service.defaultLanguageProfileId != null ? String(service.defaultLanguageProfileId) : "",
			defaultRootFolderPath: service.defaultRootFolderPath ?? "",
			defaultSeasonFolder:
				service.defaultSeasonFolder === null || service.defaultSeasonFolder === undefined
					? ""
					: service.defaultSeasonFolder
						? "true"
						: "false",
			storageGroupId: service.storageGroupId ?? "",
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
