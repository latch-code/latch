import { lazy, Suspense, useState, type FunctionComponent, type ReactNode } from 'react'
import { Button, InlineNotice, Loading } from '@latch/ui'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    retry: '重试加载',
    failed: (label: string) => `无法加载${label}，当前会话和草稿仍保留。`,
    loading: (label: string) => `正在加载${label}…`,
  },
  {
    retry: 'Retry',
    failed: (label: string) => `Could not load ${label}. Your session and draft are still here.`,
    loading: (label: string) => `Loading ${label}…`,
  },
)

/** Keep the already-open shell and its focus; only an optional body waits or fails. */
export function deferredComponent<P extends object>(
  load: () => Promise<{ default: FunctionComponent<P> }>,
  label: string | (() => string),
  frame?: (props: P, body: ReactNode) => ReactNode,
): FunctionComponent<P> {
  let InitialContent = lazy(load)
  return function DeferredContent(props: P) {
    const [Content, replace] = useState(() => InitialContent)
    const title = typeof label === 'function' ? label() : label
    const wrap = (body: ReactNode) => (frame ? frame(props, body) : body)
    return (
      <ErrorBoundary
        resetKey={Content}
        fallback={wrap(
          <InlineNotice
            tone="error"
            action={
              <Button
                size="xs"
                onClick={() => {
                  InitialContent = lazy(load)
                  replace(() => InitialContent)
                }}>
                {COPY.retry}
              </Button>
            }>
            {COPY.failed(title)}
          </InlineNotice>,
        )}>
        <Suspense fallback={wrap(<Loading label={COPY.loading(title)} />)}>
          <Content {...props} />
        </Suspense>
      </ErrorBoundary>
    )
  }
}
