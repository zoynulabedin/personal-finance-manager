import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import { logout } from "../lib/auth.server";

export async function action({ request }: Route.ActionArgs) {
  return logout(request);
}

/**
 * Logout must not happen on GET. The previous loader let any third-party page
 * sign the user out with `<img src="/your-app/logout">`, and made the route
 * vulnerable to link prefetchers. Signing out goes through the POST form in
 * the sidebar.
 */
export async function loader() {
  return redirect("/");
}
