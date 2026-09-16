import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHistoryState } from "./use-history-state";

describe("useHistoryState canonical date boundary", () => {
	it("accepts literal all and canonicalizes bounded event types without truncation", () => {
		const { result } = renderHook(() => useHistoryState());
		act(() => result.current.actions.setStatusFilter(" all "));
		expect(result.current.state.statusFilter).toBe("all");
		act(() => result.current.actions.setStatusFilter("x".repeat(101)));
		expect(result.current.state.statusFilter).toBe("x".repeat(101));
		const oneHundredTwentyEight = "x".repeat(128);
		act(() => result.current.actions.setStatusFilter(oneHundredTwentyEight));
		expect(result.current.state.statusFilter).toBe(oneHundredTwentyEight);
		act(() => result.current.actions.setStatusFilter(`${oneHundredTwentyEight}y`));
		expect(result.current.state.statusFilter).toBe(oneHundredTwentyEight);
		expect(result.current.state.eventTypeValidationError).toBeTruthy();
		act(() => result.current.actions.setStatusFilter("alliance"));
		expect(result.current.state.statusFilter).toBe("alliance");
		expect(result.current.state.eventTypeValidationError).toBeNull();
	});

	it("rejects controls and URL-like event types while retaining the last valid filter", () => {
		const { result } = renderHook(() => useHistoryState());
		act(() => result.current.actions.setStatusFilter(" Grabbed "));
		act(() => result.current.actions.setStatusFilter("grab\nbed"));
		expect(result.current.state.statusFilter).toBe("grabbed");
		expect(result.current.state.eventTypeValidationError).toBeTruthy();
		act(() => result.current.actions.setStatusFilter("https://private.example"));
		expect(result.current.state.statusFilter).toBe("grabbed");
		expect(result.current.state.eventTypeValidationError).toBeTruthy();
		for (const invalidEventType of [
			"safe data:text/plain,private",
			"safe mailto:private",
			"safe magnet:?xt=urn:private",
		]) {
			act(() => result.current.actions.setStatusFilter(invalidEventType));
			expect(result.current.state.statusFilter).toBe("grabbed");
			expect(result.current.state.eventTypeValidationError).toBeTruthy();
		}
		act(() => result.current.actions.setStatusFilter(""));
		expect(result.current.state.statusFilter).toBe("");
		expect(result.current.state.eventTypeValidationError).toBeNull();
	});

	it("rejects a start edited after the accepted end, then accepts clear/correction", () => {
		const { result } = renderHook(() => useHistoryState());
		act(() => result.current.actions.setStartDate("2026-09-01"));
		act(() => result.current.actions.setEndDate("2026-09-03"));
		const accepted = {
			startDate: result.current.state.startDate,
			endDate: result.current.state.endDate,
		};
		act(() => result.current.actions.setStartDate("2026-09-04"));
		expect(result.current.state).toMatchObject({
			...accepted,
			dateValidationError: expect.any(String),
		});
		act(() => result.current.actions.setStartDate(""));
		expect(result.current.state).toMatchObject({ startDate: "", dateValidationError: null });
	});

	it("rejects an end edited before the accepted start, then accepts a valid edit", () => {
		const { result } = renderHook(() => useHistoryState());
		act(() => result.current.actions.setStartDate("2026-09-04"));
		act(() => result.current.actions.setEndDate("2026-09-05"));
		const acceptedEnd = result.current.state.endDate;
		act(() => result.current.actions.setEndDate("2026-09-03"));
		expect(result.current.state).toMatchObject({
			endDate: acceptedEnd,
			dateValidationError: expect.any(String),
		});
		act(() => result.current.actions.setEndDate("2026-09-06"));
		expect(result.current.state.dateValidationError).toBeNull();
	});

	it("rejects rollover input and resets presets to canonical null end", () => {
		const { result } = renderHook(() => useHistoryState());
		act(() => result.current.actions.setStartDate("2026-02-30"));
		expect(result.current.state.startDate).not.toContain("2026-02-30");
		expect(result.current.state.dateValidationError).toBeTruthy();
		act(() => result.current.actions.setTimeRangePreset("all"));
		expect(result.current.state).toMatchObject({
			startDate: "",
			endDate: "",
			timeRangePreset: "all",
		});
	});
});
