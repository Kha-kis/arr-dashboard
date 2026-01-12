/**
 * Tests for ArrClientFactory
 *
 * Unit tests covering client creation, service type validation,
 * API key decryption, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServiceType } from "@prisma/client";
import {
	ArrClientFactory,
	ArrError,
	arrErrorToHttpStatus,
	arrErrorToResponse,
	isArrError,
	isNotFoundError,
	type ClientInstanceData,
} from "../client-factory.js";
import { SonarrClient, RadarrClient, ProwlarrClient, NotFoundError, UnauthorizedError, ValidationError, TimeoutError, NetworkError } from "arr-sdk";
import type { Encryptor } from "../../auth/encryption.js";

// Mock the arr-sdk module to match actual SDK signatures
vi.mock("arr-sdk", () => {
	class MockArrError extends Error {
		readonly statusCode: number;
		readonly details?: unknown;
		constructor(message: string, statusCode: number, details?: unknown) {
			super(message);
			this.name = "ArrError";
			this.statusCode = statusCode;
			this.details = details;
		}
	}

	class MockNotFoundError extends MockArrError {
		constructor(message: string, details?: unknown) {
			super(message, 404, details);
			this.name = "NotFoundError";
		}
	}

	class MockUnauthorizedError extends MockArrError {
		constructor(message: string, details?: unknown) {
			super(message, 401, details);
			this.name = "UnauthorizedError";
		}
	}

	class MockValidationError extends MockArrError {
		readonly validationErrors: Array<{ propertyName: string; errorMessage: string }>;
		constructor(message: string, validationErrors: Array<{ propertyName: string; errorMessage: string }>) {
			super(message, 400, validationErrors);
			this.name = "ValidationError";
			this.validationErrors = validationErrors;
		}
	}

	class MockTimeoutError extends MockArrError {
		constructor(message: string, details?: unknown) {
			super(message, 504, details);
			this.name = "TimeoutError";
		}
	}

	class MockNetworkError extends MockArrError {
		constructor(message: string, details?: unknown) {
			super(message, 502, details);
			this.name = "NetworkError";
		}
	}

	return {
		SonarrClient: class MockSonarrClient {
			config: unknown;
			constructor(config: unknown) {
				this.config = config;
			}
		},
		RadarrClient: class MockRadarrClient {
			config: unknown;
			constructor(config: unknown) {
				this.config = config;
			}
		},
		ProwlarrClient: class MockProwlarrClient {
			config: unknown;
			constructor(config: unknown) {
				this.config = config;
			}
		},
		ArrError: MockArrError,
		NotFoundError: MockNotFoundError,
		UnauthorizedError: MockUnauthorizedError,
		ValidationError: MockValidationError,
		TimeoutError: MockTimeoutError,
		NetworkError: MockNetworkError,
	};
});

// Create mock encryptor (cast to Encryptor since we only mock the methods we need)
const createMockEncryptor = () => ({
	encrypt: vi.fn((value: string) => ({
		value: `encrypted-${value}`,
		iv: "test-iv",
	})),
	decrypt: vi.fn(({ value }: { value: string; iv: string }) => `decrypted-api-key`),
	safeCompare: vi.fn((a: string, b: string) => a === b),
}) as unknown as Encryptor;

// Create mock instance data
const createMockInstance = (
	service: ServiceType,
	overrides?: Partial<ClientInstanceData>,
): ClientInstanceData => ({
	id: "instance-123",
	baseUrl: "http://localhost:8989",
	encryptedApiKey: "encrypted-key",
	encryptionIv: "iv-123",
	service,
	label: `Test ${service}`,
	...overrides,
});

describe("ArrClientFactory - Client Creation", () => {
	let factory: ArrClientFactory;
	let mockEncryptor: Encryptor;

	beforeEach(() => {
		mockEncryptor = createMockEncryptor();
		factory = new ArrClientFactory(mockEncryptor);
	});

	it("should create SonarrClient for SONARR service type", () => {
		const instance = createMockInstance("SONARR");

		const client = factory.create(instance);

		expect(client).toBeInstanceOf(SonarrClient);
	});

	it("should create RadarrClient for RADARR service type", () => {
		const instance = createMockInstance("RADARR");

		const client = factory.create(instance);

		expect(client).toBeInstanceOf(RadarrClient);
	});

	it("should create ProwlarrClient for PROWLARR service type", () => {
		const instance = createMockInstance("PROWLARR");

		const client = factory.create(instance);

		expect(client).toBeInstanceOf(ProwlarrClient);
	});

	it("should call encryptor.decrypt with correct parameters", () => {
		const instance = createMockInstance("SONARR", {
			encryptedApiKey: "my-encrypted-key",
			encryptionIv: "my-iv",
		});

		factory.create(instance);

		expect(mockEncryptor.decrypt).toHaveBeenCalledWith({
			value: "my-encrypted-key",
			iv: "my-iv",
		});
	});

	it("should strip trailing slash from baseUrl", () => {
		const instance = createMockInstance("SONARR", {
			baseUrl: "http://localhost:8989/",
		});

		const client = factory.create(instance);
		const config = (client as unknown as { config: { baseUrl: string } }).config;

		expect(config.baseUrl).toBe("http://localhost:8989");
	});

	it("should use default timeout when not specified", () => {
		const instance = createMockInstance("SONARR");

		const client = factory.create(instance);
		const config = (client as unknown as { config: { timeout: number } }).config;

		expect(config.timeout).toBe(30_000);
	});

	it("should use custom timeout from options", () => {
		const instance = createMockInstance("SONARR");

		const client = factory.create(instance, { timeout: 60_000 });
		const config = (client as unknown as { config: { timeout: number } }).config;

		expect(config.timeout).toBe(60_000);
	});

	it("should use custom default timeout from constructor", () => {
		const customFactory = new ArrClientFactory(mockEncryptor, 45_000);
		const instance = createMockInstance("SONARR");

		const client = customFactory.create(instance);
		const config = (client as unknown as { config: { timeout: number } }).config;

		expect(config.timeout).toBe(45_000);
	});
});

describe("ArrClientFactory - Explicit Client Creation Methods", () => {
	let factory: ArrClientFactory;
	let mockEncryptor: Encryptor;

	beforeEach(() => {
		mockEncryptor = createMockEncryptor();
		factory = new ArrClientFactory(mockEncryptor);
	});

	it("createSonarrClient should return SonarrClient for SONARR instance", () => {
		const instance = createMockInstance("SONARR");

		const client = factory.createSonarrClient(instance);

		expect(client).toBeInstanceOf(SonarrClient);
	});

	it("createSonarrClient should throw for non-SONARR instance", () => {
		const instance = createMockInstance("RADARR");

		expect(() => factory.createSonarrClient(instance)).toThrow(
			"Expected SONARR instance, got RADARR",
		);
	});

	it("createRadarrClient should return RadarrClient for RADARR instance", () => {
		const instance = createMockInstance("RADARR");

		const client = factory.createRadarrClient(instance);

		expect(client).toBeInstanceOf(RadarrClient);
	});

	it("createRadarrClient should throw for non-RADARR instance", () => {
		const instance = createMockInstance("SONARR");

		expect(() => factory.createRadarrClient(instance)).toThrow(
			"Expected RADARR instance, got SONARR",
		);
	});

	it("createProwlarrClient should return ProwlarrClient for PROWLARR instance", () => {
		const instance = createMockInstance("PROWLARR");

		const client = factory.createProwlarrClient(instance);

		expect(client).toBeInstanceOf(ProwlarrClient);
	});

	it("createProwlarrClient should throw for non-PROWLARR instance", () => {
		const instance = createMockInstance("SONARR");

		expect(() => factory.createProwlarrClient(instance)).toThrow(
			"Expected PROWLARR instance, got SONARR",
		);
	});

	it("createAnyClient should work for all service types", () => {
		const sonarrInstance = createMockInstance("SONARR");
		const radarrInstance = createMockInstance("RADARR");
		const prowlarrInstance = createMockInstance("PROWLARR");

		expect(factory.createAnyClient(sonarrInstance)).toBeInstanceOf(SonarrClient);
		expect(factory.createAnyClient(radarrInstance)).toBeInstanceOf(RadarrClient);
		expect(factory.createAnyClient(prowlarrInstance)).toBeInstanceOf(ProwlarrClient);
	});
});

describe("ArrClientFactory - Options and Callbacks", () => {
	let factory: ArrClientFactory;
	let mockEncryptor: Encryptor;

	beforeEach(() => {
		mockEncryptor = createMockEncryptor();
		factory = new ArrClientFactory(mockEncryptor);
	});

	it("should attach onError callback when provided", () => {
		const instance = createMockInstance("SONARR");
		const onError = vi.fn();

		const client = factory.create(instance, { onError });
		const config = (client as unknown as { config: { onError?: (error: Error) => void } }).config;

		expect(config.onError).toBeDefined();
	});

	it("should attach onRequest callback when provided", () => {
		const instance = createMockInstance("SONARR");
		const onRequest = vi.fn();

		const client = factory.create(instance, { onRequest });
		const config = (client as unknown as { config: { onRequest?: (config: unknown) => void } }).config;

		expect(config.onRequest).toBeDefined();
	});
});

describe("Error Type Guards", () => {
	it("isArrError should return true for ArrError instances", () => {
		const error = new ArrError("Test error", 500);
		expect(isArrError(error)).toBe(true);
	});

	it("isArrError should return false for regular Error", () => {
		const error = new Error("Regular error");
		expect(isArrError(error)).toBe(false);
	});

	it("isNotFoundError should return true for NotFoundError", () => {
		const error = new NotFoundError("Not found");
		expect(isNotFoundError(error)).toBe(true);
	});

	it("isNotFoundError should return false for other ArrError types", () => {
		const error = new UnauthorizedError("Unauthorized");
		expect(isNotFoundError(error)).toBe(false);
	});
});

describe("arrErrorToHttpStatus", () => {
	it("should return 404 for NotFoundError", () => {
		const error = new NotFoundError("Not found");
		expect(arrErrorToHttpStatus(error)).toBe(404);
	});

	it("should return 401 for UnauthorizedError", () => {
		const error = new UnauthorizedError("Unauthorized");
		expect(arrErrorToHttpStatus(error)).toBe(401);
	});

	it("should return 400 for ValidationError", () => {
		const validationErrors = [{ propertyName: "field", errorMessage: "is required" }];
		const error = new ValidationError("Invalid", validationErrors);
		expect(arrErrorToHttpStatus(error)).toBe(400);
	});

	it("should return 504 for TimeoutError", () => {
		const error = new TimeoutError("Timeout");
		expect(arrErrorToHttpStatus(error)).toBe(504);
	});

	it("should return 502 for NetworkError", () => {
		const error = new NetworkError("Network error");
		expect(arrErrorToHttpStatus(error)).toBe(502);
	});

	it("should return error statusCode if available", () => {
		const error = new ArrError("Custom error", 503);
		expect(arrErrorToHttpStatus(error)).toBe(503);
	});

	it("should return 500 as fallback", () => {
		const error = new ArrError("Generic error", 500);
		expect(arrErrorToHttpStatus(error)).toBe(500);
	});
});

describe("arrErrorToResponse", () => {
	it("should create error response with message and code", () => {
		const error = new ArrError("Something went wrong", 500);

		const response = arrErrorToResponse(error);

		expect(response).toEqual({
			success: false,
			error: "Something went wrong",
			code: "MockArrError",
			details: undefined,
		});
	});

	it("should include validation errors for ValidationError", () => {
		const validationErrors = [{ propertyName: "field", errorMessage: "must be a string" }];
		const error = new ValidationError("Validation failed", validationErrors);

		const response = arrErrorToResponse(error);

		expect(response.details).toEqual(validationErrors);
	});
});
