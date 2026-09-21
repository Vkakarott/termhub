import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The smallest boundary that keeps one failing route from taking the whole app down with it — React
 * unmounts the entire tree for an error nothing catches, which reads as a white screen. Used around
 * the lazy `/office` route, whose chunk can be gone after a deploy.
 */
export class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('route failed', error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
