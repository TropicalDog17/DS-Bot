import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.ts'

export function KeptPrivateSection({ roster, actions, run, Section, Row }) {
  const kept = roster.privateArchives ?? []
  const [confirming, setConfirming] = useState(null)
  useEffect(() => {
    if (confirming === null) return undefined
    const timer = setTimeout(() => setConfirming(null), 4000)
    return () => clearTimeout(timer)
  }, [confirming])
  if (kept.length === 0) return null
  const release = (entry) => {
    if (confirming !== entry.id) { setConfirming(entry.id); return }
    setConfirming(null)
    void run(actions.releasePrivate(entry.id))
  }
  return h(Section, { title: t('Closed after deletion · {count}', { count: kept.length }) },
    kept.map(entry => h(Row, {
      key: entry.id,
      label: entry.name,
      hint: confirming === entry.id ? t('Click again to remove. Other Bots can then read its folder, memory and chats.') : entry.workDir,
    }, h('button', { type: 'button', className: `bt-soft bt-soft-sm${confirming === entry.id ? ' bt-danger' : ''}`, onClick: () => release(entry) }, t('Remove protection')))))
}
