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

export const CARD_TAG_CSS = `
.bt-card-tag{display:inline-flex;align-items:center;gap:4px;max-width:100%;margin:0 6px 2px 0;padding:1px 7px 1px 5px;vertical-align:1px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:6px;background:color-mix(in srgb,currentColor 7%,transparent);color:inherit;font:inherit;font-size:.86em;font-weight:600;line-height:1.5;cursor:pointer;white-space:nowrap}
.bt-card-tag>svg{flex:none;opacity:.7}
.bt-card-tag-label{overflow:hidden;text-overflow:ellipsis}
.bt-card-tag[data-static]{cursor:inherit}
@media (hover:hover){.bt-card-tag:not([data-static]):hover{border-color:color-mix(in srgb,currentColor 45%,transparent)}}
`
