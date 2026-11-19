// The seat a companion plugin takes in DS Bot's interface: one icon button in the
// sidebar's head (and in the collapsed rail), and a screen in the main area while it is
// open. Opening any chat leaves it, as it leaves any other screen. A companion's client injects `dsBotPages` and registers its page:
//
//   const off = ctx.dsBotPages.register({ id: 'board', title: 'Board', icon: BoardIcon, Page })
//
// `icon` and `Page` are React components. The page gets { paneLeft, leaving, close }:
// the main area's left edge in px, true while its exit plays, and a close callback.
// DS Bot draws nothing for a companion that never registers, so a disabled plugin
// leaves no trace.
import { createElement as h } from 'react'
import { createSource } from './sources.js'

const ID = /^[a-z][a-z0-9-]{0,39}$/

export function createPages() {
  const source = createSource([])
  const register = (page) => {
    if (page === null || typeof page !== 'object') throw new TypeError('dsBotPages.register takes a page')
    const { id, title, icon, Page, order = 0 } = page
    if (typeof id !== 'string' || !ID.test(id)) throw new TypeError(`page id "${id}" must be lower-case letters, digits and dashes`)
    if (typeof title !== 'string' || title.trim() === '') throw new TypeError('a page needs a title')
    if (typeof icon !== 'function' || typeof Page !== 'function') throw new TypeError('icon and Page are components')
    if (source.getSnapshot().some(entry => entry.id === id)) throw new Error(`page "${id}" is already registered`)
    const entry = Object.freeze({ id, title: title.trim(), icon, Page, order: Number.isFinite(order) ? order : 0 })
    source.set(list => [...list, entry].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)))
    let live = true
    return () => {
      if (!live) return
      live = false
      source.set(list => list.filter(item => item !== entry))
    }
  }
  return { source, service: Object.freeze({ register, list: () => source.getSnapshot() }) }
}

// The head's buttons, one per registered page; the open page's button is the current place.
export function PageButtons({ pages, open = null, actions }) {
  return (pages ?? []).map(page => h('button', {
    key: `page:${page.id}`, type: 'button', className: 'bt-round bt-page-button', 'data-page': page.id,
    'aria-label': page.title, title: page.title, 'aria-current': page.id === open ? 'page' : undefined,
    onClick: () => actions.openPage(page.id),
  }, h(page.icon)))
}

// The open page, as Overlays mounts it.
export function PageView({ page, paneLeft, leaving, actions }) {
  return h(page.Page, { paneLeft, leaving: leaving === true, close: () => actions.closePage() })
}
