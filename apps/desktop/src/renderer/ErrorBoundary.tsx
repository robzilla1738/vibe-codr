/**
 * Top-level React error boundary — catches uncaught render errors so a single
 * component failure doesn't blank the entire window. Shows a recovery card
 * with a Reload button (re-mounts the app from scratch, re-reading window.vibe
 * state). Industry-standard production resilience for Electron renderers.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[renderer] uncaught error:", error, info.componentStack);
  }

  /** Soft remount: clear error state first so React re-renders children. */
  handleSoftReset = (): void => {
    this.setState({ error: null });
  };

  handleReload = (): void => {
    this.setState({ error: null });
    // Full re-mount — last resort when soft reset is not enough.
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="app-shell">
          <div className="workspace">
            <div className="content-inset">
              <main className="gate" id="main-content" aria-labelledby="error-title">
                <div className="gate-inner">
                  <div className="gate-copy">
                    <h1 id="error-title">Something went wrong</h1>
                    <p>An unexpected error occurred in the UI. Try recovering without a full reload first.</p>
                  </div>
                  <pre className="gate-error" role="alert" tabIndex={-1}>
                    {this.state.error.message}
                    {this.state.error.stack ? `\n\n${this.state.error.stack}` : ""}
                  </pre>
                  <div className="gate-actions">
                    <button
                      type="button"
                      className="button primary"
                      onClick={this.handleSoftReset}
                      // biome-ignore lint/a11y/noAutofocus: single autofocus owner on the error recovery screen
                      autoFocus
                    >
                      Try again
                    </button>
                    <button type="button" className="button" onClick={this.handleReload}>
                      Reload window
                    </button>
                  </div>
                </div>
              </main>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
