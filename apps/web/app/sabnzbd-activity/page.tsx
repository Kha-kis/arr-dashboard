import { SabnzbdActivityClient } from "../../src/features/sabnzbd/components/sabnzbd-activity-client";

export const metadata = {
	title: "SABnzbd History · Arr Control Center",
};

export default function SabnzbdActivityPage() {
	return <SabnzbdActivityClient />;
}
