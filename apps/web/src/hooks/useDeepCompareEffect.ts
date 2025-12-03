"use client";

import { dequal } from "dequal";
import { useEffect, useRef, type DependencyList, type EffectCallback } from "react";

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
 */
export function useDeepCompareEffect(
	effect: EffectCallback,
	deps: DependencyList
): void {
	const prevDepsRef = useRef<DependencyList | undefined>(undefined);

	if (!dequal(prevDepsRef.current, deps)) {
		prevDepsRef.current = deps;
	}

	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(effect, [prevDepsRef.current]);
}
