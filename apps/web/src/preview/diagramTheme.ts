/**
 * Mermaid's theme variables, per theme, from the design tokens (packages/ui/src/tokens.css): nodes a step off the page
 * (the sunken surface in light, the card in dark) with a hairline in the strong line's colour, words in the ink, edges
 * in the muted ink, a group's box a step the other way. The diagram renders in an isolated frame that cannot read the page's tokens, and Mermaid takes
 * hex colours only, so the values are written here; a test holds them to the tokens.
 */
export const DIAGRAM_THEMES = {
  light: {
    background: '#ffffff',
    node: '#f3f3f6',
    stroke: '#dedee0',
    group: '#ffffff',
    ink: '#17171a',
    edge: '#56565f',
  },
  dark: {
    background: '#131316',
    node: '#212126',
    stroke: '#3a3a40',
    group: '#0b0b0d',
    ink: '#ececef',
    edge: '#a3a3ad',
  },
} as const

export type DiagramTheme = keyof typeof DIAGRAM_THEMES

/** The variables Mermaid's `base` theme reads, for one theme. */
export function mermaidThemeVariables(theme: DiagramTheme): Record<string, string | boolean> {
  const colours = DIAGRAM_THEMES[theme]
  return {
    darkMode: theme === 'dark',
    background: colours.background,
    fontFamily: 'system-ui,sans-serif',
    primaryColor: colours.node,
    primaryBorderColor: colours.stroke,
    primaryTextColor: colours.ink,
    secondaryColor: colours.node,
    secondaryBorderColor: colours.stroke,
    secondaryTextColor: colours.ink,
    tertiaryColor: colours.group,
    tertiaryBorderColor: colours.stroke,
    tertiaryTextColor: colours.ink,
    mainBkg: colours.node,
    nodeBorder: colours.stroke,
    nodeTextColor: colours.ink,
    textColor: colours.ink,
    titleColor: colours.ink,
    lineColor: colours.edge,
    clusterBkg: colours.group,
    clusterBorder: colours.stroke,
    edgeLabelBackground: colours.background,
    noteBkgColor: colours.group,
    noteBorderColor: colours.stroke,
    noteTextColor: colours.ink,
    actorBkg: colours.node,
    actorBorder: colours.stroke,
    actorTextColor: colours.ink,
    actorLineColor: colours.edge,
    signalColor: colours.edge,
    signalTextColor: colours.ink,
    labelBoxBkgColor: colours.node,
    labelBoxBorderColor: colours.stroke,
    labelTextColor: colours.ink,
  }
}
