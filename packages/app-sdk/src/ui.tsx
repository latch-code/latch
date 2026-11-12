import { createElement, type ChangeEvent, type ComponentType, type ReactNode } from 'react'

type Tone = 'neutral' | 'warn' | 'err' | 'ok'

/**
 * The primitives a page draws with: the shell's own components with a narrower surface. There is no `secure` variant,
 * no dialog, sheet, drawer, menu or toast: a page draws only inside its frame, and every security surface (approvals,
 * confirmations, enrollment, toasts) is the shell's, outside it.
 */
export interface AppUi {
  Button: ComponentType<{
    children: ReactNode
    variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
    size?: 'xs' | 'sm' | 'md'
    disabled?: boolean
    loading?: boolean
    type?: 'button' | 'submit'
    onClick?: () => void
  }>
  TextField: ComponentType<{
    label: ReactNode
    value: string
    onChange: (value: string) => void
    placeholder?: string
    hint?: ReactNode
    error?: ReactNode
    disabled?: boolean
    maxLength?: number
  }>
  TextArea: ComponentType<{
    label: ReactNode
    value: string
    onChange: (value: string) => void
    placeholder?: string
    hint?: ReactNode
    error?: ReactNode
    disabled?: boolean
    rows?: number
    maxLength?: number
  }>
  Checkbox: ComponentType<{
    label: ReactNode
    checked: boolean
    onChange: (checked: boolean) => void
    description?: ReactNode
    disabled?: boolean
  }>
  Switch: ComponentType<{ label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }>
  Segmented: ComponentType<{
    label: string
    value: string
    options: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>
    onChange: (value: string) => void
    disabled?: boolean
  }>
  Group: ComponentType<{ title?: ReactNode; description?: ReactNode; action?: ReactNode; children?: ReactNode }>
  Row: ComponentType<{ title: ReactNode; description?: ReactNode; children?: ReactNode }>
  Status: ComponentType<{ tone?: Tone; children: ReactNode }>
  Badge: ComponentType<{ tone?: Tone; children: ReactNode }>
  Count: ComponentType<{ value: number }>
  Notice: ComponentType<{ tone?: 'neutral' | 'warn' | 'error'; title?: ReactNode; children?: ReactNode; action?: ReactNode }>
  Hint: ComponentType<{ label: ReactNode; children?: ReactNode }>
  Loading: ComponentType<{ label: ReactNode }>
  Empty: ComponentType<{ title: ReactNode; description?: ReactNode; action?: ReactNode }>
  Progress: ComponentType<{ active: boolean; label?: string }>
}

// The design system's components as the runtime hands them over; their own types stay with the shell.
// oxlint-disable-next-line typescript/no-explicit-any
type Primitive = ComponentType<any>
export type AppPrimitives = Record<
  | 'Button'
  | 'TextField'
  | 'TextAreaField'
  | 'Checkbox'
  | 'Switch'
  | 'SegmentedControl'
  | 'Group'
  | 'Row'
  | 'StatusPill'
  | 'Badge'
  | 'Count'
  | 'InlineNotice'
  | 'Hint'
  | 'Loading'
  | 'EmptyState'
  | 'ProgressBar',
  Primitive
>

const h = createElement
const text = (handler: (value: string) => void) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
  handler(event.target.value)
}

/**
 * Wraps the design system's primitives for a page: only the props listed in `AppUi` pass, each named explicitly, so a
 * page cannot reach `secure`, icons from the shell, shortcuts or anything else a primitive takes.
 */
export function createAppUi(ui: AppPrimitives): AppUi {
  const wrapped: AppUi = {
    Button: ({ children, variant = 'secondary', size = 'sm', disabled, loading, type = 'button', onClick }) =>
      h(ui.Button, { variant, size, disabled: disabled === true, loading: loading === true, type, onClick }, children),
    TextField: ({ label, value, onChange, placeholder, hint, error, disabled, maxLength }) =>
      h(ui.TextField, { label, value, onChange: text(onChange), placeholder, hint, error, disabled, maxLength }),
    TextArea: ({ label, value, onChange, placeholder, hint, error, disabled, rows, maxLength }) =>
      h(ui.TextAreaField, { label, value, onChange: text(onChange), placeholder, hint, error, disabled, rows, maxLength }),
    Checkbox: ({ label, checked, onChange, description, disabled }) =>
      h(ui.Checkbox, {
        label,
        checked,
        description,
        disabled,
        onChange: (event: ChangeEvent<HTMLInputElement>) => {
          onChange(event.target.checked)
        },
      }),
    Switch: ({ label, checked, onChange, disabled }) =>
      h(ui.Switch, { label, checked, onCheckedChange: onChange, disabled: disabled === true }),
    Segmented: ({ label, value, options, onChange, disabled }) =>
      h(ui.SegmentedControl, {
        label,
        value,
        options: options.map(option => ({ value: option.value, label: option.label, disabled: option.disabled === true })),
        onValueChange: onChange,
        disabled: disabled === true,
      }),
    Group: ({ title, description, action, children }) => h(ui.Group, { title, description, action }, children),
    Row: ({ title, description, children }) => h(ui.Row, { title, description }, children),
    Status: ({ tone = 'neutral', children }) => h(ui.StatusPill, { tone }, children),
    Badge: ({ tone = 'neutral', children }) => h(ui.Badge, { tone }, children),
    Count: ({ value }) => h(ui.Count, { value }),
    // Never the security variant, whatever a page passes.
    Notice: ({ tone = 'neutral', title, children, action }) => h(ui.InlineNotice, { tone, title, action, secure: false }, children),
    // With a detail the primitive draws its own ⓘ button; its default lead glyph is that same ⓘ, so a page's hint
    // takes no lead and shows one ⓘ, after the label.
    Hint: ({ label, children }) => h(ui.Hint, children === undefined || children === null ? { label } : { label, lead: false }, children),
    Loading: ({ label }) => h(ui.Loading, { label }),
    Empty: ({ title, description, action }) => h(ui.EmptyState, { title, description, action }),
    Progress: ({ active, label }) => h(ui.ProgressBar, label === undefined ? { active } : { active, label }),
  }
  return Object.freeze(wrapped)
}
