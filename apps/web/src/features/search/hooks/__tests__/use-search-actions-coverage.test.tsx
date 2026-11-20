import type { SearchResult } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import type { SearchStateActions } from "../use-search-state";

const { grabTransport, searchMutate } = vi.hoisted(() => ({
	grabTransport: vi.fn(),
	searchMutate: vi.fn(),
}));

vi.mock("../../../../hooks/api/useSearch", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../hooks/api/useSearch")>()),
	useManualSearchMutation: () => ({
		isPending: false,
		mutate: searchMutate,
	}),
}));

import { useSearchActions } from "../use-search-actions";
import { useSearchGrabRecovery } from "../use-search-grab-recovery";

const result: SearchResult = {
	id: "synthetic-guid",
	guid: "synthetic-guid",
	title: "A",
	indexer: "Synthetic Indexer",
	indexerId: 1,
	protocol: "torrent",
	instanceId: "p-1",
	instanceName: "Synthetic Prowlarr",
	grabSelector: "sg1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
};

const grabRows = [result];
let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={client}>
		<IncognitoProvider>{children}</IncognitoProvider>
	</QueryClientProvider>
);

const makeActions = () =>
	({
		setValidationError: vi.fn(),
		setFeedback: vi.fn(),
		setHasSearched: vi.fn(),
		setGrabbingKey: vi.fn(),
	}) as unknown as SearchStateActions;

beforeEach(() => {
	vi.clearAllMocks();
	window.localStorage.clear();
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	grabTransport.mockResolvedValue(undefined);
	vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
		if (url === "/api/search/grab/results/status")
			return new Response(
				JSON.stringify({
					results: [{ resultIndex: 0, availability: "not-recorded", status: null }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		if (url.includes("/api/search/grab/intents/")) return new Response(null, { status: 404 });
		if (url === "/api/search/grab")
			return (await grabTransport(url, options)) ?? new Response(null, { status: 204 });
		throw new Error("Unexpected synthetic endpoint");
	});
	searchMutate.mockImplementation(
		(_payload: unknown, callbacks: { onSuccess: (data: unknown) => void }) => {
			callbacks.onSuccess({
				instances: [{ instanceId: "p-1", instanceName: "Prowlarr", success: false, data: [] }],
				aggregated: [],
				totalCount: 0,
				failedInstanceCount: 1,
			});
		},
	);
});
afterEach(() => {
	cleanup();
	client.clear();
	vi.unstubAllGlobals();
});

describe("manual search coverage feedback", () => {
	it("carries returned-batch coverage and keeps usable data while warning about rejection", () => {
		searchMutate.mockImplementationOnce(
			(_payload: unknown, callbacks: { onSuccess: (data: unknown) => void }) =>
				callbacks.onSuccess({
					instances: [
						{
							instanceId: "p-1",
							instanceName: "Prowlarr",
							success: true,
							data: [result],
							coverage: {
								receivedCount: 2,
								acceptedCount: 1,
								rejectedCount: 1,
								metadataIncompleteCount: 0,
							},
						},
					],
					aggregated: [result],
					totalCount: 1,
					failedInstanceCount: 0,
					coverage: {
						receivedCount: 2,
						acceptedCount: 1,
						rejectedCount: 1,
						metadataIncompleteCount: 0,
					},
				}),
		);
		const actions = makeActions();
		const hook = renderHook(() => useSearchActions("synthetic", "all", { "p-1": [1] }, actions), {
			wrapper,
		});
		act(() => hook.result.current.handleSearch());
		expect(hook.result.current.results).toEqual([result]);
		expect(hook.result.current.coverage).toEqual({
			receivedCount: 2,
			acceptedCount: 1,
			rejectedCount: 1,
			metadataIncompleteCount: 0,
		});
		expect(hook.result.current.coverageIncomplete).toBe(true);
		expect(actions.setFeedback).toHaveBeenLastCalledWith(
			expect.objectContaining({
				type: "error",
				message: expect.stringContaining("1 returned result rejected"),
			}),
		);
	});

	it("does not call a failed provider search a verified empty result", () => {
		const actions = makeActions();
		const { result } = renderHook(
			() => useSearchActions("synthetic", "all", { "p-1": [1] }, actions),
			{ wrapper },
		);
		act(() => result.current.handleSearch());
		expect(actions.setFeedback).toHaveBeenCalledWith({
			type: "error",
			message: "Search incomplete: 1 Prowlarr instance unavailable; results from it are unknown.",
			incognitoMessage:
				"Search incomplete: 1 Prowlarr instance unavailable; results from it are unknown.",
		});
	});
});

describe("manual search incognito feedback", () => {
	it("does not turn an unverified acknowledgement into success or safe retry guidance", async () => {
		const message =
			"Grab outcome is unknown. Check Prowlarr and the download client before retrying.";
		grabTransport.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "ArrError", message }), {
				status: 502,
				headers: { "content-type": "application/json" },
			}),
		);
		const actions = makeActions();
		const hook = renderHook(() => useSearchGrabRecovery(grabRows, actions), { wrapper });
		await act(async () => hook.result.current.handleGrab(result));
		expect(grabTransport).toHaveBeenCalledTimes(1);
		expect(actions.setFeedback).toHaveBeenLastCalledWith({
			type: "error",
			message:
				"Could not confirm the grab result. Check Prowlarr and the download client before retrying.",
			incognitoMessage:
				"Could not confirm the grab result. Check Prowlarr and the download client before retrying.",
		});
	});

	it("stores normal and safe feedback for a successful grab", async () => {
		const actions = makeActions();
		const hook = renderHook(() => useSearchGrabRecovery(grabRows, actions), { wrapper });
		await act(async () => hook.result.current.handleGrab(result));
		expect(actions.setFeedback).toHaveBeenLastCalledWith({
			type: "success",
			message: 'Sent "A" to the download client.',
			incognitoMessage: 'Sent "parrot-security-6.0_amd64.iso" to the download client.',
		});
	});

	it("keeps both feedback variants when incognito mode changes during a grab", async () => {
		let finishGrab: (() => void) | undefined;
		grabTransport.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishGrab = resolve;
				}),
		);
		const actions = makeActions();
		const hook = renderHook(() => useSearchGrabRecovery(grabRows, actions), { wrapper });
		let pending!: Promise<void>;
		act(() => {
			pending = hook.result.current.handleGrab(result);
		});
		await waitFor(() => expect(grabTransport).toHaveBeenCalledTimes(1));

		act(() => {
			window.localStorage.setItem("arr-dashboard-incognito-mode", "true");
			window.dispatchEvent(new Event("incognito-mode-changed"));
		});
		await act(async () => {
			finishGrab?.();
			await pending;
		});

		expect(actions.setFeedback).toHaveBeenLastCalledWith({
			type: "success",
			message: 'Sent "A" to the download client.',
			incognitoMessage: 'Sent "parrot-security-6.0_amd64.iso" to the download client.',
		});
	});

	it("uses the same masked title as the result row in the safe feedback variant", async () => {
		window.localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const actions = makeActions();
		const hook = renderHook(() => useSearchGrabRecovery(grabRows, actions), { wrapper });

		await act(async () => hook.result.current.handleGrab(result));

		expect(actions.setFeedback).toHaveBeenLastCalledWith({
			type: "success",
			message: 'Sent "A" to the download client.',
			incognitoMessage: 'Sent "parrot-security-6.0_amd64.iso" to the download client.',
		});
	});

	it("does not display private provider details when a grab outcome is unrecognized", async () => {
		window.localStorage.setItem("arr-dashboard-incognito-mode", "true");
		grabTransport.mockRejectedValueOnce(
			new Error(
				'Unknown provider response for "PRIVATE_RELEASE_A" at https://private.invalid/path',
			),
		);
		const actions = makeActions();
		const hook = renderHook(() => useSearchGrabRecovery(grabRows, actions), { wrapper });

		await act(async () => hook.result.current.handleGrab(result));

		expect(actions.setFeedback).toHaveBeenLastCalledWith({
			type: "error",
			message:
				"Could not confirm the grab result. Check Prowlarr and the download client before retrying.",
			incognitoMessage:
				"Could not confirm the grab result. Check Prowlarr and the download client before retrying.",
		});
	});

	it("keeps actionable known grab guidance without provider details", async () => {
		window.localStorage.setItem("arr-dashboard-incognito-mode", "true");
		grabTransport.mockResolvedValueOnce(
			new Response(
				JSON.stringify({ message: 'Download client failed to add torrent "PRIVATE_RELEASE_A"' }),
				{ status: 400, headers: { "content-type": "application/json" } },
			),
		);
		const actions = makeActions();
		const hook = renderHook(() => useSearchGrabRecovery(grabRows, actions), { wrapper });

		await act(async () => hook.result.current.handleGrab(result));

		expect(actions.setFeedback).toHaveBeenLastCalledWith({
			type: "error",
			message:
				"The download client (qBittorrent/Transmission/etc.) rejected the torrent. Check that your download client is running and properly configured in Prowlarr.",
			incognitoMessage:
				"The download client (qBittorrent/Transmission/etc.) rejected the torrent. Check that your download client is running and properly configured in Prowlarr.",
		});
	});

	it("does not display private provider details when a search fails", () => {
		window.localStorage.setItem("arr-dashboard-incognito-mode", "true");
		searchMutate.mockImplementationOnce(
			(_payload: unknown, callbacks: { onError: (error: unknown) => void }) => {
				callbacks.onError(new Error('Search failed for "PRIVATE_RELEASE_A"'));
			},
		);
		const actions = makeActions();
		const hook = renderHook(() => useSearchActions("synthetic", "all", { "p-1": [1] }, actions), {
			wrapper,
		});

		act(() => hook.result.current.handleSearch());

		expect(actions.setFeedback).toHaveBeenLastCalledWith({
			type: "error",
			message: 'Search failed for "PRIVATE_RELEASE_A"',
			incognitoMessage: "Search failed. Check Prowlarr connections and retry.",
		});
	});

	it("preserves the normal-mode release title on successful grab", async () => {
		const actions = makeActions();
		const hook = renderHook(() => useSearchGrabRecovery(grabRows, actions), { wrapper });

		await act(async () => hook.result.current.handleGrab(result));

		expect(actions.setFeedback).toHaveBeenLastCalledWith({
			type: "success",
			message: 'Sent "A" to the download client.',
			incognitoMessage: 'Sent "parrot-security-6.0_amd64.iso" to the download client.',
		});
	});
});
