import { lazy, Suspense, useEffect, useState, type FunctionComponent, type ReactNode } from 'react'
import { Button, InlineNotice, Loading } from '@latch/ui'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { PAGE_BUILD, readServedBuild } from '../core/build.ts'
import { defineCopy } from '../core/i18n.ts'

const COPY = defineCopy(
  {
    retry: '重试加载',
    reload: '重新载入',
    changed: (label: string) => `页面版本已更新，请重新载入后打开${label}。`,
    failed: (label: string) => `无法加载${label}，当前会话和草稿仍保留。`,
    loading: (label: string) => `正在加载${label}…`,
  },
  {
    retry: 'Retry',
    reload: 'Reload',
    changed: (label: string) => `The page version has changed. Reload to open ${label}.`,
    failed: (label: string) => `Could not load ${label}. Your session and draft are still here.`,
    loading: (label: string) => `Loading ${label}…`,
  },
)

class ModuleLoadError extends Error {}

function DeferredFailure({ label, importFailed, retry }: { label: string; importFailed: boolean; retry: () => void }) {
  const [served, setServed] = useState<string | null>(null)
  const pageChanged = importFailed && served !== null && served !== PAGE_BUILD
  useEffect(() => {
    if (!importFailed || !PAGE_BUILD) return undefined
    let current = true
    void readServedBuild().then(build => {
      if (current) setServed(build)
    })
    return () => {
      current = false
    }
  }, [importFailed])
  return (
    <InlineNotice
      tone={pageChanged ? 'warn' : 'error'}
      action={
        pageChanged ? (
          <Button size="xs" onClick={() => window.location.reload()}>
            {COPY.reload}
          </Button>
        ) : (
          <Button size="xs" onClick={retry}>
            {COPY.retry}
          </Button>
        )
      }>
      {pageChanged ? COPY.changed(label) : COPY.failed(label)}
    </InlineNotice>
  )
}

/** Keep the already-open shell and its focus; only an optional body waits or fails. */
export function deferredComponent<P extends object>(
  load: () => Promise<{ default: FunctionComponent<P> }>,
  label: string | (() => string),
  frame?: (props: P, body: ReactNode) => ReactNode,
): FunctionComponent<P> {
  async function loadModule() {
    try {
      return await load()
    } catch (cause) {
      // Only a failed import can be explained by an asset from a different build.
      throw new ModuleLoadError('Optional module could not be loaded', { cause })
    }
  }
  let InitialContent = lazy(loadModule)
  return function DeferredContent(props: P) {
    const [Content, replace] = useState(() => InitialContent)
    const title = typeof label === 'function' ? label() : label
    const wrap = (body: ReactNode) => (frame ? frame(props, body) : body)
    return (
      <ErrorBoundary
        resetKey={Content}
        fallback={(_reset, cause) =>
          wrap(
            <DeferredFailure
              label={title}
              importFailed={cause instanceof ModuleLoadError}
              retry={() => {
                InitialContent = lazy(loadModule)
                replace(() => InitialContent)
              }}
            />,
          )
        }>
        <Suspense fallback={wrap(<Loading label={COPY.loading(title)} />)}>
          <Content {...props} />
        </Suspense>
      </ErrorBoundary>
    )
  }
}
