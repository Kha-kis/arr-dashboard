"use client";

import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui";
import {
	useDismissTautulliProviderNotice,
	useTautulliProviderNotices,
} from "../../../hooks/api/useSystem";

const noticeContent = (selected: "tracearr" | "tautulli") => ({
	"both-configured": {
		title: `${selected === "tracearr" ? "Tracearr" : "Tautulli"} is selected for historical analytics`,
		description:
			"Tautulli is also configured. Historical analytics stays with the selected provider until you explicitly switch it.",
	},
	"prior-removal": {
		title: `${selected === "tracearr" ? "Tracearr" : "Tautulli"} is selected for historical analytics`,
		description:
			"Review the provider selector before making changes. It does not restore a removed Tautulli connection or historical data.",
	},
});

export function TautulliProviderNotice() {
	const { data } = useTautulliProviderNotices();
	const dismissMutation = useDismissTautulliProviderNotice();
	const notice = data?.notices[0];

	if (!notice) return null;

	const content = noticeContent(notice.selected)[notice.kind];

	return (
		<Alert variant="warning" dismissible onDismiss={() => dismissMutation.mutate(notice.key)}>
			<AlertTitle>{content.title}</AlertTitle>
			<AlertDescription>
				<p>{content.description}</p>
				<Link
					href={notice.actionUrl}
					className="mt-2 inline-flex font-medium underline underline-offset-4"
				>
					Review analytics provider
				</Link>
			</AlertDescription>
		</Alert>
	);
}
