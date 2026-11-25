import { Component, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  /** A new value (the next streamed text, another session) renders the children again. */
  resetKey?: unknown
  fallback: ReactNode | ((reset: () => void, cause: unknown) => ReactNode)
  children: ReactNode
}

interface ErrorBoundaryState {
  failure: { cause: unknown } | null
  resetKey: unknown
}

/** Keeps a render error in one part of the page from unmounting the whole client. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { failure: null, resetKey: props.resetKey }
  }

  static getDerivedStateFromError(cause: unknown): Partial<ErrorBoundaryState> {
    return { failure: { cause } }
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { failure: null, resetKey: props.resetKey }
  }

  reset = () => {
    this.setState({ failure: null })
  }

  render(): ReactNode {
    if (!this.state.failure) return this.props.children
    const { fallback } = this.props
    return typeof fallback === 'function' ? fallback(this.reset, this.state.failure.cause) : fallback
  }
}
