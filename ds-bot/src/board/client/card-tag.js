// A card's note reaches its Bot as the user's message: `Note on card c_… · KEY "title": text`
// (cards.js `note`). The Bot needs that line to know which card it is about; in the chat
// the line shows as a tag of the card, and the tag opens that card on the Board.
import { createElement as h } from 'react'
import { BoardIcon } from './icons.js'

export const CARD_TAG_ID = 'board-card-note'

// A lower order wins when two rules find a piece at the same place (user-text-rule.js):
// the Bot mention is 5, DSH's own rules 10 and up.
const ORDER = 4
const NOTE_LINE = /Note on card (c_[0-9a-f]+)(?: · ([^"]+?))? "(.*?)": ?/g

export function cardTagRule() {
  return {
    id: CARD_TAG_ID,
    order: ORDER,
    match(text, from) {
      NOTE_LINE.lastIndex = from
      const found = NOTE_LINE.exec(text)
      if (found === null) return undefined
      const [line, cardId, key, title] = found
      return { id: CARD_TAG_ID, start: found.index, end: found.index + line.length, data: { cardId, ...(key ? { key } : {}), title } }
    },
  }
}

// `show(id)` makes the Board open on that card the next time it opens.
export function cardTagNode(show) {
  return function CardTag({ node, interactive, actions }) {
    const { cardId, key, title } = node.data
    const parts = [h(BoardIcon, { key: 'icon' }), h('span', { key: 'label', className: 'bt-card-tag-label' }, key ?? title)]
    if (!interactive) return h('span', { className: 'bt-card-tag', 'data-static': '', title }, ...parts)
    const open = () => { show(cardId); actions.openPage('board') }
    return h('button', { type: 'button', className: 'bt-card-tag', title, onClick: open }, ...parts)
  }
}

// A Bot's text names a card by its id (the board's tools show `c_… · KEY`), or quotes
// the note line it read. Each piece that names a card the board has, with what follows
// it there (` · KEY`, ` "title"`, `:`), shows as that card; an id the board does not
// know stays as written.
export const CARD_LINK_ORIGIN = 'https://cards.local/'
const CARD_REF = /(Note on card )?\bc_[0-9a-f]{8}\b/g
const nameOf = card => card.key || card.title

export function cardPieces(text, cards) {
  const pieces = []
  const ref = new RegExp(CARD_REF.source, 'g')
  for (let found = ref.exec(text); found !== null; found = ref.exec(text)) {
    const card = cards[found[0].slice((found[1] ?? '').length)]
    if (card === undefined) continue
    let end = found.index + found[0].length
    const take = (tail) => {
      if (!text.startsWith(tail, end)) return false
      end += tail.length
      return true
    }
    if (card.key) take(` · ${card.key}`)
    if (take(` "${card.title}"`)) take(':')
    pieces.push({ start: found.index, end, card })
    ref.lastIndex = end
  }
  return pieces
}

const swap = (text, cards, draw) => {
  let out = ''
  let cursor = 0
  for (const piece of cardPieces(text, cards)) {
    out += text.slice(cursor, piece.start) + draw(piece.card)
    cursor = piece.end
  }
  return cursor === 0 ? text : out + text.slice(cursor)
}

// A Bot's markdown: each card as a link its bubble draws as a tag. Code stays as written.
export function linkCards(text, cards) {
  if (!text.includes('c_')) return text
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, index) => (index % 2 === 1 ? part
    : swap(part, cards, card => `[${nameOf(card).replace(/[[\]\\]/g, '\\$&')}](${CARD_LINK_ORIGIN}${card.id})`))).join('')
}

// Plain text (the Board's own lines): each card by its key, else its title.
export const nameCards = (text, cards) => (typeof text === 'string' && text.includes('c_') ? swap(text, cards, nameOf) : text)

const BOARD_MASK = `url("data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='black' stroke-width='1.6' stroke-linejoin='round'><path d='M3.5 4.5h3.5v11H3.5zM8.25 4.5h3.5v7h-3.5zM13 4.5h3.5v9H13z'/></svg>")}")`
const BOT_TAG = `:is(.bt-bubble,.bt-board-md) a[href^="${CARD_LINK_ORIGIN}"]`

export const CARD_TAG_CSS = `
.bt-card-tag{display:inline-flex;align-items:center;gap:4px;max-width:100%;margin:0 6px 2px 0;padding:1px 7px 1px 5px;vertical-align:1px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:6px;background:color-mix(in srgb,currentColor 7%,transparent);color:inherit;font:inherit;font-size:.86em;font-weight:600;line-height:1.5;cursor:pointer;white-space:nowrap}
.bt-card-tag>svg{flex:none;opacity:.7}
.bt-card-tag-label{overflow:hidden;text-overflow:ellipsis}
.bt-card-tag[data-static]{cursor:inherit}
@media (hover:hover){.bt-card-tag:not([data-static]):hover{border-color:color-mix(in srgb,currentColor 45%,transparent)}}
${BOT_TAG}{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:0 7px 0 5px;vertical-align:1px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:6px;background:color-mix(in srgb,currentColor 7%,transparent);color:inherit;font-size:.86em;font-weight:600;line-height:1.5;text-decoration:none;white-space:nowrap;cursor:pointer}
${BOT_TAG}::before{content:"";flex:none;width:14px;height:14px;background:currentColor;opacity:.7;-webkit-mask:${BOARD_MASK} center/contain no-repeat;mask:${BOARD_MASK} center/contain no-repeat}
${BOT_TAG} svg{display:none}
@media (hover:hover){${BOT_TAG}:hover{border-color:color-mix(in srgb,currentColor 45%,transparent)}}
`
