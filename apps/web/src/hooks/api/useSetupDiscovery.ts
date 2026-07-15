"use client";

import type { SetupDiscoveryResponse } from "@arr/shared";
import { useQuery } from "@tanstack/react-query";
import { discoverSetupCandidates } from "../../lib/api-client/setup";
import { setupKeys } from "../../lib/query-keys";

export const useSetupDiscovery = () =>
	useQuery<SetupDiscoveryResponse, Error>({
		queryKey: setupKeys.discovery,
		queryFn: discoverSetupCandidates,
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
		retry: false,
	});
