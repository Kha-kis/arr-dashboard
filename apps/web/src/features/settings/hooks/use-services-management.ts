import { useState } from "react";
import type { ServiceInstanceSummary } from "@arr/shared";
import type { UpdateServicePayload } from "../../../lib/api-client/services";
import type { ServiceFormState } from "../lib/settings-utils";
import {
	useCreateServiceMutation,
	useDeleteServiceMutation,
	useUpdateServiceMutation,
	useTestServiceConnection,
	useTestConnectionBeforeAdd,
} from "../../../hooks/api/useServiceMutations";
import { parseNumericValue, parseSeasonFolderValue } from "../lib/settings-utils";

/**
 * Hook for managing service instances
 */
export const useServicesManagement = () => {
	const createServiceMutation = useCreateServiceMutation();
	const updateServiceMutation = useUpdateServiceMutation();
	const deleteServiceMutation = useDeleteServiceMutation();
	const testServiceConnectionMutation = useTestServiceConnection();
	const testConnectionBeforeAddMutation = useTestConnectionBeforeAdd();

	const [testingConnection, setTestingConnection] = useState<string | null>(null);
	const [testResult, setTestResult] = useState<{
		id: string;
		success: boolean;
		message: string;
	} | null>(null);
	const [testingFormConnection, setTestingFormConnection] = useState(false);
	const [formTestResult, setFormTestResult] = useState<{
		success: boolean;
		message: string;
	} | null>(null);

	const handleSubmit = async (
		formState: ServiceFormState,
		selectedServiceForEdit: ServiceInstanceSummary | null,
		resetForm: (service: ServiceFormState["service"]) => void,
	) => {
		const trimmedTags = formState.tags
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean);

		const defaultQualityProfileId = parseNumericValue(formState.defaultQualityProfileId);
		const defaultLanguageProfileId =
			formState.service === "sonarr" ? parseNumericValue(formState.defaultLanguageProfileId) : null;
		const trimmedRootFolder = formState.defaultRootFolderPath.trim();
		const defaultRootFolderPath =
			formState.service !== "prowlarr" && trimmedRootFolder.length > 0 ? trimmedRootFolder : null;
		const defaultSeasonFolder =
			formState.service === "sonarr" ? parseSeasonFolderValue(formState.defaultSeasonFolder) : null;

		// Handle storage group: empty string becomes null
		const trimmedStorageGroupId = formState.storageGroupId.trim();
		const storageGroupId = trimmedStorageGroupId.length > 0 ? trimmedStorageGroupId : null;

		const basePayload = {
			label: formState.label.trim(),
			baseUrl: formState.baseUrl.trim(),
			apiKey: formState.apiKey.trim(),
			service: formState.service,
			enabled: formState.enabled,
			isDefault: formState.isDefault,
			tags: trimmedTags,
			defaultQualityProfileId,
			defaultLanguageProfileId,
			defaultRootFolderPath,
			defaultSeasonFolder,
			storageGroupId,
		};

		if (
			!basePayload.label ||
			!basePayload.baseUrl ||
			(!selectedServiceForEdit && !basePayload.apiKey)
		) {
			return;
		}

		if (selectedServiceForEdit) {
			const updatePayload: UpdateServicePayload = { ...basePayload };
			if (!basePayload.apiKey) {
				updatePayload.apiKey = undefined;
			}

			await updateServiceMutation.mutateAsync({
				id: selectedServiceForEdit.id,
				payload: updatePayload,
			});
		} else {
			await createServiceMutation.mutateAsync(basePayload);
		}

		resetForm(basePayload.service);
	};

	const handleDeleteService = async (
		instance: ServiceInstanceSummary,
		selectedServiceForEdit: ServiceInstanceSummary | null,
		resetForm: (service: ServiceFormState["service"]) => void,
	) => {
		await deleteServiceMutation.mutateAsync(instance.id);
		if (selectedServiceForEdit?.id === instance.id) {
			resetForm(instance.service);
		}
	};

	const toggleDefault = async (instance: ServiceInstanceSummary) => {
		await updateServiceMutation.mutateAsync({
			id: instance.id,
			payload: {
				service: instance.service,
				isDefault: !instance.isDefault,
			},
		});
	};

	const toggleEnabled = async (instance: ServiceInstanceSummary) => {
		await updateServiceMutation.mutateAsync({
			id: instance.id,
			payload: {
				enabled: !instance.enabled,
			},
		});
	};

	const handleTestConnection = async (instance: ServiceInstanceSummary) => {
		setTestingConnection(instance.id);
		setTestResult(null);

		try {
			const result = await testServiceConnectionMutation.mutateAsync(instance.id);

			if (result.success) {
				setTestResult({
					id: instance.id,
					success: true,
					message: `${result.message} (v${result.version})`,
				});
			} else {
				setTestResult({
					id: instance.id,
					success: false,
					message: `${result.error}: ${result.details}`,
				});
			}
		} catch (error: unknown) {
			setTestResult({
				id: instance.id,
				success: false,
				message: error instanceof Error ? error.message : "Connection test failed",
			});
		} finally {
			setTestingConnection(null);
		}
	};

	const handleTestFormConnection = async (formState: ServiceFormState) => {
		if (!formState.baseUrl || !formState.apiKey) {
			setFormTestResult({
				success: false,
				message: "Base URL and API Key are required to test connection",
			});
			return;
		}

		setTestingFormConnection(true);
		setFormTestResult(null);

		try {
			const result = await testConnectionBeforeAddMutation.mutateAsync({
				baseUrl: formState.baseUrl.trim(),
				apiKey: formState.apiKey.trim(),
				service: formState.service,
			});

			if (result.success) {
				setFormTestResult({
					success: true,
					message: `${result.message} (v${result.version})`,
				});
			} else {
				setFormTestResult({
					success: false,
					message: `${result.error}: ${result.details}`,
				});
			}
		} catch (error: unknown) {
			setFormTestResult({
				success: false,
				message: error instanceof Error ? error.message : "Connection test failed",
			});
		} finally {
			setTestingFormConnection(false);
		}
	};

	const resetFormTestResult = () => setFormTestResult(null);

	return {
		createServiceMutation,
		updateServiceMutation,
		deleteServiceMutation,
		testingConnection,
		testResult,
		testingFormConnection,
		formTestResult,
		handleSubmit,
		handleDeleteService,
		toggleDefault,
		toggleEnabled,
		handleTestConnection,
		handleTestFormConnection,
		resetFormTestResult,
	};
};
