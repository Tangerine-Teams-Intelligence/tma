import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Skeleton — neutral placeholder for content that's loading.
 *
 * Spec ref: VISUAL_DESIGN_SPEC §3 (loading states), UX_FLOW_SPEC §6.
 *
 * Use one or more <Skeleton /> blocks where text/cards/rows would render
 * once data resolves. The component picks tones from the paper/ink token
 * scale so it works in both light and dark without per-call dark: classes.
 *
 * Animation respects `prefers-reduced-motion: reduce` (the global media
 * query in `index.css` neutralises the pulse for users who opt out).
 */

export type SkeletonProps = React.HTMLAttributes<HTMLDivElement> & {
  /** When true, render without the pulse animation (e.g., already-faded shells). */
  static?: boolean;
};

export const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, static: isStatic = false, ...props }, ref) => (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid="skeleton"
      className={cn(
        "rounded bg-[var(--ti-paper-200)]",
        !isStatic && "animate-pulse",
        className
      )}
      {...props}
    />
  )
);
Skeleton.displayName = "Skeleton";

/**
 * SkeletonText — a stack of text-shaped skeleton bars. Useful for "list
 * row of paragraph text loading" where you want a few rows of varying
 * width to look natural.
 */
export function SkeletonText({
  lines = 3,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { lines?: number }) {
  return (
    <div
      className={cn("flex flex-col gap-2", className)}
      aria-hidden="true"
      {...props}
    >
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn(
            "h-3",
            i === lines - 1 ? "w-2/3" : i % 2 === 0 ? "w-full" : "w-5/6"
          )}
        />
      ))}
    </div>
  );
}

/**
 * SkeletonCard — card-shaped placeholder (used in WorkflowGraph,
 * SocialGraph, marketplace lists, etc.). Renders a header bar + 3 text
 * lines so the visual mass roughly matches the resolved card.
 */
export function SkeletonCard({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-lg border border-[var(--ti-border-default)] bg-[var(--ti-bg-elevated)] p-4",
        className
      )}
      aria-hidden="true"
      {...props}
    >
      <Skeleton className="mb-3 h-4 w-1/3" />
      <SkeletonText lines={3} />
    </div>
  );
}

export default Skeleton;
