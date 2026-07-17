import { PageLayout } from "@arr/web/components/layout";
import { LibraryCleanupClient } from "../../src/features/library-cleanup/components/library-cleanup-client";

export default function LibraryCleanupPage() {
	return (
		<PageLayout maxWidth="7xl">
			<LibraryCleanupClient />
		</PageLayout>
	);
}
