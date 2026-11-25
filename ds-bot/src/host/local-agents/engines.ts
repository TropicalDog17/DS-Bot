export const KINDS = ['acp', 'codex', 'claude']

// Local-agent routes live under their own prefix. Before it they shared the
// provider namespace, so a CLI named like a provider DSH or another plugin
// ships (`opencode`) took that provider's name and the LLM service failed to
// load with a duplicate adapter.
export const ROUTE_PREFIX = 'local-'

const CLIS = {
  'devin-cli': { name: 'Devin CLI', kind: 'acp', command: 'devin', args: ['acp'], version: ['--version'], signIn: 'devin auth login', signedIn: { args: ['auth', 'status'] } },
  'claude-code': { name: 'Claude Code', kind: 'claude', command: 'claude', args: [], version: ['--version'], signIn: 'claude', signedIn: { args: ['auth', 'status'], fallback: { file: ['.claude', '.credentials.json'] } } },
  'codex-cli': { name: 'Codex CLI', kind: 'codex', command: 'codex', args: ['app-server', '--listen', 'stdio://'], version: ['--version'], signIn: 'codex login', signedIn: { args: ['login', 'status'] } },
  'cursor-cli': { name: 'Cursor CLI', kind: 'acp', command: 'cursor-agent', args: ['acp'], version: ['--version'], signIn: 'cursor-agent login', signedIn: { args: ['status'] } },
  'copilot-cli': { name: 'GitHub Copilot', kind: 'acp', command: 'copilot', args: ['--acp'], version: ['--version'], signIn: 'copilot' },
  'gemini-cli': { name: 'Gemini CLI', kind: 'acp', command: 'gemini', args: ['--acp'], version: ['--version'], signIn: 'gemini', signedIn: { file: ['.gemini', 'oauth_creds.json'] } },
  'antigravity': {
    name: 'Antigravity', kind: 'acp', command: 'agy', args: ['acp'], version: ['--version'], signIn: 'agy acp --login',
    cwdPerProcess: true,
    modes: {
      'read-only': ['default'],
      'workspace-write': ['accept-edits'],
      'danger-full-access': ['auto'],
    },
  },
  'opencode': { name: 'OpenCode', kind: 'acp', command: 'opencode', args: ['acp'], version: ['--version'], signIn: 'opencode auth login' },
  'cline': { name: 'Cline', kind: 'acp', command: 'cline', args: ['--acp'], version: ['--version'], signIn: 'cline auth', env: { CLINE_SESSION_BACKEND_MODE: 'local' } },
  'kilo': { name: 'Kilo CLI', kind: 'acp', command: 'kilo', commands: ['kilo', 'kilocode'], args: ['acp'], version: ['--version'], signIn: 'kilo auth' },
  'goose': { name: 'Goose', kind: 'acp', command: 'goose', args: ['acp'], version: ['--version'], signIn: 'goose configure' },
  'grok-cli': { name: 'Grok CLI', kind: 'acp', command: 'grok', args: ['agent', 'stdio'], version: ['--version'], signIn: 'grok' },
  'kimi-cli': { name: 'Kimi CLI', kind: 'acp', command: 'kimi', args: ['acp'], version: ['--version'], signIn: 'kimi login' },
  'qwen-code': { name: 'Qwen Code', kind: 'acp', command: 'qwen', args: ['--acp'], version: ['--version'], signIn: 'qwen', signedIn: { file: ['.qwen', 'oauth_creds.json'] } },
  'codebuddy': { name: 'CodeBuddy Code', kind: 'acp', command: 'codebuddy', commands: ['codebuddy', 'codebuddy-code'], args: ['--acp'], version: ['--version'], signIn: 'codebuddy login' },
  'qoder': { name: 'Qoder CLI', kind: 'acp', command: 'qodercli', commands: ['qodercli', 'qoder'], args: ['--acp'], version: ['--version'], signIn: 'qodercli' },
  'minimax-code': { name: 'MiniMax Code', kind: 'acp', command: 'mcode', args: ['acp'], version: ['--version'], signIn: 'mcode' },
  'glm-cli': { name: 'GLM Agent', kind: 'acp', command: 'glm-acp-agent', args: [], version: ['--version'], signIn: 'glm-acp-agent --setup' },
  'kiro-cli': { name: 'Kiro CLI', kind: 'acp', command: 'kiro-cli', args: ['acp'], version: ['--version'], signIn: 'kiro-cli login' },
  'factory-droid': { name: 'Factory Droid', kind: 'acp', command: 'droid', args: ['exec', '--output-format', 'acp-daemon'], version: ['--version'], signIn: 'droid' },
  'auggie': { name: 'Auggie CLI', kind: 'acp', command: 'auggie', args: ['--acp'], version: ['--version'], signIn: 'auggie login' },
  'mistral-vibe': { name: 'Mistral Vibe', kind: 'acp', command: 'vibe-acp', args: [], version: ['--version'], signIn: 'vibe' },
  'junie': { name: 'Junie', kind: 'acp', command: 'junie', args: ['--acp=true'], version: ['--version'], signIn: 'junie' },
  'iflow': { name: 'iFlow CLI', kind: 'acp', command: 'iflow', args: ['--experimental-acp'], version: ['--version'], signIn: 'iflow' },
}

export const ENGINES = Object.fromEntries(Object.entries(CLIS).map(([id, spec]) => [`${ROUTE_PREFIX}${id}`, { ...spec, id }]))

export const CUSTOM_PREFIX = `${ROUTE_PREFIX}acp-`

const OLD_CUSTOM_PREFIX = 'acp-'
export const AMBIGUOUS_OLD_ROUTES = new Set(['opencode'])
export const legacyRoute = (provider) => {
  if (typeof provider !== 'string') return undefined
  if (CLIS[provider] !== undefined) return `${ROUTE_PREFIX}${provider}`
  if (provider.startsWith(OLD_CUSTOM_PREFIX)) return `${ROUTE_PREFIX}${provider}`
  return undefined
}

export const customRoute = (id) => `${CUSTOM_PREFIX}${id}`

export function engineOf(route, custom = []) {
  if (ENGINES[route] !== undefined) return ENGINES[route]
  if (route.startsWith(CUSTOM_PREFIX)) {
    const entry = custom.find(agent => agent.id === route.slice(CUSTOM_PREFIX.length))
    if (entry !== undefined) return { name: entry.name, kind: 'acp', command: entry.command, args: entry.args ?? [], custom: true }
  }
  return undefined
}

export const isLocalAgentRoute = route => typeof route === 'string' && (ENGINES[route] !== undefined || route.startsWith(CUSTOM_PREFIX))

export function validateCustom({ name, command, args }) {
  const clean = {
    name: String(name ?? '').trim().slice(0, 40),
    command: String(command ?? '').trim(),
    args: (Array.isArray(args) ? args : String(args ?? '').split(' ')).map(arg => String(arg).trim()).filter(Boolean),
  }
  if (clean.name === '') throw new Error('Name is required')
  if (clean.command === '' || /[\s]/.test(clean.command) || !(clean.command.startsWith('/') || clean.command.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(clean.command) || /^[\w.-]+$/.test(clean.command))) {
    throw new Error('Command must be a program name, an absolute path, or a ~/path')
  }
  if (clean.args.some(arg => arg.includes('\0') || /[\r\n]/.test(arg))) throw new Error('Arguments must not contain newlines')
  return clean
}

export const MODES = {
  'read-only': { acp: ['ask', 'plan', 'read-only', 'readonly'], claude: 'plan', codex: 'read-only' },
  'workspace-write': { acp: ['accept-edits', 'accept_edits', 'acceptEdits'], claude: 'acceptEdits', codex: 'workspace-write' },
  'danger-full-access': { acp: ['bypass', 'bypassPermissions', 'bypass-permissions', 'yolo', 'full-access', 'auto-approve'], claude: 'bypassPermissions', codex: 'danger-full-access' },
}
export const acpMode = (preset, advertised, modes) => {
  const wanted = modes?.[preset] ?? MODES[preset]?.acp ?? []
  const ids = (advertised ?? []).map(option => option.id ?? option.value ?? option)
  return ids.length === 0 ? wanted[0] : wanted.find(id => ids.includes(id))
}
export const cliMode = (kind, preset) => (kind === 'acp' ? undefined : MODES[preset]?.[kind])
