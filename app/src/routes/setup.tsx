import { Navigate } from "react-router-dom";

/**
 * Legacy 5-step setup wizard route. The super-app shell replaces it with
 * /auth → /dashboard → /skills → /skills/meeting. This route is kept only
 * to redirect any stale links / docs back to the new flow.
 */
export default function SetupRoute() {
  return <Navigate to="/dashboard" replace />;
}
