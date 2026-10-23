import { Component, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  /** A new value (the next streamed text, another session) renders the children again. */
  resetKey?: unknown
  fallback: ReactNode | ((reset: () => void) => ReactNode)
  children: ReactNode
}

interface ErrorBoundaryState { failed: boolean; resetKey: unknown }

/** Keeps a render error in one part of the page from unmounting the whole client. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { failed: false, resetKey: props.resetKey }
  }

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { failed: false, resetKey: props.resetKey }
  }

  reset = () => { this.setState({ failed: false }) }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    const { fallback } = this.props
    return typeof fallback === 'function' ? fallback(this.reset) : fallback
  }
}
