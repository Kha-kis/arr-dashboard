/**
 * Utility functions for settings feature
 */

import type { ServiceType } from "./settings-constants";

export type ServiceFormState = {
	label: string;
	baseUrl: string;
	externalUrl: string;
	apiKey: string;
	service: ServiceType;
	enabled: boolean;
	isDefault: boolean;
	tags: string;
	defaultQualityProfileId: string;
	defaultLanguageProfileId: string;
	defaultRootFolderPath: string;
	defaultSeasonFolder: "" | "true" | "false";
	storageGroupId: string;
};

/**
 * Returns default form state for a given service type
 */
export const defaultFormState = (service: ServiceType): ServiceFormState => ({
	label: "",
	baseUrl: "",
	externalUrl: "",
	apiKey: "",
	service,
	enabled: true,
	isDefault: false,
	tags: "",
	defaultQualityProfileId: "",
	defaultLanguageProfileId: "",
	defaultRootFolderPath: "",
	defaultSeasonFolder: "",
	storageGroupId: "",
});

/**
 * Parses a string to a number or returns null if invalid
 */
export const parseNumericValue = (value: string): number | null => {
	if (!value || value.trim() === "") {
		return null;
	}
	const parsed = Number(value);
	return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Parses season folder value from form state
 */
export const parseSeasonFolderValue = (
	value: ServiceFormState["defaultSeasonFolder"],
): boolean | null => {
	if (value === "") {
		return null;
	}
	return value === "true";
};

/**
 * Returns service-specific placeholder values
 */
export const getServicePlaceholders = (service: ServiceType) => {
	switch (service) {
		case "sonarr":
			return {
				label: "Primary Sonarr",
				baseUrl: "http://localhost:8989",
			};
		case "radarr":
			return {
				label: "Primary Radarr",
				baseUrl: "http://localhost:7878",
			};
		case "prowlarr":
			return {
				label: "Primary Prowlarr",
				baseUrl: "http://localhost:9696",
			};
		default:
			return {
				label: "Primary Instance",
				baseUrl: "http://localhost:8989",
			};
	}
};

/**
 * Validates password strength based on configured policy
 * @param password - The password to validate
 * @param policy - "strict" requires complexity, "relaxed" only requires length
 */
export const validatePassword = (
	password: string,
	policy: "strict" | "relaxed" = "strict",
): { valid: boolean; message?: string } => {
	if (password.length < 8) {
		return { valid: false, message: "Password must be at least 8 characters" };
	}

	if (password.length > 128) {
		return { valid: false, message: "Password must not exceed 128 characters" };
	}

	// Relaxed policy only requires minimum length
	if (policy === "relaxed") {
		return { valid: true };
	}

	// Strict policy requires complexity
	if (!/[a-z]/.test(password)) {
		return {
			valid: false,
			message: "Password must contain at least one lowercase letter",
		};
	}
	if (!/[A-Z]/.test(password)) {
		return {
			valid: false,
			message: "Password must contain at least one uppercase letter",
		};
	}
	if (!/[0-9]/.test(password)) {
		return {
			valid: false,
			message: "Password must contain at least one number",
		};
	}
	if (!/[^a-zA-Z0-9]/.test(password)) {
		return {
			valid: false,
			message: "Password must contain at least one special character",
		};
	}
	return { valid: true };
};
