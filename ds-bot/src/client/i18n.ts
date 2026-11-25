export const NAMESPACE = 'ds-bot'

const fill = (text, params) => (params
  ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  : text)

export function t(key: string, params?: Record<string, unknown>): string {
  return fill(key, params)
}

export function hostText(message) {
  return message
}

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
