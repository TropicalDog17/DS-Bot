# Message layout and width

- Date: 2026-10-22
- Related: #380, #446

## Why

The widest Bot reply bubble was fixed at 560px. On a wide screen the text column is 960px, so a Bot bubble took only 58% of it, narrower than the user's bubble (70.2% of the column, 674px). Long answers, code blocks and tables were squeezed into a narrow strip and wrapped often. #380 asks for an adjustable width; some users also prefer another way of reading: Bot messages without a bubble, laid out across the whole column like a document, each with who said it and when above it.

Trade-offs:

- Width is set with a slider as a percentage of the text column, not in pixels, so it stays proportional when the window size changes or the right panel opens. Three steps would be too coarse; a slider reaches the width each person likes.
- The two layouts can be switched: bubble and flat. In the flat layout Bot messages have no container, so if it shared one value with the bubble width, the 80% that suits bubbles would only leave an empty strip on the right in the flat layout, which looks like a bubble without a background. So the flat Bot text has its own width, which fills the whole column by default.
- Like the theme, accent color and Bot animation, it is stored in the team settings and shared by all devices.
- The text column itself is not changed (960px, see #28).

## Decided behavior

- Settings → General → Appearance:
  - "Message layout": a segmented button Bubble / Flat, Bubble by default, which takes effect at once.
  - "Text width": shown only in the flat layout, a slider from 50% to 100%, 100% by default.
  - "Bubble width": a slider from 50% to 100%, 80% by default.
  - "Show thinking" switch: off by default. When off, the conversation does not show the thinking process, and while the Bot is thinking there is only the activity line; when on, the thinking process shows above the reply as before.
  - Both sliders move in steps of 5%, with the current percentage shown beside them. The value is saved 350ms after dragging stops (as with the custom accent color); closing Settings before it is saved still saves it.
- Widths are always a percentage of the text column width, the same in a Bot's own chat, group chats and the dialog of a conversation between Bots:
  - Bubble width controls every bubble: Bot bubbles and the thinking process in the bubble layout (when Show thinking is on), and user bubbles in both layouts.
  - Text width controls the Bot text and the thinking process in the flat layout (when Show thinking is on).
- Bubble layout: a Bot bubble always leaves 82px on its right for the hover toolbar (6px gap, plus three 24px buttons with 2px between them), so at 100% a Bot bubble is the column width minus 82px. In group chats a message with an avatar is sized as a proportion of (column width − 30px), plus the 30px avatar column.
- Flat layout:
  - A Bot message has one line above it: avatar, name (text color, bold), time; in group chats also the admin label and the time taken. The text is below, starting at the avatar's left edge, with no background and no padding.
  - In a Bot's own chat this line appears once per reply turn, at whatever comes first in the turn: above the thinking process if that comes first (when Show thinking is on), above the text if the text comes first; replies in earlier parts work the same way. In group chats and conversations between Bots, consecutive messages from the same Bot share one line, with 10px between them.
  - The hover toolbar floats at the message's top right and takes no width.
  - User messages stay as bubbles on the right.
- The server accepts only these values: `layout` is `bubble` or `flat`; `width` and `flatWidth` are integers from 50 to 100; `thinking` is `true` or `false`. Other values of `layout` and the widths are errors, other values of `thinking` are ignored; default values (`bubble`, `80`, `100`, `false`) are not stored. The page treats values it does not recognize as the default.
- The layout is written on `body[data-bt-layout]`, and the two widths as `--bt-msg-w` and `--bt-flat-w` (0.5–1) on `body`. Before the team state arrives, the page uses the last settings cached on this machine, to avoid a flash of the default style.

## Not done

- No pixel widths.
- Dragging does not change the chat area's style live; the value is saved on release and then follows the team state.
- The text column width is not changed, and DSH's drag handle is not brought back (#28).
- Not saved separately per device.

## Known limits

- In the flat layout the hover toolbar covers the last few characters of the first line; it goes away when the mouse moves off.
- In the bubble layout a Bot bubble is at most the column width minus 82px: a 960px column tops out at about 91%, and dragging further right only widens user bubbles. On narrow screens such as phones it tops out earlier.

## Changes

- 2026-10-23: added the "Show thinking" switch, off by default; Bot conversations no longer show the context line (#465).
