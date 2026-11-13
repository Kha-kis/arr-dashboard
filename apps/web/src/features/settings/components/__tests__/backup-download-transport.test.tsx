import type { BackupFileInfo } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
} from "../../../../lib/auth-session-signal";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { BackupListSection } from "../backup-list-section";

const backup: BackupFileInfo = {
	id: "a".repeat(24),
	filename: "synthetic-encrypted.arrb",
	type: "manual",
	timestamp: "2026-10-25T12:00:00Z",
	size: 4,
};
const downloadPath = `/api/backup/${backup.id}/download`;
const bytes = new Uint8Array([65, 82, 82, 66]);
let client: QueryClient;
let requests: Array<{ url: string; method: string }>;
let deliveries: Array<{ href: string; filename: string; attached: boolean }>;
let blobs: Blob[];
let released: string[];
let errors: unknown[][];
let clickFailure: Error | null;
let respond: () => Promise<Response>;
let release: (() => void) | null;
let active: Set<Promise<Response>>;

beforeEach(() => {
	localStorage.clear();
	acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	requests = [];
	deliveries = [];
	blobs = [];
	released = [];
	errors = [];
	clickFailure = null;
	release = null;
	active = new Set();
	respond = async () => new Response(bytes, { status: 200 });
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args);
	});
	vi.stubGlobal(
		"URL",
		class extends URL {
			static override createObjectURL(blob: Blob) {
				blobs.push(blob);
				return "blob:synthetic-backup";
			}
			static override revokeObjectURL(url: string) {
				released.push(url);
			}
		},
	);
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		deliveries.push({ href: this.href, filename: this.download, attached: this.isConnected });
		if (clickFailure) throw clickFailure;
	});
	vi.stubGlobal("fetch", (url: string, options?: RequestInit) => {
		requests.push({ url, method: options?.method ?? "GET" });
		let task: Promise<Response>;
		if (url === "/api/backup") {
			task = Promise.resolve(
				new Response(JSON.stringify({ backups: [backup] }), {
					headers: { "content-type": "application/json" },
				}),
			);
		} else if (url === downloadPath) task = respond();
		else throw new Error("Unexpected synthetic download request");
		active.add(task);
		void task.then(
			() => active.delete(task),
			() => active.delete(task),
		);
		return task;
	});
});

afterEach(async () => {
	try {
		await act(async () => {
			release?.();
			await Promise.allSettled([...active]);
		});
		await waitFor(() => expect(client.isMutating()).toBe(0));
	} finally {
		toast.dismiss();
		cleanup();
		client.clear();
		acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	}
});

async function show() {
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<BackupListSection />
					<Toaster />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return screen.findByRole("button", { name: "Download backup" });
}
const downloads = () => requests.filter((request) => request.url === downloadPath);

describe("protected Backup download through the real list and client", () => {
	it("dispatches selected bytes and filename once after a pending read and releases browser resources", async () => {
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		respond = async () => {
			await held;
			return new Response(bytes, { status: 200 });
		};
		const button = await show();
		fireEvent.click(button);
		await waitFor(() => expect(button).toBeDisabled());
		fireEvent.click(button);
		expect(downloads()).toEqual([{ url: downloadPath, method: "GET" }]);
		expect(deliveries).toEqual([]);
		await act(async () => {
			release?.();
			await Promise.allSettled([...active]);
		});
		await waitFor(() => expect(button).toBeEnabled());
		expect(deliveries).toEqual([
			{ href: "blob:synthetic-backup", filename: "synthetic-encrypted.arrb", attached: true },
		]);
		expect(new Uint8Array(await blobs[0]!.arrayBuffer())).toEqual(bytes);
		expect(released).toEqual(["blob:synthetic-backup"]);
		expect(document.querySelector("a[download]")).toBeNull();
		expect(errors).toEqual([]);
	});

	it("signals expired protected authentication without creating a download or exposing the response body", async () => {
		respond = async () =>
			new Response("synthetic-private-unauthorized-body", {
				status: 401,
				statusText: "Unauthorized",
			});
		fireEvent.click(await show());
		await screen.findByText("Failed to download backup");
		expect(getPendingUnauthorizedRevision()).toBeGreaterThan(0);
		expect(blobs).toEqual([]);
		expect(deliveries).toEqual([]);
		expect(downloads()).toHaveLength(1);
		expect(screen.queryByText("synthetic-private-unauthorized-body")).not.toBeInTheDocument();
		expect(errors).toEqual([]);
	});

	it("keeps a refused GET retryable and downloads only after explicit successful retry of the same selection", async () => {
		respond = async () => new Response("synthetic-private-refusal", { status: 503 });
		const button = await show();
		fireEvent.click(button);
		await screen.findByText("Failed to download backup");
		await waitFor(() => expect(button).toBeEnabled());
		expect(deliveries).toEqual([]);
		expect(blobs).toEqual([]);
		expect(getPendingUnauthorizedRevision()).toBe(0);
		expect(downloads()).toHaveLength(1);
		respond = async () => new Response(bytes, { status: 200 });
		fireEvent.click(button);
		await waitFor(() => expect(deliveries).toHaveLength(1));
		expect(downloads()).toEqual([
			{ url: downloadPath, method: "GET" },
			{ url: downloadPath, method: "GET" },
		]);
		expect(deliveries[0]?.filename).toBe("synthetic-encrypted.arrb");
		expect(errors).toEqual([]);
	});

	it("does not disclose a failed binary read or dispatch a partial file", async () => {
		respond = async () => {
			const response = new Response(bytes, { status: 200 });
			response.blob = async () => {
				throw new Error("synthetic-private-stream-diagnostic");
			};
			return response;
		};
		const button = await show();
		fireEvent.click(button);
		await screen.findByText("Failed to download backup");
		await waitFor(() => expect(button).toBeEnabled());
		expect(blobs).toEqual([]);
		expect(deliveries).toEqual([]);
		expect(screen.queryByText("synthetic-private-stream-diagnostic")).not.toBeInTheDocument();
		expect(errors).toEqual([]);
	});

	it("releases an attached anchor and object URL if the browser rejects dispatch, without disclosing raw errors", async () => {
		clickFailure = new Error("synthetic-private-browser-diagnostic");
		const button = await show();
		fireEvent.click(button);
		await screen.findByText("Failed to download backup");
		await waitFor(() => expect(button).toBeEnabled());
		expect(deliveries).toHaveLength(1);
		expect(released).toEqual(["blob:synthetic-backup"]);
		expect(document.querySelector("a[download]")).toBeNull();
		expect(screen.queryByText("synthetic-private-browser-diagnostic")).not.toBeInTheDocument();
		expect(errors).toEqual([]);
	});
});
