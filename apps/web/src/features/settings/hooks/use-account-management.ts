import { useState } from "react";
import { useUpdateAccountMutation } from "../../../hooks/api/useAuth";
import type { AccountFormState } from "../components/account-tab";

/**
 * Hook for managing account updates (username and TMDB API key)
 */
export const useAccountManagement = (
	currentUser?: {
		username: string;
	} | null,
) => {
	const updateAccountMutation = useUpdateAccountMutation();

	const [accountForm, setAccountForm] = useState<AccountFormState>({
		username: "",
		tmdbApiKey: "",
	});
	const [accountUpdateResult, setAccountUpdateResult] = useState<{
		success: boolean;
		message: string;
	} | null>(null);

	const handleAccountUpdate = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setAccountUpdateResult(null);

		// Build update payload
		const payload: Record<string, unknown> = {};
		if (accountForm.username && accountForm.username !== currentUser?.username) {
			payload.username = accountForm.username;
		}
		if (accountForm.tmdbApiKey && accountForm.tmdbApiKey.trim()) {
			payload.tmdbApiKey = accountForm.tmdbApiKey.trim();
		}

		if (Object.keys(payload).length === 0) {
			setAccountUpdateResult({
				success: false,
				message: "No changes to save",
			});
			return;
		}

		try {
			await updateAccountMutation.mutateAsync(payload);
			setAccountUpdateResult({
				success: true,
				message: "Account updated successfully",
			});
			// Clear TMDB field on success
			setAccountForm((prev) => ({
				...prev,
				tmdbApiKey: "",
			}));
		} catch (error: unknown) {
			setAccountUpdateResult({
				success: false,
				message: error instanceof Error ? error.message : "Failed to update account",
			});
		}
	};

	return {
		accountForm,
		setAccountForm,
		accountUpdateResult,
		handleAccountUpdate,
		updateAccountMutation,
	};
};
