import { useLayoutEffect, type RefObject } from 'react'

/*
 * Where text is streaming. A layer that is receiving a reply marks itself (`useStreamingLayer`): no move of moves.ts
 * runs on it or inside it, and while one is in view the loops of the page (the running edge, the live dot, the
 * background layer) pause, so the frames in which words arrive are spent on the words. The root carries
 * `data-streaming-view` meanwhile, which the loops' stylesheets read.
 */

/** The attribute of a layer on which text is streaming. */
const LAYER = 'data-streaming'

const inView = new Set<Element>()
const listeners = new Set<(streaming: boolean) => void>()
let observer: IntersectionObserver | undefined

function publish(): void {
  const streaming = inView.size > 0
  const root = document.documentElement
  if (root.hasAttribute('data-streaming-view') === streaming) return
  root.toggleAttribute('data-streaming-view', streaming)
  for (const listener of listeners) listener(streaming)
}

/** Whether `element` is, or is inside, a layer on which text is streaming: nothing may animate there. */
export const onStreamingLayer = (element: Element): boolean => element.closest(`[${LAYER}]`) !== null

/** Whether a streaming reply is in view right now. */
export const streamingInView = (): boolean => inView.size > 0

/** Calls `listener` when a streaming reply comes into view or the last one leaves or ends; returns the unsubscribe. */
export function watchStreaming(listener: (streaming: boolean) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Marks `element` as a layer on which text is streaming until the returned function is called. Whether it is in view
 * comes from an IntersectionObserver, so marking a layer never reads layout.
 */
export function markStreaming(element: Element): () => void {
  element.setAttribute(LAYER, '')
  if (typeof IntersectionObserver === 'function') {
    observer ??= new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.target.hasAttribute(LAYER)) inView.add(entry.target)
        else inView.delete(entry.target)
      }
      publish()
    })
    observer.observe(element)
  } else {
    inView.add(element)
    publish()
  }
  return () => {
    element.removeAttribute(LAYER)
    observer?.unobserve(element)
    inView.delete(element)
    publish()
  }
}

/** Marks the element of `ref` as a streaming layer while `streaming` is true. */
export function useStreamingLayer(ref: RefObject<Element | null>, streaming: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current
    if (!streaming || !element) return undefined
    return markStreaming(element)
  }, [ref, streaming])
}
