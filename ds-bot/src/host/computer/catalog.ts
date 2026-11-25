export const PROVIDERS = { cua: 'cua', driver: 'cua-driver' }
export const KINDS = ['observe', 'background', 'foreground']

// The macOS provider's single `cua` tool dispatches on params.method. Pure reads and
// consent-gated selection need no lease; activate, 0.2.2-rc.1's hover, and mouseMove
// with useSystemPointer raise an app or move the visible pointer, so they are
// foreground; permission UI opens on the user's screen. Everything else stays in the
// app's background.
const CUA_OBSERVE = new Set([
  'getCapabilities', 'listApps', 'findApps', 'getApp', 'listWindows', 'getState', 'listActions',
  'screenshot', 'permissionStatus', 'applicationIcons',
])
const CUA_FOREGROUND = new Set(['activate', 'hover', 'requestPermission', 'openPermissionSettings'])
const CUA_BACKGROUND = new Set([
  'click', 'scroll', 'drag', 'setValue', 'selectText', 'invoke', 'performAction',
  'performSecondaryAction', 'typeText', 'paste', 'pressKey', 'sendKeyEvent', 'show', 'launchApp',
])

// The Cua Driver provider serves one tool per method as `cua_driver_native__<name>`.
export const DRIVER_PREFIX = 'cua_driver_native__'
const DRIVER_OBSERVE = new Set([
  'list_apps', 'list_windows', 'get_window_state', 'get_accessibility_tree', 'verify_state',
  'parse_visual_regions', 'get_desktop_state', 'get_screen_size', 'get_cursor_position', 'zoom',
  'debug_window_info', 'get_browser_state', 'get_session', 'list_sessions', 'get_session_state',
  'get_agent_cursor_state', 'get_recording_state', 'get_config', 'check_permissions', 'health_report',
])

// Raising windows and moving the visible cursor are foreground; so is session
// escalation. Anything the driver adds that DS Bot does not know fails closed to
// foreground — never silently allowed.
const DRIVER_BACKGROUND = new Set([
  'launch_app', 'kill_app', 'set_window_frame', 'invoke_menu', 'click', 'double_click',
  'right_click', 'drag', 'type_text', 'press_key', 'hotkey', 'set_value', 'scroll',
  'clipboard_read', 'clipboard_write', 'page', 'browser_prepare', 'browser_navigate',
  'browser_click', 'browser_type', 'browser_dialog', 'browser_set_input_files',
  'browser_download', 'browser_pointer', 'start_recording', 'stop_recording',
  'replay_trajectory', 'install_ffmpeg', 'start_session', 'end_session', 'set_config',
])

export function classify(name, args: Record<string, any> = {}) {
  if (name === 'cua') {
    const method = typeof args?.method === 'string' ? args.method : ''
    const kind = method === 'mouseMove'
      ? (args?.params?.useSystemPointer === true ? 'foreground' : 'background')
      : CUA_OBSERVE.has(method) ? 'observe'
        : CUA_FOREGROUND.has(method) ? 'foreground'
          : CUA_BACKGROUND.has(method) ? 'background' : 'foreground'
    return { provider: PROVIDERS.cua, kind, method }
  }
  if (typeof name === 'string' && name.startsWith(DRIVER_PREFIX)) {
    const method = name.slice(DRIVER_PREFIX.length)
    const kind = DRIVER_OBSERVE.has(method) ? 'observe'
      : args?.foreground === true || !DRIVER_BACKGROUND.has(method) ? 'foreground' : 'background'
    return { provider: PROVIDERS.driver, kind, method }
  }
  return undefined
}

export const isComputerTool = name => classify(name, {}) !== undefined

export const DRIVER_GLOBAL = new Set([
  'list_apps', 'list_windows', 'get_screen_size', 'get_cursor_position',
  'get_config', 'set_config', 'check_permissions', 'health_report',
  'get_session', 'list_sessions', 'get_session_state', 'get_recording_state',
  'get_agent_cursor_state',
  'start_session', 'end_session',
])

export const DRIVER_REFUSED = new Set([
  'set_config', 'start_recording', 'stop_recording', 'replay_trajectory', 'install_ffmpeg',
  'set_agent_cursor_enabled', 'set_agent_cursor_motion', 'set_agent_cursor_theme',
])

export const LEVELS = ['off', 'view', 'background', 'foreground']
export function levelAllows(level, kind) {
  if (kind === 'observe') return LEVELS.indexOf(level) >= 1
  if (kind === 'background') return LEVELS.indexOf(level) >= 2
  return LEVELS.indexOf(level) >= 3
}
