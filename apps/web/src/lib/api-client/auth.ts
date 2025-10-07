import type { CurrentUser, CurrentUserResponse } from "@arr/shared";
import { apiRequest, UnauthorizedError } from "./base";

export async function fetchCurrentUser(): Promise<CurrentUser | null> {
	try {
		const data = await apiRequest<CurrentUserResponse>("/auth/me");
		return data.user;
	} catch (error) {
		if (error instanceof UnauthorizedError) {
			return null;
		}
		throw error;
	}
}

export async function login(payload: {
	identifier: string;
	password: string;
}): Promise<CurrentUser> {
	const data = await apiRequest<CurrentUserResponse>("/auth/login", {
		method: "POST",
		json: payload,
	});
	return data.user;
}

export async function logout(): Promise<void> {
	await apiRequest<void>("/auth/logout", {
		method: "POST",
	});
}

interface UpdateAccountPayload {
	email?: string;
	username?: string;
	currentPassword?: string;
	newPassword?: string;
}

interface UpdateAccountResponse {
	user: CurrentUser;
}

export async function updateAccount(payload: UpdateAccountPayload): Promise<UpdateAccountResponse> {
	return await apiRequest<UpdateAccountResponse>("/auth/account", {
		method: "PATCH",
		json: payload,
	});
}

interface SetupRequiredResponse {
	required: boolean;
}

export async function checkSetupRequired(): Promise<boolean> {
	try {
		const data = await apiRequest<SetupRequiredResponse>("/auth/setup-required");
		return data.required;
	} catch (error) {
		// If the endpoint fails, assume setup is not required
		return false;
	}
}
