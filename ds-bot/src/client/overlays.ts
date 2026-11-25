import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { NotificationWatcher } from './notifications.ts'
import { createPortal } from 'react-dom'
import { CommandPalette } from './palette.ts'
import { GroupSearch } from './group-search.ts'
import { NewChat } from './new-chat.ts'
import { ExchangeDialog } from './exchange.ts'
import { VoiceMode } from './voice.ts'
import { SettingsDialog } from './settings.ts'
import { ContextMenu } from './context-menu.ts'
import { PANEL_LINGER_MS, BotPanel } from './browser-pane.ts'
import { frameLayout, FALLBACK_SIDEBAR_WIDTH } from './frame-layout.ts'
import { MemoryDialog } from './memory-panel.ts'
import { reducedMotion, useLinger } from './motion.ts'
import { OpeningCover, openingModel } from './opening.ts'
import { PageView } from './pages.ts'

const DIALOG_EXIT_MS = 160
const MENU_EXIT_MS = 120

export function Overlays({ useRoster, useUi, useSessions, useSessionStatus, useActivity, useWork, useRegistry, useBrowserPages, useBrowserTabs, useBrowserHolds, useUpdate, useFrame, useSidebarPref, useSettingsShellHeld, usePages, actions }) {
  const roster = useRoster(value => value)
  const ui = useUi(value => value)
  useRegistry(value => value)
  const frameSnap = useFrame ? useFrame(value => value) : { viewport: window.innerWidth, sidebarWidth: FALLBACK_SIDEBAR_WIDTH, collapsedWidth: 0 }
  const pref = useSidebarPref ? useSidebarPref(value => value) : 'open'
  const current = useSessions(list => (Object.values(list.byId) as any[]).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id ?? null)
  const previous = useRef(current)
  useEffect(() => {
    if (previous.current === current) return
    previous.current = current
    if (current) actions.followPanel?.(current)
  }, [current])
  const open = ui.details ? { id: ui.details, view: ui.view ?? 'details', renaming: ui.renaming, tab: ui.tab, side: ui.side } : null
  const layout = frameLayout({
    viewport: frameSnap.viewport, sidebarWidth: frameSnap.sidebarWidth,
    pref, drawer: ui.leftDrawer === true,
    panel: open ? { view: open.view, yielded: ui.panelYield === true } : null,
  })
  const shown = open !== null && layout.panel !== 'folded' ? open : null
  const [kept, setKept] = useState(shown)
  useEffect(() => {
    if (shown) { setKept(shown); return undefined }
    const timer = setTimeout(() => setKept(null), reducedMotion() ? 0 : PANEL_LINGER_MS)
    return () => clearTimeout(timer)
  }, [ui.details, ui.view, ui.renaming, ui.tab, shown === null])
  const pane = shown ?? kept
  const shellHeld = useSettingsShellHeld ? useSettingsShellHeld(value => value) : false
  const [settings, settingsLeaving] = useLinger(shellHeld ? null : ui.settings, DIALOG_EXIT_MS)
  const memoryOwner = (id) => {
    const bot = roster.byId[id]
    if (bot) return { id: bot.id, name: bot.name }
    const room = roster.roomsById[id]
    return room ? { id: room.id, name: room.name, group: true } : null
  }
  const [memory, memoryLeaving] = useLinger(ui.memory && memoryOwner(ui.memory) ? ui.memory : null, DIALOG_EXIT_MS)
  const owner = memory ? memoryOwner(memory) : null
  const [menu, menuLeaving] = useLinger(ui.menu, MENU_EXIT_MS)
  const pages = usePages ? usePages(value => value) : []
  const [pageId, pageLeaving] = useLinger(typeof ui.page === 'string' && pages.some(page => page.id === ui.page) ? ui.page : null, DIALOG_EXIT_MS)
  const page = pageId ? pages.find(entry => entry.id === pageId) : undefined
  const opening = openingModel({ pending: ui.pendingOpen ?? null, current, roster })
  return h(Fragment, null,
    h(NotificationWatcher, { key: 'ds-bot:notifications', useSessions, useSessionStatus, useRoster, useWork, actions }),
    opening ? createPortal(h(OpeningCover, { model: opening, column: layout.column }), document.body) : null,
    pane ? createPortal(h(BotPanel, { pane, leaving: shown === null, room: layout.room, overlay: layout.panel === 'overlay', roster, actions, useSessions, useSessionStatus, useActivity, useWork, useBrowserTabs, useBrowserPages, useBrowserHolds }), document.body) : null,
    ui.newChat ? createPortal(h(NewChat, { key: `${ui.newChat}:${ui.newChatSection ?? ''}`, mode: ui.newChat, sectionId: ui.newChatSection ?? null, paneLeft: layout.column, roster, actions }), document.body) : null,
    ui.palette ? createPortal(h(CommandPalette, { key: ui.palette.token, start: ui.palette.query, token: ui.palette.token, roster, actions, useSessions }), document.body) : null,
    ui.groupSearch && roster.roomsById[ui.groupSearch.roomId]
      ? createPortal(h(GroupSearch, { key: ui.groupSearch.token, room: roster.roomsById[ui.groupSearch.roomId], roster, token: ui.groupSearch.token, actions }), document.body)
      : null,
    ui.exchange ? createPortal(h(ExchangeDialog, { pair: ui.exchange, paneLeft: layout.column, roster, actions }), document.body) : null,
    ui.voice ? createPortal(h(VoiceMode, { key: ui.voice, sessionId: ui.voice, paneLeft: layout.column, roster, actions, useSessions, useSessionStatus }), document.body) : null,
    menu ? createPortal(h(ContextMenu, { key: `${menu.kind ?? ''}:${menu.id}:${menu.x}:${menu.y}`, menu, roster, actions, useWork, leaving: menuLeaving }), document.body) : null,
    settings ? createPortal(h(SettingsDialog, { page: settings.page, id: settings.id, roster, actions, useUpdate, leaving: settingsLeaving }), document.body) : null,
    page ? createPortal(h(PageView, { key: `page:${page.id}`, page, paneLeft: layout.column, leaving: pageLeaving, actions }), document.body) : null,
    owner ? createPortal(h(MemoryDialog, { key: owner.id, owner, actions, leaving: memoryLeaving }), document.body) : null)
}
