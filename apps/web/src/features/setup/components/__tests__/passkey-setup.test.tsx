import {
	type PublicKeyCredentialCreationOptionsJSON,
	type RegistrationResponseJSON,
	startRegistration,
} from "@simplewebauthn/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SetupPage from "../../../../../app/setup/page";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { PasskeySetup } from "../passkey-setup";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@simplewebauthn/browser", () => ({ startRegistration: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();
const registerPasskey = vi.mocked(startRegistration);
const credentials = { username: "test-admin", password: "Test-only-password1!" };
const friendlyName = "Test key";
const options: PublicKeyCredentialCreationOptionsJSON = {
	challenge: "Y2hhbGxlbmdl",
	rp: { name: "Test Dashboard", id: "localhost" },
	user: { id: "dGVzdC1hZG1pbg", name: credentials.username, displayName: credentials.username },
	pubKeyCredParams: [{ type: "public-key", alg: -7 }],
};
const attestation: RegistrationResponseJSON = {
	id: "Y3JlZGVudGlhbA",
	rawId: "Y3JlZGVudGlhbA",
	type: "public-key",
	response: { clientDataJSON: "Y2xpZW50", attestationObject: "YXR0ZXN0YXRpb24" },
	clientExtensionResults: {},
};

function registered() {
	return Response.json(
		{
			user: {
				id: "user-1",
				username: credentials.username,
				mustChangePassword: false,
				createdAt: "2026-01-01T00:00:00Z",
				hasPassword: true,
			},
		},
		{ status: 201 },
	);
}

function wrapper({ children }: { children: ReactNode }) {
	return (
		<ColorThemeProvider>
			<IncognitoProvider>{children}</IncognitoProvider>
		</ColorThemeProvider>
	);
}

function fillAndSubmit() {
	fireEvent.change(screen.getByPlaceholderText("admin"), {
		target: { value: credentials.username },
	});
	fireEvent.change(screen.getByPlaceholderText("At least 8 characters"), {
		target: { value: credentials.password },
	});
	fireEvent.change(screen.getByPlaceholderText("Re-enter password"), {
		target: { value: credentials.password },
	});
	fireEvent.change(screen.getByPlaceholderText("e.g., My Laptop"), {
		target: { value: friendlyName },
	});
	submit();
}

function submit() {
	fireEvent.click(screen.getByRole("button", { name: "Create Admin Account" }));
}

function requests() {
	return fetchMock.mock.calls.map(([path, init]) => [init?.method, path]);
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubGlobal("fetch", fetchMock);
	fetchMock.mockImplementation(async () =>
		Response.json({ error: "Unexpected request" }, { status: 500 }),
	);
	registerPasskey.mockResolvedValue(attestation);
});

afterEach(() => vi.unstubAllGlobals());

describe("PasskeySetup", () => {
	it("keeps registration retry available after a refusal without claiming an account exists", async () => {
		fetchMock
			.mockResolvedValueOnce(Response.json({ error: "Registration refused" }, { status: 403 }))
			.mockResolvedValueOnce(registered())
			.mockResolvedValueOnce(Response.json(options))
			.mockResolvedValueOnce(Response.json({ success: true }));
		render(<PasskeySetup />, { wrapper });

		fillAndSubmit();

		const refusal = await screen.findByRole("alert");
		expect(refusal).toHaveTextContent("Registration refused");
		expect(refusal).not.toHaveTextContent(/account (was )?created/i);
		expect(screen.queryByRole("button", { name: "Continue to Dashboard" })).not.toBeInTheDocument();
		expect(router.push).not.toHaveBeenCalled();
		expect(registerPasskey).not.toHaveBeenCalled();
		expect(requests()).toEqual([["POST", "/auth/register"]]);

		submit();

		await waitFor(() => expect(router.push).toHaveBeenCalledWith("/dashboard"));
		expect(requests()).toEqual([
			["POST", "/auth/register"],
			["POST", "/auth/register"],
			["POST", "/auth/passkey/register/options"],
			["POST", "/auth/passkey/register/verify"],
		]);
	});

	it.each(["options", "authenticator", "verification"] as const)(
		"preserves password access and waits for explicit continuation after %s failure",
		async (failure) => {
			fetchMock.mockResolvedValueOnce(registered());
			if (failure === "options") {
				fetchMock.mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 }));
			} else {
				fetchMock.mockResolvedValueOnce(Response.json(options));
			}
			if (failure === "authenticator") {
				registerPasskey.mockRejectedValueOnce(new DOMException("Canceled", "NotAllowedError"));
			}
			if (failure === "verification") {
				fetchMock.mockResolvedValueOnce(
					Response.json({ error: "Verification failed" }, { status: 400 }),
				);
			}

			render(<PasskeySetup />, { wrapper });
			fillAndSubmit();

			const feedback = await screen.findByRole("alert");
			expect(requests()).toEqual([
				["POST", "/auth/register"],
				["POST", "/auth/passkey/register/options"],
				...(failure === "verification" ? [["POST", "/auth/passkey/register/verify"]] : []),
			]);
			expect(feedback).toHaveTextContent(/admin account was created/i);
			expect(feedback).toHaveTextContent(/could not confirm.*passkey/i);
			expect(feedback).toHaveTextContent(/sign in.*password/i);
			expect(feedback).toHaveTextContent("Settings → Auth → Passkeys.");
			expect(
				screen.queryByRole("button", { name: "Create Admin Account" }),
			).not.toBeInTheDocument();
			expect(screen.queryByPlaceholderText("admin")).not.toBeInTheDocument();
			expect(screen.queryByPlaceholderText("At least 8 characters")).not.toBeInTheDocument();
			expect(screen.queryByPlaceholderText("Re-enter password")).not.toBeInTheDocument();
			expect(screen.queryByPlaceholderText("e.g., My Laptop")).not.toBeInTheDocument();
			expect(router.push).not.toHaveBeenCalled();
			expect(router.replace).not.toHaveBeenCalled();

			const requestCount = fetchMock.mock.calls.length;
			fireEvent.click(screen.getByRole("button", { name: "Continue to Dashboard" }));
			expect(router.push).toHaveBeenCalledExactlyOnceWith("/dashboard");
			expect(fetchMock).toHaveBeenCalledTimes(requestCount);
		},
	);

	it("enrolls with the server's raw options and navigates to the dashboard on success", async () => {
		fetchMock
			.mockResolvedValueOnce(registered())
			.mockResolvedValueOnce(Response.json(options))
			.mockResolvedValueOnce(Response.json({ success: true }));
		render(<PasskeySetup />, { wrapper });

		fillAndSubmit();

		await waitFor(() => expect(router.push).toHaveBeenCalledExactlyOnceWith("/dashboard"));
		expect(registerPasskey).toHaveBeenCalledExactlyOnceWith({ optionsJSON: options });
		expect(fetchMock.mock.calls.map(([, init]) => init?.body)).toEqual([
			JSON.stringify(credentials),
			JSON.stringify({ friendlyName }),
			JSON.stringify({ response: attestation, friendlyName }),
		]);
		expect(requests()).toEqual([
			["POST", "/auth/register"],
			["POST", "/auth/passkey/register/options"],
			["POST", "/auth/passkey/register/verify"],
		]);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});

function renderSetupPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<SetupPage />
		</QueryClientProvider>,
		{ wrapper },
	);
}

function mockFirstInstallRequests(respond: typeof fetch) {
	fetchMock.mockImplementation(async (path, init) => {
		if (path === "/auth/setup-required") {
			return Response.json({ required: true, passwordPolicy: "strict" });
		}
		return respond(path, init);
	});
}

describe("passkey setup method switching", () => {
	it("keeps method switching locked while the authenticator is pending and through fallback", async () => {
		const enrollment = Promise.withResolvers<RegistrationResponseJSON>();
		registerPasskey.mockReturnValueOnce(enrollment.promise);
		const write = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(registered())
			.mockResolvedValueOnce(Response.json(options));
		mockFirstInstallRequests(write);
		renderSetupPage();

		await screen.findByPlaceholderText("e.g., My Laptop");
		fillAndSubmit();
		await waitFor(() => expect(registerPasskey).toHaveBeenCalledOnce());

		const password = screen.getByRole("button", { name: "Password" });
		const oidc = screen.getByRole("button", { name: "OIDC" });
		expect(password).toBeDisabled();
		expect(oidc).toBeDisabled();
		fireEvent.click(password);
		expect(screen.getByPlaceholderText("e.g., My Laptop")).toBeInTheDocument();

		await act(() => enrollment.reject(new DOMException("Canceled", "NotAllowedError")));
		const continueButton = await screen.findByRole("button", { name: "Continue to Dashboard" });

		expect(password).toBeDisabled();
		expect(oidc).toBeDisabled();
		fireEvent.click(oidc);
		fireEvent.click(screen.getByRole("button", { name: "Passkey" }));
		expect(continueButton).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Create Admin Account" })).not.toBeInTheDocument();
		fireEvent.click(continueButton);
		expect(router.push).toHaveBeenCalledExactlyOnceWith("/dashboard");
		expect(write.mock.calls.map(([path, init]) => [init?.method, path])).toEqual([
			["POST", "/auth/register"],
			["POST", "/auth/passkey/register/options"],
		]);
	});

	it("unlocks method switching after registration is refused", async () => {
		const registration = Promise.withResolvers<Response>();
		const write = vi.fn<typeof fetch>().mockReturnValueOnce(registration.promise);
		mockFirstInstallRequests(write);
		renderSetupPage();

		await screen.findByPlaceholderText("e.g., My Laptop");
		const password = screen.getByRole("button", { name: "Password" });
		const oidc = screen.getByRole("button", { name: "OIDC" });
		expect(password).toBeEnabled();
		expect(oidc).toBeEnabled();
		fillAndSubmit();
		expect(password).toBeDisabled();
		expect(oidc).toBeDisabled();

		await act(() =>
			registration.resolve(Response.json({ error: "Registration refused" }, { status: 403 })),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent("Registration refused");
		expect(password).toBeEnabled();
		expect(oidc).toBeEnabled();
		fireEvent.click(password);
		expect(screen.queryByPlaceholderText("e.g., My Laptop")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Create Admin Account" })).toBeEnabled();
		expect(write.mock.calls.map(([path, init]) => [init?.method, path])).toEqual([
			["POST", "/auth/register"],
		]);
	});
});

it("redirects a completed install from the setup route to ordinary login", async () => {
	fetchMock.mockResolvedValueOnce(Response.json({ required: false, passwordPolicy: "strict" }));
	renderSetupPage();

	await waitFor(() => expect(router.replace).toHaveBeenCalledExactlyOnceWith("/login"));
	expect(screen.queryByRole("button", { name: "Create Admin Account" })).not.toBeInTheDocument();
	expect(requests()).toEqual([["GET", "/auth/setup-required"]]);
});
