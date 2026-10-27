"use client";

import React from 'react';
import { trackError } from '@/lib/telemetry';

export interface ErrorBoundaryFallbackProps {
  error: Error;
  resetErrorBoundary: () => void;
}

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode | ((props: ErrorBoundaryFallbackProps) => React.ReactNode);
  /** Logical widget/section identifier included in telemetry metadata */
  name?: string;
  /** Contextual heading displayed when a widget crashes */
  fallbackTitle?: string;
  /** Optional custom description displayed below the heading */
  fallbackMessage?: string;
  /** Renders a compact inline recovery bar (e.g. for header/banner widgets) */
  compact?: boolean;
  /** Invoked when the user clicks "Try again" or resetKeys change */
  onReset?: () => void;
  /** Additional callback invoked when an error is caught */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  /** Values that automatically reset the boundary when any item changes */
  resetKeys?: ReadonlyArray<unknown>;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

function areResetKeysChanged(
  prevKeys?: ReadonlyArray<unknown>,
  nextKeys?: ReadonlyArray<unknown>
): boolean {
  if (prevKeys === nextKeys) return false;
  if (!prevKeys || !nextKeys) return true;
  if (prevKeys.length !== nextKeys.length) return true;
  for (let i = 0; i < prevKeys.length; i++) {
    if (!Object.is(prevKeys[i], nextKeys[i])) return true;
  }
  return false;
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
    const metadata = this.props.name ? { boundary: this.props.name } : undefined;
    trackError(error, info.componentStack ?? undefined, metadata);
    this.props.onError?.(error, info);
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (
      this.state.hasError &&
      this.props.resetKeys &&
      areResetKeysChanged(prevProps.resetKeys, this.props.resetKeys)
    ) {
      this.resetErrorBoundary();
    }
  }

  public resetErrorBoundary = (): void => {
    this.props.onReset?.();
    this.setState({ hasError: false, error: null });
  };

  render(): React.ReactNode {
    const { hasError, error } = this.state;
    const {
      children,
      fallback,
      name,
      fallbackTitle,
      fallbackMessage,
      compact = false,
    } = this.props;

    if (!hasError) {
      return children;
    }

    if (typeof fallback === 'function' && error) {
      return fallback({ error, resetErrorBoundary: this.resetErrorBoundary });
    }

    if (fallback !== undefined && typeof fallback !== 'function') {
      return fallback;
    }

    const headingText = fallbackTitle || 'Something went wrong';
    const detailText =
      fallbackMessage || (error ? error.message.substring(0, 200) : 'An unexpected rendering error occurred.');

    if (compact) {
      return (
        <div
          role="alert"
          data-testid={name ? `error-boundary-${name}` : 'error-boundary-fallback'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.625rem',
            padding: '0.375rem 0.75rem',
            borderRadius: '0.5rem',
            border: '1px solid rgba(239,68,68,0.4)',
            background: 'rgb(15 23 42)',
            color: 'rgb(248 113 113)',
            fontSize: '0.75rem',
            fontFamily: 'inherit',
          }}
        >
          <span aria-hidden="true">⚠</span>
          <span>{headingText}</span>
          <button
            type="button"
            onClick={this.resetErrorBoundary}
            style={{
              padding: '0.125rem 0.5rem',
              borderRadius: '0.375rem',
              border: '1px solid rgba(239,68,68,0.5)',
              background: 'transparent',
              color: 'rgb(248 113 113)',
              fontSize: '0.75rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      );
    }

    return (
      <div
        role="alert"
        data-testid={name ? `error-boundary-${name}` : 'error-boundary-fallback'}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '200px',
          padding: '2rem',
          margin: '1rem 0',
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
          {headingText}
        </h2>

        {/* Truncated error message */}
        {detailText && (
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
            {detailText}
          </p>
        )}

        {/* Reset button */}
        <button
          type="button"
          onClick={this.resetErrorBoundary}
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
