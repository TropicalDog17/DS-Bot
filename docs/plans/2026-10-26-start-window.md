# Start window: the pilot whale

- Date: 2026-10-26
- Related: [Windows onboarding](2026-10-26-windows-onboarding.md) sections 3, 4, 5, 6 and 8, #559
- Changed with: [Windows onboarding](2026-10-26-windows-onboarding.md) (sections 3, 4, 5 and 8, wording, "Changes to decided designs", staged rollout, acceptance, open questions, known limits), [Start page copy](2026-10-29-start-copy.md) (sections 2, 3 and 4, "Changes to decided designs"), [Desktop app](2026-10-16-desktop-app.md) (structure, window), [UI standard](../design/ui-standard.md) (1, 3.1, 4.4, 8.3, 8.4, 12, 14)
- Code: the new `app/src/start/` (`start.html`, `start.css`, `start.js`, `whale.js`, `text.mjs`), `app/src/start-window.mjs`, `app/src/start-frame.mjs`, `app/scripts/start-assets.mjs`; `app/src/main.mjs`, `preload.cjs`, `window-frame.mjs`; the plugin's `ds-bot/src/client/sidebar.js` (where the Main Bot's avatar is at the handoff)

## Why

- The engine takes 3 to 20 seconds to start the first time and 3 to 12 seconds after that. Section 3
  of the onboarding note decided what this time shows (the real phases, the cards, the recovery page),
  but not how it moves.
- The Main Bot's whale is DS Bot's own generated figure, and it is also the first thing the user sees
  in the team. If it "does the work" for the user during the start, the user knows it before they come
  in, and has already seen its state motions.
- Nothing useful can happen in the few seconds after the double-click. The window does only four
  things: it shows that the app is alive and moving; it shows at a glance how far the start has got;
  it asks only what cannot wait (the import, a full disk); and it carries the figure into the team
  window. So the window holds only the whale and a ring around it: three arcs are the three phases.
  When all goes well there is no text; the whale says one line only when the user must know or
  answer something. The window shows what the user feels, not how the code is built (maintainer
  feedback, 2026-10-27), and it is not noisy (a discussion the maintainer passed on, 2026-10-30:
  "this version is a bit noisy now").
- From the research on waiting we take only these principles:
  - A wait with something to do and an explanation feels shorter (Maister).
  - Seeing the real work reassures more; fake progress backfires (Buell and Norton; Harrison et al.).
  - No progress display under 1 second; past 10 seconds, progress and a way out must be visible (NN/g).
  - The entrance takes at most 1 second, and the start never waits for an animation (Android splash
    screens).
  - A screen seen every day should move as little as possible (Kowalski).
- The start page is a local file and the engine's page is at `http://127.0.0.1`, so they are on
  different origins. When one window calls `loadURL`, Chromium does not keep the old frame and cannot
  do a cross-document transition; this cannot be joined without changing DSH. The window would go
  blank for a moment and then show DSH's own loading, and the user would never actually see the
  "Open the team" step.
- So the start page goes in a separate small window, and the team view loads in a hidden main window
  that shows only once it has mounted. The small window has Mica the whole time, so the handoff has no
  blank frame. At the handoff the small window first grows to the main window's rectangle, and the
  main window then appears on the same rectangle, instead of jumping from the small window to the
  big one.

## Decided behavior

### 1. Two windows (open)

- Every start first shows the **start window**:
  - Content area 720 × 540; 720 × 500 when the display's work area is less than 588 high.
  - It cannot be resized, maximized or made full screen; it has only the minimize and close system
    buttons.
  - Frameless, with a 40 px title band that drags the window and holds nothing.
  - Mica on Windows 11 22H2 and later.
  - Centred on the display that holds the pointer.
- The start window keeps its size until the handoff: the first start, later starts, cards and the
  failure page all use this one size. It changes once, at the handoff: the main process grows it to
  the main window's rectangle (section 8).
- The **main window** stays 1320 × 860:
  - After the start window has painted for the first time, the main window is built hidden, right on
    its final rectangle: centred on the start window's centre and kept inside the work area. If the
    start window was dragged, the main window is placed again from its position just before the
    handoff. It does not move or resize when it appears.
  - Once the engine is up, it loads the engine's local address (the same address and port).
    Exception: while the import card is open and the user has not answered, it does not load (the
    plugin builds an empty team as soon as it gets `state`); it loads after the answer, and after the
    first part of `〔复制过来〕` ("Copy them over") has been copied.
  - It shows only after `dsBotApp.ready()`: the start window first grows to the same rectangle, the
    main window appears on top of it, and the start window is then destroyed (section 8).
- Closing the start window before the handoff (× or Alt+F4) quits the app through the current quit
  flow: the engine stops, and a copy in progress stops.
- Double-clicking the icon again before the handoff restores and focuses the start window; after the
  handoff it focuses the main window.
- The first start's pickers and prompts are attached to the start window. A picker never opens by
  itself; it appears only after the user clicks the button or link that chooses a folder.
- The sign-in window ([onboarding](2026-10-26-windows-onboarding.md) section 5) is a child of the
  main window. It appears only after the handoff, when the user clicks a sign-in entry (the settings
  card's `〔登录 DeepSeek 账号〕` ("Sign in to DeepSeek"), `〔重新登录〕` ("Sign in again"), the repair
  card, the whale menu). The start window phase has no sign-in and no sign-in window.
- When the data moves (`〔移到…〕` ("Move to…"), today's `notePage(t.moving)`), the main window hides
  first, and the start window shows the data-moving page the way a later start looks: the whale works
  and there is no text (a rename on the same volume only flashes this page). The taskbar progress
  stays as it is, and the app reopens after the move as it does now; the work files are copied by the
  app in the background after the reopen, not through the start window.

### 2. Layout

The first start's layout (coordinates are DIPs in the content area):

| Part | Without a card | With a card | Content |
|---|---|---|---|
| Title band | y 0–40 | Same | Empty, drags the window |
| Ring | Centre (360, 255), radius 106 | Centre (360, 150), radius about 66 | Three arcs, one per phase; four once a copy from DSH has started (see below); 2 px line, round caps |
| Water channel | x 48–672, y 147–287 | Shrinks with the ring | The 112 px whale in the middle of the ring (x 304–416); the part below the waterline is clipped |
| Waterline | A chord of the ring: y 287, x 260–460 | y about 170, about 124 wide | 1 px `--bt-line-2`, fading out over 18% at each end; the ripple (68 × 12) at its middle |
| The whale's line | y 379–399, centred | y 226–246, centred, between the ring and the card | 15/20, 600, `--bt-ink`; one line only, no wrap, an ellipsis only when it really does not fit; text only in the cases listed in section 3 |
| Hint row | y 403–431, centred | Hidden | 13/18, `--bt-ink-2`; at most about 22 characters, and only the one line for a full disk; empty otherwise |
| Paper | Empty, clicks pass through it | x 48–672, y 260–496 | Holds only cards |
| Place line | Centred, y 500–528, 4 px below the paper; when it is too tight the text gets an ellipsis, the button does not give way | Same | `「数据放在 C 盘（剩 412 GB）」` ("Data on drive C, 412 GB free"), 13/18, `--bt-ink-2`, followed by a small grey button `〔换个位置…〕` ("Change the location…", 28 px high, section 6). On a first start it shows only when the disk is short of space (the same condition as the hint row: less than 5 GB free), never on a reinstall; on a later start only when the disk with the data has a fifth of its starting free space left, and then the button moves the data right away (section 5); it folds away as soon as the import starts copying; hidden on the failure page and on "The team view didn't load"; still clickable while the 180-second question is open. Free space is counted the way File Explorer counts it (base 1024). Outside Windows it names the folder (`~/.ds-bot`) instead of a drive; when the free space cannot be read, there is no bracket |

- The ring's three arcs run clockwise from the top: "Prepare the data folder" (`准备数据文件夹`),
  "Start the local engine" (`启动本机引擎`) and "Open the team" (`打开团队`). Each takes 120°, with
  10° gaps between arcs (each arc draws 110°):
  - Not started: a faint `--bt-line` line.
  - In progress (after the full 250 ms, section 3): the faint line takes a 22% tint of
    `--bt-ink-deepseek`, and a short highlight (22% of the arc length, 2.5 px, 75%
    `--bt-ink-deepseek`) runs clockwise along it, one lap per 1.8 s, one per 2.6 s from 45 seconds on.
  - Done: a `--bt-ink-deepseek` line fills the arc clockwise, .56 s.
  - Failed: the arc's line turns 60% `--bt-danger` (section 7).
  - Handoff: the gaps between arcs close into one full circle (.3 s), and the circle swells once
    (.5 s, at most 1.035 times, section 8).
- Every start begins with three arcs, also a first start that will import. After `〔复制过来〕` is
  answered and the copy starts, one more phase, "Copy your old team" (`复制以前的团队`), comes between
  the data folder and the engine: the ring becomes four arcs of 90° each, still with 10° gaps (each arc
  draws 80°): data folder, copy, engine, team. The change does not jump: the dot the card turns into
  lands in the gap after the first arc (at 120°), the copy arc grows out of that point, and the other
  three arcs move aside at the same time. Every frame draws between the old and new angles (so it
  stays on the circle), on `SPRING_SHAPE` (.42 s). When "Start without the team" follows a failed
  copy, this runs backwards: the copy arc shrinks back into that point and the other three arcs
  return to their three-arc places. With `〔先不复制〕` ("Don't copy yet") the ring stays at three arcs.
  The copy arc:
  - It is in progress from the moment the dot lands and the arc grows (section 6).
  - It fills with the real progress of the copy: checking the chats takes the first 15%, and copying
    Bots and chats takes the other 85% by bytes; it updates every 200 ms, catches up in .3 s and never
    goes back.
  - Copy failed: the line and the part already drawn turn `--bt-danger`; a retry returns it to in
    progress and redraws from 0.
  - When the copy is done the arc is full, and the ring stays at four arcs from then on; "Start
    without the team" after a failed copy goes back to three arcs (above).
  - A pre-warmed engine stops for the copy, so the engine arc goes back to not started, and fills only
    when the engine of the copied team is up; from the end of the copy until the engine is up, the
    engine arc is in progress.
- Prop: in front of the whale (x 413–459, its bottom on the waterline) is a small 46 px prop that
  shows what the arc in progress is doing. "Prepare the data folder": a folder whose sheets flip up
  one after another (1.5 s). "Copy your old team": a pale old box on the left, a new box on the right
  and a dotted line between them; a box is lifted off the old one, flies along the dotted line leaning
  forward, squashes as it lands on the new box, pauses, and fades (one round per 1.6 s). "Start the
  local engine": two meshing gears turn in opposite directions (9 and 6 teeth, one turn per 2.7 s and
  1.8 s, so they stay meshed), and the whole group swells every 1.35 s. "Open the team": three small
  members hop one after another (1.8 s). It is there only while that arc is in progress: it appears with `SPRING_POP` from .6 times to full
  size and fades in over .2 s, and fades out over .16 s when it leaves. A phase that finished before
  anyone could see it still gets its beat: a data folder built before the page painted, or an engine
  that came up while the import card waited for an answer or the copy ran, still goes in progress
  first when its turn comes, shows the prop and stays at least 420 ms before it fills; a phase really
  in progress does not wait longer. "Open the team" works the same way: if the team view was ready
  before this arc went in progress (while a card waited for an answer, or because it loaded at once),
  a first start puts it in progress for 420 ms before the handoff (the first start's fallback of
  2.5 s is enough). The colours are `--bt-ink-deepseek` and its pale tint; the sheets and the members'
  eyes are `--bt-card`. The prop is in the pond and shrinks and moves up with it when a card comes; it
  is not there on failure, while a card waits for an answer (the arc is not in progress), or at the
  handoff.
- The ring, water channel, waterline, the whale's click area and the ripple form one block, called the
  pond below. Without a card, the pond, the whale's line and the hint row sit as a group 45 px lower
  than with a card, which puts the whale a little above the window's visual centre. When a card is
  about to come, the group moves up 45 px on `SPRING_SHAPE`, and in the same spring the pond shrinks
  to .62 times around the ring's centre and moves up another 60 px, so the ring rests above the card
  and the card appears in the paper below. When the card goes, the pond returns to full size and the
  group goes back down. The place line does not move. The page cannot scroll (section 11).
- The whale's line and the hint row are written straight on the Mica. Without a card they sit where
  the paper is: while the paper is empty, clicks pass through it.
- A card is an opaque `--bt-card`: 1 px `--bt-line` border, radius 12, padding 16 × 20. When the
  card's body is taller than the paper, the body scrolls inside the card and the button row stays at
  the bottom of the card.
- A later start has the same layout as the first start: the same 112 px whale, ring and waterline;
  the place line shows only when the disk is nearly full (section 5).

### 3. The whale's general rules

- It moves only for real events: a phase starting and finishing, a card appearing, a failure, being
  ready, and the user's pointer, clicks, keyboard focus and return to the window. The only exception
  is breathing and blinking while a card waits for the user's answer (the second table below).
- The whale faces right, always stays in the middle of the ring and does not swim around. When the
  main process reports a phase done, that arc fills, and the whale strokes its tail twice in place
  and surges forward. An arc never fills early and never goes back once full (only when a new folder
  starts over do all three arcs go back to not started, section 7).
- It holds still while waiting for the user's answer: at the Normal and Lively levels it has only
  small motions, leaning in, breathing and blinking (Lively also has hops that grow rarer). The longer
  it waits the slower it moves, never faster.
- A change of motion continues from the current pose: read the current `transform`, stop the loop,
  then spring to the start of the next motion. It never jumps back to rest.
- A phase counts as "in progress" only after it has run a full 250 ms: its arc takes the pale blue
  tint and the highlight runs, and the whale switches to that phase's motion. A phase that finishes
  sooner never shows in progress; its arc just fills.
- A loop state and an arc in progress stay at least 400 ms once they appear; failure and the handoff
  do not wait.
- Phases finish one at a time: the next arc starts filling 360 ms after the previous one started
  (200 ms for one already queued). The handoff does not queue: all arcs not yet full fill together
  (section 8).
- Large motions go only on the HTML wrapper outside the SVG, with `translate`, `rotate`, `scale` and
  `transform`, so the compositor thread runs them. Inside the SVG only the eyes and tail move. The
  ring and the water spout are separate SVGs: the arcs and the spout are drawn with
  `stroke-dashoffset`, and the closed circle swells with `scale`; the drops are HTML dots, moved with
  `translate`, `scale` and opacity.
- Loops are CSS animations, selected by a state attribute on `html`. One-off motions use WAAPI and
  end with `commitStyles()` and then `cancel()`.
- Each one-off motion carries a sequence number, and a new state drops the old ones. Every place that
  waits for an animation to end also has a fallback timer, because a minimized window does not run
  animations.
- Springs use only the constants in `motion.js`. The keyframes of avatar motions follow the plugin's
  (`bt-hop`, `bt-bob` and so on in `styles.js`), converted to pixels.
- The whale speaks:
  - The page rarely shows text: there is none when all goes well, none when it is slow (45 seconds)
    and none while data moves. Progress and the current work show only through the ring, the whale's
    pose and the prop (section 2). Text appears only in two cases: a full disk (the hint row and the
    place line, sections 4, 5 and 6) and an error. On an error the line under the ring (section 2)
    says one short sentence, in the Main Bot's own voice:
    - 180 seconds: `「等太久了，要不要重试？」` ("This is taking too long. Try again?", section 6).
    - Failure: `「DS Bot 没能启动」` ("DS Bot couldn't start"), `「团队界面没有加载出来」` ("The team
      view didn't load", section 7).
  - Every error page can take the log away in one click: `〔复制详细信息〕` ("Copy details") and
    `〔保存日志…〕` ("Save log…", sections 6 and 7).
  - A change of line fades out over .16 s and in over .16 s. There is no hold time and no queue: when
    the snapshot or the start clock changes, the line follows.
  - While a card is up this line is empty, and the card says it in its own first line (section 6).
    The 180-second card and the failure page are exceptions: the whale asks the 180-second question
    and the card holds only buttons; the failure page shows the decided title (section 7).
  - The hint row has one use only: when the disk is short of space and there is no better disk, it
    shows `「C 盘只剩 1.2 GB」` ("Only 1.2 GB left on drive C") for the first 10 seconds (sections 4
    and 6).

| Moment | Whale | Duration and curve |
|---|---|---|
| First start entrance | Rises from 96 px below the waterline, a 12° tilt straightens; one tail flick; eyes open | `SPRING_STRETCH` 560 ms; eyes open in 160 ms |
| Later start entrance | Rises from 84 px below the waterline, no tilt, eyes already open | `SPRING_TAP` 290 ms |
| Prepare the data folder | Searching: leans forward and peers, eyes scan left and right | 1 s; eyes 1.6 s |
| A phase done | Stays in place: two tail strokes, the body surges forward (about 5 px, head up 3°), while the arc fills clockwise; when this beat ends (360 ms) a nod, and when several arcs fill in a row, only one nod after the last | Tail 200 ms × 2; surge 420 ms; arc .56 s |
| Start the local engine | Working: bobs up and down, tail sways, blinks | 1.6 s, 1.1 s, 2.4 s; no exact repeat within 52.8 s |
| 10 seconds | Looks at the user for 600 ms, one slow blink; all loops slow to 0.85 times | Look 600 ms |
| 45 seconds | Switches to thinking: head tilted, rising and falling slowly, eyes narrowed; tail stops; the highlight on the arc and the prop slow down; no text | 2.2 s; the switch uses `SPRING_SHAPE`; highlight one lap per 2.6 s; prop one beat per 2.6 s, gears one turn per 4 s |
| Open the team | Sending a message: dashes forward, two tail strokes per dash | 1.1 s |
| The app asks (a card, 180 seconds) | Two hops, then holds still and looks at the card (after that, see the next table) | 1.3 s × 2 |
| A card the user brought up | No hop, holds still | None |
| Failure | From the current pose sinks 4 px, head down 4°, eyelids grow heavy, then goes fully still | `SPRING_SHAPE` |
| Ready, celebration (first start; first success after a retry or a fresh start) | As the ring closes, squashes then stretches, `「^ ^」` eyes, one spout; at 560 ms jumps out of the water, flies to where the Main Bot's avatar will be, shrinks to the avatar's size and lands (section 8); when there is nowhere to land, dives instead, to 1.25 times its height | 460 ms; jump 590 ms (the dive uses `SPRING_SHAPE`) |
| Ready (later start) | The ring closes, and 100 ms later it jumps straight to the Main Bot's avatar; when there is nowhere to land it dives straight away, also to 1.25 times its height | Jump 550 ms (the dive uses `SPRING_TAP` 290 ms) |

The whale also has the small reactions below, each with a cause: a card is waiting, the user did
something, or the handoff. Number 9 is the only one without an outside cause; it makes the working
bob feel less like a loop. The whale is more responsive, not busier. The Quiet level has none of 1
to 7 or 9; with reduced motion none of 1 to 9; and the failure pages (start failed, the team view
didn't load, copy failed) have none of them.

| # | Motion | When | How |
|---|---|---|---|
| 1 | Lean in | A card the app asks: when the last hop lands (2.0 s after the hops start; 0.7 s for the import's not-enough-space card). A card the user brought up: 70 ms after the shape change starts. Not on the copying, downloading or copy-failed cards | Leans 2.5° towards the card (`translate(1.91px, -1.27px) rotate(2.5deg)`, for the 112 px whale), `SPRING_SHAPE`; the eyes keep looking at the card. On an answer it pulls back with the nod, and leans in again 1 second later if the card is still there (for example after a model setting changed); petting pulls it back, and it leans in again once the pointer leaves |
| 2 | Breathe | 600 ms after holding still | The body rises and falls gently (`scale` 1 → 1.008 1.018 → 1), once per 4.2 s; on this card's own clock it slows to .8 times after 30 seconds and to .6 times after 90 seconds, never faster again; when the state changes it returns to rest in 240 ms |
| 3 | Blink | First 1.4–2.2 s after holding still, then every 3.2–6.8 s (the gap times 1.4 after 30 seconds, times 2 after 90 seconds); one blink in five is a double, 340 ms apart | 270 ms: the eyes squash to .03 and come back; no blinking while being petted, hopping or looking at the user, nor with heavy eyelids, narrowed eyes or `「^ ^」` eyes (for example while spouting) |
| 4 | Looks at you on return | The window gets focus again after losing it for 5 seconds or more, or becomes visible again after being hidden for 5 seconds or more | The same as at 10 seconds: looks at the user for 600 ms, one slow blink. Counted together with the 10-second look, at most once in 20 seconds; only during the start loop or while holding still at a card, not during the phase-done beat, a hop, petting, the dive or the failure pose |
| 5 | Eyes follow keyboard focus | The keyboard moves focus to a button or checkbox in the paper or the hint row | The eyes look at that control's centre, with the same limits as following the pointer; as soon as the pointer moves, the pointer takes over again. When a card appears, focus moves to its main button by itself; that one move is not followed, and the eyes keep looking at the card |
| 6 | Ready to press | The pointer goes down on a button that answers the card (opening "Details" (`详细`, `详细信息`), opening the model setting's `更换` ("Change"), or `〔复制详细信息〕` do not count as answers) | The body crouches slightly: `scale` 1.03 .97, 120 ms; on the click it springs back on `SPRING_TAP` and nods; moving away or cancelling only springs back; the keyboard only nods. The card's action still fires on the click |
| 7 | Lively hops grow rarer | Lively level, a card the app asks with two hops | Hops start at 0, 1.3, 3.9 and 9.1 seconds, then every 9 seconds, with breathing and blinking in between; no more hops after petting or an answer; the import's not-enough-space card hops only once |
| 8 | Dive deeper | Nowhere to land at the handoff (section 8) | Dives to 1.25 times the whale's height (140 px), so the whale is below the waterline when the window starts to grow |
| 9 | Glance around | On a first start, during "Start the local engine" while the whale works, once every 5 to 9 seconds at random gaps | The eyes look left or right at random for 600 ms: `#eye-pair` shifts 14%, 150 ms there, 270 ms hold, 180 ms back, `ease-in-out`, on top of the bob. It goes on after the 10-second slowdown and stops once the 45-second thinking starts; no glancing while the eyes follow the pointer or keyboard focus, during the 600 ms look at the user, while being petted or hopping, or while the window is not visible; if it is mid-glance when it should look at the user, the eyes first return to centre in 120 ms. Only in this phase of a first start: later starts, the data-moving page and the copying card use the working loop too, but do not glance |

- The three animation levels follow the level set in the team: the main window's page reports it to
  the app, the app stores it in its own userData and uses it at the next start. Without a record
  (the first start) the level is Normal.
  - Quiet: only the state motions in the first table, and the spout when the whale is clicked (one
    size smaller, with its squash, tail flick and `「^ ^」` eyes). Apart from that there is no eye
    following, petting, tail, nod, look at the user or ripple, no `「^ ^」` eyes at the handoff, and
    none of 1 to 7 and 9 in the second table; when a phase is done only the arc fills, and the whale
    neither strokes its tail nor surges.
  - Normal: adds eyes that follow the pointer, the tail, the nod, the look at the user, the ripple,
    `「^ ^」` eyes, the tail strokes and surge when a phase is done, and 1 to 6 and 9 of the second
    table. While waiting for the user's answer it can be petted (UI standard 8.5).
  - Lively: adds number 7 of the second table: while waiting for the user's answer the hops grow
    rarer, instead of the "keeps hopping" of UI standard 8.4.
- Click the whale and it spouts (click area 140 × 108, covering the part of the whale above the
  water):
  - It squashes and springs back (460 ms), flicks its tail once, `「^ ^」` eyes for 480 ms. A water
    column rises from the blowhole (170 ms), its top curls out to both sides (from 120 ms, 200 ms),
    and from 380 ms the whole spout scatters upwards; two drops on each side and one in the middle
    fall back (starting at 330 to 400 ms, about .5 to .6 s each), and at 760 ms comes one ripple. The
    column and drops are 70% `--bt-ink-deepseek`.
  - The 4th click within 2.5 seconds gives one big spout: 1.35 times, a deeper squash, three drops on
    each side, `「^ ^」` eyes for 900 ms; then the count starts over.
  - While lying down after a failure it gives only a small puff: .55 times, no curl, one drop, no
    squash, the eyes do not change.
  - During the entrance, sinking to start over, after ready and during the handoff, a click does
    nothing; while being petted it still spouts, and the eyes do not change.
  - Every kind of start has it. The Quiet level has it too: the column one size smaller (.85 times),
    no ripple, the squash, tail flick and `「^ ^」` eyes as usual; with reduced motion it only changes
    to `「^ ^」` eyes (section 9).
- The ripple is a thin-line 68 × 12 ellipse in the middle of the waterline. It appears in three
  places: when the whale rises on a first start (not on later starts); when the spout falls back
  (760 ms after the spout); and when the whale dives during the celebration handoff (660 ms; the spout
  at the handoff does not start a ripple of its own, and there is no ripple when the whale jumps to
  the avatar). The spout and dive ripples fade in 160 ms (the rising one in .56 s). The Quiet level
  and reduced motion have no ripple.
- The whale and the ring are hidden from screen readers (`aria-hidden`). The three phases stay in an
  invisible list (`「启动进度」` ("Start progress"), each item with a state word, the current one with
  `aria-current="step"`), and the polite live region still says `「{阶段}：进行中」` ("{phase}: in
  progress") and `「{阶段}：已完成」` ("{phase}: done"). The whale's line is plain text and does not go
  to the live region; a failure title is the exception and is read out. When a card appears, its
  first line and first sentence are read (for the 180-second card, the whale's question).

### 4. The first start, beat by beat

Time counts from the frame in which the page gets `?start=first`.

1. Entrance:
   - 0 ms, the whale rises from 96 px below the waterline in the middle of the ring.
   - 120 ms, the ripple.
   - 180 ms, each of the ring's three faint arcs draws itself clockwise (.5 s).
   - 220 ms, the waterline fades in.
   - 360 ms, the eyes open.
   - 420 ms, the place line (only when the disk is short of space) fades in.
   - 560 ms, in place.
   The entrance is all CSS and does not wait for the script. A card or ready that arrives during the
   entrance is handled once the whale is in place. The whale's line is empty; the hint row shows its
   one line only when the disk is short of space (beat 3).
2. "Prepare the data folder": the first arc goes in progress, and the whale searches, only if the
   phase is not done by 560 ms and has already run 250 ms. When it is done the first arc fills, but no
   earlier than 260 ms after the entrance (820 ms after the page paints), so that people see it fill.
   During this short wait the whale keeps its loop (the pose after the entrance, or the search it is
   in); it changes to the working loop only once the arc has filled and this beat has ended (360 ms).
   Changing loops for those 260 ms would delay the arc further by the 400 ms that a loop must stay.
   The 820 ms is only the arc waiting: the main process starts the engine as soon as it has built the
   data folder, without waiting for the page to paint. On a typical first start the data phase ends
   before the page paints (the main process takes 0.3 to 1.2 seconds to build the folder, and the page
   takes about 1 second, or several on a cold start, to paint), so the first arc never shows in
   progress and simply fills at 820 ms. A fresh start (section 7) does not wait for this beat; a ready
   that arrives during the entrance follows beat 1.
3. "Start the local engine": the second arc is in progress, the whale works and glances around now
   and then (section 3, second table, number 9), and the gears in front of it turn (section 2). The
   whale's line and the hint row are empty; when the disk is short of space and there is no better
   disk, the hint row shows `「C 盘只剩 1.2 GB」` for the first 10 seconds (on the start clock)
   (section 6).
4. 10 seconds, the engine is not up yet: the whale looks at the user once and the loops slow down; no
   text.
5. 45 seconds, the engine is not up yet: the whale switches to thinking, and the highlight on the arc
   and the gears slow down; no text.
6. 180 seconds: see section 6.
7. The engine is up: the main process loads the engine's page in the hidden main window and starts
   the 20-second ready check. The second arc fills, the third, "Open the team", goes in progress, the
   whale switches to sending a message, and the gears give way to three small members. While the
   import card is open and not yet answered, a pre-warmed engine only counts up to the second arc: the
   page does not load, the third arc does not start and the 20-second check does not start; all three
   wait for the answer (for `〔复制过来〕`, until the first part has been copied).
8. `dsBotApp.ready()`: the remaining arcs fill, the ring closes, the whale spouts once, jumps out of
   the water and lands on the Main Bot's avatar in the team window (or dives when there is nowhere to
   land), see section 8.

- 10, 45 and 180 seconds are counted on the start clock, which the page does not show. It stops while
  a card waits for the user's answer and goes on after the answer: the time the user spends thinking
  does not count against the engine.
- The place line (section 2) is there from the entrance only when the disk is short of space: for a
  new team and for an import it shows `「数据放在 C 盘（剩 1.2 GB）」` ("Data on drive C, 1.2 GB
  free") and `〔换个位置…〕`, and if nothing is clicked the start goes with that place without asking.
  When there is enough space there is no place line, so the first start has no entry for choosing the
  place; to change it, go to Settings → General → Location once inside. Only a click on
  `〔换个位置…〕` opens the picker (section 6), and the clock also stops while the picker is open. At
  the handoff the line fades out with the whole group (section 8).

### 5. Later starts

- The same page as the first start: the 112 px whale in the middle of the ring, a waterline, three
  arcs that follow the phases (sections 2 and 3). When all goes well there is no text and no place
  line, except when the disk is nearly full (below).
- 0 ms: the whale rises from 84 px below the waterline (`SPRING_TAP` 290 ms), no tilt, eyes open, no
  ripple; the ring's faint arcs draw from 180 ms, and the waterline fades in at 220 ms. The first arc
  fills 260 ms after the entrance at the earliest (550 ms after the page paints).
- For the first second the whale keeps its loop: when the first arc fills it still strokes its tail
  twice, surges forward and then nods (section 3). After 1 second it starts working (only the bob and
  blinks, the same in all three phases).
- 10 seconds: the whale looks at the user once, the loops slow down, no text.
- 45 seconds, the engine is not up yet: the whale switches to thinking, no text.
- 180 seconds: as on the first start.
- The disk is nearly full: when the data is put in a folder (the place set on a first start, after an
  import copy, a change of place or a data move), `locations.json` records that disk's free space at
  that time (`freeAtStart`). On a later start, once the free space falls below 20% of it (below
  82 GB if it started with 412 GB free), the data phase reads the place and the place line appears,
  `「数据放在 C 盘（剩 30 GB）」` ("Data on drive C, 30 GB free") with `〔换个位置…〕`, fading in over
  .22 s. `〔换个位置…〕` takes the data move of Settings → General → Location, but apart from the
  picker it opens no system dialog and asks everything on cards in the paper (section 6). A folder
  that cannot be used gives `「这里放不了」` ("That place won't work") plus one sentence with the
  reason, and `〔重新选…〕` ("Choose again…"). A usable one gives `「搬到这个文件夹？」` ("Move the data
  here?"), `「会把数据复制到 D:\Data，然后重新启动。原来的 C:\Users\<用户名>\.ds-bot 原样留着，确认没问题后可以自己删掉。」`
  ("DS Bot copies its data to `D:\Data` and starts again. `C:\Users\<user>\.ds-bot` stays as it is;
  once all is well you can delete it yourself."), `〔移动并重启〕` ("Move and restart", main button),
  `〔重新选…〕` and `〔取消〕` ("Cancel"). While the picker and the cards are open the clock stops and the
  handoff waits; when the picker is cancelled or `〔取消〕` is clicked, the start goes on and enters the
  team as usual. `〔移动并重启〕` checks once more (the team workspace may have just changed), then the
  start window turns into the data-moving page on the spot (the page reloads, the whale works, no
  text), this start's engine stops, and the move takes the same path as `〔移到…〕` in Settings →
  General → Location: after the copy it starts again in the new folder (today the old folder stays,
  and the card says so; this changes here too when "moving is moving" in onboarding section 8 lands).
  When another DSH is using this data during the copy, or the copy fails, it still opens a system
  dialog as in Settings, and then starts again in the old folder ("Known limits"). A place saved
  before without this number gets it recorded on this start, and it counts from the next start on;
  a one-off run with `DS_BOT_HOME` neither records nor shows it.
- During a change of place (section 1) there is no text under the whale, and from 45 seconds the
  whale switches to thinking.
- Ready has no celebration (except for the first success after a retry or a fresh start, section 8):
  the remaining arcs fill, the ring closes, and 100 ms later the whale jumps to the Main Bot's avatar
  (or dives when there is nowhere to land); at 220 ms `handoffShow` is sent, the start window grows to
  the main window's rectangle as on the first start, the whale lands on the avatar at 650 ms, and the
  main window appears about 0.7 seconds after ready (section 8).
- A one-off run with `DS_BOT_HOME` uses all of this, only without cards.

### 6. Cards, 180 seconds and the import

- All cards use the same shape change:
  - Appearing: the whale's line and the hint row fade out over .16 s; the group moves up 45 px, and in
    the same spring the pond shrinks to .62 times and moves up another 60 px (section 2, the same on
    first and later starts); the card's background and border layers grow from 0 height to the
    content's height (`clip-path`, on `SPRING_SHAPE`; the background fades in over .22 s); the content
    is laid out at its final size first and fades in 70 ms later; focus moves to the main button.
  - After the answer: the content leaves in .16 s (sinks 6 px, shrinks to .975, blurs 3px), the card
    folds away, the pond returns to full size, and the group goes back down.
- While a card is up the whale's line is empty and the hint row is hidden. The card's own first line
  is one sentence spoken by the whale (15/20, 600, one line), written above the decided content; the
  content itself does not change:
  - Import card: `「找到你以前的团队了：4 个 Bot、0 个群聊」` ("Found your old team: 4 Bots, 0 group
    chats"); this line is all the card says.
  - Recommended drive: `「C 盘有点挤」` ("Drive C is a bit full", not enough space), `「这里不让我放东西」`
    ("I'm not allowed to put things here", the default place cannot be used).
  - "It will go in…" (`「会放在…」`): `「我多加了一层文件夹」` ("I added one more folder").
  - The rejected card: `「这里放不了」`.
  - Confirming a data move on a later start: `「搬到这个文件夹？」`.
  - Data folder not found: `「数据不在原来的地方了」` ("Your data isn't where it was").
  - Not enough space for the import: `「地方不够放」` ("Not enough room").
  - DSH is using this team: `「DeepSeek Harness 还在用这个团队」` ("DeepSeek Harness is still using this
    team").
  - Chats from a newer version, and its "downloading" card: `「这些对话比我新」` ("These chats are newer
    than me").
  - There is no card during the copy (the copy arc on the ring is the progress).
  - The recovery card, the team view didn't load and the copy-failed card have no such line and no
    jokes (section 7). The 180-second card has none either; the whale asks the question.
- Whether the whale hops:
  - A card the app asks (recommended drive, data folder not found, import, 180 seconds): two hops; as
    the last hop lands it leans in and looks at the card, then holds still (section 3, second table).
  - A card the user brought up (the "It will go in…" card after choosing in `「其他位置…」` ("Another
    location…"), and `「这里放不了」` and `「搬到这个文件夹？」` during a later start's data move): no
    hop; it leans in 70 ms after the shape change starts. There is no card during the copy; the whale
    works.
  - A new problem in the same matter (not enough space during the copy): one hop.
- The only card for choosing a place is the recommended drive. It appears only on a first start, and
  both `〔放到 D 盘〕` ("Put it on drive D") and `〔仍然放在 C 盘〕` ("Keep it on drive C") have already
  passed a test write (onboarding section 3). A later start can also show the "data folder not found"
  card:
  - Recommended drive: `「C 盘只剩 1.2 GB。放到 D 盘（剩 412 GB）？」` ("Only 1.2 GB left on drive C.
    Put it on drive D (412 GB free)?"), `〔放到 D 盘〕` (main button, gets focus), `〔仍然放在 C 盘〕`,
    and at the end of the button row a small link `「其他位置…」`. When the default place cannot be
    used, the first sentence becomes the reason (`「DS Bot 没有权限在 C:\Users\<用户名> 里写文件。」`
    ("DS Bot can't write files in `C:\Users\<user>`.")) and the second stays the same; the buttons are
    only `〔放到 D 盘〕` (main button) and the small link `「其他位置…」`, without `〔仍然放在 C 盘〕`. When
    there is no drive to recommend, there is only `〔选择其他位置…〕` ("Choose another location…").
  - `「其他位置…」` opens the picker, and the card stays behind it. When the root it settles on is the
    folder the user chose (the rule in onboarding section 3), the card folds away and the start goes
    on without a confirmation. When the app added a `DS Bot` folder inside it, the same card changes
    into `「会放在 D:\DS Bot。」` ("It will go in `D:\DS Bot`."), `〔继续〕` ("Continue", main button) and
    `〔重新选…〕`. When the chosen place cannot be used, the same card says one sentence with the reason
    (`「DS Bot 没有权限在 D:\Data 里写文件。」` ("DS Bot can't write files in `D:\Data`."),
    `「C:\Users\<用户名>\OneDrive\文档 在 OneDrive 里，同步会打断正在写入的对话。」`
    ("`C:\Users\<user>\OneDrive\Documents` is in OneDrive; syncing interrupts chats while they are
    being written."), `「D:\Projects\DS Bot 里已经有别的文件。」` ("`D:\Projects\DS Bot` already has
    other files in it.")), with `〔重新选…〕` (main button), and the original card's `〔放到 D 盘〕` and
    `〔仍然放在 C 盘〕` stay; when the picker is cancelled it goes back to the card it came from. The
    "It will go in…" and rejected cards also have the footnote.
  - The footnote is always `「以后可以在 设置 → 通用 → 位置 里改。」` ("You can change this later in
    Settings → General → Location.").
  - When there is no better drive there is no card: the hint row shows `「C 盘只剩 1.2 GB」` for the
    first 10 seconds and is empty after that (section 4).
  - The place line's `〔换个位置…〕` (section 2) does not wait for the recommended-drive card: it can be
    clicked at any time during the first start of a new team or an import, also while the engine is
    starting, and takes the same path as `「其他位置…」`. After the choice the root is settled first
    (onboarding section 3, "one place"): when the root is the chosen folder there is no card and the
    start begins again at once; when a `DS Bot` folder was added it shows `「会放在 D:\DS Bot。」`,
    `〔继续〕` (main button) and `〔重新选…〕`; when it cannot be used it shows `「这里放不了」` plus one
    sentence with the reason (the three above, plus `「D:\Data 是 DeepSeek Harness 的数据。」`
    ("`D:\Data` is DeepSeek Harness's data.") and `「C:\Program Files\DS Bot\data 在程序文件夹里，卸载时会删掉。」`
    ("`C:\Program Files\DS Bot\data` is in the program folder, which uninstalling removes.")), with
    `〔重新选…〕` (main button). Both cards are brought up by the user and do not hop. When the picker is
    cancelled it goes back to the place line: this path has no card it came from, so "It will go in…"
    and `「这里放不了」` fold away as well, and the start keeps the default place. Choosing the current
    root or data folder counts as no choice. A choice inside the current data folder, or a root that
    overlaps it, gives `「这里放不了」` plus `「C:\Users\<用户名>\.ds-bot\旧 和现在放数据的位置重叠。」`
    ("`C:\Users\<user>\.ds-bot\old` overlaps where the data is now."); the same goes when the team
    workspace already holds something, while one that is still empty (just built by this start) can
    become the new root: choosing the user folder under the default place gives
    `「会放在 C:\Users\<用户名>\DS Bot。」` ("It will go in `C:\Users\<user>\DS Bot`."). A folder that
    cannot be read is treated as no permission. All checks follow links and junctions to the real
    path, and the DSH home sentence names the folder the user chose. If the team becomes ready while
    the picker or one of these two cards is open, the handoff and the 20-second view check wait until
    the answer: the handoff would take away the start window together with the picker attached to it.
    Once settled, the start begins again by the path of `〔换个位置…〕` in section 7: the whale sinks at
    once and the place line names the new drive at once. The old engine is ended directly, without
    waiting for it to finish starting or to quit in order (both take 3 to 10 seconds, the whale would
    stay under water all that time, and that folder is deleted right away with nothing in it worth
    keeping). The folders this start built in the default place are deleted (the data folder entirely,
    the team workspace only while it is still empty), the place is recorded at this point, the three
    arcs go back to not started, and the whale rises again where it was. While an import copy is
    running this click is not taken, and once the copy is done the line folds away: moving a copied
    team belongs to Settings → General → Location.
- On a later start, `〔换个位置…〕` on the place line when the disk is nearly full (section 5): after the
  choice it first checks whether the data can move there (the same checks as the data move in
  Settings). One that cannot be used gives `「这里放不了」` plus one sentence with the reason, from the
  reasons of the rejected card above, plus two more: `「D:\ 是整块磁盘，要选它里面的一个文件夹。」`
  ("`D:\` is a whole drive; choose a folder on it.") and `「D:\Work 和总工作区互相包含。」` ("`D:\Work`
  and the team workspace contain each other."); a folder that already holds something gives
  `「D:\Data 里已经有别的文件。」` ("`D:\Data` already has other files in it."); with `〔重新选…〕` (main
  button). A usable one gives `「搬到这个文件夹？」`, `〔移动并重启〕` (main button), `〔重新选…〕` and
  `〔取消〕`; for the footnote and the body see section 5. Neither card has `〔放到 D 盘〕` or
  `〔仍然放在 C 盘〕`.
- A reinstall (`C:\Users\<user>\.ds-bot` holds a team and there is no saved place) shows no card, not
  even when the disk is short of space; the start page does not show the last team or its path, and
  once inside it is the same team.
- 180 seconds: the whale asks at once `「等太久了，要不要重试？」`, and the card holds only `〔继续等待〕`
  ("Keep waiting", main button), `〔重试〕` ("Try again"), `〔复制详细信息〕` and `〔保存日志…〕`; the screen
  reader reads the question.
  - `〔继续等待〕`: the card folds away, and asks again after another 180 seconds.
  - `〔重试〕`: restarts the engine, the clock starts from 0, the whale shakes itself and goes back to
    work.
  - The engine comes up while the card is still there: the card folds away and the second arc fills
    as usual.
- Data folder not found (mostly on later starts): text and buttons as decided in section 3 of the
  onboarding note, main button first. Still not found after `〔重试〕`: `「还是找不到这个文件夹。」`
  ("Still can't find this folder.") appears under the buttons (`--bt-danger`, fades out after 4
  seconds). The whale's eyes look left and right once; no hop.
- The import (section 4 of the onboarding note) happens entirely in the paper, with the same shape
  change:
  - The import card is as short as it can be: only one line `「找到你以前的团队了：4 个 Bot、0 个群聊」`
    with `〔复制过来〕` (main button, gets focus) and `〔先不复制〕`, and a "Details" (`「详细」`) at the
    end of the button row. "Details" is a fold like the one on the failure page, and only when opened
    does it show: `「复制后会多占 4.6 GB，DeepSeek Harness 里的原件不动。」` ("The copy takes another
    4.6 GB; the originals in DeepSeek Harness stay untouched.", below 1 MB it says "less than 1 MB",
    never "0 MB"), `「模型设置：DeepSeek API · DeepSeek-V4-Pro　更换」` ("Model settings: DeepSeek API ·
    DeepSeek-V4-Pro  Change"), two checkboxes, and the footnote `「也可以在 设置 → 通用 → 位置 里复制。」`
    ("You can also copy the team in Settings → General → Location."). When it opens, the card's border
    grows taller on `SPRING_SHAPE`, and the content fades in 70 ms later. The names found, the number
    of parts and what will be copied are not on the card (the names and the number of parts are on the
    "Copied" (`「复制好了」`) card once inside).
  - The card appears only after the first arc (data folder) has filled. As soon as the card appears,
    the engine starts warming up, the chats are checked at the same time when DSH is not holding them,
    and the whale hops twice and holds still. Until the answer the ring stays at the first arc: even a
    pre-warmed engine does not draw the engine arc or show the gears. On `〔先不复制〕` the whale nods,
    the pre-warmed engine goes on as the real engine without a restart, and the engine arc goes on
    drawing (three arcs).
  - Not enough space (only the first part is checked): `「空间不够：复制要约 1.7 GB，C 盘只剩 1.5 GB，还差 0.2 GB。」`
    ("Not enough space: the copy needs about 1.7 GB, drive C has 1.5 GB left, 0.2 GB short."),
    `〔选择其他位置…〕` (main button), `〔先不复制〕`
  - During the copy: the card does not fold away but jumps up and becomes an arc of the ring. On
    `〔复制过来〕` (or `〔重试〕` after a failed copy):
    - The card's content leaves in .16 s as usual; 60 ms later the card's background and border start
      to fold: with `clip-path` it shrinks to a 12 px dot in the middle of the card, turns
      `--bt-ink-deepseek` at the same time, and jumps along an arc, first up and then right, onto the
      ring. With three arcs it lands in the gap after the first arc; with four already (`〔重试〕`
      after a failed copy) it lands at the middle of the copy arc (the pond is still shrunk and moved
      up at this point). It fades before landing, .52 s in all: the first 45% shrinking and rising
      (`cubic-bezier(.3,.7,.4,1)`), in place by 80%, and the rest fading.
    - When the dot is in place (.42 s) the ring changes from three arcs to four (section 2): the copy
      arc grows out of the landing point, in progress, and the faint line thickens at once to 5 px and
      returns to 2 px (.42 s); the prop changes to the moving boxes. Then the pond returns to full size
      and the group goes back down (section 2).
    - The copy arc fills with the real progress (section 2); there is no step list, no numbers and no
      time left. The taskbar progress still shows on the start window.
    - The copy finished before the dot landed (a very small team): the arc still lights up first and
      fills only after 420 ms in progress.
    - The whale works.
  - The copy has no stop button (decided by the user, 2026-11-02): to stop, quit the app or close the
    start window; the copy stops at a safe point, leaves no half-copied team, and only then does the
    app quit.
  - DSH is using this team (after `〔复制过来〕`): the whale holds still and does not bob. It checks
    again every 2 seconds without showing anything; once the lock is free, the card turns straight
    into the copy. The card has one `〔先不复制〕` (main button). The "downloading" card also has
    `〔先不复制〕` (main button), plus `「下载太慢？手动下载」` ("Download too slow? Download manually");
    when the download fails, `〔重试〕` and `〔手动下载〕` ("Download manually").
  - Copy failed: the whale takes the failure pose, and the copy arc turns red (section 2). The card
    has one sentence on what happened, `「团队没有复制完：文件被别的程序占用。DeepSeek Harness 里的团队没有变化。」`
    ("The team wasn't fully copied: a file is in use by another program. The team in DeepSeek Harness
    is unchanged."), one on what to do, `「可以重试，或者先不带团队开始，以后在 设置 → 通用 → 位置 里再复制。」`
    ("Try again, or start without the team and copy it later in Settings → General → Location.", small
    text), `〔重试〕` (main button), `〔先不带团队开始〕` ("Start without the team"), the same log buttons
    as the failure page, and "Details" (`「详细信息」`). `〔重试〕`: the card jumps back to the copy arc,
    which redraws from 0; `〔先不带团队开始〕`: the card folds away and the ring shrinks back to three
    arcs. An error while checking the chats is not a failure: the copy goes ahead, only without the
    check first (section 4 of the onboarding note).
  - The work files do not go through the start window: the app copies them in the background after
    the team opens, and the progress shows in Settings → General → Location and on the "Copied" card in
    the Main Bot's chat.

### 7. Failure, updates and a view that didn't load

- Within 1 second of a failure:
  - The whale's line changes at once to `「DS Bot 没能启动」`, written between the ring and the card
    (section 2), and the screen reader reads it.
  - The whale takes the failure pose (section 3), and the stuck arc turns red, with no cross: the
    failure shows only through the whale's pose, the red arc and this line.
  - The hint row fades out.
  - The paper becomes the recovery card: one sentence on what happened (the reason), one on what to do
    (small text, by reason: no write permission, `「给这个文件夹写入权限后重试。」` ("Allow writing to
    this folder and try again."); not enough space, `「清理出一些空间后重试。」` ("Free up some space and
    try again.") (`〔换个位置…〕` is not wired into the recovery card yet, so these two sentences do not
    mention changing the place); incomplete program files, `「重新安装 DS Bot 后再打开。」` ("Reinstall
    DS Bot and open it again."); data folder not found (external drive unplugged),
    `「插上那块硬盘，或者把文件夹放回原处后重试。」` ("Plug the drive back in, or put the folder back,
    and try again."); the engine stopped, and anything else, `「先重试一次；还不行，就复制详细信息去反馈。」`
    ("Try again; if it still fails, copy the details and report it.")), five buttons and "Details"
    (`「详细信息」`). The card has no first line from the whale. When the data folder cannot be built or
    written, the first arc is red; when the engine cannot start or the Host exits, the engine arc is
    red. The pond shrinks and moves up, and the ring sits above the card (section 2).
  - Focus moves to `〔重试〕`. The window does not hide.
- An error in the main process that nobody catches also goes to this page: before the handoff it
  becomes the recovery card as for a start failure, without Electron's own error box; after the
  handoff it only goes to the log, and the team works as usual. The start window never shows a system
  message box or error box.
- After `〔复制详细信息〕` is clicked, the button's text changes to `「已复制」` ("Copied") and changes
  back after 1.6 seconds. It copies the version, platform, reason and the last 200 lines of the log.
- `〔保存日志…〕` opens the system save dialog attached to the start window (default file name
  `DS-Bot-log.txt`) and writes the same header and the last 5000 lines of the log into the chosen
  file; cancelling does nothing. The failure page, "The team view didn't load", the 180-second card
  and the copy-failed card all have these two buttons, in place of the old `〔打开日志文件夹〕` ("Open
  log folder"). "Details" opens to at most 168 px, and the log scrolls inside the box.
- When there is a new version:
  - The recovery card opens an update bar between the reason and the buttons. `〔下载并安装〕`
    ("Download and install") becomes the only main button, and `〔重试〕` becomes a normal button.
  - While downloading it shows `「正在下载 {版本}（37%，78/212 MB）」` ("Downloading {version} (37%,
    78/212 MB)"), a 4 px progress bar and `「下载太慢？手动下载」`.
  - When downloaded it shows `「正在安装，装好后会重新打开。」` ("Installing; it reopens when done.").
  - When the download fails it shows `「下载失败。」` ("The download failed."), `〔重试〕` and
    `〔手动下载〕`.
  - The whale lifts its head once, looks at the update bar, and goes still again.
- The choices on the recovery card:
  - `〔重试〕`: filled arcs stay filled; the red arc goes back to in progress, the whale shakes itself
    and goes back to work.
  - `〔换个位置…〕` and `〔用新的空白团队开始…〕` ("Start with a new blank team…"): first a folder is
    chosen (the root is settled by the same rule as on the first start); then the whale sinks to 84 px
    below the waterline and fades out over .16 s, the three arcs go back to not started, and the whale
    rises again where it was (the 12° tilt straightens, `SPRING_STRETCH`). The place line's
    `〔换个位置…〕` (section 6) takes the same path; when the phases are taken back, the whale sinks
    first even if the next snapshot finishes the first phase again at once.
  - The first success after a retry or a fresh start celebrates once, the same on first and later
    starts: as the ring closes it squashes, shows `「^ ^」` eyes and spouts, then jumps onto the Main
    Bot's avatar, or dives when there is nowhere to land (section 8).
- The team view has not loaded after 20 seconds:
  - The main window never shows.
  - The whale takes the failure pose, the "Open the team" arc turns red, and its line changes to
    `「团队界面没有加载出来」`, with no cross. The card first has one sentence on what happened,
    `「引擎已经起来了，但团队界面 20 秒内没有画出来。」` ("The engine is up, but the team view didn't
    draw within 20 seconds."), and one on what to do, `「重新载入一次；还不行，就复制详细信息去反馈。」`
    ("Reload it; if it still doesn't show, copy the details and report it.", small text), then
    `〔重新载入〕` ("Reload"), `〔复制详细信息〕`, `〔保存日志…〕` and "Details" (`「详细信息」`), with no
    first line from the whale.
  - `〔重新载入〕`: reloads in the hidden main window, the "Open the team" arc goes back to in progress,
    and the 20 seconds start over.
  - A late `ready()` hands off directly, without a celebration.

### 8. Handoff

Every kind of start begins its handoff the same way. `t0` is the moment `ready()` arrives (counted
from the end of the entrance if the whale is not yet in place): all arcs not yet full fill together
(.56 s), and the ring closes: the gaps close (.3 s), and the full circle swells once (.5 s, section 2).
The handoff waits neither for queued phases nor for text on the page.

The celebration handoff is the handoff of a first start, and of the first success after a retry or a
fresh start (section 7):

| Time | Start window | Main process |
|---|---|---|
| `t0` | The ring closes; the whale squashes then stretches (460 ms), `「^ ^」` eyes, one tail flick, one spout (section 3) | The main window shows on its final rectangle, but at opacity 0, off the taskbar and below the start window: Windows' own opening transition finishes while it cannot be seen, and showing a window this big no longer stalls the first step of the growth that follows |
| `t0` + 160 ms | The hint row fades out | |
| `t0` + 560 ms | At full stretch it jumps out of the water and flies to where the Main Bot's avatar will be (590 ms, see "Jumping onto the Main Bot's avatar" below); when there is nowhere to land it dives, to 1.25 times its height; the whale's line, waterline, ring, water still falling, paper and place line fade out over .16 s | |
| `t0` + 660 ms | Only for the dive: the ripple, faded in 160 ms (the spout at the handoff does not start a ripple of its own) | |
| `t0` + 720 ms | Sends `handoffShow` | The main window is already hidden on its final rectangle (centred on the start window's centre, inside the work area); the taskbar still shows the start window's button |
| `handoffShow` + 40 ms | Text, waterline, ring and paper have all faded, leaving only the Mica and the flying whale (for the dive the whale is below the waterline, leaving only the Mica) | Grows the start window from 720 × 540 to the main window's rectangle, 260 ms, ease in and out, with step-by-step `setBounds`, about 14 ms per step |
| `handoffShow` + 300 ms | | Fully grown |
| `t0` + 1080 ms (980 ms for the dive) | Lands on the avatar 60 ms after the window is fully grown (this last short stretch is in a window that no longer moves), sends `handoffDone` (for the dive, when the dive ends) | |
| `handoffDone`, at the earliest when fully grown | | The main window turns opaque under the start window and returns to the taskbar; the start window leaves the taskbar and fades out over 180 ms (`setOpacity`, composited by the system, no relayout), and the whale melts into the real avatar beneath it; when the fade ends the main window gets focus and the start window is destroyed. If there is still no `handoffDone` 300 ms after the window is fully grown, this starts anyway |

- In the celebration handoff the main window starts to show about 1.1 seconds after ready and is
  fully shown at 1.3 seconds.
- The main process does the growth: Electron 44 on Windows ignores the `animate` argument of
  `setBounds`, so the size can only change step by step. Each step relays out the page, but repaints
  only some of the steps (8 repaints in 23 steps in the probe), so during the growth the page holds
  only the flying whale: text, waterline, ring and paper have all faded before it. The whale's
  animation runs on the compositor thread, but the page repaints only on some steps, so in these
  260 ms the whale may move in jerks, more so when the machine is busy (known limits).
- The handoff without a celebration (later starts): the ring closes; at 100 ms the page's text,
  waterline, ring and paper fade out over .16 s and the whale jumps towards the Main Bot's avatar
  (480 ms), landing at 580 ms (60 ms after the window is fully grown) and sending `handoffDone`. When
  there is nowhere to land the whale dives in 290 ms (`SPRING_TAP`), to 1.25 times its height, and
  sends `handoffDone` at 390 ms; both send `handoffShow` at 220 ms. The growth and showing count from
  `handoffShow` as on the first start, and the main window starts to show about 0.6 seconds after
  ready and is fully shown at 0.8 seconds.
- When the page does not send `handoffShow`, the main process shows the main window by itself: after
  2.5 seconds for a first start and a celebration handoff, after 0.8 seconds for other later starts.
  The page sends it much earlier: 0.72 seconds with a celebration, 0.22 seconds without; if the
  entrance has not finished, at most one entrance later (560 ms, 290 ms).
- Reduced motion: no growth and no jump. The remaining arcs fill and the ring closes, each in just
  .12 s, and a celebration changes to `「^ ^」` eyes (not at the Quiet level); at 300 ms the content
  fades out over .12 s, `handoffShow` is sent at 420 ms and `handoffDone` at 440 ms, and the main
  window appears straight on its final rectangle (section 9).
- When the start window has focus, the main window shows directly and takes focus.
- When the start window does not have focus, the main window does not steal focus; it takes the
  start window's place in the stacking order, and its taskbar button flashes.
- When the start window is minimized there is no growth, the main window appears minimized too, and
  its taskbar button flashes.
- Jumping onto the Main Bot's avatar: the whale does not cross windows (two windows, two renderer
  processes and two origins cannot draw one path across windows); it flies inside the start window to
  where the Main Bot's avatar will be. The start window grows to the main window's rectangle, the main
  window appears on the same rectangle, and the avatar is right under the whale, so it looks as if the
  Main Bot walks into its own seat. Both the celebration handoff and the one without do this:
  - The plugin says where the avatar is: when the sidebar calls `dsBotApp.ready()`, it passes where
    the Main Bot's avatar is drawn in the team page (`.bt-side [data-bot-id] .bt-mark` in the team
    column, 60 px on the tiles of a wide team column, 44 px in the narrow bar):
    `{ x, y, width, height, viewportWidth, viewportHeight }`, in the team page's CSS px. It is passed
    only when the Main Bot has its default look (whale, `deepseek` colour, no photo) and the avatar is
    visible in the team column. The preload passes only bounded numbers.
  - The main process (`landingOf` in `start-window.mjs`) converts it to DIPs by the team page's zoom
    (the width of the team content area ÷ `viewportWidth`), then to the start page's own coordinates
    once the start window has grown to the main window's rectangle (the start window's frame offset is
    carried over), and puts it in the handoff snapshot: `landing: { x, y, size }`. Anything that does
    not look like a box in the page (not numbers, smaller than 16 px, outside the page) is left out.
    `main.log` records where the whale lands, or that there was nowhere to land and the whale dived.
    When the handoff waits for the user's answer (section 6), this position is kept and used after
    the answer.
  - The start page (`leap` in `whale.js`): the whale leaves the water channel (which clips it at the
    waterline) for the window-sized `.flight` layer and, in the page's own coordinates, first leaps up
    out of the water (highest at 40% of the flight, higher than both start and end), then glides to
    the avatar while shrinking to the avatar's size. For the last 300 ms the window is growing up and
    to the left, so on screen it flies up and to the left all the way into the avatar. On take-off the
    body straightens: the celebration's stretch, and the failure pose and lowered gaze before a late or
    held handoff, are taken back in the first 40% of the flight, so it lands upright like the avatar.
    Two tail strokes (none at the Quiet level); in the celebration handoff the `「^ ^」` eyes open at
    70%, so it lands with its eyes open like the avatar. If a card has just folded away and the pond is
    still shrunk, it takes off at its visible size.
  - The main window shows only after the whale lands (growth starts at `handoffShow` + 40 ms, takes
    260 ms, and the landing is 60 ms later): the celebration handoff takes off at `t0` + 560 ms, flies
    520 ms and lands at 1080 ms; the one without takes off at 100 ms, flies 480 ms and lands at 580 ms.
    If the main process is late, it waits until the window is fully grown; if the page does not report
    the landing, the main window shows anyway 300 ms after the window is fully grown. Showing means the
    start window fades out over the main window, so for these 180 ms the whale and the avatar overlap
    in one place and never jump into two.
  - When there is nowhere to land it dives as before: the Main Bot has another look or a photo, the
    team column is fully collapsed (in the narrow bar and an open drawer the avatar is visible, so it
    still lands), classic Agent mode, or the start window is minimized. DSH Desktop and DSH Web have no
    `dsBotApp`, so the sidebar reports no position, and they have no start window either. With reduced
    motion there is no jump; it fades out as before (section 9).
  - The avatar in the team view has no animation of its own: where the whale lands is the avatar.
- On a first start DSH first shows its "Preview notice" (`「预览版说明」`), whose overlay covers the
  sidebar: the whale still lands where the avatar is, and when the main window appears the avatar is
  under the overlay.
- When the main window first appears, DSH's loading and the first mount of the sidebar (#559) are
  done, and the "Preview notice" is already showing.
- The two windows use their own colours: the start window uses the light or dark DeepSeek theme, and
  the main window uses the user's own theme.

### 9. Reduced motion

- Follows `prefers-reduced-motion` (on Windows, Settings → Accessibility → Visual effects → Animation
  effects). Switching it while the window is open takes effect at once: running animations jump to
  their end.
- The whale is always a still image: no rising, loops, hops, ripples, tail, following, petting or
  spouting, and none of the nine motions in the second table of section 3; when a phase is done the
  whale does not move. Clicking the whale only changes to `「^ ^」` eyes.
- Props appear and fade directly, without popping or moving: the folder's sheets do not flip, the
  boxes do not move, the gears do not turn, the members do not hop.
- State shows only through a direct change of the eyes: open as usual, narrowed from 45 seconds,
  heavy eyelids on failure; `「^ ^」` when the whale is clicked and in the celebration handoff (from
  ready until the content fades).
- The ring does not draw itself; it is there from the start. Filling an arc and closing into a full
  circle take just .12 s each, and the circle does not swell; an arc in progress only takes the pale
  blue tint, without a running highlight.
- The whale's line, cards, hint row and update bar only fade in over .12 s and out over .16 s, without
  blur, movement or scaling. On `〔复制过来〕` the card does not fly but folds away as usual, the ring
  changes straight to four arcs (no growing, no moving aside), and the copy arc goes straight in
  progress without thickening. The card's height is set at once (the content is transparent at
  first); the group moving up and the pond shrinking, and their return down and to full size, are
  also set at once; there is no running highlight.
- When sinking to start over, the water channel fades out over .16 s, the arcs go back to not
  started, and the whale is back at once.
- The handoff has no growth and no jump: the remaining arcs fill and the ring closes, at 300 ms the
  content fades out over .12 s, `handoffShow` is sent at 420 ms, and the main window appears straight
  on its final rectangle (section 8).
- No information is lost: the arcs, props, the whale's line, hint row, buttons, the invisible phase
  list and the announcements are all there.

### 10. Colour, Mica and the title band

- The colours are the DeepSeek theme from UI standard section 2.1, one light and one dark set, defined
  on `:root` in `start.css`. `start-assets.mjs` generates them from `themes.js` and `inks.js`, and
  `--check` compares them. The whale uses `--bt-ink-deepseek` (`#4D6BFE` / `#6A84FF`).
- Light or dark follows `nativeTheme.themeSource`:
  - The main process stores the value the team view last reported, and the animation level, in
    `start-frame.json` in userData, and sets it before building the start window.
  - Without a record it follows the system.
  - It writes neither `DSH_HOME` nor `~/.dsh`.
- Windows 11 22H2 and later:
  - The window uses `backgroundMaterial: 'mica'`, background `#00000000`; the page's `html` and `body`
    are transparent.
  - The system buttons' colour is `#00000000`, their symbols use `--bt-ink`, and the Mica shows under
    the buttons too.
  - The lightest text on Mica uses `--bt-ink-2`, not `--bt-ink-3`: so do the hint row and the place
    line.
- Other Windows versions: the window background and the system buttons' colour both use `--bt-main`.
  The page is still transparent and does not need to tell the cases apart.
- At most two large areas of accent colour per screen: the whale and the single main button (a filled
  arc is a 2 px line, and the spout and drops only flash, so they do not count).
- No warning colour (`--bt-warn` is not decided): low space, OneDrive and slowness all use neutral
  ink.
- Forced colours (Windows contrast themes): the ring's faint lines use `GrayText`, and so does a
  failed arc (failure shows through the whale's pose and the title); filled arcs, the closed circle,
  the highlight on the arc, the spout and the drops use `Highlight`.
- Font: `-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif`;
  paths and logs use `ui-monospace, Consolas, monospace`. The only sizes are 13/18, 14/22 and 15/20
  (600), and numbers use tabular figures.
- macOS: like Windows, no system title bar; the traffic lights sit in the 40 px title band, the window
  uses `vibrancy: 'sidebar'`, background `#00000000`, and the page is transparent.
- Linux: system title bar, no title band, otherwise the same.

### 11. Implementation

- The start order in `main.mjs`:
  1. `setMenu`.
  2. Read `start-frame.json` and set `themeSource`.
  3. `hostPort()`, moved before building the window.
  4. Build the start window (`show: true`), `loadFile`.
  5. Import the remaining modules dynamically.
  6. Place checks (the results become cards).
  7. Start the engine.
  Once the start window has painted, build the hidden main window on its final rectangle.
- The start page's files:
  - `start.html`: CSP `default-src 'self'; base-uri 'none'; object-src 'none'`, no inline styles or
    scripts.
  - `start.css`.
  - `start.js`: the bridge and the interface.
  - `whale.js`: the whale's state machine.
  - `text.mjs`: the one table of Chinese and English text, used by the start page, the main process's
    pickers and the cards in the team window. Layers, key names, writing rules and tests are in
    [Start page copy](2026-10-29-start-copy.md): the first part of a key is the layer decided there
    (`voice`, `say`, `hint`, `card`, `reason`, `btn`, `note`, `foot`, `status`, `dialog`), which says
    where on the page the line is, with one writing rule per layer.
  - Budget: these five files together at most 45 KB (uncompressed, the target set by the prototype);
    the prototype went over, and what to do about it is under "Open questions".
- The DOM for every state is in the page from the start and is switched with `hidden` and
  attributes; no large blocks of nodes are inserted at run time.
- The three phases are an invisible list in the page (`ol`, `「启动进度」`), and `aria-current` and the
  state words update as before; only the whale, the waterline and the ring are visible: each arc's
  `data-state` (`pending`, `active`, `done`, `failed`) follows the same phase in the list, and the
  closed circle is `html[data-ring=closed]`.
- When a card needs the paper, the pond (`.pond`) shrinks and moves up with the group in the same
  spring (`shift()` in `start.js`), around the ring's centre ((360, 210) in the group's coordinates).
- `start.js` picks the whale's line and the hint row from the snapshot and the start clock
  (section 3), without asking `whale.js` and without a queue. The handoff timeline is in `whale.js`
  (section 8) and does not wait for text on the page. The page does not read `explain` (`mode`,
  `name`, `nextStep`, `previewNotice`) in the snapshot.
- `html` is `overflow: hidden` and `body` is `overflow: clip`: while the group sits low, whatever
  sticks out is clipped, and neither focus, scroll anchoring nor a restored scroll position can move
  the page.
- `start-assets.mjs` generates the whale's SVG from `characterMarkup('whale', 'deepseek')` and writes
  it into `start.html`, with fixed mask ids. The same script writes `motion.js`'s springs and the
  theme colours into `start.css`. `npm test` runs its `--check`.
- The preload exposes `dsBotStart` (`onState`, `act`) only when the page address is exactly the start
  page.
- The main process always sends the whole state, and sends it again after the page reloads. The
  preload keeps the last one and replays it to a new subscriber first.
- The main process accepts `act` only from the start window's main frame at exactly the same address,
  and only with a name on the allowlist.
- The main process owns: the phases, the two timers for 180 seconds and 20 seconds, the handoff's
  fallback timer, the taskbar progress and the update state. The page counts 10 and 45 seconds on its
  clock.
- The main process also does the growth at the handoff: the main window is built on its final
  rectangle from the start, 160 ms after `handoffShow` the start window grows there with step-by-step
  `setBounds`, at 460 ms the main window shows while the start window leaves the taskbar, and 300 ms
  later the start window is destroyed (section 8). The fallback timer picks 2.5 seconds or 0.8 seconds
  by whether this handoff is a first start and whether it celebrates. The start page sends only two
  events, `handoffShow` and `handoffDone`, as before; where the whale lands is worked out by the main
  process at the start of the handoff from the avatar position that `ready()` brought, and put in the
  handoff snapshot (`landing`, section 8); the team view gets no extra event.
- `main.log` records how long each of the three phases took.
- The start window is destroyed at the handoff, and its renderer process exits with it.

## Changes to decided designs

| Original design | Now |
|---|---|
| [Windows onboarding](2026-10-26-windows-onboarding.md) section 3, "the start page and the engine's page share this window" | The start page is in its own start window; the engine's page loads in the hidden main window, which shows only after `dsBotApp.ready()` (open) |
| Same, "the picker is attached to the window" | Attached to the start window, and never opens by itself |
| Same, the third item of the first-start notes, "Chats and settings are saved on this computer… · A community open-source project, not an official DeepSeek product" | Both halves are gone from the start window: the first half went with the notes (see the "first-start notes" row below); the second half first became a footnote on every first-start screen, and was removed too on 2026-10-31 (see the last row of this table). "Not an official DeepSeek product" stays in the README and the download section of the onboarding note |
| Same, "back to the start page" when not ready after 20 seconds | The start window stays the whole time, and the main window does not show |
| Same, "double-clicking the icon again during the first start restores and focuses the existing window" | Focuses whichever window is showing |
| Same, section 8, later starts "only say 'Opening your team…'" | No elapsed seconds; at 45 seconds the whale switches to thinking, no text; 180 seconds as on the first start |
| Same, "Changes to decided designs": the window loads the start page first, then the engine's local address | The start window comes first; the main window loads the engine's local address (the same address and port) hidden, and shows only once ready |
| Same, acceptance "the window is visible within 2 seconds of the process starting" and "no `dialog.show*` that is not attached to the main window" | The window in both means the start window |
| [Desktop app](2026-10-16-desktop-app.md) "Window" | Adds the start window: 720 × 540, not resizable, only minimize and close, Mica; at the handoff the main process grows it to the main window's rectangle (section 8) |
| [UI standard](../design/ui-standard.md) 4.4 avatar sizes | Adds 112 (start window) |
| Same, 8.3 state motions | Adds motions found only in the start window: rising, the tail stroke and surge when a phase is done, the nod, the spout, jumping onto the Main Bot's avatar at the handoff (or diving), the tail sway |
| Same, 3.1 font families | The start window adds `"Microsoft YaHei UI"`, recorded in section 14 |
| Same, 12 accessibility | For a newly shown card and the recovery page, focus moves to the main button |
| [Windows onboarding](2026-10-26-windows-onboarding.md) section 3, "the title 'Preparing your Bot team…', with the three real phases below, each with a progress tick"; this note's first draft, section 2: the title row and the three stations (four looks of a 16 px marker, phase names, thin lines between stations, a running highlight while in progress) | No title row, and the phases are not drawn: the station where the whale stops is the progress, a station it leaves keeps a ring, and nothing else is drawn on the waterline; the three phases stay only in the invisible "Start progress" list, and announcements are as before; the elapsed seconds move to the top right; without a card the group sits 80 px lower (sections 2 and 3) |
| Same, the first-start notes (product introduction, "Next: connect a model…", "Chats and settings are saved on this computer…", the small text giving the place, "DeepSeek Harness's 'Preview notice' shows first…"); this note's first draft, section 4, beat 3, notes that appear one by one | No more notes. The whale says one short line at a time (sections 3 and 4); the hint row says only the one thing to know next: "You'll connect a model soon: a DeepSeek account or an API key", "A notice page comes first; just click 'Continue'"; the first start does not show the full path, the place line shows only the drive and the free space (second addition, 2026-10-28), and the path appears only on cards and in Settings → General → Location |
| This note's first draft of 2026-10-28: the first start has no entry for choosing the place; only the recommended-drive card has `「其他位置…」` | When the disk is short of space, the place line `「数据放在 C 盘（剩 1.2 GB）」` with `〔换个位置…〕` can be clicked at any time (sections 2, 4 and 6). Maintainer, 2026-10-28: "give a suggestion, and also offer a way to choose for yourself; avoid small pop-ups"; from 2026-11-01 there is no place line when there is enough space ("Changes") |
| Same, the hints past 10 and 45 seconds, "The first start is a bit slower; Windows may be checking the files it just installed." and "Slower than usual; antivirus software may be checking new files, please wait a little longer." | No text: at 45 seconds the whale switches to thinking, and the highlight on the arc and the prop slow down (2026-11-01) |
| Same, the start takes more than 180 seconds: "The start is much slower than usual. You can wait a little longer, or try again." | The whale asks `「等太久了，要不要重试？」`, and the card holds only `〔继续等待〕`, `〔重试〕`, `〔复制详细信息〕` and `〔保存日志…〕` |
| Same, the small text of the notes on a reinstall, "Continuing with your last data: 6 Bots, 2 group chats (`C:\Users\<user>\.ds-bot`). You can change this in Settings → General → Location." (copied in section 6 of this note) | The hint row says "Your 6 Bots and 2 group chats from last time are all here", without the path |
| This note's first draft, section 6, the copy title "Copying the Bot team…", three steps "with the same markers as the three stations" | Title "Moving in"; the markers of the three steps stay, written in section 6 (the three stations no longer have markers) |
| Same, "Not done": "The whale does not talk, show bubbles, cover cards or buttons, or ask the user to do anything"; section 3, "a phase done… the marker behind it pops a tick"; section 7, the failed station becomes a cross in the danger colour | The whale says a short line about its state, and a card's first line is also its line (except on failure cards); only the 180-second line is a question, and the answer is on the card's buttons; still no rotating tips or jokes, no bubbles; a finished station keeps a ring; failure shows only through the whale's pose and the decided title, with no cross |
| Same, section 1, "the start window never changes size" | It does not change before the handoff; at the handoff the main process grows it to the main window's rectangle, and the main window is built on that rectangle from the start (sections 1 and 8) |
| Same, section 8, handoff: `handoffShow` is sent 620 ms after `t0`, the start window then leaves the taskbar and the main window shows, and the start window closes once the main window has shown for 250 ms (at most 400 ms); later starts show the main window at 120 ms; when the page does not send `handoffShow`, the first start falls back after 1.5 seconds; "Not done", "the start never waits for an animation", "the celebration happens only on the first start and the first success after a retry" | The first start first says "In we go", and celebrates 300 ms later; `handoffShow` about 1.1 seconds after ready; 160 ms later the start window grows to the main window's rectangle in 300 ms, the main window appears at 460 ms, only then does the start window leave the taskbar, and it is destroyed 300 ms later; the main window appears about 1.6 seconds after ready (about 0.6 seconds on later starts, about 1.5 seconds for a later start that celebrates); the fallback becomes 2.5 seconds for a first start and a celebration handoff, and stays 0.8 seconds for other later starts; no growth with reduced motion; loading the engine and the team view never waits for an animation, and the handoff waits about 460 ms more for the growth; a later start that celebrates does not say "In we go" |
| [UI standard](../design/ui-standard.md) section 1, item 4, and 8.4, "continuous ambient animation only at the Lively level"; 8.4, Lively "keeps hopping while waiting for your answer"; 8.3 state motions | Only in the start window, while a card waits for the user's answer, the Normal and Lively levels also breathe and blink; Lively changes to hops that grow rarer; also adds leaning in, ready to press, eyes following keyboard focus, and a look at you on return to the window (section 3, second table). None of it at the Quiet level or with reduced motion; the avatar in the plugin does not change |
| This note's first draft, section 3, "moves only for real events: … and the user's pointer and clicks", "still while waiting for the user's answer"; the table in section 3 and section 6, "two hops, then still, looking at the card", "no hop, still" | Holds still while waiting for the user's answer: leaning in, breathing and blinking (section 3, second table), and also moves for keyboard focus and a return to the window; at the Quiet level, with reduced motion and on failure pages, once still it stays still |
| This note of 2026-10-28, section 4, beat 2, "if already done, swims straight to station 2" | It leaves station 1 only once the greeting has been read in full (1.66 seconds after the page paints), bobbing while it waits (section 4). Maintainer trying it on 2026-10-29: "when I saw the little whale it was already at the second position": the main process had built the data folder before the page painted, so the whale swam off as soon as it rose, and station 1 seemed never to have happened |
| This note's sections 5, 6 and 7: at 45 seconds "Slower than usual, please wait a little longer."; "It will go in `D:\DS Bot`" with "Continue" and "Choose again"; "…syncing interrupts chat records while they are being written."; the whale's line "The team view didn't load." | No text at 45 seconds (2026-11-01); `「会放在 D:\DS Bot。」` with `〔继续〕` and `〔重新选…〕` (the same `〔重新选…〕` on the rejected card); "…chats while they are being written."; `「团队界面没有加载出来」`. Follows the writing rules of each layer in [Start page copy](2026-10-29-start-copy.md) |
| This note of 2026-10-28, sections 2, 3 and 9: the whale stops at one of three stations (x 168 / 360 / 552), swims right to the next station when a phase is done, and a station it leaves keeps a ring; a 624 px waterline; an 88 px whale on the first start, 64 px on later starts without a waterline; with reduced motion a change of station fades out and in | The whale stays in the middle, and the three arcs around it are the progress: pale blue with a running highlight while in progress, filled clockwise when done, red on failure; the waterline is a chord of the ring (200 px); every kind of start has the 112 px whale, the ring and the waterline; when a card comes the pond shrinks to .62 times and moves up 60 px, and the ring rests above the card (sections 2, 3 and 9). On 2026-10-30 the maintainer passed on a discussion that found this version too noisy: "this version is a bit noisy now", "could it be a bit simpler"; after comparing three proposals (a progress bar of three waterline segments, a ring, only the whale) the ring was chosen |
| Same, sections 3 and 4: the whale says one short line at a time, which follows the whale and queues by hold time: entrance "Hi, I'm the chief" (on a reinstall the name of the team's Main Bot, on an import "Hi, I'm here"), "First, find a place for things", "Found it", "Warming up, give me a moment", at 10 seconds "The first time is a bit slower", "Off to open the door"; a card that arrives during the entrance waits 1.5 seconds for the greeting to be read; "Open questions" asks which name the greeting uses | Silent when all goes well; one line only at 45 seconds, 180 seconds, on failure and during a data move, fading out and in on a change, with no queue (section 3). From the discussion: "actually I think just a whale may be enough, and then we can do interactive animation; text isn't really needed". A smooth start lasts only a few seconds, and the ring already shows the progress; so the name of the greeting no longer needs deciding |
| Same, section 4, beats 3 and 8, and section 6: the hint row says what to know next: for a new team "You'll connect a model soon: a DeepSeek account or an API key", on a reinstall "Your 6 Bots and 2 group chats from last time are all here", and when DSH will show its preview notice "A notice page comes first; just click 'Continue'" | The hint row has only `「C 盘只剩 1.2 GB」` for the first 10 seconds when the disk is short of space, and `〔打开日志文件夹〕` from 45 seconds (sections 3 and 4). All three lines are about what happens once inside: the Main Bot's settings card covers connecting a model, the preview notice has its own "Continue", and a reinstall opens on the old team; saying it early while waiting only adds a line of text |
| Same, sections 2 and 4: "N seconds elapsed" at the top right from 5 seconds, hidden while a card waits for an answer, kept until "In we go"; on later starts in the hint row from 10 seconds | Not shown; 10, 45 and 180 seconds are still counted on the same start clock, which still stops while a card waits for an answer (section 4). A number that ticks every second was the only text that kept changing on the page in a smooth start; when it is slow there is no text, and the 180-second question and the failure page give the way out (2026-11-01) |
| Same, section 3, Normal level "while the first start waits, clicking the whale makes it spin once"; Quiet level "no eye following, click spin, petting, tail… or `「^ ^」` eyes"; "Not done", "no spout" | Clicking the whale makes it spout, on every kind of start: the 4th click within 2.5 seconds gives a big spout, while lying down after a failure only a small puff, and no spout during the entrance, the sinking or after ready; the Quiet level spouts too, the column one size smaller, with the squash, tail flick and `「^ ^」` eyes as usual; reduced motion only changes to `「^ ^」` eyes (section 3). The maintainer proposed exactly this: a whale floating on the water that spouts when clicked. Without text, interaction is the whale's only response to the user, and the spout is the whale's own motion. The Quiet level has it too: it appears once only after the user clicks, and is not a continuous ambient animation |
| Same, section 8: the first start first says "In we go" (shown only after the previous line has been readable for 400 ms, `readyLine` waits at most 600 ms), and 300 ms after it appears squashes, shows `「^ ^」` eyes and dives; queued swimming could delay the handoff by up to 600 ms; a later start's first success after a retry or a fresh start does not say "In we go" and dives 920 ms after the squash and spring back | All arcs not yet full fill together, the ring closes and swells once; the celebration handoff (first start, first success after a retry or a fresh start) at the same time squashes, shows `「^ ^」` eyes and spouts, and dives at 560 ms; the first start and a later start that celebrates use the same table (section 8). Without text, the ring closing is the "done"; the spout is the motion the user has seen when clicking the whale |
| This note of 2026-10-29, section 4, beat 2: the whale leaves station 1 only once the greeting has been read in full (1.66 seconds after the page paints) | The first arc fills 260 ms after the entrance at the earliest (820 ms after the page paints) (section 4). There is no greeting to wait for; and the whale no longer leaves, so the "rises and swims off" that the 1.66 seconds guarded against cannot happen; only one beat is kept so that people see the first arc fill |
| This note of 2026-10-28, section 5: on later starts the 64 px whale has "Opening your team…" under it, with a running highlight after 1 second, no waterline and no rings; nothing else moves in the first second | The same page as the first start, with no text when all goes well; from 45 seconds the whale says "Slower than usual, please wait a little longer", and the hint row has only `〔打开日志文件夹〕`; in the first second only the beat when the first arc fills (tail stroke, surge, nod) (section 5). The ring already says it is opening; later starts take only 3 to 12 seconds, so a line of text that is always there is noise. A phase done is a real event (section 3), so later starts also show the ring moving |
| Same, section 8: on the first start `handoffShow` about 1.1 seconds after ready and the main window appears at about 1.6 seconds; on later starts 120 ms and about 0.6 seconds; for a later start that celebrates about 1.04 seconds and about 1.5 seconds; with reduced motion about 0.86 seconds | The celebration handoff sends `handoffShow` at 0.72 seconds and the main window appears at about 1.2 seconds; without a celebration 0.22 seconds and about 0.7 seconds; with reduced motion 0.42 seconds; the main process's fallback is unchanged (2.5 seconds, 0.8 seconds, section 8). With no "In we go" to read, the handoff no longer waits for text; the handoff without a celebration gains 100 ms, so the closed ring is seen first |
| This note's sections 2 and 6: without a card, the pond, the whale's line and the hint row sit as a group 80 px lower than with a card, putting the whale at the window's visual centre (ring centre (360, 290), waterline y 322, the whale's line y 414–434, hint row y 438–466); when a card comes the group moves up 80 px | 45 px lower, putting the whale a little above the window's visual centre: ring centre (360, 255), water channel y 147–287, waterline y 287, the whale's line y 379–399, hint row y 403–431; when a card comes the group moves up 45 px, and the position with a card is unchanged (sections 2 and 6). Maintainer, 2026-10-30: "move it up a bit" |
| This note's sections 3, 4, 5, 7 and 8: at ready the whale dives, to 1.25 times its height; on the first start the Main Bot's whale rises once on its tile in the team view's sidebar, done by the plugin, with a reveal event sent through `dsBotApp` when the main process shows the main window (open), and the first card in the Main Bot's chat waits for it to rise; "Open questions" asks how the whale on the tile knows it should rise, and what happens when the "Preview notice" covers the sidebar; "Not done", "the whale does not fly from the start window into the main window" | The whale jumps out of the water, flies inside the growing start window to where the Main Bot's avatar will be, shrinks to the avatar's size and lands; the main window appears on the same rectangle, with the avatar right under it. The sidebar passes the avatar's position with `dsBotApp.ready()`, and the main process converts it to the start page's coordinates (`landing`); there is no reveal event, the avatar in the team view has no animation of its own, and the first card does not wait; while the "Preview notice" is up it still lands where the avatar is. When there is nowhere to land (another look or a photo, the team column collapsed, classic Agent mode) it dives as before, and with reduced motion it fades out as before (sections 3 and 8). Maintainer, 2026-10-30: "after the start, morph smoothly into the main page, and Chief jumps to Chief's spot on the left of the main page" |
| This note's section 8, "during the growth nothing but Mica may be on the page" | During the growth the page holds only the flying whale: text, waterline, ring and paper still fade before the growth; the whale's animation runs on the compositor thread, but the page repaints only on some steps, so in these 300 ms the whale may move in jerks (section 8, "Known limits"). The whale must stay visible to land on the avatar: this is accepted for "Chief jumps to Chief's spot on the left of the main page" |
| This note of 2026-10-28, sections 2, 4 and 5: a footnote at the bottom left, "A community open-source project, not an official DeepSeek product"; the place line at the bottom right, with "Change the location…" as a link; later starts without a place line | No footnote; the place line at the bottom centre, with `〔换个位置…〕` as a small grey button; on later starts it also shows when the disk has only a fifth of its starting free space left, and the button moves the data right away (sections 2 and 5). A later start asks the data-move confirmation and `「这里放不了」` on cards, and only the picker is a system window (section 6). Maintainer, 2026-10-31: "remove the community/unofficial note at the bottom left; show the bottom-right one at init, and otherwise only when space is low (free space is 20% of the starting capacity): change the location"; the starting capacity was taken as the free space at the first start (in the code, the free space of the disk when the data was put in that folder: recorded when the first start sets the place, recorded again after a change of place, a data move or an import copy, and filled in on the next start for older installs), the position as the bottom centre, a later start moves the data right away on the click, and "make it a grey button instead"; after seeing the system dialog that rejected a data move: "let's avoid any default pop-ups like this in the system as far as we can" |

## Changes

- 2026-10-26: Decided the start window's look and motion. Basis: a merge of three independent
  proposals and two rounds of review, probes on Electron 44 (Mica, system button colour, rendering in
  a hidden window), and a prototype that can be opened and viewed.
- 2026-10-26: Rewrote the place cards after the simplification in onboarding sections 3 and 4: one
  recommended-drive card instead of the four cards "Found earlier data", "Disk is short", "Place
  cannot be used" and "Team workspace is in OneDrive"; a confirmation only when the app changed the
  path; no card on a reinstall; an import card with one sentence and two buttons, details folded; the
  copy in three steps, and the work files not through the start window. Corrections after review: the
  card for an unusable default place has no `〔仍然放在 C 盘〕`; each card names its main button; the
  "data folder not found" card joins the cards with two hops.
- 2026-10-27: The import card gets a line of small text that says how much more the copy takes and
  that the originals stay untouched; the change-of-place page is renamed "Moving DS Bot's data…"
  (onboarding §8's `〔移到…〕` becomes a real move). Corrections after review: when the engine comes up
  while the import card is open, it only ticks and does not load the page (§1, §4 beat 8); the in-use
  card and the download card have `〔先不复制〕`; the rejected card keeps the buttons and footnote of the
  card it came from; the space example becomes 1.7 / 1.5 / 0.2 GB.
- 2026-10-27: Section 1 adds the sign-in window (onboarding section 5): a child of the main window,
  shown only after the handoff when the user clicks a sign-in entry; the start window phase has none.
- 2026-10-28: Rewritten after the maintainer's feedback of 2026-10-27: the small window showed how the
  code is built (a line with three dots and phase names, several notes), not what the user feels, and
  the last step's jump into the team window was too abrupt. Three parts were decided together: (1) a
  "the whale is the progress" start window: the station where the whale stops is the progress, a
  station it leaves keeps a ring, all text in the window is the whale's short lines, one at a time,
  and a card's first line is its line too; the title row, the stations' markers and phase names, the
  notes and the small text giving the place are removed, the 180-second card keeps only buttons, a
  reinstall gets a single hint, and the copy title becomes "Moving in"; the whale is more responsive
  (leaning in, breathing, blinking, a look at you on return to the window, eyes following keyboard
  focus, ready to press, Lively hops that grow rarer, diving deeper), with breathing and blinking only
  while a card waits for the user; at the handoff the start window grows to the main window's
  rectangle and the main window appears on the same rectangle (about 1.6 seconds after ready, fallback
  2.5 seconds), and the whale rises on its tile in the sidebar. (2) The goal card after the handoff
  becomes a multiple choice with `〔确定〕` ("OK"). (3) The second half of the AI-native work: the
  opening line does not call the model, the plugin draws the goal card, the suggestion card and the
  first task, onboarding makes at most 3 model requests, and it works with the model turned off. The
  last two parts are in onboarding sections 5 and 6; this note goes only up to the handoff. Basis: the
  prototype and its checks (82 states, 22 scenarios, a joint check of the handoff and the team
  window), and a probe of growing windows on Electron 44. Corrections after review: how the whale on
  the tile rises goes into section 8 (values from the prototype, started by the main process through
  a `dsBotApp` reveal event, open), no longer pointing at onboarding section 5; the name in the
  greeting follows the team (a reinstall uses the team's name, an import or an unreadable name gives
  "Hi, I'm here"); a card that arrives during the entrance waits 1.5 seconds for the greeting to be
  read; the 300 ms minimum hold and "this line is empty while a card is up" state the failure and
  180-second exceptions; a later start's first success after a retry or a fresh start does not say "In
  we go" and dives 920 ms after the squash and spring back, with the same 2.5-second fallback as the
  first start; the start window leaves the taskbar only when the main window appears; with reduced
  motion the `「^ ^」` eyes hold 300 ms longer; the elapsed seconds hide while a card is up; the 45 KB
  budget goes into section 11, with the same suggestion as the onboarding note; "faint ring" is called
  just "ring", as in the onboarding note; the fallback for an empty Mica frame, the delay in "Not done"
  and "does not ask the user to do anything" are rewritten for the new handoff and the talking whale;
  first-draft rules such as "still while waiting for the user's answer" are recorded in "Changes to
  decided designs"; the "Changed with" list in the header is completed.
- 2026-10-28 place line: when the first batch landed (start window, handoff, failure page, log), the
  maintainer saw that the first start still opened the "Welcome to DS Bot" system dialog, and asked to
  "give a suggestion, and also offer a way to choose for yourself; avoid small pop-ups". The first
  start no longer opens that dialog; right of the footnote is a line `「数据放在 C 盘（剩 412 GB）· 换个位置…」`
  (sections 2 and 4), which opens the system picker only on a click; settling the root, "It will go
  in…" and `「这里放不了」` follow section 6, the rejection reasons add the DSH home and program folder
  sentences, once settled the start sinks and begins again as in section 7, and the folders this start
  built in the default place are deleted; it folds away after an import copy. Basis: the code in the
  desktop app and its checks (`place.test.mjs`, `start-window.test.mjs`, tests on the unpackaged app).
- 2026-10-28 glancing: section 3's second table adds number 9: while working at station 2 the whale
  looks to one side for 600 ms every 5 to 9 seconds at random, not at the Quiet level or with reduced
  motion; the maintainer asked "could the little fish's sway become a random sway-and-glance?", and it
  can, on top of the bob. Basis: the wander case in the prototype's `alive.cjs` (three times in 30
  seconds at the Normal level, gaps of 7.8 to 8.5 seconds, zero times at the Quiet level and while the
  pointer is on the page).
- 2026-10-29 greet first, then set off: section 4, beat 2: even when the data phase is done, the whale
  waits for the greeting to be read in full before leaving station 1, bobbing while it waits. When the
  maintainer tried the landed start window: "when I saw the little whale it was already at the second
  position": on that first start the main process built the data folder in 2.9 seconds, and the page
  painted only at 8.6 seconds (a cold start; 2 seconds on the next two starts), so the whale swam to
  station 2 560 ms after rising. Basis: the greet case in the prototype's `alive.cjs` (when the data
  phase finishes before the entrance ends, the whale leaves station 1 1.66 seconds after the entrance
  and says "Warming up, give me a moment" 0.6 seconds later; the same when it finishes halfway through
  the search, without saying "First, find a place for things"), and measurements on a trial copy (the
  window appears at 1.1 seconds, the data is done at 1.9 seconds, the page paints at 2.1 seconds; the
  whale leaves station 1 1.68 seconds after the entrance; `main.mjs` starts the engine right after it
  marks the data done, and "engine took" in the log counts from that moment, independent of the
  greeting).
- 2026-10-29 copy layers: the start page's text is layered by its place on the page, in one table, see
  [Start page copy](2026-10-29-start-copy.md); the `text.mjs` item in section 11 now points there;
  four changes follow the layers' rules: the 45-second hint and "The team view didn't load" lose their
  full stops, "It will go in …" gains one, "Choose again" gains …, and the OneDrive reason says "chats"
  instead of "chat records" (sections 5, 6 and 7).
- 2026-10-30 ring: the maintainer passed on a discussion that found the start window too noisy ("this
  version is a bit noisy now", "could it be a bit simpler", "actually I think just a whale may be
  enough, and then we can do interactive animation; text isn't really needed"), and proposed keeping
  only a whale floating on the water that spouts when clicked, with the progress as a bar or a ring;
  after comparing three proposals (a progress bar of three waterline segments, a ring, only the whale)
  the ring was chosen. "Why" and sections 2 to 11 are rewritten for the ring: the three stations and
  the rings they leave become three arcs around the whale, every kind of start has the 112 px whale,
  ring and waterline, and when a card comes the pond shrinks to .62 times and moves up 60 px; silent
  when all goes well (the greeting, the per-phase lines, "In we go", connecting a model, the preview
  notice and reinstall hints, and the elapsed seconds are removed, and later starts lose "Opening your
  team…"), keeping only the low-space hint, 45 seconds, 180 seconds, failure, cards and the data move;
  on later starts and during a data move the whale says the 45-second line; clicking the whale spouts
  instead of spinning; at the handoff the remaining arcs fill and the ring closes, the celebration
  spouts, dives at 560 ms and sends `handoffShow` at 0.72 seconds, and the one without at 0.22 seconds.
  "Open questions" loses the greeting's name, and the waterline row is rewritten for the ring; "Not
  done" and "Known limits" follow. Basis: the prototype's ring layout (screenshots of all 82 states
  passed the layout probe, which also checks that the ring does not touch the whale's line, the hint
  row or cards: no problems); `ring-live.cjs`: on the first start `handoffShow` 0.72 seconds after
  ready (1.09 to 1.17 seconds in the old layout), on later starts 0.23 to 0.33 seconds, all within the
  prototype's fallbacks of 1.5 and 0.8 seconds; the 45-second `〔打开日志文件夹〕` can be clicked with
  the pointer, the data-move line is there, the spout's `「^ ^」` eyes give way to the failure pose, and
  `〔重试〕` clears the red arc; all 10 comments from an independent review are fixed (the empty paper
  lets clicks through, the hint row hides while a card is up, the 112 px whale's entrance depth of 96 /
  84 px, sinking 84 px, the spout's `「^ ^」` eyes do not override the failure pose, no spout after ready,
  forced colours cover the arcs, highlight, spout and drops, the arcs draw in 0.5 s, and so on). Checks
  in the desktop app (off-screen Electron, a stand-in bridge, all 15 pass): on the first start
  `handoffShow` 0.73 seconds after ready, on later starts 0.24 seconds (with the engine up only 0.5
  seconds before ready); when the data phase finishes before the page paints, the first arc fills at
  820 ms, and one finished at 700 ms goes in progress at 565 ms and fills at 999 ms. A first start on
  real hardware (a one-off copy of this branch with the pinned DSH 0.2.1-rc.4): the window appears at
  1.5 seconds, the page paints at 2.9 seconds, the first arc fills at 2.6 seconds page time; the second
  arc fills after 17.1 seconds of engine start, and the team is ready 4.4 seconds later; `handoffShow`
  738 ms after ready, the window starts to grow 173 ms later, the team window appears 1.31 seconds
  after ready, and the page shows no leftover rings or elapsed seconds. Two deliberate differences
  from the prototype: the whale keeps its loop while the first arc waits (the prototype switched to
  the working loop first, and the 400 ms that a loop must stay delayed the arc further); and at ready
  the beat in progress is no longer finished, and the remaining arcs fill together (the prototype let
  it finish; in the desktop app written after the prototype, a later start whose engine came up 0.5
  seconds before ready sent `handoffShow` only at 0.46 seconds). Corrections after review: the whale
  keeps its loop while the first arc waits (section 4); later starts have the beat of the first arc
  filling in the first second (section 5); a nod when a beat ends (section 3); at the Quiet level a
  click on the whale still squashes, flicks the tail and shows `「^ ^」` eyes; the rising ripple fades
  in .56 s; the low-space line counts its first 10 seconds on the start clock and is there from the
  entrance.
- 2026-10-30 jump to Chief: the maintainer asked "should we add a short description of what it is
  doing, move it up a bit, after the start morph smoothly into the main page, and Chief jumps to
  Chief's spot on the left of the main page", then "do all three", and right after "keep the copy
  cancelled": so no text describing the current work was added, and the page still has no text when
  all goes well (section 3); only the other two points were done. First, moving up: without a card the
  group sits 45 px lower (80 px before), the ring moves up 35 px, and when a card comes the group moves
  up 45 px; unchanged with a card (sections 2 and 6). Second, at the handoff the whale no longer dives
  but jumps out of the water, flies inside the growing start window to where the Main Bot's avatar
  will be, shrinks to the avatar's size and lands, and the main window appears on the same rectangle
  (sections 3, 4, 5, 7, 8, 9 and 11): the plugin's sidebar passes the Main Bot's avatar position in
  `dsBotApp.ready()` (only for the default whale with the avatar visible in the team column), the main
  process converts it with `landingOf` to the start page's coordinates and puts it in the handoff
  snapshot, and the start page's `leap` flies 590 ms (550 ms without a celebration), landing 30 ms
  before the main window appears; `handoffDone` is now sent on landing (1150 ms with a celebration,
  650 ms without); when there is nowhere to land it dives as before. The whale rising on the tile and
  the `dsBotApp` reveal event are dropped, and their row in "Open questions" goes with them: the avatar
  in the team view need not move by itself, since where the whale lands is the avatar; when the
  "Preview notice" covers the sidebar the whale still lands where the avatar is, and the avatar is
  under the overlay (section 8). "During the growth nothing but Mica may be on the page" becomes
  "only the flying whale"; that the whale may move in jerks during the growth, and that the landing
  point may be a few pixels off when the team column is still moving after `ready()`, go into "Known
  limits"; "Not done" follows. Basis: the app's tests (`start-window.test.mjs`: `landingOf` is right
  when both windows have the same frame, when the team page is zoomed to 125 %, and when only the start
  window has a system title bar, and no malformed report lands; with a position in `ready()` the
  handoff snapshot has `landing`, without one it does not; `start-page.test.mjs` checks the `.flight`
  layer), and the plugin's sidebar test (`app-ready.test.js`: the default whale reports its position,
  another look or a photo does not). A first start on real hardware (a one-off copy with the pinned DSH
  0.2.1-rc.4, the team page zoomed to 125%): the main process recorded "the whale lands at 105, 116
  (60 px)", and after the team window appeared the Main Bot's avatar in the sidebar was at (104, 116),
  60 px, 1 px off; `handoffShow` 738 ms after ready, the window starts to grow 171 ms after it,
  `handoffDone` 442 ms after it, and the team window appears 1.32 seconds after ready: on this machine
  the growth is slower than 300 ms, so the whale lands first and then grows with the window (two runs,
  the same landing point both times); on the first start the "Preview notice" overlay covers the
  sidebar, and the avatar is under the overlay
- 2026-10-31 place line: the maintainer: "replace the old three-dot style, remove the community/
  unofficial note at the bottom left, and the change-location at the bottom right". On follow-up
  questions: the "three-dot style" is the old three stations, which the ring has already replaced, so
  this change leaves it; the maintainer asked "should the ring show the 3 phases being started?": each
  of the three arcs already is one phase (section 2), so no text is added (2026-10-30, "keep the copy
  cancelled"). The footnote is removed; the place line moves to the bottom centre, `〔换个位置…〕` becomes
  a small grey button (28 px, `small`), and the whole line sits 4 px below the paper (section 2); the
  first start still has it, and later starts have it only when the disk with the data has less than
  20% of its starting free space left: the starting free space is recorded in `locations.json` when
  the data is put in a folder (`freeAtStart`; when the disk is full it cannot be recorded, and is
  recorded the next time), places saved earlier get it on the next start; on later starts
  `〔换个位置…〕` moves the data right away (section 5). In testing, a rejected data move opened a system
  dialog, and the maintainer said: "let's avoid any default pop-ups like this in the system as far as
  we can". So during a later start's data move everything except the system picker is asked on cards:
  `「这里放不了」` uses the rejected card of section 6 (with two more reasons, "whole drive" and "contain
  each other with the team workspace", and an unreadable folder counts as no permission), and the
  confirmation is a new card, `「搬到这个文件夹？」` with `〔移动并重启〕`, `〔重新选…〕` and `〔取消〕`; after
  the confirmation the start window turns into the data-moving page on the spot, this start gives way,
  and the waiting handoff is dropped. The system dialogs that remain go into "Known limits". Sections
  2, 3, 4, 6 and 8 and "Changes to decided designs" follow. Basis: the app's tests (`place.test.mjs`:
  the 20% boundary; `start-window.test.mjs`: turning into the data-moving page and dropping the waiting
  handoff; `main-low-space.test.mjs`: with the disk nearly full a later start has the place line, a
  choice inside the data folder gives `「这里放不了」`, an unreadable `C:\System Volume Information`
  counts as no permission, after a cancel the engine comes up and the team view loads as usual, and
  after `〔移动并重启〕` the page loads `?start=moving`, the engine stops before the copy, the data is
  copied to the new folder, `locations.json` switches to the new folder and its own free space, and the
  app restarts, with no system dialog all the way; `main-room-left.test.mjs`: with plenty of free space
  there is no place line, changing the team workspace leaves the recorded free space alone, and the
  data move in Settings works as before; `main.test.mjs`: a place never recorded gets recorded this
  time; `start-page.test.mjs`: the footer holds only the place line and the grey button, and the
  data-move cards); deliberately breaking the 20% check, stopping the engine before the copy, or
  dropping the start on cancel each makes the tests fail. All 17 off-screen rendering checks pass (the
  place line is centred, clickable with the pointer, 12 px from the bottom edge, 4 px below the paper
  with a card, on later starts and the failure page, long English paths with an ellipsis, dark, both
  cards). An independent review (four aspects, each comment checked once more) confirmed 7 comments,
  all fixed: an unreadable folder no longer turns a normal start into the failure page, a 0 recorded
  while the disk was full does not count, and the wording in start-copy section 3, this note's section
  5, "Changes to decided designs" and the onboarding note. A later start on real hardware (a one-off
  copy of this branch, 4.0 GB free on drive G, a recorded starting space of 10^15 bytes): the place
  line `「数据放在 G 盘（剩 4.0 GB）」` ("Data on drive G, 4.0 GB free"), clickable with the pointer;
  first the picker was cancelled, and the start went on as usual; then clicked again and a folder
  chosen, the team view became ready while the card was open, and the handoff waited; the card
  `「搬到这个文件夹？」` showed the real path, with no system dialog; after `〔移动并重启〕` the start
  window turned into the data-moving page, the waiting handoff was dropped (after waiting 13 seconds),
  and 6 seconds later the app restarted on the new folder and handed off, with `locations.json`
  holding the new folder and 3.99 GB.
- 2026-11-01 no text, add props: the user asked that "the start window rarely shows text, unless space
  is low or there is an error, and the latter offers one-click copy/download of the log", and that
  "while loading there should be related components, for example a folder flipping its pages in front
  of the whale, two gears turning with a pulse". So the two 45-second lines ("This is taking a while;
  antivirus software may be checking new files", "Slower than usual, please wait a little longer"),
  the data move's "Moving DS Bot's data…" and the 45-second `〔打开日志文件夹〕` are removed, and slowness
  shows only through the whale's pose; on a first start the place line also shows only when the disk
  is short of space (overturning "the first start still shows it" of 2026-10-31, so a first start with
  enough space has no entry for choosing the place); every error page has `〔复制详细信息〕` and the new
  `〔保存日志…〕` (`saveLog`, the system save dialog, the last 5000 lines) in place of `〔打开日志文件夹〕`
  (`openLogs` is no longer a start page action); a prop for each phase goes in front of the whale: a
  folder flipping sheets, meshing gears, small hopping members (sections 2, 3, 4, 5, 6, 7, 9 and 11).
  Basis: unit tests of the start page and the start window; a whole start recorded in headless Chrome
  with a stand-in bridge (light, dark), and screenshots of each phase, the failure page, 180 seconds
  and low space; with reduced motion the props have no loop animation. Not yet run on real hardware in
  the desktop app, and `〔保存日志…〕` has not been clicked for real yet. This change alters a decided
  design and needs the maintainer to confirm it.
- 2026-11-01 (waiting for the maintainer to confirm): animation has one source. The start window's
  cards and the cards in the team window that replace system dialogs (`app/src/page-card.css`) use the
  same colours and springs, all generated by `scripts/start-assets.mjs` from the plugin's `themes.js`
  and `motion.js`: a card appears on `SPRING_SHAPE`, folds away with the start window card's exit
  (sinks 6 px, shrinks to .975, blurs 3px, .16 s), and with reduced motion only fades in over .12 s and
  out over .16 s (section 9). The import cards (section 6) get their snapshots from the main process's
  `import-flow.mjs`, and the page still draws only from the snapshot.
- 2026-11-01 how the handoff shows: a recording of the handoff in the desktop app (real Electron 44,
  the real `StartWindow`, a stand-in team page, a 60 fps ffmpeg screen recording) showed three
  problems: the growth used `cubic-bezier(.2,.7,.2,1)`, which covers most of the distance in the first
  40%, so the window looked finished very early, and after landing the whale waited over 200 ms in a
  large empty dark window; when the main window appeared through `show()`, Windows' own opening
  transition played over the start window, with one or two frames of the whole window greyed out, the
  whale and the avatar split into two, and then dark jumping to light; and the 160 ms wait before the
  growth left the whale hanging at the top of its jump. Changed to: the main window shows at `ready()`
  at opacity 0 under the start window (the opening transition finishes unseen and does not stall the
  first step of the growth); the growth starts at `handoffShow` + 40 ms, 260 ms, ease in and out; the
  whale lands 60 ms after the window is fully grown, the main process waits for `handoffDone` before
  making the main window opaque, then fades the start window out over 180 ms, and the whale melts into
  the avatar. With reduced motion, or when the page sends no `handoffShow`, there is no growth and the
  same fade. Basis: recordings before and after (on the first start, ready to the main window showing
  went from 1.24 seconds with one greyed frame to the fade starting at 1.09 seconds and ending at 1.29
  seconds; later starts begin at 0.58 seconds); unit tests of the start window (the main window shows
  transparent underneath at `ready()`, waits for the landing or 300 ms, gets focus only after the
  fade, and is taken back on failure). Fading a Mica window with `setOpacity` works on Windows 11.
- 2026-11-02 no stop button for the copy: the small stop-copy button under the ring looked like a
  leftover dot. Decided by the user: "remove the cancel/stop-copy button". Section 6 drops the button
  and the "Stop the copy?" confirmation card; to stop, quit the app or close the window, and the copy
  stops first, without leaving half a team, before the app quits.
- 2026-11-02 uncaught errors: section 7: an uncaught error in the main process goes to the recovery
  card before the handoff and only to the log after it, and Electron's own error box no longer opens.
- 2026-11-02 data folder not found: the recovery card gets one more reason: when the disk with the
  data is gone (not the program's own files missing), it no longer says "Something unexpected
  happened" but `「找不到放数据的文件夹，可能是移动硬盘没插上。」` ("The data folder can't be found; the
  external drive may be unplugged."), and the first arc is red.
- 2026-11-02 copy-failed card: section 6 adds a sentence on what to do.
- 2026-11-02 the team-view-didn't-load card: section 7 adds a sentence on what happened, one on what to
  do, and "Details", as on the recovery card.
- 2026-11-02 the recovery card says what to do: the user wanted "the error pages filled in as well".
  Section 7: the recovery card adds a sentence on what to do under the reason (by reason).
- 2026-11-02 every arc gets its beat: in the recording of `〔先不复制〕` the gears never showed; the engine
  had warmed up while the card waited for an answer, and after the answer the ring jumped straight to
  "Open the team". Section 2: a phase that finished unseen (not only the data folder) still goes in
  progress for at least 420 ms when its turn comes, with its prop, before it fills; the same for "Open
  the team" before the handoff on a first start.
- 2026-11-02 three arcs first, four after the answer: after watching the four-arc recording, the user
  said what they had pictured was "three bars at first; when the first finishes its sweep it asks
  whether you want it; if yes, it jumps up, rearranges into 4 bars and starts the import; improve the
  box-moving animation a bit; if no, keep the 3-bar start". Section 2: every start begins with three
  arcs, the copy arc grows only when the copy starts while the other three move aside, and it shrinks
  back to three arcs when the copy stops; the box-moving prop is redrawn (old box, new box and dotted
  line, the box flies leaning and squashes as it lands). Section 6: the import card appears only once
  the first arc has filled, and until the answer the ring stays at the first arc; the dot lands in the
  gap after the first arc.
- 2026-11-02 the import joins the ring: after watching the import recording, the user asked to "cut it
  down as far as possible; make the import a progress bar that, after the click, jumps up and morphs
  (the 3-arc ring becomes a 4-arc ring)". Section 2: on a first start that copies a team from DSH the
  ring has four arcs, with the extra "Copy your old team", which fills with the real progress of the
  copy, the prop during the copy is the moving boxes, and when the pre-warmed engine stops for the
  copy the engine arc goes back to not started; other starts keep three arcs. Section 6: the import
  card keeps only one line and two buttons, with size, model settings, checkboxes and footnote folded
  into "Details", and the names found, the number of parts and what will be copied removed; the
  step-by-step "Moving in" card is removed, and after `〔复制过来〕` the card shrinks into a dot and jumps
  into the copy arc; stopping the copy becomes an icon button under the ring plus a confirmation card;
  a failed copy turns that arc red. Section 9: with reduced motion the card does not fly. Below 1 MB it
  says "less than 1 MB". Basis: an import recorded in the desktop app against a stand-in DSH home
  (`app/dist-recordings/`, not in the repository).
- 2026-11-02 the whale shrinks to 0.75 times: first start 88 → 66 px, later starts 64 → 48 px, ripple
  and rings 56 × 12 → 42 × 9, aligned around their centres on the waterline and the stations' old
  positions (PR #702).

## Open questions

| Question | Options | Suggestion |
|---|---|---|
| Where does the start page go? | A separate start window (this note); a transparent `WebContentsView` layered in the main window, with the team view loading underneath and fading out once ready; `loadURL` in the same window as in the original design | A separate start window: a real small window, Mica the whole time, no blank frame at the handoff, and "Open the team" is real. The overlay is the second choice: also no blank frame, but the start is a big window from the outset, and two sets of focus need handling; measured on Electron 44, an invisible `WebContentsView` does not render, so the overlay can only be opaque, and the start has no Mica. The original way would show DSH's own loading, and the ring closing, the celebration and the growth would all have to go |
| Can the whale's tail move on its own? | The start page cuts the generator's output into two layers at the tail stalk (`27.9, 61.1`), adding no new shapes; the generator gets an option to put the tail on its own layer; the tail does not move | Use the cut first, only in the start window. Add the option to the generator when the plugin needs it too. Dropping it only loses the tail; everything else stays |
| Keep the waterline? | Keep: a chord of the ring, 200 px, 1 px `--bt-line-2`, fading at both ends; drop it and keep only the whale and the ring | Keep: it is where the whale's clipped edge is, and where the spout and ripples land |
| What to do about the start page going over the 45 KB budget (section 11)? (Measured on the prototype: the five files' source is 113 KB, 79 KB minified, about 35 KB gzipped; `text.mjs` holds both Chinese and English) | Relax the budget; split `text.mjs` by language and load only the interface language; minify when packaging | First split `text.mjs` by language and minify when packaging, and measure the start page's first frame in M4; if the first frame is not late, relax the budget: the page is a local file and does not go over the network (as in the "Open questions" of [onboarding](2026-10-26-windows-onboarding.md)) |

## Not done

- No percentage progress bar: the engine does not report a percentage. An arc of the ring has only
  four looks, not started, in progress, done and failed, and is never drawn partly by percentage. The
  copy and download progress bars use real byte counts.
- No invented phases, and loading the engine and the team view never waits for an animation; the
  handoff waits about 460 ms more for the growth, see section 8. The celebration (the spout) happens
  only on the first start and the first success after a retry or a fresh start. In the celebration
  handoff the main window appears about 1.2 seconds after `ready()` (the growth starts only after the
  page's text, ring and paper have faded), and about 0.7 seconds without a celebration.
- No rotating tips or jokes. When all goes well the whale is silent; only in the cases listed in
  section 3 does it say one short line about its state, with no bubbles, no jokes, and without
  covering cards or buttons; the only question among the whale's lines is the 180-second one, and the
  answer is on the card's buttons. It does not tell in advance what comes once inside (connecting a
  model, the preview notice, the last team). On failure it does not cry or make a fuss, and the
  failure page has no jokes.
- The whale has no "?" badge (UI standard 8.2: large avatars show no badge), and does not leap out of
  the water sideways (jumping to the Main Bot's avatar at the handoff is the only time it leaves the
  water, section 8); it spouts only when the user clicks it and in the celebration handoff; it does not
  swim around, does not react to every key press, and has no sound.
- The whale does not fly across windows: it flies inside the start window to where the Main Bot's
  avatar will be, and the main window takes over at the same spot (section 8); the avatar in the team
  view has no rising animation of its own.
- No DSH whale logo, and no animations, illustrations, sounds or fonts from other products.
- No CSS or DOM injected into the engine's page to join the frames, and no changes to DSH.
- No Rive, Lottie or web fonts: the CSP `default-src 'self'` does not allow WASM, and no other runtime
  is added.
- Nothing clickable or pettable in the title band.

## Known limits

- The start window has no system windows: the picker is the app's own too ([Desktop
  app](2026-10-16-desktop-app.md) "Picker"), and everything else is asked on cards (maintainer,
  2026-10-31: "let's avoid any default pop-ups like this in the system as far as we can"). The system
  dialogs below have all been replaced by cards since 2026-11-01; this item stays for the record: the
  remaining system dialogs were: another DSH using the data during a data move, and a failed copy (on
  later starts and in Settings), the data-move confirmation in Settings and "Choose a place outside…",
  the first start's questions about copying the team (the import card had not landed yet), chats newer
  than DSH and a failed copy during a team copy, the update prompts, "A new version may fix this" on
  the failure page, and the first tray notice when the window closes.
- The main window starts DSH and ds-bot while hidden. `dsBotApp.ready()`, the remount check of #559
  and the measurement of the system button colour all run in an invisible window, and must be verified
  in M4.
- When a Mica window that has never shown calls `show()` for the first time, one or two frames of empty
  Mica may show first. At the handoff the start window has already grown into Mica of the same size,
  with at most the whale on top where the avatar is; the main window appears on top of it, so those one
  or two frames look the same as what is underneath, except that the whale may vanish for a frame or
  two before the avatar appears. M4 confirms with a 60 fps recording that there is no white or black
  frame before the main window's first frame; if there is, the main window first appears under the
  grown start window, and moves on top and the start window is destroyed only after it has painted its
  first frame.
- The `#00000000` system button colour has been verified as transparent only on one Windows 11
  (26200, dark, window not in the foreground). Foreground, light, hover and pressed are not verified.
  On a system that paints the buttons opaque, use an opaque `--bt-main` window instead.
- Measured unpackaged on a busy machine: the window is built 1.35–1.57 seconds after the process
  starts, and the page paints for the first time 0.9–1.0 seconds later. The start page's first frame
  looks exactly like an empty window, so this gap does not show, but the entrance comes late.
- The tail and eyes inside the SVG, the ring's arcs and their highlight, the spout, the content's
  blur fade-in and the running highlight do not run on the compositor thread. While antivirus software
  scans and the engine is starting, they may stutter; in that case drop the tail first.
- The animation level and light or dark are remembered only after the team view reports them once. If
  the theme was changed outside the app, the next start uses the old one first.
- The second arc filling is inferred from the engine's HTTP coming up: DSH does not report named
  phases (item 11 of "What DSH needs to provide").
- On a display whose work area is less than 588 high, the window is only 500 high, and long cards
  scroll inside the paper.
- The start has one more renderer process (about 40–60 MB), destroyed after the handoff.
- In the roughly 600 ms from the start of the growth until the start window is destroyed, both windows
  exist, and in the 300 ms after the main window appears both are visible. The start window leaves the
  taskbar only when the main window appears, so the taskbar button does not vanish and come back; but
  in those 300 ms Alt+Tab may briefly show two.
- On a typical first start the data phase ends before the page paints, so the first arc rarely shows
  in progress: it simply fills 260 ms after the entrance.
- In the celebration handoff the main window appears only about 1.2 seconds after ready, and about 0.7
  seconds without a celebration: the growth starts only after the page's text, ring and paper have
  faded, and the main window shows only once fully grown.
- The growth relies on step-by-step `setBounds`: each step relays out the page but repaints only some
  of them, so the paper must be empty during the growth; on a busy machine the growth is not smooth.
- When the whale jumps to the avatar, the second half of the flight happens during the window's 300 ms
  of growth. Its animation runs on the compositor thread, but the window grows step by step and the
  page repaints only on some steps (8 repaints in 23 steps in the probe), so the whale may move in
  jerks, more so on a busy machine.
- The whale's landing point is measured at the moment the sidebar calls `ready()`: if the team column
  is still moving after that (the list sliding, the width changing), the landing point may be a few
  pixels off.
- Whether the ring's faint lines (`--bt-line`), the pale blue of an arc in progress and the waterline
  (`--bt-line-2`) are legible on real Mica is not verified: the prototype's screenshots used an opaque
  `--bt-main` background.
