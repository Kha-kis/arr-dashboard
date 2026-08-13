"use client";

import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui";
import {
	useDismissTautulliProviderNotice,
	useTautulliProviderNotices,
} from "../../../hooks/api/useSystem";

const NOTICE_CONTENT = {
	"both-configured": {
		title: "Tautulli and Tracearr are both configured",
		description:
			"Use one historical analytics provider at a time to avoid mixing data. Review your services before making changes.",
	},
	"prior-removal": {
		title: "A prior Tautulli removal needs review",
		description:
			"Review your current services before making changes. Deleted configurations and credentials cannot be reconstructed.",
	},
} as const;

export function TautulliProviderNotice() {
	const { data } = useTautulliProviderNotices();
	const dismissMutation = useDismissTautulliProviderNotice();
	const notice = data?.notices[0];

	if (!notice) return null;

	const content = NOTICE_CONTENT[notice.kind];

	return (
		<Alert variant="warning" dismissible onDismiss={() => dismissMutation.mutate(notice.key)}>
			<AlertTitle>{content.title}</AlertTitle>
			<AlertDescription>
				<p>{content.description}</p>
				<Link
					href={notice.actionUrl}
					className="mt-2 inline-flex font-medium underline underline-offset-4"
				>
					Review services
				</Link>
			</AlertDescription>
		</Alert>
	);
}
