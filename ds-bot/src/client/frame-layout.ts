import { STORAGE } from './storage.ts'

export const MIN_CHAT = 420
export const RAIL_WIDTH = 88
export const PANEL_MIN = { details: 320, browser: 360, side: 320 }
export const DSH_NARROW = 1024
export const trackRoom = ({ width, right }) => Math.max(0, Math.min(width, right))

export const SIDEBAR_MIN = 264
export const SIDEBAR_MAX = 420
export const FALLBACK_SIDEBAR_WIDTH = 280
export const RAIL_SNAP = (RAIL_WIDTH + SIDEBAR_MIN) / 2

/**
 * The width the collapsed shell sidebar still takes, from what the frame shows.
 * `measured` is the column's settled width while the shell reports itself collapsed.
 * `collapsed === null` means the frame has no sidebar column at all, so there is no
 * track to subtract: the narrow web shell on a phone keeps none, and a platform guess
 * would push the chat short by the same amount, under our rail (#1084). While the
 * shell slides its sidebar the widths in between are not settled, so the last stands.
 */
export const nextCollapsedWidth = ({ measured, collapsed, animating = false, last }) => {
  if (animating) return last
  if (collapsed === null) return 0
  if (collapsed === true) return measured ?? 0
  return last
}

export function frameLayout({ viewport, sidebarWidth, pref, drawer = false, panel = null }) {
  const fits = pref === 'open' && viewport >= sidebarWidth + MIN_CHAT
  let left = pref === 'hidden' ? 'hidden' : fits ? 'open' : drawer && pref === 'open' ? 'drawer' : 'rail'
  let occupied = left === 'open' ? sidebarWidth : left === 'hidden' ? 0 : RAIL_WIDTH
  let panelState = 'none'
  if (panel !== null) {
    const need = (PANEL_MIN[panel.view] ?? PANEL_MIN.details) + MIN_CHAT
    if (occupied + need <= viewport) panelState = 'shown'
    else if (panel.yielded === true) {
      if (left !== 'hidden') { left = 'rail'; occupied = RAIL_WIDTH }
      panelState = occupied + need <= viewport ? 'shown' : 'overlay'
    } else panelState = 'folded'
  }
  return { left, panel: panelState, column: occupied, room: Math.max(0, viewport - occupied) }
}

export function dragColumn(x, viewport) {
  if (x < RAIL_SNAP) return { left: 'rail', width: RAIL_WIDTH }
  const docks = viewport >= SIDEBAR_MIN + MIN_CHAT
  const high = docks ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, viewport - MIN_CHAT)) : SIDEBAR_MAX
  return { left: docks ? 'open' : 'drawer', width: Math.round(Math.max(SIDEBAR_MIN, Math.min(x, high))) }
}

export const toggledPref = (pref, shown) => (pref === 'hidden' ? shown : 'hidden')

// The shell measures the window on its own frame, a beat apart from us, and
// re-applies its own rule when it does: a flip this soon after a width change is
// the shell settling, not a gesture.
export const RESIZE_SETTLE_MS = 500
export const userSidebarToggle = ({ before, after, requested = false, sinceResize = Infinity }) =>
  before.collapsed !== after.collapsed && !requested && sinceResize >= RESIZE_SETTLE_MS
  && (before.viewport < DSH_NARROW) === (after.viewport < DSH_NARROW)

const PREFS = ['open', 'rail', 'hidden']
export function readSidebar(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(STORAGE.sidebar) ?? 'null')
    const pref = PREFS.includes(saved?.pref) ? saved.pref : 'open'
    const shown = saved?.shown === 'rail' ? 'rail' : 'open'
    const width = Number.isFinite(saved?.width) ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, saved.width)) : FALLBACK_SIDEBAR_WIDTH
    return { pref, shown, width }
  } catch { return { pref: 'open', shown: 'open', width: FALLBACK_SIDEBAR_WIDTH } }
}
export function writeSidebar(value, storage = globalThis.localStorage) {
  try { storage.setItem(STORAGE.sidebar, JSON.stringify(value)) } catch {}
}
