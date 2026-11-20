import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useManualImportSourceQuery } from "../useManualImport";

const params = {
	ownerId: "owner",
	instanceId: "instance",
	service: "radarr" as const,
	downloadId: "source",
	enabled: true,
};
afterEach(() => vi.unstubAllGlobals());
function show(initial: Parameters<typeof useManualImportSourceQuery>[0] = params) {
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			requests.push(url);
			return new Response(
				JSON.stringify({
					kind: "observed",
					operation: {
						operationId: "operation",
						state: "pending",
						reason: null,
						selectedFileCount: 2,
						verifiedFileCount: 0,
						canConsiderNewAttempt: false,
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}),
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const hook = renderHook(
		(props: Parameters<typeof useManualImportSourceQuery>[0]) => useManualImportSourceQuery(props),
		{
			initialProps: initial,
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={client}>{children}</QueryClientProvider>
			),
		},
	);
	return { ...hook, requests, client };
}
describe("owned source import query", () => {
	it.each([{ ownerId: null }, { enabled: false }, { downloadId: undefined }, { instanceId: "" }])(
		"does not read without an active complete owned source scope %#",
		async (change) => {
			const view = show({ ...params, ...change });
			await act(async () => {
				await Promise.resolve();
			});
			expect(view.requests).toHaveLength(0);
			expect(view.result.current.data).toBeUndefined();
		},
	);
	it.each([
		{ ownerId: "other" },
		{ instanceId: "alias" },
		{ service: "sonarr" as const },
		{ downloadId: "another-source" },
		{ cursor: "another-page" },
	])("does not carry cached evidence into a changed scope %#", async (change) => {
		const view = show();
		await waitFor(() =>
			expect(view.result.current.data).toMatchObject({
				kind: "observed",
				operation: { selectedFileCount: 2 },
			}),
		);
		view.rerender({ ...params, ...change, enabled: false });
		expect(view.result.current.data).toBeUndefined();
		expect(view.requests).toHaveLength(1);
		view.client.clear();
	});
	it("uses cached source discovery, not the legacy-only route or browser key", async () => {
		const view = show();
		await waitFor(() => expect(view.result.current.data?.kind).toBe("observed"));
		expect(view.requests).toEqual([
			"/api/manual-import/source?instanceId=instance&service=radarr&downloadId=source",
		]);
		view.client.clear();
	});
});
