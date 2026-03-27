import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Mocks
// ============================================================================

const mockUseSeerrUserQuota = vi.fn();

vi.mock("../../../../hooks/api/useSeerr", () => ({
	useSeerrUserQuota: (...args: unknown[]) => mockUseSeerrUserQuota(...args),
}));

// Mock next/link as a plain <a>
vi.mock("next/link", () => ({
	default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
		<a href={href} {...rest}>
			{children}
		</a>
	),
}));

// Import after mocks
import { RequesterProfilePopover } from "../requester-profile-popover";

// ============================================================================
// Test data
// ============================================================================

const sampleUser = {
	id: 42,
	displayName: "Alice Wonderland",
	email: "alice@example.com",
	avatar: "https://example.com/avatar.jpg",
	createdAt: "2024-01-01",
	updatedAt: "2024-06-01",
	permissions: 0,
	requestCount: 15,
	userType: 1,
};

const sampleQuota = {
	movie: { used: 3, remaining: 7, restricted: true, limit: 10, days: 7 },
	tv: { used: 1, remaining: 4, restricted: true, limit: 5, days: 7 },
};

const unrestrictedQuota = {
	movie: { used: 0, remaining: 0, restricted: false, limit: 0, days: 0 },
	tv: { used: 0, remaining: 0, restricted: false, limit: 0, days: 0 },
};

// ============================================================================
// Helpers
// ============================================================================

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

function renderPopover(overrides: Partial<React.ComponentProps<typeof RequesterProfilePopover>> = {}) {
	return render(
		<RequesterProfilePopover
			seerrUser={sampleUser}
			displayName="Alice Wonderland"
			instanceId="inst-1"
			isIncognito={false}
			{...overrides}
		>
			<button type="button">Click me</button>
		</RequesterProfilePopover>,
		{ wrapper: createWrapper() },
	);
}

// ============================================================================
// Tests
// ============================================================================

describe("RequesterProfilePopover", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUseSeerrUserQuota.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: false,
		});
	});

	it("renders the trigger element", () => {
		renderPopover();
		expect(screen.getByText("Click me")).toBeTruthy();
	});

	it("shows popover content when trigger is clicked", async () => {
		mockUseSeerrUserQuota.mockReturnValue({
			data: sampleQuota,
			isLoading: false,
			isError: false,
		});
		renderPopover();
		fireEvent.click(screen.getByText("Click me"));
		await waitFor(() => {
			expect(screen.getByText("Alice Wonderland")).toBeTruthy();
			expect(screen.getByText("15 requests")).toBeTruthy();
		});
	});

	it("shows avatar when not in incognito mode", async () => {
		mockUseSeerrUserQuota.mockReturnValue({
			data: sampleQuota,
			isLoading: false,
			isError: false,
		});
		renderPopover();
		fireEvent.click(screen.getByText("Click me"));
		await waitFor(() => {
			const avatar = document.querySelector('img[src="https://example.com/avatar.jpg"]');
			expect(avatar).toBeTruthy();
		});
	});

	it("hides avatar when in incognito mode", async () => {
		mockUseSeerrUserQuota.mockReturnValue({
			data: sampleQuota,
			isLoading: false,
			isError: false,
		});
		renderPopover({ isIncognito: true });
		fireEvent.click(screen.getByText("Click me"));
		await waitFor(() => {
			const avatar = document.querySelector('img[src="https://example.com/avatar.jpg"]');
			expect(avatar).toBeFalsy();
		});
	});

	it("displays movie and TV quota bars when restricted", async () => {
		mockUseSeerrUserQuota.mockReturnValue({
			data: sampleQuota,
			isLoading: false,
			isError: false,
		});
		renderPopover();
		fireEvent.click(screen.getByText("Click me"));
		await waitFor(() => {
			expect(screen.getByText("Movie Quota")).toBeTruthy();
			expect(screen.getByText("TV Quota")).toBeTruthy();
			expect(screen.getByText("3/10")).toBeTruthy();
			expect(screen.getByText("1/5")).toBeTruthy();
		});
	});

	it("shows 'No quota restrictions' when quotas are unrestricted", async () => {
		mockUseSeerrUserQuota.mockReturnValue({
			data: unrestrictedQuota,
			isLoading: false,
			isError: false,
		});
		renderPopover();
		fireEvent.click(screen.getByText("Click me"));
		await waitFor(() => {
			expect(screen.getByText("No quota restrictions")).toBeTruthy();
		});
	});

	it("shows error message when quota fetch fails", async () => {
		mockUseSeerrUserQuota.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
		});
		renderPopover();
		fireEvent.click(screen.getByText("Click me"));
		await waitFor(() => {
			expect(screen.getByText("Could not load quota")).toBeTruthy();
		});
	});

	it("shows loading spinner while quota is loading", async () => {
		mockUseSeerrUserQuota.mockReturnValue({
			data: undefined,
			isLoading: true,
			isError: false,
		});
		renderPopover();
		fireEvent.click(screen.getByText("Click me"));
		await waitFor(() => {
			const spinner = document.querySelector(".animate-spin");
			expect(spinner).toBeTruthy();
		});
	});

	it("renders 'View all requests' link with correct href", async () => {
		mockUseSeerrUserQuota.mockReturnValue({
			data: unrestrictedQuota,
			isLoading: false,
			isError: false,
		});
		renderPopover();
		fireEvent.click(screen.getByText("Click me"));
		await waitFor(() => {
			const link = screen.getByText("View all requests");
			expect(link.closest("a")?.getAttribute("href")).toBe("/requests?user=42");
		});
	});

	it("singular request count for 1 request", async () => {
		mockUseSeerrUserQuota.mockReturnValue({
			data: unrestrictedQuota,
			isLoading: false,
			isError: false,
		});
		renderPopover({ seerrUser: { ...sampleUser, requestCount: 1 } });
		fireEvent.click(screen.getByText("Click me"));
		await waitFor(() => {
			expect(screen.getByText("1 request")).toBeTruthy();
		});
	});
});
