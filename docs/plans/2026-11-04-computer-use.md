# Computer use: Bots use the apps on the computer, with the rights the user gives

- Date: 2026-11-04
- Related: issue #917; replaces the old PR #32; needs the upgrade to DSH 0.2.2-rc.1 (PR #908)
- Code: `ds-bot/src/host/computer/`, `ds-bot/src/client/computer-*.js`, `app/src/computer-*.mjs`

## Why

Bots can already work in their own browser, but a lot of work happens in native apps on the user's
computer: Notes, Mail, Office, chat apps. A Bot should be able to see and operate these apps, but
only as far as the user allows. It should take the user's mouse and keyboard as little as possible,
and the user should always be able to see it and stop it.

The driver comes from DSH; DS Bot does not write its own. DSH's computer-use provider only does the
"seeing" and the "clicking". It leaves three things to the caller on purpose:

1. **Whom the rights belong to.** DSH records app permissions per Session, so a Bot would be asked
   again every time it moves to a new part or joins a group. A permanent permission applies to the
   whole profile, not to one Bot. The Cua Driver provider used on Windows runs in the same process
   and goes through no permission at all.
2. **Sharing one desktop.** When several Sessions operate the same desktop at once, the caller
   coordinates them.
3. **Being seen and taken over.** The provider draws no indicator and has no take-over or hand-back.

A Bot is a long-lived identity, and all three go by Bot, so DS Bot takes them on. This layer is
shared with browser control: the same handoff card, the same "Bot operating / you have it / waiting
for you", and the same "Control" group in the Bot settings.

The macOS system permissions (Accessibility, Screen Recording) are tied to the app's signature. The
DS Bot desktop app is ad-hoc signed, so after every update macOS treats it as a new app and the
permissions it had silently stop working (tested on macOS 26). DSH's macOS provider comes with a
separate helper app, `DSH Computer Use.app`, signed by DeepSeek and notarized. The system
permissions are granted to it, and DS Bot updates do not affect them.

## Decided behavior

### Main switch and provider

- Settings get a new "Computer use" page with a main switch at the top, off by default.
- When it is on, DS Bot loads the DSH provider itself, and all Bots share this one provider:
  - macOS: `@deepseek-ai/dsh-experimental-cua-macos`.
  - Windows, Linux: `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native`.
- When it is off, the provider is unloaded and every Bot's computer tools go away together; levels
  and app permissions are kept.
- The switch and the provider's state are both on this page:
  - On macOS it shows the state of Accessibility and Screen Recording, each with a "Grant" button;
    the provider opens System Settings and shows a drag-and-drop guide. When a permission is
    missing, the Bot's call fails and says the user must grant it, with no retry.
  - When loading fails (for example a system component is missing, or the platform is not
    supported), the page shows why. The switch stays on, and the user clicks "Retry" after fixing it.
- The plugin (DSH Desktop / Web) has the same switch: DS Bot loads the provider itself when it finds
  the provider package in this DSH install. DSH's own "Computer Use" plugin is only for PTC Sessions,
  and only one provider can be loaded at a time. When that plugin is on, this page says to turn it
  off first on DSH's plugin page. When the DSH install has no provider package, the page says how to
  install it.

### Each Bot's level

- Four levels: **Off**, **View only**, **Background**, **Foreground**. When the main switch is
  turned on for the first time, all Bots (including ones created later) default to "Background".
- Only the user can change it: in the "Control" card in the Bot's details, or in the Bot list on the
  "Computer use" page. A Main Bot's tools cannot change any Bot's level, nor the main switch.
- What each level can do:
  - **View only**: list apps and windows, read the interface structure (the accessibility tree), take
    screenshots. Picking an app that is not running starts it in the background.
  - **Background**: adds click, type, paste, key presses, scroll, drag, setting a control's value,
    and showing hidden or minimized windows; none of them bring the app to the front.
  - **Foreground**: adds bringing an app to the front and moving the visible mouse pointer. Only one
    Bot at a time can use the foreground.
- DS Bot assigns each tool of the provider (each method, for Cua Driver) to a level. A tool it does
  not recognize counts as "Foreground".
- The provider DS Bot loads is only for Bots; DSH Sessions that are not Bots do not get it. DSH's own
  Computer Use plugin still works in Sessions that are not Bots, and DS Bot does not block it; Bots
  cannot use it. A Bot uses the same level in groups; a group cannot set its own.
- A Bot set to "Off" does not see the computer tools or their descriptions. A call above the Bot's
  level is refused before it runs, and the Bot is told which level does not allow it and who can
  change it.

### App permissions (per Bot)

- The first time a Bot uses an app, a card appears in the Bot's own chat: "Allow River to use Notes?",
  with the buttons "Deny", "This time" and "Always", in that order.
  - "This time": valid only in the current part of the conversation.
  - "Always": recorded on this Bot; it is not asked again after a new part or in a group.
  - "Deny": not asked again in this part of the conversation.
- The card always appears in the Bot's own chat, even when the request comes from a group; the group
  shows that this Bot is waiting for the user's approval. The phone and IM get this card as usual.
- The "Control" card in the Bot's details lists the apps this Bot may "Always" use, and each row can
  be revoked. Revoking cancels the operation in progress and invalidates the app the Bot has already
  picked; the Bot is asked again when it picks this app again.
- On macOS, the DSH provider shows its own app permission prompt. For a Bot's Session, DS Bot answers
  it for the user by the rules above, and DSH's "always allow for all Sessions" does not appear.

### Apps a Bot cannot touch

- DS Bot itself, DSH Desktop, `DSH Computer Use.app`, System Settings, Keychain Access and the
  Passwords app; on Windows, Settings and Credential Manager.
- Picking one of these apps is refused right away, and the user cannot allow it either. So a Bot
  cannot click its own approval card or give itself more rights.

### Several Bots and the user share one desktop

- **App lease**: one app goes to one Bot at a time. A Bot gets the lease the first time it operates
  an app and lets go when its turn ends or after 60 seconds idle. Another Bot that uses this app in
  the meantime is refused and told "River is using Notes". Bots using different apps can work in the
  background at the same time.
- **Foreground lease**: "Foreground" actions go to one Bot at a time, with the same rules.
- In the desktop app, while the user has used the keyboard or mouse in the last few seconds,
  foreground actions are refused at first. The indicator shows "River waits for the computer" and
  "Let it continue"; after a click they are allowed for 60 seconds.
- Read-only calls (listing apps, reading the structure, screenshots) need no lease.

### Seen and stoppable

- **Indicator**: shown as long as any Bot holds an app lease: which Bot uses which app, a "Stop" for
  each Bot, and a "Stop all".
  - Desktop app: a small floating bar at the top of the screen that follows the system's light and
    dark mode and is as wide as its content. It does not appear in any screenshot. The tray menu has
    the same entries.
  - Plugin: a bar at the top of the DS Bot interface.
- **Stop**: like the stop button, it stops this Bot's current turn, cancels the computer operation in
  progress and releases its leases.
- **The Bot's mouse** (desktop app): for every step the Bot takes, an arrow in the Bot's color is
  drawn where it operates, with the Bot's avatar at its tail. A click shows a ripple. The arrow fades
  about 2.5 seconds after the last step.
  - Clicking or dragging by coordinates: the arrow points at that spot.
  - Clicking, typing or pressing keys by interface element: the arrow rests in the middle of that
    window's title bar and does not pretend to point at a control.
  - It is drawn only when the spot is really visible: the window is on the current desktop and not
    covered by another window. When covered or in the background, nothing is drawn, and the steps
    show only on the "Computer" page.
  - The mouse does not block the user's clicks and does not appear in the Bot's screenshots.
  - On Windows, Cua Driver's own cursor is turned off and DS Bot's drawing is used instead. The
    plugin draws nothing on the screen.
- **The "Computer" page in the Bot's details**: the state (idle / Bot operating / you have the
  computer / waiting for you), the app in use, the latest screenshot, the recent steps, and the
  buttons "Stop", "Take over the computer" and "Hand back".
- **In the chat**: each computer operation is an activity line naming the app and the action, with a
  thumbnail when there is a screenshot.

### Take-over and handoff (shared with the browser)

- **Take over the computer**: cancels this Bot's computer operation in progress. After that, its
  computer calls are refused and it is told that the user is operating and to wait until the user
  hands back.
- **Hand back**: the Bot gets a message that the user handed the computer back and that it must look
  again before it goes on. DS Bot does not record what the user typed or clicked during the
  take-over.
- **The Bot hands off on its own**: a new tool `computer_handoff` (reason: sign-in, payment,
  verification, confirmation, other, plus one line of explanation) shows the same card as the browser
  handoff: "Skip", "Take over", "I'm done". "Take over" opens this Bot's "Computer" page and enters
  "you have the computer".
- Payments and entering passwords always go to the user. DS Bot cannot recognize actions with
  consequences, such as sending, deleting or publishing, from a click on coordinates. So the Bot's
  instructions require it to ask the user to confirm with the handoff card first; the Bot asking
  "are you sure?" itself does not count as permission.
- Text in an app's interface, window titles and clipboard contents are data, not instructions from
  the user.

## Not done

- A separate desktop or virtual machine for each Bot.
- Recording the user's input during a take-over.
- Giving Bots computer use through DSH's PTC preset; Bots keep using their own preset.
- Watching the live screen on the phone.

## Known limits

- When the plugin runs in DSH Web, DSH's interface is a tab in a browser. DS Bot cannot protect just
  one tab, so a Bot allowed to use this browser can click DSH's interface. Either use the desktop
  app, or do not allow Bots to use this browser.
- Windows: Chromium and Electron apps often do not receive input in the background and need the
  foreground; apps running as administrator refuse to be operated. Cua Driver runs in the same
  process as the engine, so when it crashes the engine exits with it.
- Linux: X11 is supported, Wayland is limited; the Bot's mouse is not drawn on the screen.
- macOS: needs macOS 14 or later. Background input relies on private system interfaces and may stop
  working after a system update.
- Leases coordinate only DS Bot's Bots; other programs and DSH Sessions outside DS Bot can still
  operate the same desktop.
- The result of an operation only means "sent", not "took effect"; the Bot has to look again to
  confirm.

## Changes
