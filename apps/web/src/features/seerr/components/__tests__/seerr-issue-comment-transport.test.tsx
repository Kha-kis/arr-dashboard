import type { SeerrIssue, ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { RequestsClient } from "../requests-client";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

const stamp = "2026-10-01T12:00:00Z";
const connection = (id: "north" | "south"): ServiceInstanceSummary => ({
	id,
	service: "seerr",
	label: `Synthetic ${id}`,
	baseUrl: "https://seerr.invalid",
	externalUrl: null,
	enabled: true,
	isDefault: id === "north",
	hasApiKey: true,
	hasHttpAuth: false,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "unverified",
		kind: null,
		fingerprint: null,
		verifiedAt: null,
		lastCheckedAt: null,
	},
	createdAt: stamp,
	updatedAt: stamp,
	tags: [],
});
const viewer = {
	id: 5,
	displayName: "Synthetic viewer",
	createdAt: stamp,
	updatedAt: stamp,
	permissions: 1,
	requestCount: 0,
	userType: 1,
};
const issue = (id: string): SeerrIssue => ({
	id: 41,
	issueType: 1,
	status: 1,
	problemSeason: 0,
	problemEpisode: 0,
	createdAt: stamp,
	updatedAt: stamp,
	createdBy: viewer,
	comments: [],
	media: {
		id: 7,
		tmdbId: 7,
		status: 2,
		createdAt: stamp,
		updatedAt: stamp,
		title: `Issue on ${id}`,
	},
});
const page = (results: unknown[]) => ({
	pageInfo: { pages: 1, pageSize: 50, results: results.length, page: 1 },
	results,
});
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let client: QueryClient | undefined;
const unexpected: string[] = [];

function mount(reply: () => Response | Promise<Response>) {
	const posts: Array<{ path: string; message: string }> = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "https://dashboard.invalid");
		const { pathname } = url;
		const method = init?.method ?? "GET";
		if (method === "GET" && pathname === "/api/services")
			return json({ services: [connection("north"), connection("south")] });
		if (method === "GET" && /^\/api\/seerr\/status\/(north|south)\/health$/.test(pathname))
			return json({ status: "healthy", lastCheckedAt: stamp, error: null });
		if (method === "GET" && /^\/api\/seerr\/status\/(north|south)$/.test(pathname))
			return json({
				version: "1.0.0",
				commitTag: "synthetic",
				updateAvailable: false,
				commitsBehind: 0,
			});
		if (method === "GET" && /^\/api\/seerr\/requests\/(north|south)\/count$/.test(pathname))
			return json({
				total: 0,
				movie: 0,
				tv: 0,
				pending: 0,
				approved: 0,
				declined: 0,
				processing: 0,
				available: 0,
			});
		if (method === "GET" && /^\/api\/seerr\/requests\/(north|south)$/.test(pathname))
			return json(page([]));
		if (method === "GET" && /^\/api\/seerr\/issues\/(north|south)$/.test(pathname))
			return json(page([issue(pathname.split("/").at(-1)!)]));
		if (method === "POST" && /^\/api\/seerr\/issues\/(north|south)\/41\/comment$/.test(pathname)) {
			expect(init?.credentials).toBe("include");
			posts.push({ path: pathname, message: JSON.parse(String(init?.body)).message });
			return reply();
		}
		unexpected.push(`${method} ${pathname}`);
		return json({ error: "Unexpected synthetic request" }, 500);
	});
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<RequestsClient />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return { posts, client };
}
const draft = () => screen.getByPlaceholderText("Add a comment...");
async function openIssues() {
	fireEvent.click(await screen.findByRole("button", { name: /^Issues$/ }));
	await screen.findByRole("heading", { name: "Issue on north" });
}
afterEach(() => {
	cleanup();
	client?.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	localStorage.clear();
	expect(unexpected.splice(0)).toEqual([]);
});

it("does not carry an issue comment draft into the same numeric issue on another instance", async () => {
	const view = mount(() => json({ id: 1, message: "ok", createdAt: stamp, user: viewer }));
	await openIssues();
	fireEvent.change(draft(), { target: { value: "Draft for the north issue only" } });
	const selector = screen.getByRole("option", { name: "Synthetic south" }).closest("select");
	expect(selector).not.toBeNull();
	fireEvent.change(selector!, { target: { value: "south" } });
	await screen.findByRole("heading", { name: "Issue on south" });
	expect(draft()).toHaveValue("");
	expect(view.posts).toEqual([]);
});

it("does not dispatch Enter again while an issue comment is pending", async () => {
	let release!: () => void;
	const response = new Promise<Response>((resolve) => {
		release = () => resolve(json({ id: 1, message: "Draft", createdAt: stamp, user: viewer }));
	});
	const view = mount(() => response);
	await openIssues();
	fireEvent.change(draft(), { target: { value: "Draft" } });
	fireEvent.keyDown(draft(), { key: "Enter" });
	try {
		await waitFor(() => expect(view.posts).toHaveLength(1));
		await waitFor(() => expect(screen.getByTitle("Send comment")).toBeDisabled());
		fireEvent.keyDown(draft(), { key: "Enter" });
	} finally {
		await act(async () => release());
	}
	await waitFor(() => expect(view.client.isMutating()).toBe(0));
	expect(view.posts).toEqual([{ path: "/api/seerr/issues/north/41/comment", message: "Draft" }]);
	expect(draft()).toHaveValue("");
});

it("retains each instance draft and leaves a newer draft intact after a held success", async () => {
	let release!: () => void;
	const response = new Promise<Response>((resolve) => {
		release = () =>
			resolve(json({ id: 1, message: "North original", createdAt: stamp, user: viewer }));
	});
	const view = mount(() => response);
	await openIssues();
	const choose = (id: "north" | "south") => {
		const selector = screen.getByRole("option", { name: `Synthetic ${id}` }).closest("select");
		expect(selector).not.toBeNull();
		fireEvent.change(selector!, { target: { value: id } });
	};
	fireEvent.change(draft(), { target: { value: "North original" } });
	fireEvent.click(screen.getByTitle("Send comment"));
	try {
		await waitFor(() => expect(view.posts).toHaveLength(1));
		fireEvent.change(draft(), { target: { value: "New north draft" } });
		choose("south");
		await screen.findByRole("heading", { name: "Issue on south" });
		expect(draft()).toHaveValue("");
		fireEvent.change(draft(), { target: { value: "South draft" } });
		fireEvent.keyDown(draft(), { key: "Enter" });
	} finally {
		await act(async () => release());
	}
	await waitFor(() => expect(view.client.isMutating()).toBe(0));
	expect(draft()).toHaveValue("South draft");
	choose("north");
	await screen.findByRole("heading", { name: "Issue on north" });
	expect(draft()).toHaveValue("New north draft");
	expect(view.posts).toEqual([
		{ path: "/api/seerr/issues/north/41/comment", message: "North original" },
	]);
});

it("retains a rejected comment for one explicit retry and clears it after acceptance", async () => {
	let replies = 0;
	const view = mount(() =>
		++replies === 1
			? json({ message: "Synthetic rejected comment" }, 422)
			: json({ id: 1, message: "Retry draft", createdAt: stamp, user: viewer }),
	);
	await openIssues();
	fireEvent.change(draft(), { target: { value: "  " } });
	fireEvent.keyDown(draft(), { key: "Enter" });
	expect(view.posts).toEqual([]);
	fireEvent.change(draft(), { target: { value: " Retry draft " } });
	fireEvent.keyDown(draft(), { key: "Enter" });
	await waitFor(() => {
		expect(view.posts).toHaveLength(1);
		expect(view.client.isMutating()).toBe(0);
	});
	expect(draft()).toHaveValue(" Retry draft ");
	fireEvent.click(screen.getByTitle("Send comment"));
	await waitFor(() => expect(draft()).toHaveValue(""));
	expect(view.posts).toEqual([
		{ path: "/api/seerr/issues/north/41/comment", message: "Retry draft" },
		{ path: "/api/seerr/issues/north/41/comment", message: "Retry draft" },
	]);
});

it("reports an uncertain comment outcome and retains the draft without replay", async () => {
	const warning = vi.spyOn(toast, "warning");
	const success = vi.spyOn(toast, "success");
	const view = mount(() => json({ error: "SeerrMutationOutcomeUnknownError" }, 502));
	await openIssues();
	fireEvent.change(draft(), { target: { value: "Uncertain draft" } });
	fireEvent.keyDown(draft(), { key: "Enter" });
	await waitFor(() =>
		expect(warning).toHaveBeenCalledWith("Outcome unknown. Check Seerr before retrying."),
	);
	expect(success).not.toHaveBeenCalled();
	expect(draft()).toHaveValue("Uncertain draft");
	await waitFor(() => expect(view.client.isFetching()).toBe(0));
	expect(view.posts).toEqual([
		{ path: "/api/seerr/issues/north/41/comment", message: "Uncertain draft" },
	]);
});
