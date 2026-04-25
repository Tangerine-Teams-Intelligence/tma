import { Navigate } from "react-router-dom";
import { useStore, isMeetingConfigured } from "@/lib/store";
import MeetingsListPage from "@/pages/meetings";

/**
 * Meeting tool entry. If the user has finished setup, show the meetings list
 * (the "Open" view). If not, redirect them into the inline setup view.
 */
export default function MeetingRoute() {
  const meetingConfig = useStore((s) => s.skills.meetingConfig);
  const ready = isMeetingConfigured(meetingConfig);

  if (!ready) {
    return <Navigate to="/meeting/setup" replace />;
  }

  return <MeetingsListPage />;
}
