import { AGENT_PRESETS, type AgentPreset } from '@latch/protocol'
import { currentLocale } from './i18n.ts'

const ENGLISH: Readonly<
  Record<string, { description: string; license?: string; installNote?: string; adapterDescription?: string; direct?: string }>
> = {
  codex: {
    description: 'Connects directly to Codex. Codex manages its models, login, and sandbox.',
    installNote: 'Version 0.156.0 or later',
    adapterDescription: 'Uses the Codex bundled with codex-acp. Codex manages its models, login, and sandbox.',
    direct: 'Direct connections require Codex 0.156.0 or later: npm i -g @openai/codex',
  },
  'claude-agent': {
    description: 'Uses your existing Claude Code login. Latch doesn’t read your credentials.',
    license: 'Apache-2.0 adapter. Claude Code is proprietary.',
    installNote: 'Sign in to Claude Code as well',
  },
  pi: {
    description: 'pi manages models and login. The Latch extension configures permissions.',
    installNote: 'Native models need 0.84.4 or later. Model services through Latch need 1.5.0 or later.',
  },
  opencode: {
    description: 'Connects directly to OpenCode. OpenCode manages models and login.',
    installNote: 'Direct connections need 2.2.6 or later. Earlier versions run through opencode acp.',
    adapterDescription: 'Runs through opencode acp. OpenCode manages models and login.',
    direct: 'Direct connections require OpenCode 2.2.6 or later: npm i -g @opencode/cli@latest',
  },
  dsh: {
    description: 'Replies arrive as complete messages.',
    installNote: 'Version 0.2.2-rc.1 or later',
  },
  qwen: { description: 'Qwen Code manages login and models.' },
  goose: { description: 'Configure models in goose.' },
  cursor: {
    description: 'Runs the official Cursor CLI with your account. Cursor manages models and login.',
    license: 'Proprietary (Cursor Terms of Service)',
  },
  antigravity: {
    description: 'Uses the models and login of the Antigravity CLI on this computer.',
    license: 'Proprietary (Google Antigravity terms)',
    installNote: 'Antigravity CLI 1.5.8 or later required',
  },
  grok: {
    description: 'Uses the models and login of Grok Build on this computer.',
    license: 'Grok Build release terms. Open-source code is Apache-2.0.',
    installNote: 'Version 1.0.77 or later',
  },
}

/** These are Latch’s preset descriptions. A Host may return the adapter as its effective route. */
export function harnessPresetCopy(preset: AgentPreset) {
  const words = currentLocale() === 'en' && Object.hasOwn(ENGLISH, preset.id) ? ENGLISH[preset.id] : undefined
  const official = words ? AGENT_PRESETS.find(item => item.id === preset.id) : undefined
  const text = <T extends string | undefined>(value: T, known: string | undefined, translation: string | undefined): string | T =>
    value === known ? (translation ?? value) : value
  const description =
    preset.description === official?.fallback?.description
      ? (words?.adapterDescription ?? preset.description)
      : text(preset.description, official?.description, words?.description)
  return {
    description,
    license: text(preset.license, official?.license, words?.license),
    installNote: text(preset.installNote, official?.installNote, words?.installNote),
    adapterDescription: text(preset.fallback?.description, official?.fallback?.description, words?.adapterDescription),
    direct: text(preset.fallback?.direct, official?.fallback?.direct, words?.direct),
  }
}
