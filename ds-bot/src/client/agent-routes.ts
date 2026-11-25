import { INKS } from './inks.ts'
import { AGENT_LOGOS } from './agent-logos.ts'

const PREFIX = 'local-'
const CUSTOM_PREFIX = `${PREFIX}acp-`
const cliOf = route => (typeof route === 'string' && route.startsWith(PREFIX) ? route.slice(PREFIX.length) : undefined)

export const AGENT_BADGES = {
  'devin-cli': ['DV', 'violet'],
  'claude-code': ['CC', 'tangerine'],
  'codex-cli': ['CX', 'green'],
  'cursor-cli': ['CU', 'magenta'],
  'copilot-cli': ['GH', 'graphite'],
  'gemini-cli': ['GM', 'yellow'],
  'antigravity': ['AG', 'sky'],
  'opencode': ['OC', 'blue'],
  'cline': ['CL', 'cyan'],
  'kilo': ['KL', 'yellow'],
  'goose': ['GS', 'brown'],
  'grok-cli': ['GX', 'graphite'],
  'kimi-cli': ['KM', 'charcoal'],
  'qwen-code': ['QW', 'cobalt'],
  'codebuddy': ['CB', 'blue'],
  'qoder': ['QD', 'green'],
  'minimax-code': ['MM', 'rose'],
  'glm-cli': ['GL', 'cobalt'],
  'kiro-cli': ['KR', 'violet'],
  'factory-droid': ['DR', 'orange'],
  'auggie': ['AU', 'violet'],
  'mistral-vibe': ['MV', 'orange'],
  'junie': ['JN', 'green'],
  'iflow': ['IF', 'cyan'],
}
const CUSTOM = ['AC', 'rose']

export const logoOf = engine => (cliOf(engine) === undefined ? undefined : AGENT_LOGOS[cliOf(engine)])

export const badgeOf = (engine) => {
  if (typeof engine !== 'string') return undefined
  if (engine.startsWith(CUSTOM_PREFIX)) return CUSTOM
  return cliOf(engine) === undefined ? undefined : AGENT_BADGES[cliOf(engine)]
}

export const isLocalRoute = ref => badgeOf(String(ref ?? '').split('/')[0]) !== undefined

export const routeOf = ref => String(ref ?? '').split('/')[0]

export function modelsFor(models, ref?) {
  const list = models ?? []
  return isLocalRoute(ref)
    ? list.filter(model => routeOf(model.ref) === routeOf(ref))
    : list.filter(model => !isLocalRoute(model.ref))
}

export function agentAvatar(engine) {
  const logo = logoOf(engine)
  if (logo?.kind === 'image') return { image: logo.src }
  const badge = badgeOf(engine)
  if (badge === undefined) return undefined
  const [glyph, ink] = badge
  const mark = logo?.kind === 'path'
    ? `<rect width="64" height="64" rx="16" fill="${INKS.black[1]}"/><g transform="translate(14 14) scale(1.5)"><path d="${logo.d}" fill="#${logo.hex}"/></g>`
    : `<rect width="64" height="64" rx="16" fill="${INKS[ink][0]}"/><text x="32" y="41" text-anchor="middle" font-size="26" font-weight="700" fill="${INKS.black[1]}" font-family="system-ui,sans-serif">${glyph}</text>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${mark}</svg>`
  return { image: `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}` }
}
