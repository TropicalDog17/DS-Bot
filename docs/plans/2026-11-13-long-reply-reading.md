# Reading long replies

- Date: 2026-11-13
- Related: #1562, [long messages](2026-10-16-long-messages.md), [message layout and width](2026-10-22-message-layout.md), #601

## Why

A Bot's reply to the user in its own chat folds only beyond 20,000 characters
([long messages](2026-10-16-long-messages.md)): the user is there to read it. But a reply
of a few thousand characters is often several screens tall, and reading it has three
problems:

- When the reply finishes, the chat rests at its end. To read from the start, the user has
  to scroll up, and after scrolling too far has to find where it begins.
- In the middle, the user does not know which part they are in and cannot see what parts
  come later; to jump to "Risks" or "Conclusion" they have to scroll looking for headings.
- To find a section again, they can only scroll from memory.

#601 already loosened line spacing, lists and spacing between Chinese and English in the
bubble. This note decides navigation for long replies; it does not change typesetting or
folding.

We looked at Grok Bot. Its public docs do not say how long answers show in the chat. What
they describe is a different path: finished pieces meant for reading, such as reports and
memos, become a Page, which is a card in the chat; opened, it fills the window and the chat
shrinks to a small side panel. In open-source projects that imitate the Grok Bot interface
(not Grok Bot itself), long answers show in full, unfolded, with no table of contents; while
writing, the view follows to the bottom, and there is a "back to latest" at the bottom. DS
Bot also shows replies in full, and DSH provides "back to latest". What none of these have
is a sense of place for a reader in the middle of a long answer: going back to the start,
knowing which section they are in, and jumping by section. That is what this note adds;
when the reader is not in a long answer, the interface shows nothing extra.

Trade-offs:

- It appears only when needed. It does not appear when the whole reply fits, when the
  reader can see its start, or when they have nearly finished, in line with "quiet when
  nothing is going on".
- One small surface does both "back to start" and "contents". There is no permanent button
  on every reply and no contents column at the side: the text column is at most 960px wide,
  and there is no room for headings on either side.
- The contents use the reply's real headings (Markdown `#` headings, h1–h4 when rendered);
  it does not guess whether a bold line is a heading.
- Everything is done in the Bot bubble that DS Bot draws itself. The chat scroll area
  belongs to DSH; DS Bot only reads its position and calls its `scrollTo`, and does not
  change DSH's follow-to-bottom logic (hard rule 1).

## Decided behavior

### When it appears

- When a Bot reply (in the Bot's own chat, an earlier part, or a group chat message) meets
  all the conditions below, a "reading pill" appears at the top of the chat:
  - the reply is finished, not streaming, and not folded;
  - the reply is taller than the visible area of the chat (visible area: from 8px below DS
    Bot's top pill to above the input box);
  - the start of the reply has scrolled past the top edge of the visible area;
  - at least 96px of the reply below the pill has not been read yet.
- The user's own messages and the dialog of exchanges between Bots do not show the pill.
- At most one reply meets these conditions at a time, so there is at most one pill in the
  chat.

### Look

- Position: 8px below the top pill, left edge aligned with the reply's left edge (not past
  8px from the left of the scroll area). It stays fixed there and does not move when the
  reply scrolls. When the "N new messages ↑" pill is present and the two would touch, the
  reading pill moves to 8px below it.
- Appearance: 28 high, pill shaped, glass background (`--bt-glass-bg` + backdrop blur),
  `.5px` hairline border, glass shadow. At most 360px wide (on narrow screens, screen width
  minus 32px).
- When the reply has two or more headings, the pill has two segments:
  - On the left, a 24px up-arrow button: "back to the start of this reply".
  - On the right, the heading of the section being read, followed by a small down arrow;
    before the first heading is reached it says "Contents". A long heading is cut with an
    ellipsis.
- When the reply has fewer than two headings, the pill is a single button: an up arrow
  with "Start of reply".
- Entrance: `bt-pop-drop` (moved up 4px and scaled to .96 → in place, `SPRING_TAP`) plus
  `bt-veil-in`; exit `bt-pop-out` .12s. With reduced motion there is no entrance
  animation.

### Which section is being read

- The "reading" line is 24px below the bottom edge of the pill. The last heading whose top
  is above or exactly on this line is the current section.
- Only the reply's own h1–h4 count as headings: those inside block quotes, tables and
  `<details>` do not count, and empty headings do not count.

### Contents

- Clicking the right segment of the pill (or pressing ↓ on it) opens the contents menu,
  4px below the pill, styled like `.bt-menu`.
- One heading per row. Indentation counts from the highest level this reply uses: each
  lower level adds 12px, at most two levels (20px, 32px).
- The current section uses the accent color and weight 500 and is marked `aria-current`;
  when the menu opens, focus is on this item.
- Arrow keys, Home and End move between items; Esc closes the menu and returns focus to the
  pill; clicking outside the menu closes it.
- Choosing an item scrolls to that heading, which stops 8px below the pill; the pill stays
  and changes to that section's name.

### Back to start

- Clicking the up arrow (or the single button when there is only one) scrolls so the start
  of the reply rests below the top pill, and the pill then goes away by itself.
- Scrolling is smooth; with reduced motion it jumps straight there.

### Performance

- All replies share one `ResizeObserver` for height. Only replies taller than three
  quarters of the visible area listen to scrolling, and position is measured at most once
  per frame. When the size of a reply or the scroll area changes, the check runs again. The
  one-quarter margin is there because the visible area gets shorter when DSH's input box
  grows, and no size change reaches this code then.

## Not done

- No change to the folding threshold or behavior, and no change to bubble typesetting.
- No pushing the user's message to the top of the screen after sending so the reply writes
  below without following: the scroll area and follow-to-bottom belong to DSH, and DS Bot
  does not change them (hard rule 1).
- No guessing headings from bold lines or numbered paragraphs.
- No reading progress bar.
- No opening a single reply as a full page with the chat at the side, like Grok Bot's Page.
  That is a different feature that overlaps with [Bot views](2026-10-20-widget-views.md)
  and [long messages](2026-10-16-long-messages.md), and needs its own design.
- A reply that is still streaming does not show the pill.

## Known limits

- The pill is fixed at the top of the visible area and covers the first few characters of
  the line under it; when the user scrolls, that line moves on.
- The phone app draws its own chat and is outside the scope of this note.

## Changes
