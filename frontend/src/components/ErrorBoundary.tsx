import React from 'react';
import { trackError } from '@/lib/telemetry';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    trackError(error, info.componentStack ?? undefined);
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): React.ReactNode {
    const { hasError, error } = this.state;
    const { children, fallback } = this.props;

    if (!hasError) {
      return children;
    }

    if (fallback) {
      return fallback;
    }

    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '200px',
          padding: '2rem',
          margin: '1rem',
          borderRadius: '0.75rem',
          border: '1px solid rgba(239,68,68,0.4)',
          background: 'rgb(15 23 42)',
          color: 'rgb(248 113 113)',
          fontFamily: 'inherit',
          gap: '1rem',
        }}
      >
        {/* Icon row */}
        <div style={{ fontSize: '2.5rem', lineHeight: 1 }} aria-hidden="true">
          ⚠
        </div>

        {/* Heading */}
        <h2
          style={{
            margin: 0,
            fontSize: '1.125rem',
            fontWeight: 600,
            color: 'rgb(248 113 113)',
            letterSpacing: '0.02em',
          }}
        >
          Something went wrong
        </h2>

        {/* Truncated error message */}
        {error && (
          <p
            style={{
              margin: 0,
              fontSize: '0.875rem',
              color: 'rgb(203 213 225)',
              maxWidth: '480px',
              textAlign: 'center',
              wordBreak: 'break-word',
              opacity: 0.8,
            }}
          >
            {error.message.substring(0, 200)}
          </p>
        )}

        {/* Reset button */}
        <button
          type="button"
          onClick={this.handleReset}
          style={{
            marginTop: '0.5rem',
            padding: '0.5rem 1.25rem',
            borderRadius: '0.5rem',
            border: '1px solid rgba(239,68,68,0.5)',
            background: 'transparent',
            color: 'rgb(248 113 113)',
            fontSize: '0.875rem',
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'background 0.15s ease, color 0.15s ease',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.12)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
