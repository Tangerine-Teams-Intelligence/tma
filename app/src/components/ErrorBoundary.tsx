// === wave 10.1 hotfix ===
// Minimal class-component error boundary. v1.10.0 shipped with brand-new
// Wave-10 mounts (GitSyncIndicatorContainer, GitInitBannerContainer) that
// — if their Tauri call rejected or any descendent threw on first paint —
// crashed the entire React tree because the app had no boundary anywhere.
// In production Tauri the result is a fully blank webview ("black screen
// of death" on dark theme).
//
// This boundary is intentionally tiny: it catches the render error, logs
// to console with a caller-supplied prefix so engineers can grep dogfood
// logs, and renders nothing in place of the broken subtree. The rest of
// the app keeps painting.
//
// Use it ONLY as a defensive wrap around non-critical UI surfaces (the
// git-sync dot, the git-init banner). Never wrap the AppShell itself —
// the goal here is to fail-soft on cosmetic widgets while leaving the
// route-level error path untouched.

import React from "react";

interface Props {
  /** Caller-provided log prefix, e.g. "[wave10] GitSyncIndicator". */
  label: string;
  /** Optional fallback node. Defaults to `null` so the broken surface
   *  collapses to zero height instead of leaving a visible artifact. */
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(
      `[wave10] ${this.props.label} failed to render:`,
      error,
      info,
    );
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
