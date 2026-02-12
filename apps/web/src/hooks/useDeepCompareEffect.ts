"use client";

import { dequal } from "dequal";
import { useEffect, useRef, useState, type DependencyList, type EffectCallback } from "react";

/**
 * A custom hook that works like useEffect but uses deep comparison
 * for the dependency array instead of reference equality.
 *
 * Use this when your dependencies are objects or arrays that may be
 * recreated on each render but have the same values.
 *
 * Uses dequal for fast, accurate deep equality including:
 * - Primitives, arrays, plain objects
 * - Date, RegExp, Map, Set (with deep element comparison)
 * - Circular reference handling
 *
 * Implementation note: To avoid mutating refs during render (which violates React
 * rules and can cause issues with concurrent features), we:
 * 1. Use state to track a "signal" value that triggers effect re-runs
 * 2. Compute whether deps changed during render (read-only comparison against state)
 * 3. Update state and refs only inside useEffect (commit phase)
 *
 * This ensures all mutations happen in the commit phase, making the hook
 * compatible with React's concurrent rendering features.
 */
export function useDeepCompareEffect(
	effect: EffectCallback,
	deps: DependencyList
): void {
	// State to hold the last committed deps - triggers re-render when updated
	const [committedDeps, setCommittedDeps] = useState<DependencyList | undefined>(undefined);

	// Refs to hold values for access inside useEffect without causing re-renders
	const effectRef = useRef(effect);
	const depsRef = useRef(deps);

	// Compute during render: has deps changed from committed deps?
	// Reading state/refs is allowed during render - no mutations here
	const hasChanged = committedDeps === undefined || !dequal(committedDeps, deps);

	// Sync effect runs every render to capture the latest effect and deps
	// These refs let us access current values in the main effect without
	// needing them in the dependency array
	useEffect(() => {
		effectRef.current = effect;
		depsRef.current = deps;
	});

	// Main effect runs when hasChanged boolean changes
	useEffect(() => {
		if (hasChanged) {
			// Update committed deps state (safe - commit phase)
			// This will trigger a re-render, but hasChanged will be false
			// on that render since committedDeps will equal deps
			setCommittedDeps(depsRef.current);
			return effectRef.current();
		}
		 
	}, [hasChanged]);
}
