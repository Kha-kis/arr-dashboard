"use client";

import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { CurrentUser } from "@arr/shared";
import {
	login,
	logout,
	fetchCurrentUser,
	updateAccount,
	checkSetupRequired,
	removePassword,
	getPasskeyCredentials,
	initiateOIDCLogin,
	type PasskeyCredential,
	type SetupRequiredResponse,
} from "../../lib/api-client/auth";

// Login
interface LoginPayload {
	username: string;
	password: string;
	rememberMe?: boolean;
}

export const useLoginMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<CurrentUser, unknown, LoginPayload>({
		mutationFn: login,
		onSuccess: (user) => {
			// Immediately set the user data in cache instead of invalidating
			// This prevents race conditions on redirect
			queryClient.setQueryData(["current-user"], user);
		},
	});
};

// Logout
export const useLogoutMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<void, unknown, void>({
		mutationFn: logout,
		onSuccess: () => {
			// Immediately clear user data from cache
			queryClient.setQueryData(["current-user"], null);
		},
	});
};

// Current User
export const useCurrentUser = (enabled: boolean = true): UseQueryResult<CurrentUser | null, Error> => {
	const queryClient = useQueryClient();

	const query = useQuery<CurrentUser | null>({
		queryKey: ["current-user"],
		queryFn: fetchCurrentUser,
		staleTime: 5 * 60 * 1000,
		retry: false,
		enabled,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
	});

	// Handle 401 errors to clear stale cache
	// Run as a controlled side effect after render
	useEffect(() => {
		if (query.error && typeof query.error === "object" && "status" in query.error && query.error.status === 401) {
			queryClient.setQueryData(["current-user"], null);
		}
	}, [query.error, queryClient]);

	return query;
};

// Update Account
interface UpdateAccountPayload {
	username?: string;
	currentPassword?: string;
	newPassword?: string;
}

interface UpdateAccountResponse {
	user: CurrentUser;
}

export const useUpdateAccountMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<UpdateAccountResponse, unknown, UpdateAccountPayload>({
		mutationFn: updateAccount,
		onSuccess: () => {
			// Invalidate to refetch with updated hasPassword and hasTmdbApiKey fields
			queryClient.invalidateQueries({ queryKey: ["current-user"] });
		},
	});
};

// Remove Password
interface RemovePasswordPayload {
	currentPassword: string;
}

interface RemovePasswordResponse {
	success: boolean;
	message: string;
}

export const useRemovePasswordMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<RemovePasswordResponse, unknown, RemovePasswordPayload>({
		mutationFn: removePassword,
		onSuccess: () => {
			// Invalidate current user to refetch and show updated state
			queryClient.invalidateQueries({ queryKey: ["current-user"] });
		},
	});
};

// Setup Required (also returns password policy for frontend validation)
export const useSetupRequired = () =>
	useQuery<SetupRequiredResponse>({
		queryKey: ["setup-required"],
		queryFn: checkSetupRequired,
		staleTime: 5 * 60 * 1000,
		retry: 1,
		refetchOnMount: "always", // Always check API health when login page loads
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});

// Passkey Credentials
export const usePasskeyCredentials = () =>
	useQuery<PasskeyCredential[]>({
		queryKey: ["passkey-credentials"],
		queryFn: getPasskeyCredentials,
		staleTime: 5 * 60 * 1000, // 5 minutes
	});

// OIDC Login (simplified - provider is configured via admin API)
export const useOIDCLogin = () => {
	return useMutation<{ authorizationUrl: string }, Error, void>({
		mutationFn: async () => {
			const authorizationUrl = await initiateOIDCLogin();
			return { authorizationUrl };
		},
	});
};