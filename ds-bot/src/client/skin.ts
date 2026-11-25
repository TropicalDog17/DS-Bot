export const MIN_SKIN_ALPHA = 0.7

export const SKIN_VARIABLES = ['--bt-skin-main', '--bt-skin-sidebar', '--bt-skin-card']

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i

export function parseColor(value) {
  const text = String(value ?? '').trim()
  const hex = HEX.exec(text)
  if (hex !== null) {
    const digits = hex[1]
    const pair = (at) => {
      const part = digits.length <= 4 ? digits[at] + digits[at] : digits.slice(at * 2, at * 2 + 2)
      return Number.parseInt(part, 16)
    }
    const alpha = digits.length === 4 ? pair(3) / 255 : digits.length === 8 ? pair(3) / 255 : 1
    return { r: pair(0), g: pair(1), b: pair(2), a: alpha }
  }
  const rgb = RGB.exec(text)
  if (rgb !== null) {
    const alpha = rgb[4] === undefined ? 1 : rgb[5] === '%' ? Number(rgb[4]) / 100 : Number(rgb[4])
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: Math.max(0, Math.min(1, alpha)) }
  }
  return undefined
}

const hex2 = value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
const withAlpha = ({ r, g, b }, a) => `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a * 255)}`

export const alphaOf = value => parseColor(value)?.a ?? 1

export function skinSurfaceVars({ main, sidebar, colors }, { minAlpha = MIN_SKIN_ALPHA } = {}) {
  const vars = {}
  const floor = alpha => Math.min(1, Math.max(alpha, minAlpha))
  const mainAlpha = alphaOf(main)
  const sidebarAlpha = alphaOf(sidebar)
  if (mainAlpha < 1) {
    const alpha = floor(mainAlpha)
    vars['--bt-skin-main'] = withAlpha(parseColor(colors.main) ?? { r: 252, g: 252, b: 252 }, alpha)
    vars['--bt-skin-card'] = withAlpha(parseColor(colors.card) ?? { r: 255, g: 255, b: 255 }, alpha)
  }
  if (sidebarAlpha < 1) {
    vars['--bt-skin-sidebar'] = withAlpha(parseColor(colors.sidebar) ?? { r: 247, g: 247, b: 247 }, floor(sidebarAlpha))
  }
  return vars
}

export function over(surface, alpha, wallpaper) {
  const back = parseColor(wallpaper) ?? { r: 255, g: 255, b: 255, a: 1 }
  return { r: surface.r * alpha + back.r * (1 - alpha), g: surface.g * alpha + back.g * (1 - alpha), b: surface.b * alpha + back.b * (1 - alpha), a: 1 }
}

const channel = value => {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
export const contrastRatio = (foreground, background) => {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export function readSkinSurfaceVars(doc, theme, { minAlpha = MIN_SKIN_ALPHA } = {}) {
  const body = doc?.body
  if (body === undefined) return {}
  const dark = body.hasAttribute?.('data-ds-dark-theme') === true
  const mode = dark ? theme.dark : theme.light
  const colors = { main: mode.bg, sidebar: mode.sidebar, card: mode.card }
  const style = doc.defaultView?.getComputedStyle?.(body)
  const token = name => {
    const value = style?.getPropertyValue?.(name)?.trim() ?? ''
    if (value === '' || parseColor(value) !== undefined) return value
    const canvas = doc.createElement('canvas')
    canvas.width = canvas.height = 1
    const paint = canvas.getContext('2d')
    paint.fillStyle = value
    paint.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data
    return withAlpha({ r, g, b }, a / 255)
  }
  return skinSurfaceVars({ main: token('--dsw-alias-bg-base'), sidebar: token('--dsw-specific-sidebar-fill'), colors }, { minAlpha })
}

export function writeSkinSurfaceVars(doc, read) {
  const body = doc?.body
  const apply = () => {
    if (body === undefined) return
    const vars = read() ?? {}
    for (const name of SKIN_VARIABLES) {
      if (vars[name] === undefined) body.style.removeProperty(name)
      // Writing the value the body already has still mutates the style attribute and
      // notifies observers; a theme or DOM observer reacting to that could loop.
      else if (body.style.getPropertyValue?.(name) !== vars[name]) body.style.setProperty(name, vars[name])
    }
  }
  return {
    apply,
    clear() {
      if (body === undefined) return
      for (const name of SKIN_VARIABLES) body.style.removeProperty(name)
    },
  }
}
