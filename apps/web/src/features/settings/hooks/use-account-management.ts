import { useState } from "react";
import { useUpdateAccountMutation } from "../../../hooks/api/useAuth";
import { validatePassword } from "../lib/settings-utils";
import type { AccountFormState } from "../components/account-tab";

/**
 * Hook for managing account updates
 */
export const useAccountManagement = (currentUser?: {
  email: string;
  username: string;
} | null) => {
  const updateAccountMutation = useUpdateAccountMutation();

  const [accountForm, setAccountForm] = useState<AccountFormState>({
    email: "",
    username: "",
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
    tmdbApiKey: "",
  });
  const [accountUpdateResult, setAccountUpdateResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const handleAccountUpdate = async (
    event: React.FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    setAccountUpdateResult(null);

    // Validate password fields if updating password
    if (
      accountForm.newPassword ||
      accountForm.confirmPassword ||
      accountForm.currentPassword
    ) {
      if (!accountForm.currentPassword) {
        setAccountUpdateResult({
          success: false,
          message: "Current password is required to change password",
        });
        return;
      }
      if (!accountForm.newPassword) {
        setAccountUpdateResult({
          success: false,
          message: "New password is required",
        });
        return;
      }
      if (accountForm.newPassword !== accountForm.confirmPassword) {
        setAccountUpdateResult({
          success: false,
          message: "New passwords do not match",
        });
        return;
      }

      const passwordValidation = validatePassword(accountForm.newPassword);
      if (!passwordValidation.valid) {
        setAccountUpdateResult({
          success: false,
          message: passwordValidation.message ?? "Password validation failed",
        });
        return;
      }
    }

    // Build update payload
    const payload: Record<string, unknown> = {};
    if (accountForm.email && accountForm.email !== currentUser?.email) {
      payload.email = accountForm.email;
    }
    if (
      accountForm.username &&
      accountForm.username !== currentUser?.username
    ) {
      payload.username = accountForm.username;
    }
    if (accountForm.newPassword && accountForm.currentPassword) {
      payload.currentPassword = accountForm.currentPassword;
      payload.newPassword = accountForm.newPassword;
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
      // Clear password and TMDB fields on success
      setAccountForm((prev) => ({
        ...prev,
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
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
