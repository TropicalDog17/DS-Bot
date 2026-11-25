// Follows DeepSeek Harness apps/desktop windows-layout.ts and main.ts (MIT); see NOTICE.

export const CAPTION_HEIGHT = 40

export const TRAFFIC_LIGHTS = { x: 16, y: (CAPTION_HEIGHT - 14) / 2 }

export const framelessOn = platform => platform === 'win32' || platform === 'darwin'

export function materialOf(platform, release) {
  if (platform === 'darwin') return 'vibrancy'
  return platform === 'win32' && Number(String(release).split('.')[2] ?? 0) >= 22621 ? 'mica' : undefined
}

export function frameOptions(platform, material, caption) {
  if (platform === 'win32') {
    return { titleBarStyle: 'hidden', titleBarOverlay: { height: CAPTION_HEIGHT, ...caption }, ...(material === 'mica' ? { backgroundMaterial: 'mica' } : {}) }
  }
  if (platform === 'darwin') return { titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHTS, vibrancy: 'sidebar', visualEffectState: 'active' }
  return {}
}

/**
 * macOS puts the vibrancy back late after a window comes back from the Dock or from hiding
 * (electron/electron#25368), and the transparent window shows the desktop until then. While the
 * window is minimized or hidden it paints `fill()`; coming back, the change from no vibrancy to
 * 'sidebar' makes macOS put the material back.
 */
export function keepVibrancy(win, fill) {
  const apply = () => {
    if (win.isDestroyed()) return
    if (win.isMinimized() || !win.isVisible()) {
      win.setVibrancy(null)
      win.setBackgroundColor(fill())
    } else {
      win.setVibrancy('sidebar')
      win.setBackgroundColor('#00000000')
    }
  }
  for (const event of ['minimize', 'hide', 'restore', 'show']) win.on(event, apply)
}

const COLOR = /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/iu
export const cssColor = value => typeof value === 'string' && COLOR.test(value)

export const nativeThemeSource = value => (value === 'light' || value === 'dark' || value === 'system' ? value : undefined)
