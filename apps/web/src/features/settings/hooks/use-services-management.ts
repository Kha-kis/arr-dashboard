import type { ServiceInstanceSummary } from "@arr/shared";
import { useState } from "react";
import { toast } from "sonner";
import {
	useCreateServiceMutation,
	useDeleteServiceMutation,
	useTestConnectionBeforeAdd,
	useTestServiceConnection,
	useUpdateServiceMutation,
} from "../../../hooks/api/useServiceMutations";
import type { UpdateServicePayload } from "../../../lib/api-client/services";
import { getErrorMessage } from "../../../lib/error-utils";
import { supportsHttpBasicAuth, type ServiceFormState } from "../lib/settings-utils";

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
		version?: string;
		error?: string;
		details?: string;
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

		// Handle storage group: empty string becomes null
		const trimmedStorageGroupId = formState.storageGroupId.trim();
		const storageGroupId = trimmedStorageGroupId.length > 0 ? trimmedStorageGroupId : null;

		// Handle external URL: empty string becomes null
		const trimmedExternalUrl = formState.externalUrl.trim();
		const externalUrl = trimmedExternalUrl.length > 0 ? trimmedExternalUrl : null;

		// qui-only fields: only persist when the form is for a qui instance,
		// so toggling these in a Sonarr form (which can't render them, but
		// could otherwise carry stale state from a previous edit) is a no-op.
		const trimmedPathPrefix = formState.pathPrefix.trim();
		const isQui = formState.service === "qui";
		const username = formState.httpAuthUsername.trim();
		const password = formState.httpAuthPassword;
		let httpAuth: { username: string; password: string } | null | undefined;
		if (!supportsHttpBasicAuth(formState.service)) {
			httpAuth = selectedServiceForEdit?.hasHttpAuth ? null : undefined;
		} else if (!formState.httpAuthEnabled) {
			httpAuth = selectedServiceForEdit?.hasHttpAuth ? null : undefined;
		} else if (username || password) {
			if (!username || !password) {
				toast.error("Enter both an HTTP Basic Auth username and password");
				return;
			}
			httpAuth = { username, password };
		} else if (!selectedServiceForEdit?.hasHttpAuth) {
			toast.error("Enter both an HTTP Basic Auth username and password");
			return;
		}

		const basePayload = {
			label: formState.label.trim(),
			baseUrl: formState.baseUrl.trim(),
			externalUrl,
			apiKey: formState.apiKey.trim(),
			httpAuth,
			service: formState.service,
			enabled: formState.enabled,
			isDefault: formState.isDefault,
			tags: trimmedTags,
			storageGroupId,
			...(isQui
				? {
						hasLocalFilesystemAccess: formState.hasLocalFilesystemAccess,
						pathPrefix: trimmedPathPrefix.length > 0 ? trimmedPathPrefix : null,
					}
				: {}),
		};

		if (
			!basePayload.label ||
			!basePayload.baseUrl ||
			(!selectedServiceForEdit && !basePayload.apiKey)
		) {
			return;
		}

		try {
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
		} catch (error) {
			toast.error(getErrorMessage(error, "Failed to save service"));
		}
	};

	const handleDeleteService = async (
		instance: ServiceInstanceSummary,
		selectedServiceForEdit: ServiceInstanceSummary | null,
		resetForm: (service: ServiceFormState["service"]) => void,
	) => {
		try {
			await deleteServiceMutation.mutateAsync(instance.id);
			if (selectedServiceForEdit?.id === instance.id) {
				resetForm(instance.service);
			}
		} catch (error) {
			toast.error(getErrorMessage(error, "Failed to delete service"));
		}
	};

	const toggleDefault = async (instance: ServiceInstanceSummary) => {
		try {
			await updateServiceMutation.mutateAsync({
				id: instance.id,
				payload: {
					service: instance.service,
					isDefault: !instance.isDefault,
				},
			});
		} catch (error) {
			toast.error(getErrorMessage(error, "Failed to update default status"));
		}
	};

	const toggleEnabled = async (instance: ServiceInstanceSummary) => {
		try {
			await updateServiceMutation.mutateAsync({
				id: instance.id,
				payload: {
					enabled: !instance.enabled,
				},
			});
		} catch (error) {
			toast.error(getErrorMessage(error, "Failed to toggle service"));
		}
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
					message: `${result.message} (v${result.version?.replace(/^v/i, "") ?? "unknown"})`,
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
				message: getErrorMessage(error, "Connection test failed"),
			});
		} finally {
			setTestingConnection(null);
		}
	};

	const handleTestFormConnection = async (
		formState: ServiceFormState,
		selectedService?: ServiceInstanceSummary | null,
	) => {
		const canUseSavedApiKey = Boolean(
			selectedService &&
				!formState.apiKey &&
				formState.service === selectedService.service &&
				formState.baseUrl.trim() === selectedService.baseUrl,
		);
		if (!formState.baseUrl || (!formState.apiKey && !canUseSavedApiKey)) {
			setFormTestResult({
				success: false,
				message: "Base URL and API Key are required to test unsaved connection details",
			});
			return;
		}

		setTestingFormConnection(true);
		setFormTestResult(null);

		try {
			const username = formState.httpAuthUsername.trim();
			const password = formState.httpAuthPassword;
			if (formState.httpAuthEnabled && (username || password) && (!username || !password)) {
				setFormTestResult({
					success: false,
					message: "Enter both HTTP Basic Auth fields to test unsaved credentials",
				});
				return;
			}
			if (canUseSavedApiKey && selectedService) {
				let savedTestInput:
					| string
					| { id: string; httpAuth: { username: string; password: string } | null };
				if (!formState.httpAuthEnabled || !supportsHttpBasicAuth(formState.service)) {
					savedTestInput = { id: selectedService.id, httpAuth: null };
				} else if (username && password) {
					savedTestInput = { id: selectedService.id, httpAuth: { username, password } };
				} else if (selectedService.hasHttpAuth) {
					savedTestInput = selectedService.id;
				} else {
					setFormTestResult({
						success: false,
						message: "Enter both HTTP Basic Auth fields to test unsaved credentials",
					});
					return;
				}
				const result = await testServiceConnectionMutation.mutateAsync(savedTestInput);
				setFormTestResult({
					success: result.success,
					message: result.success
						? (result.message ?? "Connection successful")
						: (result.error ?? "Connection failed"),
					version: result.version,
					error: result.error,
					details: result.details,
				});
				return;
			}
			if (formState.httpAuthEnabled && (!username || !password)) {
				setFormTestResult({
					success: false,
					message: "Enter both HTTP Basic Auth fields to test unsaved credentials",
				});
				return;
			}
			const result = await testConnectionBeforeAddMutation.mutateAsync({
				baseUrl: formState.baseUrl.trim(),
				apiKey: formState.apiKey.trim(),
				service: formState.service,
				httpAuth:
					supportsHttpBasicAuth(formState.service) && formState.httpAuthEnabled
						? { username, password }
						: undefined,
			});

			if (result.success) {
				setFormTestResult({
					success: true,
					message: result.message ?? "Connection successful",
					version: result.version,
				});
			} else {
				setFormTestResult({
					success: false,
					message: result.error ?? "Connection failed",
					error: result.error,
					details: result.details,
				});
			}
		} catch (error: unknown) {
			setFormTestResult({
				success: false,
				message: getErrorMessage(error, "Connection test failed"),
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
