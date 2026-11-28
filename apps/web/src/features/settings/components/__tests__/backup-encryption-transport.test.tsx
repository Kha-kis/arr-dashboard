import type { BackupPasswordStatus } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { backupKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { BackupEncryptionSection } from "../backup-encryption-section";

type Request = { url: string; method: string; body: unknown };
let requests: Request[];
let status: BackupPasswordStatus;
let refused: boolean;
let statusRefused: boolean;
let readPending: Promise<void> | undefined;
let releaseRead: (() => void) | undefined;
let release: (() => void) | undefined;
let pending: Promise<void> | undefined;
let client: QueryClient;
const writes = () => requests.filter((request) => request.method !== "GET");
const statusReads = () => requests.filter((request) => request.method === "GET");

function hold() {
	pending = new Promise<void>((resolve) => {
		release = resolve;
	});
}
function fill(password: string, confirmation = password) {
	fireEvent.change(screen.getByPlaceholderText("Enter new password (min 8 characters)"), {
		target: { value: password },
	});
	fireEvent.change(screen.getByPlaceholderText("Confirm new password"), {
		target: { value: confirmation },
	});
}
function show() {
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<BackupEncryptionSection />
					<Toaster />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}
async function settled() {
	await waitFor(() =>
		expect(
			client
				.getMutationCache()
				.getAll()
				.some((m) => m.state.status === "pending"),
		).toBe(false),
	);
}
beforeEach(() => {
	localStorage.clear();
	requests = [];
	status = { configured: false, source: "none" };
	refused = false;
	statusRefused = false;
	readPending = undefined;
	releaseRead = undefined;
	pending = undefined;
	release = undefined;
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	vi.stubGlobal(
		"confirm",
		vi.fn(() => false),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const request = {
				url,
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			requests.push(request);
			let body: unknown;
			let code = 200;
			if (url === "/api/backup/password/status" && request.method === "GET") {
				await readPending;
				code = statusRefused ? 503 : 200;
				body = statusRefused ? { error: "Synthetic private status diagnostic" } : status;
			} else if (url === "/api/backup/password" && ["PUT", "DELETE"].includes(request.method)) {
				await pending;
				if (refused) {
					code = 503;
					body = { error: "Synthetic password action refused" };
				} else {
					status =
						request.method === "PUT"
							? { configured: true, source: "database" }
							: { configured: true, source: "environment" };
					body = { success: true, message: "Synthetic password action acknowledged" };
				}
			} else {
				throw new Error("Unexpected synthetic password request");
			}
			return new Response(JSON.stringify(body), {
				status: code,
				headers: { "content-type": "application/json" },
			});
		}),
	);
});
afterEach(async () => {
	await act(async () => {
		release?.();
		releaseRead?.();
	});
	await settled();
	toast.dismiss();
	cleanup();
	client.clear();
	vi.unstubAllGlobals();
});

describe("Backup encryption caller transport", () => {
	it.each(["New Password", "Confirm Password"])(
		"associates the %s control with its visible label without writing",
		async (label) => {
			show();
			await screen.findByText("No Password Configured");
			fireEvent.click(screen.getByRole("button", { name: "Set Password" }));
			expect(screen.getByLabelText(label)).toHaveAttribute("type", "password");
			expect(writes()).toEqual([]);
		},
	);

	it("keeps a failed initial status unknown and recovers through explicit status-only retries", async () => {
		statusRefused = true;
		show();
		await screen.findByText("Password status unavailable");
		expect(screen.queryByText("No Password Configured")).not.toBeInTheDocument();
		expect(screen.queryByText("Password Configured")).not.toBeInTheDocument();
		expect(screen.queryByText("Synthetic private status diagnostic")).not.toBeInTheDocument();
		expect(writes()).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "Retry status check" }));
		await waitFor(() => expect(client.isFetching({ queryKey: backupKeys.passwordStatus })).toBe(0));
		await screen.findByRole("button", { name: "Retry status check" });
		expect(statusReads()).toHaveLength(2);
		expect(screen.queryByText("No Password Configured")).not.toBeInTheDocument();
		statusRefused = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry status check" }));
		await screen.findByText("No Password Configured");
		expect(screen.queryByText("Password status unavailable")).not.toBeInTheDocument();
		expect(statusReads()).toHaveLength(3);
		expect(writes()).toEqual([]);
	});

	it("does not present cached configured status as verified after a failed refresh", async () => {
		status = { configured: true, source: "database" };
		show();
		await screen.findByRole("button", { name: "Remove" });
		statusRefused = true;
		await act(async () => client.invalidateQueries({ queryKey: backupKeys.passwordStatus }));
		await screen.findByText("Password status unavailable");
		expect(screen.queryByText("Password Configured")).not.toBeInTheDocument();
		expect(screen.queryByText("No Password Configured")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
		readPending = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		statusRefused = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry status check" }));
		const checking = await screen.findByRole("button", { name: "Checking..." });
		expect(checking).toBeDisabled();
		fireEvent.click(checking);
		expect(statusReads()).toHaveLength(3);
		await act(async () => releaseRead?.());
		await screen.findByText("Password Configured");
		await screen.findByRole("button", { name: "Remove" });
		expect(statusReads()).toHaveLength(3);
		expect(writes()).toEqual([]);
	});

	it("keeps status unverified after an acknowledged set whose readback fails without replaying the write", async () => {
		show();
		await screen.findByText("No Password Configured");
		fireEvent.click(screen.getByRole("button", { name: "Set Password" }));
		fill("Synthetic-password-1");
		statusRefused = true;
		fireEvent.click(screen.getByRole("button", { name: "Save Password" }));
		await screen.findByText("Backup password updated successfully");
		await screen.findByText("Password status unavailable");
		await settled();
		expect(screen.queryByText("No Password Configured")).not.toBeInTheDocument();
		expect(screen.queryByText("Password Configured")).not.toBeInTheDocument();
		expect(screen.queryByPlaceholderText("Confirm new password")).not.toBeInTheDocument();
		expect(writes()).toHaveLength(1);
		statusRefused = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry status check" }));
		await screen.findByText("Password Configured");
		expect(statusReads()).toHaveLength(3);
		expect(writes()).toEqual([
			{ url: "/api/backup/password", method: "PUT", body: { password: "Synthetic-password-1" } },
		]);
	});

	it("prevents short/mismatched submissions and Cancel clears the unsaved password draft", async () => {
		show();
		fireEvent.click(await screen.findByRole("button", { name: "Set Password" }));
		fill("short");
		const save = screen.getByRole("button", { name: "Save Password" });
		expect(save).toBeDisabled();
		fireEvent.click(save);
		fill("Synthetic-password-1", "Synthetic-password-2");
		expect(save).toBeDisabled();
		fireEvent.click(save);
		expect(writes()).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Set Password" }));
		expect(screen.getByPlaceholderText("Enter new password (min 8 characters)")).toHaveValue("");
		expect(screen.getByPlaceholderText("Confirm new password")).toHaveValue("");
		expect(screen.getByRole("button", { name: "Save Password" })).toBeDisabled();
		expect(writes()).toEqual([]);
	});

	it("retains a refused set draft and only acknowledged explicit retry refreshes status and clears it", async () => {
		show();
		fireEvent.click(await screen.findByRole("button", { name: "Set Password" }));
		fill("Synthetic-password-1");
		refused = true;
		fireEvent.click(screen.getByRole("button", { name: "Save Password" }));
		await screen.findByText("Failed to set password: Synthetic password action refused");
		await settled();
		expect(screen.getByPlaceholderText("Enter new password (min 8 characters)")).toHaveValue(
			"Synthetic-password-1",
		);
		expect(screen.getByText("No Password Configured")).toBeInTheDocument();
		expect(screen.queryByText("Backup password updated successfully")).not.toBeInTheDocument();
		expect(writes()).toHaveLength(1);
		expect(statusReads()).toHaveLength(1);
		refused = false;
		hold();
		fireEvent.click(screen.getByRole("button", { name: "Save Password" }));
		const saving = await screen.findByRole("button", { name: "Saving..." });
		expect(saving).toBeDisabled();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		expect(screen.getByPlaceholderText("Confirm new password")).toBeDisabled();
		fireEvent.click(saving);
		expect(writes()).toHaveLength(2);
		expect(statusReads()).toHaveLength(1);
		await act(async () => release?.());
		await screen.findByText("Password Configured");
		await screen.findByText("Backup password updated successfully");
		await settled();
		expect(statusReads()).toHaveLength(2);
		expect(writes()).toEqual([
			{ url: "/api/backup/password", method: "PUT", body: { password: "Synthetic-password-1" } },
			{ url: "/api/backup/password", method: "PUT", body: { password: "Synthetic-password-1" } },
		]);
		fireEvent.click(screen.getByRole("button", { name: "Change Password" }));
		expect(screen.getByPlaceholderText("Enter new password (min 8 characters)")).toHaveValue("");
		expect(screen.getByPlaceholderText("Confirm new password")).toHaveValue("");
	});

	it("requires removal consent, preserves refused status, then reads back environment fallback after retry", async () => {
		status = { configured: true, source: "database" };
		show();
		const remove = await screen.findByRole("button", { name: "Remove" });
		fireEvent.click(remove);
		expect(writes()).toEqual([]);
		vi.mocked(confirm).mockReturnValue(true);
		refused = true;
		fireEvent.click(remove);
		await screen.findByText("Failed to remove password: Synthetic password action refused");
		await settled();
		expect(remove).toBeEnabled();
		expect(screen.getByText("Password is stored securely in the database.")).toBeInTheDocument();
		expect(screen.queryByText("Backup password removed from database")).not.toBeInTheDocument();
		expect(writes()).toHaveLength(1);
		expect(statusReads()).toHaveLength(1);
		refused = false;
		hold();
		fireEvent.click(remove);
		const removing = await screen.findByRole("button", { name: "Removing..." });
		expect(removing).toBeDisabled();
		fireEvent.click(removing);
		expect(writes()).toHaveLength(2);
		expect(statusReads()).toHaveLength(1);
		await act(async () => release?.());
		await screen.findByText("Password is set via BACKUP_PASSWORD environment variable.");
		await screen.findByText("Backup password removed from database");
		await settled();
		expect(screen.getByText("Password Configured")).toBeInTheDocument();
		expect(screen.queryByText("No Password Configured")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
		expect(statusReads()).toHaveLength(2);
		expect(writes()).toEqual([
			{ url: "/api/backup/password", method: "DELETE", body: null },
			{ url: "/api/backup/password", method: "DELETE", body: null },
		]);
	});
});
