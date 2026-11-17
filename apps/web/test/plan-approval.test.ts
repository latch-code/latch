import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Approval } from '@latch/protocol'
import { ApprovalDrawer, PLAN_COPY } from '../src/composer/ApprovalDrawer.tsx'
import { approvalActions } from '../src/core/permissions.ts'

const noop = () => {}

describe('a plan the harness asks to go on with', () => {
  const plan: Approval = {
    id: 'ap1',
    sessionId: 's',
    toolName: 'Ready to code?',
    toolCallId: 'call_exit',
    reason: 'Ready to code?',
    arguments: JSON.stringify({ plan: '## Steps\n1. Read\n2. **Change** it' }),
    requestedAt: new Date().toISOString(),
    options: [
      { id: 'exit-plan-default', label: 'Yes, manually approve edits', kind: 'allow_once' },
      { id: 'reject', label: 'No, keep planning', kind: 'reject_once' },
    ],
    risk: 'R2',
    advisory: true,
    plan: '## Steps\n1. Read\n2. **Change** it\n\n<img src=x onerror=alert(1)>[link](https://example.invalid) ![pic](https://example.invalid/p.png) https://example.invalid/auto <https://example.invalid/angle>',
  }
  const drawn = (approval: Approval) =>
    renderToStaticMarkup(
      createElement(ApprovalDrawer, {
        approvals: [approval],
        messages: [],
        index: 0,
        onIndex: noop,
        gateFor: item => approvalActions(item, null),
        busy: new Map(),
        statuses: new Map(),
        onDecide: noop,
      }),
    )

  it('reads in full as a plan, answered with the harness’s own options under plain words', () => {
    const html = drawn(plan)
    expect(html).toContain('approval-plan')
    expect(html).toContain('<h2>Steps</h2>')
    expect(html).toContain('<strong>Change</strong>')
    expect(html).toContain(PLAN_COPY.go)
    expect(html).toContain(PLAN_COPY.keepPlanning)
    // The harness's words are kept in the hover; its markup and links are not drawn.
    expect(html).toContain('Yes, manually approve edits')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href=')
    expect(html).not.toContain('src=')
  })

  it('is any other ask when the harness presents no plan', () => {
    const { plan: _plan, ...ask } = plan
    const html = drawn(ask)
    expect(html).not.toContain('approval-plan')
    expect(html).not.toContain(PLAN_COPY.go)
  })
})

describe('what else a plan call carries', () => {
  it('is still shown beside the plan, and the plan itself is not shown twice', () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalDrawer, {
        approvals: [
          {
            id: 'ap2',
            sessionId: 's',
            toolName: 'Ready to code?',
            reason: 'Ready to code?',
            arguments: JSON.stringify({ plan: '1. Do it', planFilePath: '/tmp/plan.md' }),
            requestedAt: new Date().toISOString(),
            options: [
              { id: 'exit-plan-default', label: 'Yes, manually approve edits', kind: 'allow_once' },
              { id: 'reject', label: 'No, keep planning', kind: 'reject_once' },
            ],
            advisory: true,
            plan: '1. Do it',
          },
        ],
        messages: [],
        index: 0,
        onIndex: noop,
        gateFor: item => approvalActions(item, null),
        busy: new Map(),
        statuses: new Map(),
        onDecide: noop,
      }),
    )
    expect(html).toContain('planFilePath')
    expect(html.match(/Do it/gu)).toHaveLength(1)
  })
})
