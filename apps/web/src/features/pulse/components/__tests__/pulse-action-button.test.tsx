/**
 * Unit tests for <PulseActionButton />.
 *
 * The button itself is a thin adapter over `usePulseActionMutation` — we
 * mock the hook and verify three things:
 *   1. The declared label renders.
 *   2. A click calls `mutate` with the correct `{ signalId, action }`.
 *   3. `isPending` disables the button and swaps in a spinner.
 *
 * React Query wiring, toast dispatch, and query invalidation belong to
 * the hook and are out of scope for this test — covering them here would
 * just duplicate the hook's own test surface.
 */

import type { PulseAction } from "@arr/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutate = vi.fn();
const mockUseMutation = vi.fn(() => ({ mutate, isPending: false }));

vi.mock("../../../../hooks/api/usePulse", () => ({
	usePulseActionMutation: () => mockUseMutation(),
}));

import { PulseActionButton } from "../pulse-action-button";

const ACTION: PulseAction = {
	kind: "scheduler.enable",
	target: { jobId: "hunting" },
	label: "Enable",
	confirmLabel: "Click again to enable",
	destructive: false,
};

beforeEach(() => {
	mutate.mockReset();
	mockUseMutation.mockReset();
	mockUseMutation.mockReturnValue({ mutate, isPending: false });
});

describe("<PulseActionButton />", () => {
	it("renders the action label as the button text", () => {
		render(<PulseActionButton signalId="sig-1" action={ACTION} />);
		expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
	});

	it("invokes the mutation with { signalId, action } on click", () => {
		render(<PulseActionButton signalId="sig-42" action={ACTION} />);

		fireEvent.click(screen.getByRole("button", { name: "Enable" }));

		expect(mutate).toHaveBeenCalledTimes(1);
		expect(mutate).toHaveBeenCalledWith({ signalId: "sig-42", action: ACTION });
	});

	it("is disabled and exposes aria-busy while pending", () => {
		mockUseMutation.mockReturnValue({ mutate, isPending: true });
		render(<PulseActionButton signalId="sig-1" action={ACTION} />);

		const button = screen.getByRole("button", { name: /Enable/ });
		expect(button).toBeDisabled();
		expect(button).toHaveAttribute("aria-busy", "true");
	});
});
