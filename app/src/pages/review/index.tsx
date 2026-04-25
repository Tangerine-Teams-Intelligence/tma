/**
 * RV-0 / AP-0 — when ?applied=1 is in the URL, show ApplyStatus instead of
 * the review form (the review just submitted).
 */
import { useSearchParams } from "react-router-dom";

import ReviewView from "../meetings/ReviewView";
import ApplyStatus from "../meetings/ApplyStatus";

export default function ReviewPage() {
  const [params] = useSearchParams();
  if (params.get("applied")) return <ApplyStatus />;
  return <ReviewView />;
}
