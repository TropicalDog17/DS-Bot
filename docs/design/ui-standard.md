# DS Bot UI design standard

Version: draft 0.2 (2026-10-15, checked against `dev` `2f9300d`; 0.1 was 2026-10-11). It applies to every interface in `ds-bot/src/client/`.

## 0. How to use this standard

- **Levels**: "must" cannot be broken; "should" is the default, with exceptions allowed for a reason, and the exception goes into a code comment; "may" is a recommended practice.
- **Where the values come from**: every value is taken from the current code (the theme, style and motion modules), not made up. The "Current deviations" list at the end of each section names the places where the code does not match the standard. When the code is unified, the standard wins.
- **Reference interfaces**: the top pill and the usage page in settings. The motion of a new interface follows these two.
- **Direction**: fix the current state in place. Values follow the existing code; the work only removes inconsistencies and does not set a new visual design. Over time this grows into DS Bot's own design language.
- **When there is a trade-off**: do not decide on your own. Build a side-by-side preview of the two options and let the maintainer choose; once chosen, record it in section 14, "Decision record", and follow the record from then on.
- **Hard rules** (from `AGENTS.md`): only original material, no code, icons or graphics copied from other products; interface text is English only, and goes through `t()` in `i18n.js`; do not change DSH itself.

## 1. Design principles

1. **One surface changes shape.** When the state changes, the same surface changes its size and content; one element does not disappear while another appears. The top pill is the example.
2. **Shapes use springs only.** Changes in size, position and corner radius must use the springs in section 9; only color and opacity may use a fixed duration.
3. **What comes in goes out.** Popovers, dialogs and menus must play an exit animation when they close; they cannot just unmount.
4. **Quiet when nothing happens.** Avatars and the interface move only when the state changes or the user acts. Continuous ambient animation appears only at the "Lively" level (section 8.4).
5. **Content waits for the surface.** While a surface changes shape, its content does not reflow; large content fills in after the change ends.
6. **Text says only what the user needs.** No development discussion, plans or process; see section 11.
7. **All colors come from the theme.** Components do not hard-code colors; see section 2.

## 2. Color

### 2.1 Themes

A theme defines 8 base colors each for light and dark. Every `--bt-*` variable is derived from these 8 colors, so changing the theme recolors the whole team interface (`themes.js`).

| Base color | Meaning |
|---|---|
| `bg` | Main area background |
| `sidebar` | Sidebar and settings navigation background |
| `bubble` | Bot message bubble |
| `card` | Cards, input boxes, popover cards |
| `text` | Body text |
| `user` / `userText` | User bubble and its text |
| `accent` | Accent color |

Built-in themes:

| Theme | Light bg / text / accent | Dark bg / text / accent |
|---|---|---|
| DeepSeek (default) | `#fcfcfc` / `#141414` / `#4d6bfe` | `#141414` / `#f2f2f2` / `#5b7bff` |
| Mono | `#ffffff` / `#0d0d0d` / `#0d0d0d` | `#0f0f0f` / `#f4f4f4` / `#f4f4f4` |
| Paper | `#faf9f5` / `#1f1e1b` / `#d97757` | `#1f1e1b` / `#f3f0e8` / `#e08a6d` |
| Moonlight | `#f7f9fc` / `#121826` / `#1e86ff` | `#0b1020` / `#e8edf7` / `#4f9dff` |

The user can override the accent color in Settings → General (7 presets or a custom color). A preset uses `INKS[ink][0]` in the light interface and `INKS[ink][1]` in the dark interface; a custom color has the same value in both. DSH marks dark mode with `data-ds-dark-theme` on `body`.

### 2.2 Semantic variables

Components must use only these variables, never raw color values.

| Variable | Derived from | Use |
|---|---|---|
| `--bt-ink` | `text` | Body text, icons |
| `--bt-ink-2` | `text` 60% | Secondary text, descriptions, default icons |
| `--bt-ink-3` | `text` 36% | Faint text, placeholders, empty states |
| `--bt-main` | `bg` | Main area, menu and dialog backgrounds |
| `--bt-sidebar` | `sidebar` | Sidebar, settings navigation; badge outline |
| `--bt-card` | `card` | Cards, input boxes |
| `--bt-bubble` | `bubble` | Bot bubble |
| `--bt-line` | `text` 8% | Card and input box borders (1px), dividers |
| `--bt-line-2` | `text` 15% | Hairline edge of raised surfaces (.5px) |
| `--bt-hover` | Light `rgba(119,119,119,.09)`, dark `rgba(160,160,160,.12)` | Hover background; secondary button background |
| `--bt-active` | Light `.17`, dark `.2` | Selected and pressed background |
| `--bt-accent` / `--bt-accent-ink` | `accent`; the text color is whichever of `#141414` and white has the higher contrast (decided 2026-10-16) | Primary button, switch, focus ring, unread dot, "New" divider, new-message pill |
| `--bt-user` / `--bt-user-ink` | `user` / `userText` | User bubble |
| `--bt-tag-bg` / `--bt-tag-ink` | `text` 6% (dark 9%) / 58% | Labels |

### 2.3 Status colors

| Status | Value | Use |
|---|---|---|
| Accent | `--bt-accent` | Primary action, selection, focus |
| Success / working | `--bt-green` (`#00c972`) | Working badge, done check mark |
| Main Bot | `--bt-star` (`#ff9800`) | Main Bot star |
| Danger | `--bt-danger` (`#e02135`, set once in the base style sheet, the same value in both interfaces) | Delete, error text, confirm-state background (`color-mix` 10%) |
| Warning / waiting for your answer | Not decided (see current deviations) | Waiting-for-your-answer dot, notices that need attention |
| Notice dot / recording | Not decided (see current deviations) | Update notice dot, microphone while recording |

A status badge's background should mix about 80% with the sidebar background to soften it (`color-mix(in srgb, <color> 80%, var(--bt-sidebar))`).

### 2.4 Character colors

Colors for Bot characters (`inks.js`), each with a light and a dark value:

- 12 colors to choose for a character: black, brown, red, orange, yellow, green, cyan, blue, violet, magenta, gray, plus one gradient, aurora.
- 7 accent presets: deepseek, charcoal, graphite, rose, sky, tangerine, cobalt.
- When a new Bot has no color chosen, one is picked deterministically from its Bot id, out of the colors left after removing black, gray, brown and the gradient.
- The first Main Bot is always the deepseek-blue whale.

Bot names and mentions are written in the same color; pure black reads like a heading, so text uses gray instead.

### 2.5 Rules

- Must: use only the variables in section 2.2 and the status colors in section 2.3.
- Must: add a new color to the theme derivation (`themeVars`) first, then use the variable in the component.
- Should: use the accent color only on primary actions, selected states, focus rings and unread notices, with no more than two large accent areas on one screen.
- Should: raised surfaces (pill, menus, dialogs) use a `.5px var(--bt-line-2)` hairline edge; flat cards and input boxes use `1px var(--bt-line)`.

**Current deviations** (`2f9300d`):

- Red has 4 values: `#e02135` (17 places, danger), `#c21d2e` (5 places: menu danger items, the danger zone in Bot settings, missing model, error text for folders and updates), `#E5484D` (2 places: update notice dot, connection warning dot), `#ff3e51` (microphone while recording, end voice, and also in the custom color wheel). Unify as `--bt-danger`; whether the notice dot and recording get a separate variable is not decided.
- No warning color is defined, and the code has two sets: `#e3a008` (4 places: waiting-for-your-answer dot, warning level in feedback, star on the about page) with text color `#b7791f` / dark `#f0b84a` (`member-status.js`); the secret card uses `#b25e09` / `#f59e0b` instead. Unify as `--bt-warn` (plus a text color).
- Besides `--bt-green`, the secret card hard-codes `#16a34a` as a success color and gives `--bt-green` a different fallback, `#22a06b`.
- Leaving out the theme files and variable definitions, components hard-code about 80 hex colors across 15 files (nearly half in `styles.js`). Where white or black is used for text and icons on the accent color, use `--bt-accent-ink` instead.

## 3. Type

### 3.1 Font families

- Interface: `var(--bt-font)`, which is DSH's body font `--dsw-font-family` (if the user set a body font in DSH, that one is used); without a DSH theme it falls back to `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.
- Code, secrets, paths: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`.
- The font size of conversation content follows DSH's `--dsh-content-font-size` (default 14px).
- No Chinese font is named: the desktop app replaces DSH's built-in fonts with a version that names no Chinese font (`app/src/fonts.css`) and leaves Chinese to the system fallback (PingFang on macOS through `-apple-system`, fontconfig's choice on Linux, the system or user-installed Chinese font on Windows); in DSH Desktop / Web it follows DSH.

### 3.2 Type scale

Must use only the sizes in the table below.

| Step | Size / line height | Weight | Use | Example |
|---|---|---|---|---|
| Chart | 10 / 12 | 400 | Chart ticks only | Months on the usage heatmap |
| Caption | 11 / 16 | 400–500 | Counts, times, small chips | `.bt-chip` |
| Small | 12 / 16 | 400–500 | Labels, descriptions, small buttons, errors | `.bt-tag`, `.bt-note`, `.bt-soft-sm` |
| Body | 13 / 18 | 400 | Settings rows, menu items, panel body text, lists | `.bt-set-row`, `.bt-menu button` |
| Content | 14 / 22 | 400 | Input boxes, primary buttons | `.bt-soft` |
| Bubble | 14 / 24 | 400 | Body text of conversation bubbles; the line height is the font size + 10 and follows --dsh-content-font-size | `.bt-bubble`, `.bt-ububble` |
| Pill | 14 / 20 | 400 | Top pill | `.bt-pill` |
| Subheading | 15 / 20 | 600 | Dialog titles, card titles | `.bt-settings-head h2`, `.bt-q-title` |
| Heading | 17 / 24 | 500 | Bot name in the details panel | `.bt-drawer-name` |
| Figures | 22, 34 | 600 | Large figures on the usage page | `.bt-us-stat-value` |

- Weights are only 400, 500 and 600. Section headings are 13/600 (`.bt-set-section h3`).
- Number columns should use tabular figures (`font-variant-numeric: tabular-nums`).

**Current deviations** (`2f9300d`):

- 12.5px in 5 places (3 in `browser-pane.js`, 2 in `sidebar.js`: browser tabs and cards, the update card) becomes 12 or 13; 11.5px in 1 place (`secret-card.js`, code in the secret description) becomes 11 or 12.
- 16px in 3 places (`about.js:114`, `styles.js:198`, `styles.js:529`) and 18px in 1 place (`styles.js:561`) are not on the scale; move each to the nearest step or note that it is a graphic.
- Weight 700 in 1 place (`styles.js:151`, the "!" in the connection warning dot) is a graphic and may stay.
- Line heights have about 10 more values off the scale, such as 17, 19, 21, 26 and 28px (about 35 places); some of them center single-line controls vertically.
- 8.5px is used only in the "?" of the status badge; it is a graphic and stays.

## 4. Spacing and size

### 4.1 Spacing

The base unit is 4px, with 2 and 6 allowed as half steps.

| Value | Use |
|---|---|
| 2 | Between buttons in a group, between list rows, between menu items |
| 4 | Between icon and text (compact) |
| 6 | Between label and field, menu container padding |
| 8 | The most common spacing within a group; between icon and text (regular) |
| 10 / 12 | Card padding, settings row padding (10 × 12) |
| 16 | Dialog padding, panel margin |
| 20 / 24 | Between sections |

### 4.2 Control heights

| Height | Control |
|---|---|
| 20 | Switch |
| 28 | Small button, icon button, send button in the conversation |
| 32 | Compact input box, items in a tab strip |
| 36 | Standard button, round button, input box, sidebar row avatar |
| 40 | Top pill, primary button (large) |
| 44 | Minimum height of the input card, panel tab strip |

Clickable areas must be at least 28 × 28.

### 4.3 Layout sizes

| Area | Size |
|---|---|
| Settings dialog | Width `min(1100px, 100vw - 48px)`, height `min(780px, …)`, the same size for every page (matching the usage page) and unchanged when switching pages; left navigation 198px |
| Memory dialog | Width `min(680px, 100vw - 48px)`, height `min(760px, …)` |
| Right panel | Details 320px; browser 520px by default, resizable, minimum 360px, and the conversation column keeps at least 420px |
| Left sidebar | Like the right panel, it is not squeezed narrower. Drag the right edge to set the width, 264–420px; release below 176px and it snaps to an 88px avatar rail (44px avatars); drag out from the rail to get the full sidebar back. The toggle in the top-left corner (and its shortcut) collapses the whole column, and another click restores it. When the window gets narrower, the right panel collapses first (and comes back when it fits), then the left sidebar collapses to the avatar rail; when a panel opens in a narrow window, the left sidebar first collapses to the rail to make room, and the panel covers the conversation only if it still does not fit. Windows, macOS and the web all behave the same. The desktop app's minimum window width is 508px (rail + 420) |
| Bubbles | Bot bubble at most `min(var(--bt-msg-w) × 100%, 100% - 82px)` wide, user bubble at most `var(--bt-msg-w) × 100%`; `--bt-msg-w` is the bubble width setting (50%–100%, default 80%) |
| Input card | At most `min(992px, 100%)` wide |
| Main Bot card | 95px wide |

### 4.4 Avatar sizes

| Size | Where |
|---|---|
| 20 | Bot in the secret card |
| 22 | Next to messages in the conversation |
| 24 | Top pill, command palette |
| 28 | Bot list in settings, activity row ("X is …") |
| 36 | Sidebar row |
| 48 | Browser empty state |
| 60 | Main Bot card in the sidebar |
| 64 | Details panel |

## 5. Corner radius

Must use only the radii in the table below.

| Value | Use |
|---|---|
| 4 | Labels, chips |
| 6 | Menu items, mini buttons |
| 8 | Input boxes, dropdowns, items in a segmented button |
| 10 | Segmented control frame, sidebar rows |
| 12 | Cards, menus, Main Bot card, toast, command palette, settings cards |
| 16 | Settings dialog |
| 18 | Bubbles |
| 20 | Memory dialog |
| 22 | Input card (18 when it has several lines or attachments) |
| 999px | Pill shape: standard buttons, tabs, top pill, switch |
| 50% | Circle: avatars, round buttons, badges, swatches |

**True circles**: DSH sets `corner-shape: superellipse(1.5)` on every element, so `border-radius: 50%` draws a rounded square. Places that need a true circle (badges, status dots) must add `corner-shape: round`. The desktop app's own pages are not inside DSH: the start window (`start.css`) and the in-page cards and pickers (`page-card.css`, where the card's `all:unset` also clears it) set the same `superellipse(1.5)` themselves, so a 999px button looks the same as in the plugin, a rounded rectangle like the top pill.

**Current deviations** (`2f9300d`): about 20 radii are off the scale, mostly in `browser-pane.js` (9, 7, 5, 3, 2px, 8 places in all) and `usage-page.js` (9, 5, 3, 14px, 30%, 7 places in all); there are also 14px in `sidebar.js`, 5px in `secret-card.js`, 13px in `member-status.js`, 1px in `styles.js` and `9999px` ×2. 9 → 8 or 10; 9999px → 999px; the rest go to the nearest value in the table. Chart elements on the usage page (bars, cells) may be exceptions, noted in a comment.

## 6. Shadows and layers

### 6.1 Elevation levels

| Level | Shadow | Edge | Use |
|---|---|---|---|
| 0 flat | None | `1px var(--bt-line)` | Cards, input boxes |
| 1 raised | `0 2px 8px -1px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04)` | `.5px var(--bt-line-2)` | Top pill; the input card uses the same shape with `.05 / .03` plus a 1px outer ring |
| 2 popover | `0 10px 20px -3px rgba(0,0,0,.1), 0 4px 6px -4px rgba(0,0,0,.1)` | `.5px var(--bt-line-2)` | Menus, dropdowns, popover cards |
| 3 toast | `0 8px 28px rgba(0,0,0,.14)` | `1px var(--bt-line-2)` | Toast |
| 4 dialog | `0 24px 80px rgba(0,0,0,.24)` | `.5px var(--bt-line-2)` | Settings, memory; scrim `rgba(0,0,0,.32)` |

### 6.2 z-index

| Value | Layer |
|---|---|
| 0–8 | Local stacking within the page |
| 30 | Top pill notifications |
| 40 | Right panel |
| 45 | Drag shield, sidebar pop-out pane |
| 60 | Menus, settings dialog, emoji bar, update card |
| 61 | Memory dialog |
| 70 | Avatar editor, tooltip bubble, command palette |
| 1000 | Toast |

**Current deviations** (`2f9300d`): the code has 41 different shadow values (about 20 on 10-11), and only 4 of them exactly match levels 1–4 in section 6.1. Examples: the command palette `.bt-palette` uses `0 24px 48px -12px rgba(0,0,0,.25)`, the avatar editor `.bt-avedit` uses `0 12px 40px rgba(0,0,0,.18)`, and the usage page date picker `.bt-us-pick` uses `0 22px 50px -18px rgba(0,0,0,.32),…`. Unify them into the five levels; outline rings such as `inset 0 0 0 1px var(--bt-line)` and the badge's background-colored ring are not shadow levels and are listed separately.

## 7. Icons

- Must: draw them ourselves; do not use other products' icons. The official DSH whale (`FishLogo`) is used only to stand for the DSH Agent.
- Canvas: `viewBox="0 0 20 20"`, stroke only with no fill, `stroke="currentColor"`, round caps and joins (`stroke-linecap/linejoin: round`).
- Stroke width: 1.5 for 15px icons; 1.6 for 16–18px icons; arrows may use 1.8.
- Size: 14–15px in menus and inline; 16px in buttons; 18px for primary actions like the plus.
- Color follows the text (`currentColor`), `--bt-ink-2` by default and `--bt-ink` on hover.
- The current icons are in `icons.js`: plus, search, person, up arrow, microphone, sound wave, share, close, left and right arrows, cloud download, smiley, reply, more, check mark, down arrow, download, gauge, plug, calendar, connector, switch, paper clip, clock, gear, pin, unread, pencil, star, copy, hide, delete, duplicate, sliders, memory, group chat. The browser panel also has globe, forward, back, reload and lock (`browser-pane.js`).

## 8. Bot characters

### 8.1 Characters

- 20 original characters, generated with `dev/characters.mjs`: each is a small 3D model traced from a fixed three-quarter view into flat layers (body, decal, shadow away from the light, highlight toward the light), placed on a 100-unit canvas.
- The eyes are holes cut out of every layer, so the color behind shows through. The eyes' position and tilt follow the surface, and the near eye is wider than the far eye.
- Character list: whale, star, moon, wave, squircle, zed, hex, gumdrop, peanut, saucer, bunny, kitty, beacon, plus, magnet, acorn, pebbles, cushion, ring, gem.
- Must: add new characters through the generator, not by editing the data in `characters.js` by hand; never use any vendor's logo as a decal.
- The user can also upload a photo in place of a character (cropped to a circle).

### 8.2 Badges

- Round badge: 12px across (8px while working), flush with the bottom-right corner, a `1.5px` outline in the sidebar background color, `corner-shape: round`. Working is a green dot; waiting for your answer is a "?" in the accent color.
- Main Bot: one large solid star, sized with the avatar (36% of the avatar, 14–22px), separated by an outline in the sidebar background color.
- Group admin: a small star on a round base (`AdminStar`), used in group members, group settings and new group chat. When the same Bot in a group is both a Main Bot and an admin, the small admin star is shown.
- The large avatars in the details panel and the top pill show no badge.

### 8.3 Status motions

| Status | Body | Eyes |
|---|---|---|
| Idle | Still (for the Lively level see 8.4) | Still |
| Thinking | Head tilted, slow rise and fall, 2.2s | Squint |
| Searching | Peeks left and right, 1s | Glance left and right |
| Working | Bobs up and down, 1.6s (three kinds by shape: bob, sway, squash) | Blink |
| Sending a message | Lunges forward, 1.1s | — |
| Waiting for your answer | Jumps twice when the question arrives | — |
| Done | One squash and rebound, 1.8s | — |

### 8.4 Three animation levels

Settings → Bots → Animation, applied to the whole team (`body[data-bt-motion]`).

| Level | Content |
|---|---|
| Quiet | Only the status motions in 8.3 |
| Normal (default) | Quiet + interaction: nuzzle on avatar hover, spin when the large avatar is clicked, eyes follow the pointer |
| Lively | Normal + occasional blinks and small moves while idle (jump, sway, stretch, look around; one kind per Bot, a 9-second cycle, staggered between Bots); while waiting for your answer it keeps jumping and the "?" moves above its head |

### 8.5 Petting

- Triggers only on the avatar, or in a ring around it (20% of the avatar size wide).
- Motion: a spring tilt of 8° toward the pointer, then nuzzling back and forth (up to 14°, a 0.78s period) until the pointer leaves; after it leaves, it springs back from its current pose.
- Eyes: the capsule eyes fold away and become closed `^ ^` arcs.
- Works only for Bots that are idle or waiting for your answer.

## 9. Motion

### 9.1 Springs

Every spring is sampled by `springEasing(stiffness, damping)` into a CSS `linear()` curve (`motion.js`), usable by both CSS transitions and WAAPI. You must use the constants in the table below and must not set your own parameters in a component.

| Constant | ω / ζ | About | Overshoot | Use |
|---|---|---|---|---|
| `SPRING_SHAPE` | 20 / 0.78 | 420ms | 2% | Surface shape changes, dialogs, pages, switch thumb |
| `SPRING_TAP` | 30 / 0.8 | 290ms | 1.5% | Press, popover entrance |
| `SPRING_LIST` | 22 / 0.8 | 190ms | 0 | List reordering |
| `SPRING_STRETCH` | 18 / 0.56 | 560ms | 12% | Surfaces that stretch open ("Memory updated" in the pill) |
| `SPRING_POP` | 22 / 0.49 | 430ms | 17% | Small marks popping in (check marks, icons) |
| `SPRING_LEAD` / `SPRING_TRAIL` | 28 / 0.86, 17 / 0.86 | about 0.3s | ≈0 | Leading / trailing edge of a slider |
| `QUICK_EDGES` | 30 / 0.85, 20 / 0.85 | about 0.3–0.45s | ≈0 | Highlights that follow the keyboard and pointer |
| Layout glide (not yet a constant) | 31.6 / 1.0 (`springEasing(1000, 63)`) | about 0.3s | 0 | Sidebar row reordering. It is now written only in `GLIDE` in `sidebar.js:214` and should move into `motion.js` as a shared constant |

`spring(curve, property…)` builds the transition string, for example `spring(SPRING_TAP, 'scale')`.

### 9.2 Fixed durations

Only for color, opacity and changes that do not involve shape:

| Duration | Use |
|---|---|
| .12s ease | Hover background, text color, border (default) |
| .16s | Exit fade-out |
| .22s ease-out | Content blur fade-in (`bt-veil-in`), scrim fade-in |
| `cubic-bezier(.22,1,.36,1)` | Cascading entrance and rolling numbers on the usage page (usage page only) |

Durations of 1 second or more are the avatars' looping motions (section 8.3), and millisecond values are stagger delays; neither is limited by this table.

**Current deviations** (`2f9300d`):

- Fixed durations under 1 second include, besides .12, .16 and .22s, about 20 more such as .1, .13, .14, .15, .18, .2, .24, .25, .28, .3, .32, .36, .4 and .45s, in about 80 places.
- There are 10 `cubic-bezier` curves in 40 places. Of these, `(.34,1.56,.64,1)` overshoots and is used in 6 places for shape changes; it should become `SPRING_POP`. `(.22,1,.36,1)` is also used outside the usage page (`group-settings.js`, `schedules.js`, `secret-card.js`, `styles.js`).

### 9.3 Shared parts

| Name | What it does | Used in |
|---|---|---|
| `useGlide` | Slides a thumb to the selected item; the leading edge is fast and the trailing edge slow, so it stretches while moving and contracts on arrival; a target change midway keeps the velocity | Settings navigation, segmented controls, tabs everywhere, command palette highlight |
| `Segmented` | A row of buttons with a `useGlide` thumb (`aria-pressed`) | The three animation levels, "Who answers" in group chats |
| `useFlip` | List items slide from their old position to the new one, and new items sharpen out of a blur | Command palette results, new conversation dropdown |
| `useMorph` | The container height follows its content on a spring | New conversation dropdown, connector expansion, "Show more" |
| `useLinger` | Keeps an element for a moment after closing and unmounts it after the exit plays | Settings, memory, menus, model menu |
| `bt-veil-in` | Opacity + blur 6px → 0, .22s | Every entering content layer |
| Press | The separate `scale` property on `SPRING_TAP` | Text buttons .96, icon buttons .9 |

### 9.4 Entrance and exit

| Surface | Entrance | Exit |
|---|---|---|
| Menus, dropdowns (opening downward) | `bt-pop-drop`: up 4px, scaled to .96 → in place, `SPRING_TAP` | `bt-pop-out`: fade out, scale to .97, blur 2px, .12s |
| Popovers opening upward | `bt-pop-lift`: down 4px → in place | Same as above |
| Dialogs | `bt-dialog-rise`: down 12px, scaled to .96 → in place, `SPRING_SHAPE`; content `bt-veil-in` | `bt-dialog-sink`: sink 6px, scale to .975, blur 3px, fade out, .16s |
| Pages in settings | Going one level in comes from the right (18px), going one level out from the left, the same level from below (10px) | — |
| Toast | Rises from 16px below, scaled to .94 | Fade out |

- Must: popover keyframes animate only the separate `translate` / `scale` properties and never touch `transform`, so elements already positioned with `transform` need no change.
- Must: on close, use `useLinger` to keep the element until the exit ends.

### 9.5 Performance

- Must: frame-by-frame animations animate only `transform`, `translate`, `scale`, `rotate` and `opacity`.
- Must: infinitely looping animations (avatar status motions, shimmering text) run only while visible: they pause when the page is hidden, when the window has had no input for 30 seconds or when the element is outside the viewport, and resume on input or when back in the viewport (`motion-rest.js`). As long as one loop is running, the window repaints every frame.
- Must: do not animate frame by frame the properties that cause large reflows (`width`, `height`, `margin`). When width or height really must change:
  - While the surface changes shape, its content is fixed at the final size and only the edge moves (the right panel does this).
  - Large content next to it (the conversation column) reflows only once: it makes room at once when the surface grows, and takes the space back after the surface has finished shrinking.
- Should: use blur only on small layers. No blur on a whole panel or a whole page.
- Should: render large content after the frame has finished changing shape, and use `startTransition` to yield the main thread.

### 9.6 Reduced motion

When the system has "Reduce motion" turned on (`prefers-reduced-motion: reduce`):

- Must: all avatar motion stops.
- Must: sliders jump straight to the end; dialogs only fade in; other added animations are turned off.
- `reducedMotion()` is in `motion.js`, and a JS animation must check it before it starts.

**Current deviations** (`2f9300d`, still present):

- `browser-pane.js:31` has its own copy of `SPRING_LEAD` / `SPRING_TRAIL` (ω 24 / 12), different from the shared values in `motion.js` (ω 28 / 17); change it to reference `motion.js`. The values of `GLIDE` in `sidebar.js:214` (ω≈31.6, ζ=1) are correct but not in `motion.js`; move it into a shared constant with the same values.
- There are 99 keyframes, and some differ by only one value. For example, a plain fade-in exists as `bt-fade`, `bt-fade-in`, `bt-blur-in`, `bt-veil-in` and `bt-us-fade`. Merge them into the kinds in section 9.4.

## 10. Components

Each component states its use, size, states and motion. Class names are the ones in the current code.

### 10.1 Buttons

| Kind | Class | Size | Look | Use |
|---|---|---|---|---|
| Primary button | `.bt-send` | Height 40 (small 28), pill shape | Accent background, `--bt-accent-ink` text | At most one per interface: send, create, save |
| Secondary button | `.bt-soft` / `.bt-soft-sm` | Height 36 / 28, pill shape, 16 / 12 left and right | `--bt-hover` background | Other actions |
| Round button | `.bt-round` | 36 × 36 | 1px `--bt-line` edge, `--bt-main` background | Search and new at the top of the sidebar |
| Icon button | `.bt-icon-btn` | 28 × 28, round | Transparent background, `--bt-ink-2` icon, background on hover | Toolbars, close |
| Mini button | `.bt-mini` | Font size 12, radius 6 | Transparent background | Small inline actions (copy, more) |

- States: hover changes the background (.12s); press is `scale` .96 (icon button .9) on `SPRING_TAP`; disabled is `opacity: .35` with no press response.
- Dangerous actions: text in the danger color, placed last in the menu after a divider; actions that cannot be undone need a second click to confirm.

### 10.2 Input

| Kind | Class | Size |
|---|---|---|
| Input box | `.bt-input` | Height 36, radius 8, 1px `--bt-line` edge, `--bt-card` background, font size 13 |
| Dropdown | `.bt-select` | Height 34, radius 8 |
| Multi-line input | `.bt-input-area` | Minimum height 80 |
| Field | `.bt-field` | Label (12, `--bt-ink-2`) on top, spacing 6 |

### 10.3 Selection

| Kind | Class / component | Spec |
|---|---|---|
| Segmented control | `Segmented` (`.bt-seg`) | Frame radius 10, padding 2, `--bt-hover` background; buttons 30 high, radius 8; the thumb uses `useGlide`, and the selected item has a `--bt-card` background with a light shadow |
| Switch | `.bt-switch` | 36 × 20, round thumb 16; accent color when on; the thumb runs on `SPRING_SHAPE`; while held, the thumb stretches to 21px |
| Swatch | `.bt-swatch` | 22 × 22 circle, 2px outline when selected |

Use a segmented control for two to four mutually exclusive options, a switch for on / off, and a dropdown for more options.

### 10.4 Labels and badges

| Kind | Class | Spec |
|---|---|---|
| Label | `.bt-tag` | Font size 12, 6 left and right, radius 4, `--bt-tag-bg` background, at most 96px wide with an ellipsis for overflow |
| Chip | `.bt-chip` | Font size 11, radius 4, 1px edge |
| Status badge | `.bt-badge-*` | See 8.2 |

### 10.5 Menus

- `.bt-menu`: radius 12, padding 6, minimum width 200, `--bt-main` background, level 2 shadow.
- Menu item: minimum height 30, radius 6, padding 6 × 8, font size 13; 16px icons; `--bt-hover` on hover.
- Divider `.bt-menu-sep`; danger items go last.
- Motion: see 9.4. Keyboard: `Esc` closes; arrow keys should move between menu items (current deviation #11).

### 10.6 Dialogs

- Structure: scrim `.bt-scrim` + dialog. The dialog has radius 16 (memory 20) and a level 4 shadow.
- Settings dialog: 198px left navigation (`--bt-sidebar` background, the selected item uses a vertical `useGlide` thumb), with the page on the right.
- Page content uses "section + card + row":
  - Section heading `h3`: 13 / 600, bottom margin 8.
  - Card `.bt-set-card`: radius 12, 1px `--bt-line` edge, `--bt-card` background.
  - Row `.bt-set-row`: padding 10 × 12, label on the left, control on the right; a 1px divider between rows.
  - Rows have no description text by default (section 11).
- Close: the close button in the top-right corner, `Esc`, or a click on the scrim.

### 10.7 Right panel

- Details 320px; browser 520px by default, with a draggable left edge.
- A 44-high tab strip at the top: the Bot itself is the first tab, each browser page has a tab, and each side conversation has a tab; under the selected tab is a thumb that moves on leading and trailing edge springs.
- When the width changes, the tab strip and the view are fixed at the final width and pinned to the right, and only the panel's left edge moves (section 9.5).

### 10.8 Cards

| Card | Use | Spec |
|---|---|---|
| Settings card | Settings pages | See 10.6 |
| Question card `.bt-q` | A Bot asks the user a question | White card, 1px inset outline, padding 14 × 16, spacing 12; option rows with radius 12 and padding 10 × 8, with dividers between options (as it looks after the question card polish of 2026-10-11). Rises from below on a spring, and the submit button pops in |
| Browser card `.bt-bcard` | Open pages in details | Radius 12, `.5px` edge, title + text preview |

### 10.9 Feedback

Choose by where the problem is:

| Kind | Class | When to use |
|---|---|---|
| Inline error | `.bt-error` | A field or an action failed; the error is written next to it |
| Toast | `.bt-toast` | Messages that belong to no place, such as a failed background request; bottom center, radius 12, level 3 shadow, with a "Details" link |
| Empty state | `.bt-empty` | An empty list; 13 / `--bt-ink-3`, centered, one sentence |
| Skeleton | — | Placeholder while loading, no spinner; replaced with `bt-veil-in` when the content arrives |
| Shimmer | — | Text for something in progress ("Thinking…"), with a light sweeping across the text |

### 10.10 Top pill

- Height 40, pill shape, 24px avatar on the left, level 1 shadow.
- On hover a right arrow pops out (width 0 → 18px, blur fade-in); a click opens the right panel.
- When an event happens (such as "Memory updated"), it stretches to the right (`SPRING_STRETCH`), the icon pops in (`SPRING_POP`), and then it contracts (`SPRING_SHAPE`).
- This is the motion reference: every new surface that changes shape works the same way.

### 10.11 Sidebar

- Main Bot card: width 95, radius 12, 60px avatar + name + role label.
- Row: 36px avatar + name + one line of preview; `--bt-hover` on hover; `--bt-active` when selected; a pinned row shows a small pin next to the name.
- When the list order changes, rows slide to their new positions on the layout glide spring (ω≈31.6, ζ=1). This spring is now written only in `GLIDE` in `sidebar.js` and should move into `motion.js` (current deviation #7).

### 10.12 Conversation

- Bubbles: radius 18, padding 7 × 12; Bot bubble `--bt-bubble`, user bubble `--bt-user`.
- Input card: minimum height 44, radius 22 (18 when it has several lines or attachments), padding 7.5, the input variant of the level 1 shadow; "+" on the left, microphone and send button on the right.
- Activity row ("X is …"): height 36, 28px avatar + shimmer text. It enters with a scale of .9 → 1 plus a fade-in (`SPRING_TAP`) and exits in .14s, scaling to .92 with a fade-out and blur.
- Reading pill `.bt-reading` ([Reading long replies](../plans/2026-11-13-long-reply-reading.md)): height 28, glass background, `.5px` hairline edge; buttons 24 high, font size 12, `--bt-ink-2`; enters with `bt-pop-drop`, exits with `bt-pop-out` .12s; the outline menu uses `.bt-menu`.

## 11. Text

- Must: write only what the user needs. Do not put the discussion, plans or process from a session into the interface (for example "right away", "later", "next version"), except for wording the user gave verbatim.
- Must: settings have no description text by default. When one is really needed, write one neutral sentence about what the setting does; do not repeat the wording from a session, and do not compare options. If in doubt, leave it out.
- Must: write interface text in English only, and pass it through `t()` from `i18n.js` so that `{name}` slots are filled in one place.
- Should: English uses sentence case; labels and buttons have no period; buttons start with a verb (Create, Save, Delete).
- Should: error text says clearly what happened and what the user can do, placed next to where the error happened.
- Terms:

| English | Chinese |
|---|---|
| Bot | Bot |
| Main Bot | `主 Bot` |
| Group chat | `群聊` |
| Group admin | `群管理员` |
| DSH Agent | DSH Agent |
| DeepSeek Harness / Harness | DeepSeek Harness / Harness |
| Memory | `记忆` |
| Connectors | `连接器` |
| Scheduled tasks | `定时任务` |
| Usage | `用量` |

## 12. Accessibility

- Must: icon buttons have an `aria-label`; menus have `role="menu"`, dialogs `role="dialog"` + `aria-modal`, switches `role="switch"` + `aria-checked`, segmented controls `role="group"` + `aria-pressed` on the buttons.
- Must: usable from the keyboard. `Esc` closes the top layer; the `Tab` order matches the visual order.
- Must: focusable controls have a focus ring: `2px solid var(--bt-accent)`, offset 1–2px, shown only on `:focus-visible`.
- Must: text and icons on the accent color use `--bt-accent-ink`. It is whichever of `#141414` and white has the higher contrast, not a fixed luminance threshold.
- Must: follow the reduced motion rules in section 9.6.

**Current deviations** (`2f9300d`): there are 10 `:focus-visible` rules in all, covering only switches, model selection, secret options, the top pill, question card options, tool rows and the memory delete button. Buttons, menu items, tabs and sidebar rows still need them. Menus (context menu, model menu, folder menu, account menu, "+" menu) support only `Esc`, not arrow keys; arrow keys work today only in the command palette, the new conversation dropdown, the memory panel and the top pill.

## 13. Summary of current deviations

Checked against `dev` `2f9300d` (2026-10-15). In parentheses is the state at draft 0.1 on 10-11.

| # | Item | Current | Standard |
|---|---|---|---|
| 1 | Red | 4 values: `#e02135`, `#c21d2e`, `#E5484D`, `#ff3e51` (2 at 0.1) | One `--bt-danger` = `#e02135` (decided 2026-10-15). Danger uses are unified (#268, 2026-10-16); the notice dot `#E5484D` and recording `#ff3e51` are not decided. Note: `#e02135` as text on a dark background reaches only 3.2–3.9:1; whether the dark interface gets a separate value is not decided |
| 2 | Warning and success colors | No warning color defined, two sets in the code; success also has `#16a34a` and `#22a06b` (not recorded at 0.1) | `--bt-warn` + text color; only `--bt-green` |
| 3 | Hard-coded colors | About 80 hex colors in components (not recorded at 0.1) | Only the variables in sections 2.2 and 2.3. The unread dot, "New" divider and new-message pill follow the accent color (decided 2026-10-15) |
| 4 | Font sizes and weights | 12.5px ×5, 11.5px ×1, 16px ×3, 18px ×1; about 10 line heights off the scale | Only the steps in 3.2 |
| 5 | Corner radius | About 20 off the scale, mostly in the browser panel and the usage page | Only the values in section 5 |
| 6 | Shadows | 41 values (about 20 at 0.1) | The five levels in 6.1 |
| 7 | Custom springs | The slider spring in `browser-pane.js` differs from the shared values; the layout spring in `sidebar.js` has correct values but is not in `motion.js` | Both reference `motion.js`; the layout spring becomes a constant with the same values |
| 8 | Fixed durations and curves | About 20 durations, 10 `cubic-bezier` curves, 6 places with overshoot (not recorded at 0.1) | The three durations in 9.2; shape changes use springs |
| 9 | Keyframes | 99 (about 100 at 0.1) | Merged into the kinds in 9.4 |
| 10 | Focus ring | 10 `:focus-visible` rules (unchanged) | Every focusable control |
| 11 | Menu keyboard | 5 kinds of menu have only `Esc` (unchanged) | Arrow keys move between menu items |
| 12 | New interfaces not covered | Added or reworked since 0.1: folder menu, permission picker, approval prompt, group member status (`member-status.js`) | Add to section 10 |
| 13 | Preset accent colors in the dark interface | The 7 preset accent colors store the light value (`prefs.accent` = `INKS[ink][0]`), and the dark interface uses it too. Charcoal `#141416` on the dark background `#141414` is 1.00:1, Graphite 1.34:1, Cobalt 2.48:1 (found 2026-10-16) | Decided (2026-10-16): the dark interface takes `INKS[ink][1]`, and custom colors are unchanged. Fixed in #267 |

Unifying these deviations touches many files. It is best done in several passes, one item per pass, with a screenshot comparison in DSH each time.

## 14. Decision record

Where a practice has a trade-off, or once had two candidates, the maintainer's choice is recorded here. A new entry gives the date, what was chosen, and the reason or the cost.

| Date | Item | Decision |
|---|---|---|
| 2026-10-10 | Motion of the settings dialog, details tabs and menus | Follow the feel of the top pill and the usage page: the dialog rises and sinks on a spring, tabs have a thumb, menus pop out on a spring and exit in 0.12s. Structure, sizes and colors stay the same |
| 2026-10-15 | Direction of the standard | Fix the current state in place; do not set a new visual design. Where practices are inconsistent, build a comparison preview and let the maintainer decide |
| 2026-10-15 | Settings dialog size | Every page uses the usage page size (`min(1100px, 100vw - 48px)` × `min(780px, …)`), so switching to the usage page no longer makes it larger. Neither candidate size (800 × 620, 900 × 700) is chosen. The look (radius 16, .5px edge, scrim, navigation, cards) stays as it is. #224 |
| 2026-10-15 | Unread dot, "New" divider, new-message pill | Follow the accent color instead of a fixed blue (`#1084fe`, `#0c64c1`). #225 |
| 2026-10-15 | Danger color | Unified as `#e02135` (`--bt-danger`) |
| 2026-10-15 | Items kept as they are | Tertiary text at 36%; dark backgrounds in the `#141414` family, shadows kept; the activity row (spring entrance, "· 1m" shown after a full minute); user bubbles always 18px; group chat names use the character color directly; tooltips use the native title |
| 2026-10-16 | Text color on the accent color | Whichever of `#141414` and white has the higher contrast, instead of black text only when luminance > 0.45. The old rule picked the lower-contrast side for 8 of the 15 accent colors, for example Tangerine with white text at 2.89:1 versus black at 6.38:1. Cost: the send button icon becomes dark in the DeepSeek dark, Moonlight and Paper themes. Changed in #225 |
| 2026-10-16 | Preset accent colors in the dark interface (current deviation #13) | A preset uses its dark value `INKS[ink][1]` in the dark interface, matching the color of Bot names; a custom color has the same value in both interfaces. A color counts as a preset only if it exactly equals a preset's light value (the same test as the settings page). Contrast on the dark background: Charcoal 1.00 → 16.45, Graphite 1.34 → 12.71, Cobalt 2.48 → 4.90. Cost: the same preset looks different in the two interfaces (Charcoal is near black in light and near white in dark), as in the Mono theme. Changed in #267 |
| 2026-10-16 | Danger color applied (current deviation #1) | The base style sheet sets `--bt-danger:#e02135`, and 22 danger colors (17 `#e02135`, 5 `#c21d2e`) now read it; the confirm-state background uses `color-mix`. The feedback notice box has the fallback `var(--bt-danger,#e02135)`, because when the interface fails to assemble it must still show without the base style sheet. The red of recording and the notice dot is unchanged (not decided). Cost: the 5 former `#c21d2e` places drop from 5.98 to 4.73:1 contrast in the light interface (on white) and rise from 3.08 to 3.89:1 in the dark interface. #268 |
| 2026-10-23 | Reasoning and context rows | Reasoning is hidden by default and can be turned on in Settings → General → Appearance; Bot conversations do not show DSH's context rows (such as "Tools updated"); the activity row is the only in-progress indicator (following Grok). #465 |
