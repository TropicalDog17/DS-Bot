# Desktop app

- Date: 2026-10-16
- Related: PR #275; [vision](../vision.md), "Two forms"; [DSH concessions ledger](2026-10-13-dsh-concessions.md)

## Why

The plugin runs in the user's own DSH. DSH decides the interface layout, the global settings and the DSH
version, so the plugin has to give way in many places (see the concessions ledger). When the user's DSH
updates, it can also break the Bots. The desktop app lets DS Bot own its profile, data, interface and DSH
version. When it opens, the Bot team is there.

Trade-offs:

- **The engine is DSH; there is no separate agent runtime.** Bot turns, tools, models, Sessions, MCP and
  skills still go through DSH, the same as in the plugin.
- **The interface uses the DSH web front end for now.** An own interface would have to redo, one by one,
  what the DSH web front end already has (tool cards, approvals, settings, Markdown, sending files, group
  chat history). That slowed other work, so it is paused. The window uses the DSH web front end, with
  `ds-bot` inside it as a plugin, the same as in DSH Desktop. The own interface will continue later, for
  the same reasons as before: when the DSH web front end starts, it activates every interface plugin, and
  one failing plugin stops the whole page; DSH decides its module format and page structure, and both are
  still changing.

## Decided behavior

### Structure

| Part | What it does |
|---|---|
| Shell | The Electron main process. Only one instance runs. The window loads the engine's own local address (`http://127.0.0.1:port`), and the engine serves the web front end, the same as DSH Web. The shell starts and stops the engine process. For the window, see "Window" below |
| Engine | A child process. On Linux it uses a bundled standalone Node, so that sharp's libvips does not clash with Electron's system glib; on macOS and Windows it uses the Node that ships with Electron. It starts the profile `ds-bot` with `runProfile()` from `@deepseek-ai/dsh/profile-boot` and listens only on `127.0.0.1`. The port is a free one chosen on the first start and kept after that, because the page's local storage (unread marks, layout, preferences) follows the address. When the port is taken, it picks a new one. The environment variable `DS_BOT_APP=1` tells ds-bot that it runs in the desktop app |
| Interface | The DSH web front end with the `ds-bot` plugin, the same as the plugin |

- The plugin and the desktop app use the same `ds-bot`. The plugin does not change.
- The installer and `ds-bot` share one version number.
- The engine's profile is three bundles stacked: DSH's `dsh-base`, the DSH web front end `dsh-web-app`
  and `ds-bot`; plugins the user installs come after them. On every start, the engine moves these three
  bundles back to the front.

### Window

- Every start first shows a **start window** of 720 × 540 (720 × 500 when the display's work area is
  short) (`app/src/start/`). The Main Bot's whale swims along the waterline through three real stages
  while the team interface loads in the hidden main window. When it is ready, the start window grows to
  the main window's rectangle and the main window appears in its place (see
  [start window](2026-10-26-start-window.md)).
- Windows: the window is frameless, the same as DSH Desktop. The title bar is part of the page. The
  system minimize, maximize and close buttons stay at the top right, in the same color as the interface
  under them, and follow the theme. Drag the title bar to move the window; double-click to maximize.
- Windows 11 (22H2 and later): the sidebar uses the Mica material and reaches the top of the window. The
  chat area also reaches the top, with a rounded top-left corner, and the system buttons sit over it. On
  Windows 10 the title bar has the same color as the sidebar and is opaque.
- When a dialog opens, the title bar and system buttons dim with the page.
- The page is still the DSH web front end in web mode, and the shortcuts are the same as on the web.
- macOS: the window is frameless too. The traffic lights sit at the left end of a 40 px title band at the
  top of the page; the sidebar and the chat area both reach the top of the window. The sidebar uses the
  system sidebar material (vibrancy), which does not change when the window is not in front. Drag the
  title band to move the window; double-click zooms as the system setting says. In full screen the
  traffic lights hide and the sidebar toggle moves back to the far left.
- Linux: the system title bar.

### Tray and quitting

- Windows, macOS and Linux all have a system tray icon that stays. The icon is the app's own whale. The
  tray menu has "Open DS Bot" and "Quit DS Bot".
- Closing the window does not quit: the window hides, the engine and the Bots keep working, and the Bot
  browser tabs stay. When the app is opened again, the window comes back to the desktop (the
  single-instance lock hands the second start to the one already running).
- When the window is really gone (for example the renderer process died), the tray's "Open" builds a new
  window on the engine that is running: the address is still the engine's local address and the cookie
  from the first load is still there, so there is no second engine and the start token is not used
  again.
- Closing all windows does not quit the app. "Quit" in the tray is the one normal way to quit.
- The first time the window is closed, a card appears in the window (over the page, not a system
  dialog). It says the app stays in the tray and keeps running. The window hides only after the user
  clicks [OK] on the card; Esc does not close this card. The app keeps this confirmation in its own data
  and does not ask again. When the page cannot draw the card (not loaded yet, no answer within
  2 seconds), the window still hides into the tray, and the card comes on the next close (waiting for
  the maintainer to confirm). Closing the window waits for the card's answer, so when the card appears
  the window first comes to the front (a minimized window is restored first). While the card is there,
  another click on close also brings the window to the front. Bot browser views are drawn above the
  page, so they hide while the card is there and do not cover it.
- While a team import or a data move runs, closing the window cancels it, as before: the copy stops at a
  safe point and does not leave half a team.
- In these cases the window really closes instead of hiding: an installed update needs a restart, a data
  move finished and needs a restart, the start failed, the system shuts down or logs out.
- macOS: a click on the tray icon shows the menu; a click on the Dock icon brings the window back. A
  full-screen window leaves full screen before it hides, or the desktop keeps a black area.
- Notices that belong to the window (the update notices) do not show while the window is hidden or
  minimized. They wait until the window is back, and they are also cards in the window.
- The macOS app menu has no "Quit" and no ⌘Q: "Quit" in the tray is the one normal way to quit.
- When the tray icon cannot be created (some desktop environments have no tray), the app still has a
  clear way out: the macOS app menu gets a "Quit", and on other systems closing the window shows a card
  in the window that asks whether to end it. If the answer is no, or the card cannot be drawn, the window
  is minimized: it stays in the taskbar, does not disappear and does not quit the app. This is the only
  exception; in no other case does the app ask on its own whether to quit.
- The start address from the engine works only once. If the first load did not succeed (the window was
  gone while it loaded), a new window does not use this address again: it goes to the engine's local
  address. Without the cookie the engine refuses it, and opening the app again gives a new address.

### Picker

- The app has no system pickers. Choosing the data location (the first start's "Change the location…",
  data moves on later starts and in settings), choosing a cookie file and Save As for downloads all use
  the app's own picker. It covers the page of the window that opened it (the start window or the team
  window), on the same layer as cards, with the same colors and springs (`app/src/page-card.css`).
- Look: a title; an up button and a breadcrumb of the path; a line where a path can be typed (`~` is the
  home folder, a relative path starts from the current folder, press Enter or [Go]); on the left, places
  (Home, Desktop, Documents, Downloads, only those that exist) and drives (drive letters on Windows; `/`
  and the volumes under `/Volumes` on macOS; `/` and the volumes under `/media`, `/run/media` and `/mnt`
  on Linux). When the window is narrow, this column becomes a horizontal row under the path. On the
  right, the contents of the current folder, folders first, sorted with numbers in human order; hidden
  items (names that start with a dot, Windows `$` system folders) are not listed. At the bottom, [New
  folder], [Cancel] and the main button ([Choose this folder], [Open], [Save]). Save As has an extra
  file name line; when it opens, the part of the file name without the extension is selected.
- Choosing a folder: a selected folder is chosen; with no selection, the current folder is chosen.
  Choosing a file: the main button works only when one file is selected; double-clicking a file chooses
  it. Save As: clicking a file puts its name into the file name. When a file with the same name exists,
  the picker shows a line "chart.png already exists. Do you want to replace it?" with [Replace], and does
  not overwrite directly. When the same name belongs to a folder, the user is asked to choose another
  name.
- Errors are all written in the picker. No box pops up and the picker does not close: the folder is
  gone, the drive is gone (an unplugged drive, a disconnected network drive), no permission, not a
  folder, path too long, name not allowed (characters and reserved names that Windows does not allow),
  a folder with that name already exists. A folder that cannot be read leaves the picker on the level it
  was on, with the error above the list. A folder with more than 2000 items lists only the first 2000
  and says so.
- Keyboard: the arrow keys, Home, End, PageUp and PageDown move in the list; Enter opens a folder or
  chooses; Backspace and Alt+↑ go up one level; Esc first closes the replace question or the new folder
  line, then cancels the picker; Tab cycles only inside the picker.
- The page only draws. Listing folders, creating folders and checking the chosen path all happen in the
  main process and answer over IPC (`app/src/folder-picker.mjs`, `app/src/picker-host.mjs`, drawn by
  `showPicker` in `app/src/preload.cjs`). Only the page that shows this picker can ask, and after the
  picker closes nothing is answered. The main process checks the chosen path again: a chosen folder must
  be an existing folder, a chosen file must be a file, and for Save As the folder must exist and the name
  must be allowed.
- When the page does not draw the picker within 2 seconds (not loaded, stuck), it counts as no choice:
  choosing a location and choosing a cookie file count as cancel; a download is saved in the Downloads
  folder, with ` (2)`, ` (3)` added when the name is taken.
- Downloads: Electron needs to know where to save when the download starts, but the picker answers
  later. So the download first goes into a `downloading` staging folder in the app data. When the choice
  is made and the download is done, it moves to the chosen place (copied across drives). Cancelling the
  picker cancels the download and deletes the staged file.
- While the picker is open, Bot browser views hide (they are drawn above the page) and come back when it
  closes.

### Models

- The model provider and key are set in DS Bot Settings → "Models" and in the key card in the Main Bot
  chat. They are written into DSH's credentials and settings and stored in the desktop app's data
  location, the same as in the plugin. DSH's own model page is in "Advanced settings (DeepSeek
  Harness)" and opens directly on "Models".
- The DSH web front end's own automatic credential onboarding ("Get started", "Add an API key to get
  started") is turned off: on every start the app writes `credentialOnboarding: false` for
  `ui-settings-models` in `profiles/app-onboarding.patch.yml` and passes it through the `patchFiles` of
  `runProfile`. This patch has only this one line. DSH's "Preview Notice" has no switch and still
  appears (see [DSH concessions ledger](2026-10-13-dsh-concessions.md) C16).

### DSH version

- The installer pins one DSH version. It follows only DSH rc versions, not alpha versions. Now it is
  0.2.2-rc.1.
- The pinned version must keep up with the rc version that DSH Desktop ships: within the same Session
  format version, a newer DSH can write records that an older one does not know and must reject, and
  such chats cannot be opened in the app after an import.
- DSH fixes and new features reach users with new DS Bot versions.

### Data

- The data location is the desktop app's `DSH_HOME`, by default `~/.ds-bot`. The profile, Sessions, team
  data, model settings and keys are all here.
- The shell's own data (window, browser storage) is in the folder the system gives the app. A new
  install uses the DS Bot folder; an existing install keeps using its old folder and browser encryption
  identity, keeps sign-ins, preferences, the port and the chosen locations, and does not move the user's
  files.
- The desktop app does not write the user's DSH `~/.dsh`; the import only reads it.

### First start and import

- The first start does not open a system picker. It uses the default data location (`~/.ds-bot`) and
  team workspace (`~/DS Bot`) directly and records them in `locations.json` in the shell data. The right
  side of the start window's footer says where the data is and how much space is left on the drive, with
  "Change the location…". Only a click on it opens the system folder picker. For the chosen folder, the
  root rule (`src/place.mjs`, see [Windows onboarding](2026-10-26-windows-onboarding.md)) puts the data
  in `<root>/data` and the team workspace in `<root>/workspace`. Both can also be changed later in
  settings (see "Change location" below). Neither location can be inside the other, and neither can be
  inside the user's DSH data.
- When the user's DSH already has a team, the app asks whether to import it, only once, on the first
  start. The import copies Bots, groups, memory, Sessions, attachments, model settings and keys, and does
  not change a single byte in the old location. After the import, the two teams go their own ways and do
  not sync.
  - When DSH is using this team, the user is asked to close it first. "In use" follows the same rule as
    the plugin's home-lock: the lock was refreshed within 60 seconds, and the process in the lock is
    still alive on the same machine (Windows reuses process IDs, so looking only at the process ID would
    take an old lock for a live one).
  - When the target already has `.credentials.yaml` or `.env`, they are not overwritten, and the import
    result records them as "kept". A `.credentials.yaml` that holds only the `client-connection/` records
    the engine wrote itself is not the user's, and is replaced by the old one as usual. The staging folder
    for the copy is always deleted, whether the copy succeeds, fails or is stopped halfway.
  - The engine starts once in the new data location before the copy, so that DSH does not take the old
    team's folder for one of its projects.
  - Files in the old team's work folder are copied to the new team workspace, without overwriting
    existing files.
  - From the model settings, only the model lines of the profile are taken (DeepSeek API and account,
    other providers, default model, presets). When several profiles have them, the user picks one. MCP,
    skills and DSH Agents set up separately in DSH are not imported.
- After the import, every Bot and group moves to a new part (a new work folder) before its next turn.
  The old parts are read only as history and can still be viewed and searched. Moving a work folder
  later works the same way.
- When the user's DSH writes a newer Session format than the pinned version, the app stops and asks the
  user to update DS Bot first.
- Before the copy, the pinned version reads every chat of the team once: within the same format version,
  a newer DSH can also write records that the pinned version must reject. It reads a temporary copy in
  the data location with a DSH profile without `ds-bot` (only `dsh-base` and `dsh-web-app`), and deletes
  the copy afterwards. When there are chats written by a newer DSH, the app stops as it does for a newer
  format version, with the buttons "Quit / Start without the team". If the user quits, the next start
  asks again for the location and the import. Chats with damaged files do not block it: the user's own
  DSH cannot open them either. When the check itself cannot run, the copy goes ahead as usual.
- When the app quits before the first start is finished, nothing is recorded, and the next start asks
  everything again from the beginning. This includes closing the welcome box or choosing "Quit", quitting
  while a dialog is open, and closing the window during the copy. The copy stops at a safe point and
  does not leave half a team, so it can be copied again next time.

### Change location

- The entry is DS Bot Settings → General → "Location". The team workspace is where Bots and groups
  without their own folder work. The English interface calls it Team workspace.
- Change the team workspace: choose or type a folder; it is created if it does not exist. It cannot be
  inside the DSH or team data, and it cannot contain them. No restart is needed. Bots and groups that use
  the team workspace move to a new part on their next turn, the same as for other folder changes; the
  old folder and its files are not touched. The plugin can change it too.
- Change the data location (desktop app only): choose an empty or new folder. It cannot contain or be
  inside the team workspace, cannot be in the user's DSH data or the program folder, and cannot be a
  whole drive. After confirmation, the app stops the engine and copies the data into a temporary folder
  next to the new folder. Only when the copy is complete is it renamed to the new folder. Then the app
  restarts on its own and uses the new location.
  - The old data folder stays as it is; the user deletes it after checking that all is well.
  - When the copy fails, the app shows the reason and keeps using the old location after the restart.
    Quitting during the copy also keeps the old location, without half a copy or a temporary folder.
  - Temporary runs for development and tests (`DS_BOT_HOME`) cannot change the data location.

### Plugins

- The engine parts of DSH plugins (tools, models, MCP, skills, search and so on) are installed and run
  as they are. Installation uses the pnpm that ships with the app.
- Interface plugins are written the Cordis way: plugins provide and use services, declare dependencies,
  every registration can be undone, and the interface is composed through slots.
- Where the app overlaps with DSH, it uses DSH's slot names and data: first tool cards
  (`tool.call.toolview`), the global overlay (`shell.overlay`) and settings (`settings.section`,
  `settings.general.item`). A DSH interface plugin can move over by changing its packaging and plugging
  into these slots.
- Interface plugins load per page. When one plugin fails, only its own area shows an error; the rest
  works as usual.
- Computer use and browser use: both DSH's provider plugins and DS Bot's own can be installed. The user
  chooses which one to use in settings, and only one loads at a time. The interface must be able to show
  the screenshots, approvals and questions these plugins use.

### Install and update

- The app ID (appId) is `io.github.fei2411.dsbot`. The Windows installer GUID keeps the value of the
  released versions, so after the program rename it still installs over the old install and updates the
  shortcuts and the uninstall entry.
- Windows (x64): an install wizard. The program location can be changed, and the app can run right after
  the install. It installs only for the current user: it does not ask "for all users or just me", needs
  no administrator rights, and installs into `%LOCALAPPDATA%\Programs\DS Bot` by default. Uninstalling
  does not delete the data location.
- Windows auto-update: downloads in the background, checks the sha512, and when the download is done
  shows a notice in the window to restart and update. Without a restart, it installs on the next quit.
  - It checks the latest GitHub Release once at start and then every 4 hours. The Release's
    `latest.yml` has the installer's file name and sha512.
  - The notice is a card in the window (a system dialog before 2026-11-01). "Restart now" stops the
    engine first and then installs; "Not now" waits for the next quit. When the card cannot be drawn,
    that also counts as "Not now" ([start page copy](2026-10-29-start-copy.md)).
  - It can update even when the engine does not start: the check begins before the engine starts (after
    the first start's import). When the start fails, the error box says a new version is out; after the
    error box is closed, the app waits for the download, installs it and opens again.
  - ds-bot and DSH inside the app update with the app: the plugin does not check updates for these two
    itself, and the About page says "Updates come with the DS Bot app."
- Release: when a Release is published, the workflow builds the Windows installer and uploads it, its
  `.blockmap` and `latest.yml` to the Release. The app and ds-bot share one version number, and the
  Release tag is that version number. After the packages for all platforms are uploaded, the workflow
  uploads `SHA256SUMS.txt` and installers without a version number (such as `DS-Bot-win-x64.exe`), adds
  the `Download / 下载` (Download) table at the top of the notes, and only then marks the Release as
  latest. So do not tick "Set as the latest release" when publishing.
- macOS (Apple silicon and Intel): a zip. It cannot auto-update; when a new version is out, it tells the
  user to download it. No dmg: on macOS 26 a downloaded unsigned dmg shows as "damaged" and cannot be
  opened.
- The installer carries all the files the pinned DSH installs, not trimmed by profile.
- No signing with a developer certificate and no notarization; the macOS package is only ad-hoc signed.
  macOS blocks the first open, and the user has to click "Open Anyway" in "System Settings → Privacy &
  Security".

## Not done

- No fork of DSH, no patches to DSH.
- No desktop app installed through npm, and no one-click install inside DSH Desktop.

## Not done for now

- DS Bot's own interface: paused; the window uses the DSH web front end. The code stays in the
  repository (`app/ui/` and its engine layer `app/engine/`), but is not installed or packaged. The way of
  writing interface plugins in "Plugins" above will be put in place when the own interface continues.

## Known limits

- First run: Windows shows a SmartScreen warning; on macOS the user has to allow the app by hand in
  System Settings.
- On Linux, whether the tray icon is visible depends on the desktop environment: GNOME and KDE need a
  tray extension to draw it. A created icon is not always a visible one; in that case opening the app
  again still brings the window back to the desktop.
- On Windows the system scales the tray icon down by the display scale, and above 150% it is not sharp.
- The tray icon, the menu and "closing the window hides it" were checked with real Electron on Windows
  (`app/scripts/check-lifecycle.mjs`). The macOS Dock and full screen, tray visibility on Linux, and
  system shutdown and logout have not been checked on real machines yet: the code follows how DSH Desktop
  does it, and unit tests cover the rules themselves.
- A Session records the full path of its work folder, and this cannot change. So both the import and
  moving a work folder need a new part.

## Changes

- 2026-10-17: the user chooses the provider for computer use and browser use, PR #278.
- 2026-10-17: the window switches to an own interface drawn with the plugin's Bot interface: team
  sidebar, Bot private chats, details, search, new Bot and settings; the window is frameless, PR #279.
- 2026-10-17: Bot details are to show turns, tok/s, cache hits and context; the DSH right sidebar and
  "Classic Agent mode" are not done for now, PR #279.
- 2026-10-17: Bot details show turns, tok/s, cache hits and context, PR #287.
- 2026-10-17: the engine's profile becomes the desktop app's own combination and no longer loads the DSH
  web front end, PR #291.
- 2026-10-18: fixed app identity; Windows installs only for the current user and asks for a restart when
  an update has downloaded; the installer does not trim DSH files by profile, PR #303.
- 2026-10-18: a "Models" page in settings; the provider and key are stored in DSH, PR #319.
- 2026-10-18: the own interface is paused, and the window goes back to the DSH web front end and the
  system title bar; the engine's profile goes back to `dsh-base`, `dsh-web-app` and `ds-bot`, PR #323.
- 2026-10-18: details of choosing the two locations on the first start and importing the team from the
  user's DSH, PR #324.
- 2026-10-19: details of Windows auto-update; publishing a Release uploads the Windows installer; the
  plugin inside the app no longer checks for updates itself, PR #329.
- 2026-10-19: macOS gets two dmgs (Apple silicon arm64, Intel x64), each built on a runner of the same
  architecture; ad-hoc signing (without a signature the download shows as "damaged"); when a new version
  is out, a box pops up, and "Download" opens the release page without installing automatically; the
  notice comes only after the new dmg is uploaded; CI and the release both build and check the packages,
  PR #334.
- 2026-10-19: the pinned DSH goes to 0.2.1-rc.2; the pinned version keeps up with the rc version that DSH
  Desktop ships, PR #336.
- 2026-10-27: the pinned DSH goes to 0.2.1-rc.4.
- 2026-11-01: the pinned DSH goes to 0.2.1-rc.5.
- 2026-11-04: the pinned DSH goes to 0.2.2-rc.1.
- 2026-10-19: before copying the team, the pinned version reads every chat once and stops when there are
  chats written by a newer DSH, PR #340.
- 2026-10-20: when the app quits before the first start is finished, nothing is recorded and the next
  start asks again from the beginning; the welcome box gets "Quit"; the copy stops at a safe point and
  does not leave half a team, PR #360.
- 2026-10-20: the window is frameless on Windows, and the sidebar uses Mica on Windows 11; macOS still
  uses the system title bar, Issue #362.
- 2026-11-06: the window is frameless on macOS too, with the traffic lights in the title band and the
  system sidebar material on the sidebar; the page is still in web mode and the shortcuts do not change,
  Issue #1044.
- 2026-10-20: macOS ships a zip instead of a dmg: on macOS 26 an unsigned dmg downloaded with Safari
  (arm64 and x64, built locally or in CI alike) shows as "damaged" and cannot be opened; ad-hoc signing
  the dmg does not help either; a zip is only blocked by Gatekeeper and can be opened with "Open Anyway",
  Issue #351.
- 2026-10-20: the team workspace and the data location can be changed in settings; in the Chinese
  interface `团队工作区` is renamed `总工作区` (both "team workspace"), Issue #364.
- 2026-10-20: the window loads the engine's local address instead of `dsh-app://app`: DSH's account
  sign-in uses the page address as the address to return to after the browser sign-in, and accepts only
  a local http address. Sign-in windows that DSH opens go to the system browser, Issue #376. The title
  bar dims with the page when a dialog opens.
- 2026-10-23: the app connects the Bot browser: the app provides its own webview bridge, each Bot's
  sign-ins are stored in the shell's own data and are cleared when the Bot is deleted, Issue #449.
- 2026-10-25: closing the window only hides it, and the app stays in the system tray; "Open" in the tray
  brings the window back, and "Quit" is the one normal way to quit, Issue #500.
- 2026-10-26: DSH Web's automatic credential onboarding is turned off, and models are set on DS Bot's own
  model page and key card; deciding whether a team is "in use" during the import also looks at when the
  lock was refreshed; existing keys are not overwritten; the staging folder is always deleted; creating
  the window no longer depends on the Downloads folder; double-clicking after a failed start also brings
  the window to the front; the Release is marked latest only at the end, and comes with `SHA256SUMS.txt`,
  installers without a version number and a download table ([Windows onboarding](2026-10-26-windows-onboarding.md)
  M1).
- 2026-10-29: the desktop app bundles the Office runtime (Python, standalone Node, the LibreOffice engine
  and the Office skills), see [Office documents](2026-10-27-office-documents.md), Issue #613, PR #624.
- 2026-11-01: the program, the executable and the installer all use DS Bot / dsbot; existing installs,
  data, the browser encryption identity and the update path of old clients stay compatible.
- 2026-11-01 (waiting for the maintainer to confirm): the user asked to "avoid Windows boxes in all
  other parts of the interface". The tray notice on the first window close, the "end it?" question when
  there is no tray, the two update notices, and the confirmation and "this place won't work" for data
  moves in settings all become cards in the team window: the app's own preload puts a layer over the
  page, the main process inserts the stylesheet, and the colors and springs come from the same source as
  the start window (`app/src/page-card.css`, generated by `scripts/start-assets.mjs`). Only the system
  pickers (choose folder, choose cookie file, Save As for downloads) remain system windows, which the
  user agreed to keep.
- 2026-11-02 (waiting for the maintainer to confirm): the user asked "is it possible to build all such
  prompts as our own pages", the answer was "yes", and the pickers also become the app's own: choosing
  the data location, choosing a cookie file and Save As for downloads are all pickers on the page (the
  "Picker" section), and `app/src` no longer has `dialog.show*`. When the tray card on the first window
  close appears, the window first comes to the front and Bot browser views get out of the way; when the
  page cannot draw the card, it is not recorded as confirmed.
- 2026-11-02: the LibreOffice engine package moves to `resources/node_modules` outside `app.asar`, which
  fixes Office file previews failing to start a child process after packaging (#679, PR #705); the start
  window, whale progress, footer location line and recovery card are merged (PR #702).
