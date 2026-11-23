// Interface copy is English. Keys are the English text, so `t` only fills `{name}`
// slots; the module stays the one place copy goes through.
export const NAMESPACE = 'ds-bot'

const fill = (text, params) => (params
  ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  : text)

export function t(key, params) {
  return fill(key, params)
}

// A message from the host, as the interface shows it.
export function hostText(message) {
  return message
}

// The interface language tag, for the host and for dates and times.
export function language() {
  return 'en'
}

export const dateLocale = () => 'en-US'

// MarkdownText re-parses when `labels` changes identity, and a streaming message starts
// over, so one object serves every render.
let labels = null
export function mdLabels() {
  labels ??= { code: { copyLabel: t('Copy'), copiedLabel: t('Copied') }, footnotes: t('Footnotes') }
  return labels
}
