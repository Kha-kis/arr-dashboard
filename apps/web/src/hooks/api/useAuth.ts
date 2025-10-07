"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CurrentUser } from "@arr/shared";
import {
	login,
	logout,
	fetchCurrentUser,
	updateAccount,
	checkSetupRequired,
} from "../../lib/api-client/auth";

// Login
interface LoginPayload {
	identifier: string;
	password: string;
}

export const useLoginMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<CurrentUser, unknown, LoginPayload>({
		mutationFn: login,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["current-user"] });
		},
	});
};

// Logout
export const useLogoutMutation = () => {
	const queryClient = useQueryClient();

	return useMutation<void, unknown, void>({
		mutationFn: logout,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["current-user"] });
		},
	});
};

// Current User
export const useCurrentUser = (enabled: boolean = true) =>
	useQuery<CurrentUser | null>({
		queryKey: ["current-user"],
		queryFn: fetchCurrentUser,
		staleTime: 5 * 60 * 1000,
		retry: false,
		enabled,
	});

// Update Account
interface UpdateAccountPayload {
	email?: string;
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
		onSuccess: (data) => {
			queryClient.setQueryData(["current-user"], data.user);
		},
	});
};

// Setup Required
export const useSetupRequired = () =>
	useQuery<boolean>({
		queryKey: ["setup-required"],
		queryFn: checkSetupRequired,
		staleTime: 5 * 60 * 1000,
		retry: 1,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
