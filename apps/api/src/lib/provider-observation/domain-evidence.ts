import type { ProviderCoverageReceipt, ProviderObservationDomain } from "@arr/shared";
import {
	evaluateProviderDomainCoverageMap,
	type ProviderCoverageDomainEvaluation,
} from "./coverage-receipt.js";

export interface EvaluatedProviderDomainCoverage extends ProviderCoverageDomainEvaluation {}

/**
 * Validate each V2 domain independently. V1 receipts intentionally expose no
 * domain capabilities, preserving the legacy aggregate contract.
 */
export function evaluateProviderDomainCoverage(
	receipt: ProviderCoverageReceipt,
): ReadonlyMap<ProviderObservationDomain, EvaluatedProviderDomainCoverage> {
	return evaluateProviderDomainCoverageMap(receipt);
}
