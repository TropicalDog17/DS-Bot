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
//
// While it is registered a page can also ask for the user: `mark(id, true)` puts a dot on
// its button, and `alert(id, text, onOpen)` shows a short notice whose Open opens the
// page (and calls `onOpen` first, so the page can lead with what the notice was about).
import { createElement as h } from 'react'
import { createSource } from './sources.js'

const ID = /^[a-z][a-z0-9-]{0,39}$/

export function createPages({ alert } = {}) {
  const source = createSource([])
  const registered = id => source.getSnapshot().some(entry => entry.id === id)
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
  const mark = (id, on) => {
    source.set(list => (list.some(entry => entry.id === id && entry.marked !== (on === true))
      ? list.map(entry => (entry.id === id ? Object.freeze({ ...entry, marked: on === true }) : entry))
      : list))
  }
  const notice = (id, text, onOpen) => {
    const said = typeof text === 'string' ? text.trim() : ''
    if (!registered(id) || said === '') return
    alert?.({ page: id, text: said, onOpen: typeof onOpen === 'function' ? onOpen : undefined })
  }
  return { source, service: Object.freeze({ register, mark, alert: notice, list: () => source.getSnapshot() }) }
}

// The head's buttons, one per registered page; the open page's button is the current place.
export function PageButtons({ pages, open = null, actions }) {
  return (pages ?? []).map(page => h('button', {
    key: `page:${page.id}`, type: 'button', className: 'bt-round bt-page-button', 'data-page': page.id,
    'aria-label': page.title, title: page.title, 'aria-current': page.id === open ? 'page' : undefined,
    'data-marked': page.marked === true || undefined,
    onClick: () => actions.openPage(page.id),
  }, h(page.icon), page.marked === true ? h('span', { className: 'bt-page-dot', 'aria-hidden': true }) : null))
}

// The open page, as Overlays mounts it.
export function PageView({ page, paneLeft, leaving, actions }) {
  return h(page.Page, { paneLeft, leaving: leaving === true, close: () => actions.closePage() })
}
