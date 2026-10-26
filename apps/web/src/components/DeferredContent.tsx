import { lazy, Suspense, useState, type FunctionComponent } from 'react'
import { Button, InlineNotice, Loading } from '@latch/ui'
import { ErrorBoundary } from './ErrorBoundary.tsx'

/** Keep the already-open shell and its focus; only an optional body waits or fails. */
export function deferredComponent<P extends object>(
  load: () => Promise<{ default: FunctionComponent<P> }>,
  label: string,
): FunctionComponent<P> {
  return function DeferredContent(props: P) {
    const [Content, replace] = useState(() => lazy(load))
    return (
      <ErrorBoundary
        resetKey={Content}
        fallback={
          <InlineNotice
            tone="error"
            action={
              <Button size="xs" onClick={() => replace(() => lazy(load))}>
                重试加载
              </Button>
            }>
            无法加载{label}，当前会话和草稿仍保留。
          </InlineNotice>
        }>
        <Suspense fallback={<Loading label={`正在加载${label}…`} />}>
          <Content {...props} />
        </Suspense>
      </ErrorBoundary>
    )
  }
}
