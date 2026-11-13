import { webcrypto } from "node:crypto";
import type { ManualImportOperationStatus } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { authKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { useManualImportStore } from "../../store";
import { ManualImportReview } from "../manual-import-review";

const sources = ["first", "second"].map((downloadId) => ({
	instanceId: "instance",
	instanceName: "Synthetic connection",
	service: "radarr" as const,
	downloadId,
}));
let posts: Record<string, unknown>[];
let statuses: Map<string, ManualImportOperationStatus>;
let unavailable: boolean;
let releasePost: (() => void) | null;
let holdPost: boolean;
let candidateFailure: boolean;
beforeEach(() => {
	sessionStorage.clear();
	localStorage.clear();
	useManualImportStore.getState().clear();
	vi.stubGlobal("crypto", webcrypto);
	posts = [];
	statuses = new Map();
	unavailable = false;
	releasePost = null;
	holdPost = false;
	candidateFailure = false;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, options?: RequestInit) => {
			const parsed = new URL(url, "http://localhost");
			let body: unknown;
			let status = 200;
			if (options?.method === "POST") {
				const submitted = JSON.parse(String(options.body));
				posts.push(submitted);
				body = {
					operationId: `operation-${posts.length}`,
					state: "pending",
					reason: null,
					selectedFileCount: 1,
					verifiedFileCount: 0,
					canConsiderNewAttempt: false,
				};
				statuses.set(submitted.idempotencyKey, body as ManualImportOperationStatus);
				status = 202;
				if (holdPost)
					await new Promise<void>((resolve) => {
						releasePost = resolve;
					});
			} else if (url.includes("/source")) {
				body = { kind: "none" };
			} else if (url.includes("/operations")) {
				body = statuses.get(parsed.searchParams.get("idempotencyKey") ?? "");
				if (unavailable || !body) {
					status = unavailable ? 503 : 404;
					body = { error: "Synthetic unavailable" };
				}
			} else {
				const source = parsed.searchParams.get("downloadId");
				if (candidateFailure && source === "first") {
					status = 503;
					body = { error: "Synthetic unavailable" };
				} else
					body = {
						candidates: [
							{
								service: "radarr",
								id: source === "first" ? 1 : 2,
								downloadId: source,
								path: `/synthetic/${source}`,
								movie: { id: source === "first" ? 12 : 13, title: `Synthetic ${source}` },
								quality: { quality: { id: 1 } },
							},
						],
						total: 1,
					};
			}
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		}),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
function show() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	client.setQueryData(authKeys.currentUser, { id: "owner", username: "Synthetic" });
	const completed = vi.fn();
	const onOpenChange = vi.fn();
	const view = render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<ManualImportReview
						sources={sources}
						open
						onOpenChange={onOpenChange}
						onCompleted={completed}
					/>
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return { ...view, client, completed, onOpenChange };
}
async function submit(count: number) {
	const button = await screen.findByRole("button", { name: /Import 1 selected/i });
	await waitFor(() => expect(button).toBeEnabled());
	fireEvent.click(button);
	await waitFor(() => expect(posts).toHaveLength(count));
}
async function navigate(direction: "Next" | "Previous", position: number) {
	const button = screen.getByRole("button", { name: `${direction} download` });
	await waitFor(() => expect(button).toBeEnabled());
	fireEvent.click(button);
	await screen.findByText(`Download ${position} of 2`);
}
describe("Manual Import multi-source review", () => {
	it("reviews all sources without auto-submission and restores each retained pending attempt", async () => {
		const view = show();
		await submit(1);
		await screen.findByText(/0 of 1 files verified/i);
		await navigate("Next", 2);
		expect(posts).toHaveLength(1);
		expect(screen.queryByText(/0 of 1 files verified/i)).not.toBeInTheDocument();
		await submit(2);
		await screen.findByText(/0 of 1 files verified/i);
		await navigate("Previous", 1);
		await screen.findByText(/0 of 1 files verified/i);
		expect(posts[0]?.idempotencyKey).not.toBe(posts[1]?.idempotencyKey);
		expect(posts).toHaveLength(2);
		expect(view.completed).not.toHaveBeenCalled();
		expect(view.onOpenChange).not.toHaveBeenCalled();
	});
	it("announces verified completion only once per operation when revisiting multiple completed sources", async () => {
		const view = show();
		await submit(1);
		await screen.findByText(/0 of 1 files verified/i);
		statuses.set(String(posts[0]?.idempotencyKey), {
			...statuses.get(String(posts[0]?.idempotencyKey))!,
			state: "completed",
			verifiedFileCount: 1,
		});
		fireEvent.click(screen.getByRole("button", { name: /Check progress/i }));
		await screen.findByText(/1 of 1 files verified/i);
		await navigate("Next", 2);
		await submit(2);
		await screen.findByText(/0 of 1 files verified/i);
		statuses.set(String(posts[1]?.idempotencyKey), {
			...statuses.get(String(posts[1]?.idempotencyKey))!,
			state: "completed",
			verifiedFileCount: 1,
		});
		fireEvent.click(screen.getByRole("button", { name: /Check progress/i }));
		await screen.findByText(/1 of 1 files verified/i);
		await waitFor(() => expect(view.completed).toHaveBeenCalledTimes(2));
		await navigate("Previous", 1);
		await screen.findByText(/1 of 1 files verified/i);
		await act(async () => {
			await Promise.resolve();
		});
		expect(view.completed).toHaveBeenCalledTimes(2);
		expect(posts).toHaveLength(2);
	});
	it("locks source navigation while the submission response is outstanding", async () => {
		holdPost = true;
		show();
		await submit(1);
		expect(screen.getByRole("button", { name: "Next download" })).toBeDisabled();
		await act(async () => releasePost?.());
		await screen.findByText(/0 of 1 files verified/i);
		await navigate("Next", 2);
		expect(posts).toHaveLength(1);
	});
	it("keeps other sources reachable when candidates are unavailable", async () => {
		candidateFailure = true;
		show();
		await screen.findByText(/Manual import candidates are unavailable/i);
		await navigate("Next", 2);
		await submit(1);
		expect(posts[0]?.files).toEqual(
			expect.arrayContaining([expect.objectContaining({ downloadId: "second" })]),
		);
	});
	it("does not replay a retained request when cached observation fails on return", async () => {
		show();
		await submit(1);
		await screen.findByText(/0 of 1 files verified/i);
		await navigate("Next", 2);
		unavailable = true;
		await navigate("Previous", 1);
		await screen.findByText(/Current evidence is unavailable/i);
		expect(posts).toHaveLength(1);
	});
});
