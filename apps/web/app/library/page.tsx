import { PageLayout } from "../../src/components/layout";
import { LibraryClient } from "../../src/features/library/components/library-client";

const LibraryPage = () => (
	<PageLayout gap="6">
		<LibraryClient />
	</PageLayout>
);

export default LibraryPage;
