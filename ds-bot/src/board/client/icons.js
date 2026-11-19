// The board's own two line icons, drawn like DS Bot's (20px box, 1.6 stroke).
import { createElement as h } from 'react'

const lineIcon = paths => function LineIcon() {
  return h('svg', { width: 16, height: 16, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    ...paths.map(d => h('path', { key: d, d })))
}

// Two links of a chain, on a slant: a link to a PR or a ticket.
export const LinkIcon = lineIcon(['M8.5 11.5l3-3', 'M9.5 6.5l1.2-1.2a2.8 2.8 0 0 1 4 4l-1.2 1.2', 'M10.5 13.5l-1.2 1.2a2.8 2.8 0 0 1-4-4l1.2-1.2'])
// Three columns of cards, the middle one shorter: the work board.
export const BoardIcon = lineIcon(['M3.5 4.5h3.5v11H3.5z', 'M8.25 4.5h3.5v7h-3.5z', 'M13 4.5h3.5v9H13z'])
