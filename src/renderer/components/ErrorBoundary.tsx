import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors in the component tree and shows a recovery UI instead of a blank screen.
 * Unlike the bootstrap-level `fatalError` state in App, this handles errors that occur after the initial render.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[omnibrowser] Error no capturado en el árbol de React:', error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="fatal-state">
          <strong>OmniBrowser encontró un error inesperado</strong>
          <span>{this.state.error.message}</span>
          <button onClick={() => window.location.reload()} type="button" style={{ marginTop: 16, padding: '8px 16px', cursor: 'pointer' }}>
            Recargar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
