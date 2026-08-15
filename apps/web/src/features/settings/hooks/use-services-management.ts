import type { AnalyticsProvider, ServiceInstanceSummary } from "@arr/shared";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
	useCreateServiceMutation,
	useDeleteServiceMutation,
	useReplaceServiceIdentityMutation,
	useTestConnectionBeforeAdd,
	useTestServiceConnection,
	useUpdateServiceMutation,
	useVerifyServiceIdentityMutation,
} from "../../../hooks/api/useServiceMutations";
import { ApiError } from "../../../lib/api-client/base";
import {
	inspectServiceIdentity,
	type ServiceIdentityCandidate,
	type UpdateServicePayload,
} from "../../../lib/api-client/services";
import { getErrorMessage } from "../../../lib/error-utils";
import { type ServiceFormState, supportsHttpBasicAuth } from "../lib/settings-utils";

export type IdentityFlow = {
	instanceId: string;
	mode: "verify" | "replace";
	candidate: ServiceIdentityCandidate;
	connectionGeneration: number;
	identityGeneration: number;
	replacementPayload: UpdateServicePayload;
	requiresReinspection: boolean;
	message: string;
};

function getIdentityConflict(error: unknown) {
	if (!(error instanceof ApiError) || error.status !== 409 || !error.payload) return null;
	const payload = error.payload as { details?: unknown };
	const details = payload.details;
	if (!details || typeof details !== "object") return null;
	const value = details as Record<string, unknown>;
	if (
		value.code !== "IDENTITY_REPLACEMENT_REQUIRED" &&
		value.code !== "IDENTITY_CANDIDATE_CHANGED" &&
		value.code !== "IDENTITY_GENERATION_STALE"
	)
		return null;
	return value as {
		code:
			| "IDENTITY_REPLACEMENT_REQUIRED"
			| "IDENTITY_CANDIDATE_CHANGED"
			| "IDENTITY_GENERATION_STALE";
		candidate?: ServiceIdentityCandidate;
		connectionGeneration: number;
		identityGeneration: number;
	};
}

type AnalyticsUnavailableConfirmation = {
	selected: AnalyticsProvider;
	alternativeEnabled: boolean;
	onConfirm: () => Promise<void>;
};

function getAnalyticsUnavailableConfirmation(error: unknown): {
	selected: AnalyticsProvider;
	alternativeEnabled: boolean;
} | null {
	if (!(error instanceof ApiError) || error.status !== 409) return null;
	if (!error.payload || typeof error.payload !== "object") return null;
	const payload = error.payload as Record<string, unknown>;
	if (
		payload.code !== "ANALYTICS_PROVIDER_CONFIRMATION_REQUIRED" ||
		(payload.selected !== "tracearr" && payload.selected !== "tautulli") ||
		typeof payload.alternativeEnabled !== "boolean"
	) {
		return null;
	}
	return { selected: payload.selected, alternativeEnabled: payload.alternativeEnabled };
}

/**
 * Hook for managing service instances
 */
export const useServicesManagement = () => {
	const createServiceMutation = useCreateServiceMutation();
	const updateServiceMutation = useUpdateServiceMutation();
	const deleteServiceMutation = useDeleteServiceMutation();
	const testServiceConnectionMutation = useTestServiceConnection();
	const testConnectionBeforeAddMutation = useTestConnectionBeforeAdd();
	const verifyIdentityMutation = useVerifyServiceIdentityMutation();
	const replaceIdentityMutation = useReplaceServiceIdentityMutation();
	const [identityFlow, setIdentityFlow] = useState<IdentityFlow | null>(null);

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
	const [analyticsUnavailableConfirmation, setAnalyticsUnavailableConfirmation] =
		useState<AnalyticsUnavailableConfirmation | null>(null);
	const confirmationRetryInFlight = useRef(false);

	const requestAnalyticsUnavailableConfirmation = (
		error: unknown,
		retry: (selected: AnalyticsProvider) => Promise<void>,
	): boolean => {
		const confirmation = getAnalyticsUnavailableConfirmation(error);
		if (!confirmation) return false;
		setAnalyticsUnavailableConfirmation({
			...confirmation,
			onConfirm: async () => {
				if (confirmationRetryInFlight.current) return;
				confirmationRetryInFlight.current = true;
				setAnalyticsUnavailableConfirmation(null);
				try {
					await retry(confirmation.selected);
				} catch (retryError) {
					toast.error(getErrorMessage(retryError, "Failed to update service"));
				} finally {
					confirmationRetryInFlight.current = false;
				}
			},
		});
		return true;
	};

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

		let identityReplacementPayload: UpdateServicePayload | undefined;
		try {
			if (selectedServiceForEdit) {
				const updatePayload: UpdateServicePayload = { ...basePayload };
				if (!basePayload.apiKey) {
					updatePayload.apiKey = undefined;
				}
				identityReplacementPayload = updatePayload;
				const updateVariables = {
					id: selectedServiceForEdit.id,
					payload: updatePayload,
				};
				try {
					await updateServiceMutation.mutateAsync(updateVariables);
				} catch (error) {
					if (
						requestAnalyticsUnavailableConfirmation(error, async (selected) => {
							await updateServiceMutation.mutateAsync({
								...updateVariables,
								payload: {
									...updateVariables.payload,
									confirmAnalyticsUnavailableFor: selected,
								},
							});
							resetForm(basePayload.service);
						})
					) {
						return;
					}
					throw error;
				}
			} else {
				await createServiceMutation.mutateAsync(basePayload);
			}

			resetForm(basePayload.service);
		} catch (error) {
			const conflict = getIdentityConflict(error);
			if (conflict?.candidate && identityReplacementPayload && selectedServiceForEdit) {
				setIdentityFlow({
					instanceId: selectedServiceForEdit!.id,
					mode: "replace",
					candidate: conflict.candidate,
					connectionGeneration: conflict.connectionGeneration,
					identityGeneration: conflict.identityGeneration,
					replacementPayload: identityReplacementPayload,
					requiresReinspection: false,
					message:
						"This connection points at a different provider. Review and explicitly replace it.",
				});
				return;
			}
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
			if (
				requestAnalyticsUnavailableConfirmation(error, async (selected) => {
					await deleteServiceMutation.mutateAsync({
						id: instance.id,
						confirmAnalyticsUnavailableFor: selected,
					});
					if (selectedServiceForEdit?.id === instance.id) {
						resetForm(instance.service);
					}
				})
			) {
				return;
			}
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
		const updateVariables = {
			id: instance.id,
			payload: {
				enabled: !instance.enabled,
			},
		};
		try {
			await updateServiceMutation.mutateAsync(updateVariables);
		} catch (error) {
			if (
				requestAnalyticsUnavailableConfirmation(error, async (selected) => {
					await updateServiceMutation.mutateAsync({
						...updateVariables,
						payload: {
							...updateVariables.payload,
							confirmAnalyticsUnavailableFor: selected,
						},
					});
				})
			) {
				return;
			}
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

	const inspectIdentity = async (instance: ServiceInstanceSummary) => {
		try {
			const priorFlow = identityFlow?.instanceId === instance.id ? identityFlow : null;
			const stagedReplacementCandidate =
				priorFlow?.mode === "replace" && priorFlow.requiresReinspection
					? priorFlow.replacementPayload
					: undefined;
			const inspection = await inspectServiceIdentity(instance.id, stagedReplacementCandidate);
			setIdentityFlow({
				instanceId: instance.id,
				mode: priorFlow?.mode ?? (instance.identity.status === "mismatch" ? "replace" : "verify"),
				candidate: inspection.candidate,
				connectionGeneration: inspection.connectionGeneration,
				identityGeneration: inspection.identityGeneration,
				replacementPayload: priorFlow?.replacementPayload ?? {},
				requiresReinspection: false,
				message:
					instance.identity.status === "mismatch"
						? "The provider differs from the enrolled server. Replacement clears cache data and expires affected pending approvals."
						: "Confirm this provider identity to verify the saved connection.",
			});
		} catch (error) {
			toast.error(getErrorMessage(error, "Unable to inspect provider identity"));
		}
	};

	const confirmIdentity = async () => {
		if (!identityFlow || identityFlow.requiresReinspection) return;
		const confirmation = {
			confirmationDigest: identityFlow.candidate.confirmationDigest,
			expectedConnectionGeneration: identityFlow.connectionGeneration,
			expectedIdentityGeneration: identityFlow.identityGeneration,
		};
		try {
			if (identityFlow.mode === "replace") {
				await replaceIdentityMutation.mutateAsync({
					id: identityFlow.instanceId,
					payload: identityFlow.replacementPayload,
					...confirmation,
				});
			} else {
				await verifyIdentityMutation.mutateAsync({ id: identityFlow.instanceId, ...confirmation });
			}
			setIdentityFlow(null);
		} catch (error) {
			const conflict = getIdentityConflict(error);
			if (conflict) {
				setIdentityFlow((current) =>
					current
						? {
								...current,
								...(conflict.candidate ? { candidate: conflict.candidate } : {}),
								...(conflict.code === "IDENTITY_REPLACEMENT_REQUIRED"
									? { mode: "replace" as const, requiresReinspection: false }
									: { requiresReinspection: true }),
								connectionGeneration: conflict.connectionGeneration,
								identityGeneration: conflict.identityGeneration,
								message:
									"The provider changed while you were confirming. Inspect it again before continuing.",
							}
						: current,
				);
				return;
			}
			toast.error(getErrorMessage(error, "Unable to confirm provider identity"));
		}
	};

	return {
		createServiceMutation,
		updateServiceMutation,
		verifyIdentityMutation,
		replaceIdentityMutation,
		identityFlow,
		inspectIdentity,
		confirmIdentity,
		dismissIdentityFlow: () => setIdentityFlow(null),
		deleteServiceMutation,
		testingConnection,
		testResult,
		testingFormConnection,
		formTestResult,
		analyticsUnavailableConfirmation,
		cancelAnalyticsUnavailableConfirmation: () => setAnalyticsUnavailableConfirmation(null),
		handleSubmit,
		handleDeleteService,
		toggleDefault,
		toggleEnabled,
		handleTestConnection,
		handleTestFormConnection,
		resetFormTestResult,
	};
};
