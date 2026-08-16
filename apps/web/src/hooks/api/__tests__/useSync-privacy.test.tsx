import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	validateSync: vi.fn(),
}));

vi.mock("../../../lib/api-client/trash-guides", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../lib/api-client/trash-guides")>();
	return { ...actual, validateSync: apiMocks.validateSync };
});

import { useValidateSync } from "../useSync";

function createWrapper(client: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	};
}

describe("useValidateSync log privacy", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does not log raw validation error messages", async () => {
		apiMocks.validateSync.mockRejectedValue(
			new Error("Private API key at http://private-radarr:7878"),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const { result } = renderHook(() => useValidateSync(), {
			wrapper: createWrapper(client),
		});

		try {
			await act(async () => {
				await result.current
					.mutateAsync({ templateId: "template-1", instanceId: "instance-1" })
					.catch(() => undefined);
			});

			const serializedLogs = JSON.stringify(errorSpy.mock.calls);
			expect(serializedLogs).not.toContain("Private API key");
			expect(serializedLogs).not.toContain("private-radarr");
		} finally {
			errorSpy.mockRestore();
			client.clear();
		}
	});

	it("does not log raw silent-failure responses", async () => {
		apiMocks.validateSync.mockResolvedValue({
			valid: false,
			conflicts: [
				{
					configName: "Private Custom Format",
					existingId: 42,
					action: "REPLACE",
					reason: "Private conflict reason",
				},
			],
			errors: [],
			warnings: ["Private warning at http://private-radarr:7878"],
		});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const { result } = renderHook(() => useValidateSync(), {
			wrapper: createWrapper(client),
		});

		try {
			await act(async () => {
				await result.current.mutateAsync({ templateId: "template-1", instanceId: "instance-1" });
			});

			const serializedLogs = JSON.stringify(warnSpy.mock.calls);
			expect(serializedLogs).not.toContain("Private Custom Format");
			expect(serializedLogs).not.toContain("Private conflict reason");
			expect(serializedLogs).not.toContain("Private warning");
			expect(serializedLogs).not.toContain("private-radarr");
		} finally {
			warnSpy.mockRestore();
			client.clear();
		}
	});
});
