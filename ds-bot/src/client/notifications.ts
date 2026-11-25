import { createElement as h, useEffect, useRef, useState } from 'react'
import { Switch } from './bot-settings.ts'
import { t } from './i18n.ts'
import { NOTIFY_KEY, badgeOf, noticeText, notificationRows, notifyKind, readNotifyPrefs, writeNotifyPrefs } from './notify.ts'

const shellNotify = notice => Promise.resolve(bridge()?.notify?.(notice)).catch(() => {})
const bridge = () => (typeof window === 'undefined' ? undefined : (window as any).dsBotApp)
const prefsNow = () => readNotifyPrefs(typeof localStorage === 'undefined' ? null : localStorage.getItem(NOTIFY_KEY))
const savePrefs = (next) => {
  try { localStorage.setItem(NOTIFY_KEY, JSON.stringify(next)) } catch {}
  return next
}

const listeners = new Set<() => void>()
let current = prefsNow()
export function useNotifyPrefs() {
  const [, bump] = useState(0)
  useEffect(() => {
    const run = () => bump(value => value + 1)
    listeners.add(run)
    return () => { listeners.delete(run) }
  }, [])
  return current
}
export function changeNotify(change) {
  current = savePrefs(writeNotifyPrefs(current, change))
  for (const run of listeners) run()
  return current
}

export function NotificationWatcher({ useSessions, useSessionStatus, useRoster, useWork, actions }) {
  const work = useWork(value => value)
  const roster = useRoster(value => value)
  const statuses = useSessionStatus(map => map)
  const viewing = useSessions(list => (Object.values(list.byId) as any[]).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id ?? null)
  const previous = useRef(new Map())
  useEffect(() => {
    const shell = bridge()
    shell?.onOpenSession?.((sessionId) => { actions.openSession?.(sessionId) })
    return undefined
  }, [])
  useEffect(() => {
    const prefs = prefsNow()
    const open = document.hasFocus?.() !== false && document.visibilityState !== 'hidden'
    const rows = notificationRows({ statuses, roster, approvals: work.approvals })
    const next = new Map()
    for (const row of rows) {
      const { id, sessionId, name, group, status: after } = row
      const before = previous.current.get(id)
      next.set(id, after)
      const kind = notifyKind({
        before, after,
        viewing: viewing === sessionId,
        focused: open,
        enabled: prefs.enabled,
        muted: prefs.muted[id] === true,
        group,
      })
      if (kind === undefined) continue
      void shellNotify({ sessionId: id, ...noticeText({ title: name, kind }) })
    }
    previous.current = next
    bridge()?.setBadge?.(badgeOf(rows))
  }, [statuses, viewing, roster, work])
  return null
}

export function NotificationsRow() {
  const prefs = useNotifyPrefs()
  const [permission, setPermission] = useState(undefined)
  useEffect(() => {
    let stopped = false
    void Promise.resolve(bridge()?.notifyStatus?.()).then((value) => { if (!stopped) setPermission(value) }).catch(() => {})
    return () => { stopped = true }
  }, [])
  const denied = permission === 'denied'
  return h('div', { className: 'bt-set-row' },
    h('div', { className: 'bt-set-copy' },
      h('span', null, t('Notifications')),
      h('span', { className: 'bt-set-hint' }, t('Tell me when a Bot answers while I am looking elsewhere.')),
      denied ? h('span', { className: 'bt-set-hint bt-danger', role: 'alert' }, t('System notifications are turned off for DS Bot. Unread marks still show them.')) : null),
    h('div', { className: 'bt-set-control' }, h(Switch, {
      label: t('Notifications'), on: prefs.enabled === true,
      onChange: next => changeNotify({ enabled: next }),
    })))
}

export function isMuted(id) {
  return prefsNow().muted[id] === true
}
export function toggleMuted(id) {
  return changeNotify({ mute: { id, on: !isMuted(id) } })
}
