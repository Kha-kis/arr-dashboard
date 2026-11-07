import { startRegistration } from "@simplewebauthn/browser";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import type { PasskeyCredential } from "../../../../lib/api-client/auth";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { PasskeySection } from "../passkey-section";

// The OS/browser ceremony is external; keep the component and HTTP client real.
vi.mock("@simplewebauthn/browser", () => ({ startRegistration: vi.fn() }));

const original: PasskeyCredential = {
	id: "synthetic-existing",
	friendlyName: "Synthetic existing key",
	backedUp: false,
	createdAt: "2026-01-01T00:00:00.000Z",
	lastUsedAt: "2026-01-01T00:00:00.000Z",
};
const options = {
	challenge: "Y2hhbGxlbmdl",
	rp: { id: "localhost", name: "Synthetic fixture" },
	user: { id: "Zml4dHVyZQ", name: "fixture", displayName: "Synthetic fixture" },
	pubKeyCredParams: [{ type: "public-key", alg: -7 }],
	timeout: 60000,
	attestation: "none",
	excludeCredentials: [],
	authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
};
const registered: Awaited<ReturnType<typeof startRegistration>> = {
	id: "c3ludGhldGlj",
	rawId: "c3ludGhldGlj",
	type: "public-key",
	response: {
		clientDataJSON: "Y2xpZW50",
		attestationObject: "YXR0ZXN0YXRpb24",
		transports: ["internal"],
	},
	clientExtensionResults: {},
	authenticatorAttachment: "platform",
};
type Request = { url: string; method: string; body: unknown };
let requests: Request[];
let rows: PasskeyCredential[];
let rejectCeremony: ((error: Error) => void) | undefined;

beforeEach(() => {
	localStorage.clear();
	requests = [];
	rows = [original];
	vi.mocked(startRegistration).mockReset();
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
			if (url === "/auth/passkey/credentials" && request.method === "GET") {
				body = { credentials: rows };
			} else if (url === "/auth/passkey/register/options" && request.method === "POST") {
				body = options;
			} else if (url === "/auth/passkey/register/verify" && request.method === "POST") {
				rows = [...rows, { ...original, id: "synthetic-added", friendlyName: "Synthetic new key" }];
				body = { verified: true };
			} else {
				throw new Error("Unexpected synthetic request");
			}
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
});
afterEach(async () => {
	if (rejectCeremony) {
		await act(async () => rejectCeremony?.(new Error("Synthetic cleanup")));
		rejectCeremony = undefined;
	}
	cleanup();
	vi.unstubAllGlobals();
});

describe("Passkey registration rejection after options", () => {
	it.each([
		["cancelled", "NotAllowedError", "Synthetic ceremony cancelled"],
		["unsupported", "Error", "Synthetic device does not support passkeys"],
	])(
		"keeps %s ceremony failure honest and permits explicit retry",
		async (_category, name, message) => {
			vi.mocked(startRegistration).mockImplementationOnce(
				() =>
					new Promise((_resolve, reject) => {
						rejectCeremony = reject;
					}),
			);
			render(
				<ColorThemeProvider>
					<IncognitoProvider>
						<PasskeySection />
					</IncognitoProvider>
				</ColorThemeProvider>,
			);
			await screen.findByText("Synthetic existing key");
			fireEvent.change(screen.getByPlaceholderText("Passkey name (e.g., iPhone, YubiKey)"), {
				target: { value: "Synthetic new key" },
			});
			fireEvent.click(screen.getByRole("button", { name: "Add Passkey", exact: true }));
			await waitFor(() => expect(startRegistration).toHaveBeenCalledTimes(1));
			expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: options });
			expect(screen.getByRole("button", { name: "Registering...", exact: true })).toBeDisabled();
			expect(requests.filter((r) => r.method === "POST")).toEqual([
				{
					url: "/auth/passkey/register/options",
					method: "POST",
					body: { friendlyName: "Synthetic new key" },
				},
			]);
			const error = new Error(message);
			error.name = name;
			await act(async () => {
				rejectCeremony?.(error);
				rejectCeremony = undefined;
			});
			await screen.findByText(message);
			expect(screen.getByText("Synthetic existing key")).toBeInTheDocument();
			expect(screen.queryByText("Passkey registered successfully!")).not.toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Add Passkey", exact: true })).toBeEnabled();
			expect(requests.filter((r) => r.url === "/auth/passkey/register/verify")).toHaveLength(0);

			vi.mocked(startRegistration).mockResolvedValueOnce(registered);
			fireEvent.click(screen.getByRole("button", { name: "Add Passkey", exact: true }));
			await screen.findByText("Passkey registered successfully!");
			await screen.findByText("Synthetic new key");
			expect(screen.getByText("Synthetic existing key")).toBeInTheDocument();
			expect(screen.queryByText(message)).not.toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Add Passkey", exact: true })).toBeEnabled();
			expect(requests.filter((r) => r.method === "POST")).toEqual([
				{
					url: "/auth/passkey/register/options",
					method: "POST",
					body: { friendlyName: "Synthetic new key" },
				},
				{
					url: "/auth/passkey/register/options",
					method: "POST",
					body: { friendlyName: "Synthetic new key" },
				},
				{
					url: "/auth/passkey/register/verify",
					method: "POST",
					body: { response: registered, friendlyName: "Synthetic new key" },
				},
			]);
		},
	);
});
