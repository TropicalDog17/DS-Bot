import { installStyles } from './styles.ts'
import { nextCollapsedWidth, trackRoom } from './frame-layout.ts'

export const sidebarTrackWidth = () => {
  const box = typeof document === 'undefined' ? undefined : document.querySelector('[class*="_sidebarCol"]')?.getBoundingClientRect()
  return box === undefined ? null : trackRoom(box)
}

export const dshCollapsed = () => {
  if (typeof document === 'undefined') return null
  const column = document.querySelector('[class*="_sidebarCol"]')
  return column ? column.closest('[data-sidebar-collapsed]') !== null : null
}

// The track the collapsed shell sidebar keeps: nothing under a frameless window
// (Windows title bar, macOS desktop), its icon rail elsewhere.
export const collapsedTrackWidth = () =>
  document.documentElement.hasAttribute('data-windows-titlebar') || document.documentElement.dataset.platform === 'darwin' ? 0 : 56

// The conversation column's margins live in one rule of our own, matched on the
// column's exact class. A custom property on <body> would restyle the whole page,
// tens of milliseconds a write. A changed rule still restyles the column's
// subtree, so a drag writes the column's own inline style each frame and the
// rule once, on release.
const room = { rule: null, selector: '' }
const roomRule = () => {
  const live = room.rule?.parentStyleSheet?.ownerNode?.isConnected
  if (live && room.selector) return room.rule
  const column = document.querySelector('[class*="_centerCol"]')
  const selector = column ? [...column.classList].filter(name => name.includes('_centerCol')).map(name => `.${CSS.escape(name)}`).join(',') : ''
  if (live && !selector) return room.rule
  const declarations = room.rule?.style.cssText ?? ''
  room.rule?.parentStyleSheet?.ownerNode?.remove()
  const style = installStyles(`${selector || '[class*="_centerCol"]'}{${declarations}}`, 'chat-room')
  room.rule = style.sheet.cssRules[0]
  room.selector = selector
  return room.rule
}
const margin = (side, width, style) => {
  if (width === null) style.removeProperty(`margin-${side}`)
  else style.setProperty(`margin-${side}`, `${width}px`, 'important')
}
let roomHold = 0
export const chatRoom = {
  setRight(width) { margin('right', width, roomRule().style) },
  setLeft(width) { margin('left', width, roomRule().style) },
  hold(on) {
    cancelAnimationFrame(roomHold)
    if (on) { roomRule().style.setProperty('transition', 'none', 'important'); return }
    roomHold = requestAnimationFrame(() => { roomHold = requestAnimationFrame(() => roomRule().style.removeProperty('transition')) })
  },
  columns() {
    roomRule()
    return room.selector ? [...document.querySelectorAll(room.selector)] : []
  },
}

// Feeds the frame source the geometry the layout rules read: viewport, the
// shell sidebar's collapsed track width, and its collapsed flag. A resize or a
// sidebar slide does not always come with a window event, so the track width
// comes off a ResizeObserver and the flag off a MutationObserver.
export function installFrameWatch(frame) {
  let collapsedWidth = collapsedTrackWidth()
  let raf = 0
  const watched = new Set<Element>()
  let sidebarEl: Element | null = null
  let centerEl: Element | null = null
  let watchingTree = false
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null
  const watchAttributesOnly = () => {
    if (!watchingTree) return
    watchingTree = false
    mutations.disconnect()
    mutations.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-animating'] })
  }
  const watchSubtree = () => {
    if (watchingTree) return
    watchingTree = true
    mutations.disconnect()
    mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-animating'] })
  }
  const read = () => {
    const column = sidebarEl?.isConnected ? sidebarEl : document.querySelector('[class*="_sidebarCol"]')
    const animating = column?.closest('[data-animating]') != null
    const box = column ? column.getBoundingClientRect() : undefined
    const width = animating || box === undefined ? null : trackRoom(box)
    const collapsed = column ? column.closest('[data-sidebar-collapsed]') !== null : null
    collapsedWidth = nextCollapsedWidth({ measured: width, collapsed, animating, last: collapsedWidth })
    frame.set((state) => {
      const next = { ...state, viewport: window.innerWidth, collapsedWidth, collapsed: collapsed === true }
      return state.viewport === next.viewport && state.collapsedWidth === next.collapsedWidth && state.collapsed === next.collapsed ? state : next
    })
  }
  const measure = () => {
    if (sidebarEl && !sidebarEl.isConnected) sidebarEl = null
    if (centerEl && !centerEl.isConnected) centerEl = null
    if (!sidebarEl || !centerEl) {
      for (const selector of ['[class*="_sidebarCol"]', '[class*="_centerCol"]']) {
        for (const column of document.querySelectorAll(selector)) {
          if (!watched.has(column)) { watched.add(column); observer?.observe(column) }
          if (selector === '[class*="_sidebarCol"]') sidebarEl = column
          else centerEl = column
        }
      }
    }
    if (sidebarEl && centerEl) watchAttributesOnly()
    else watchSubtree()
    read()
  }
  const schedule = () => {
    if (raf === 0) raf = requestAnimationFrame(() => { raf = 0; measure() })
  }
  const mutations = new MutationObserver(schedule)
  measure()
  window.addEventListener('resize', schedule)
  return () => {
    cancelAnimationFrame(raf)
    mutations.disconnect()
    observer?.disconnect()
    window.removeEventListener('resize', schedule)
  }
}
