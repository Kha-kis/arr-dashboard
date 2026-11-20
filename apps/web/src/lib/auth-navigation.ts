/** Leave authenticated client-router state behind after acknowledged logout. */
export function navigateToSignedOutPage(): void {
	window.location.replace("/login");
}
