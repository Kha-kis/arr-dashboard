import { Suspense } from "react";
import { PageLayout } from "../../src/components/layout";
import { PremiumPageLoading } from "../../src/components/layout/premium-components";
import { LibraryClient } from "../../src/features/library/components/library-client";

const LibraryPage = () => (
	<PageLayout gap="6">
		<Suspense fallback={<PremiumPageLoading />}>
			<LibraryClient />
		</Suspense>
	</PageLayout>
);

export default LibraryPage;
