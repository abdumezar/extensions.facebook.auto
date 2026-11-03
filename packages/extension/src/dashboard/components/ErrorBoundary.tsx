import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card } from "../ui/index.js";

interface Props {
  children: ReactNode;
  /** Changing this resets the boundary — used to clear the error on view change. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors in one region so a single bad page cannot blank the whole
 * dashboard. The fallback is recoverable: the user can retry, and switching views
 * resets it automatically via `resetKey`.
 *
 * Class component because React exposes no hook equivalent for error catching.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // The dashboard has no telemetry sink; the console is what a developer with
    // the tab open will actually see.
    console.error("Dashboard render error:", error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <ErrorFallback error={this.state.error} onRetry={() => this.setState({ error: null })} />
    );
  }
}

function ErrorFallback({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Card variant="outlined" role="alert" className="space-y-3">
      <h2 className="text-title-medium text-error">{t("error.title")}</h2>
      <p className="text-body-medium text-on-surface-variant">{t("error.desc")}</p>
      <pre
        dir="ltr"
        className="max-h-32 overflow-auto rounded-sm bg-surface-container-highest p-3 font-mono text-body-small text-on-surface-variant"
      >
        {error.message}
      </pre>
      <Button icon="refresh" onClick={onRetry}>
        {t("error.retry")}
      </Button>
    </Card>
  );
}
