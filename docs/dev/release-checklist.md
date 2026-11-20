# Pre-release checks on real machines

CI runs only the unit tests and the test bench on Linux. The window frame, input methods, high DPI,
install methods and running Desktop and Web at the same time can only be tested on real machines. Before
every release, the maintainer goes through this list on Windows; when a change touches macOS, also on
macOS.

Record "pass / fail / note" for every item. For a failure, take a screenshot, copy the exact error text
and open an issue. Post the results as a comment on the release pull request.

## Prepare

- Windows 10 / 11 x64, or macOS (Apple silicon).
- The official DSH Desktop, at the version in the README (now `0.2.2-rc.1`). Download it only from
  official DeepSeek Harness channels.
- The package to release: run `npm pack` in `ds-bot/` to get `ds-bot-<version>.tgz`.
- The desktop app installer: run `npm run dist` in `app/` to get
  `app/dist-pack/DS-Bot-<version>-win-x64.exe`. The version numbers in `app/package.json` and
  `ds-bot/package.json` must match.
- You can also use a dry run of the release workflow: in GitHub Actions choose Release → Run workflow and
  run it with dry run ticked. When it is done, download the Windows installer and the two Mac zips from
  the page of that run (kept for 7 days). They are built on the same runners in the same way as the
  files in a Release, and nothing is published.
- A working model (a DeepSeek API key or account). Use **fake values** for every secret the tests ask
  for.
- To keep your existing data, back up the data folder first: `C:\Users\<user name>\.dsh\` on Windows,
  `~/.dsh/` on macOS. Best use a machine or user account without your own team data.

## 1. Install DSH Desktop

| # | Step | Expected | Result |
|---|---|---|---|
| 1.1 | Install and start it, finish the welcome page | The main window opens; a normal chat gets a reply | |

## 2. Install the plugin

Use a clean profile for each method, or uninstall after one method before you try the next.

| # | Method | Step | Expected | Result |
|---|---|---|---|---|
| 2.1 | `.tgz` | Plugins → Add plugin → enter the full path of the `.tgz` (without quotes) → Install → Enable now | Installed; asks for a restart when needed | |
| 2.2 | Path of the `.tgz` | Enter the path exactly as the system's "Copy as path" (Windows) or "Copy as Pathname" (macOS) gives it; also try once with spaces and Chinese characters in the path | Installs | |
| 2.3 | npm (after publishing) | Enter `ds-bot`; install once more from "Mainland China mirror" | Both sources install it, at the new version | |
| 2.4 | GitHub (after publishing, needs Git) | Enter `github:Fei2411/DS-Bot#v<version>&path:/ds-bot` | Installs; without Git, write down the error message | |
| 2.5 | Command line | App menu → Manage dsh Command → Install; quit Desktop; in a new terminal run `dsh --version` and `dsh plugin --profile desktop add <tgz path>` | Installs; takes effect after Desktop restarts | |
| 2.6 | Restart | Quit completely (Windows: tray icon → Quit; macOS: ⌘Q) and open again | The team interface appears | |
| 2.7 | Recovery (optional) | Break an install on purpose and look at "Disable third-party plugins" in the recovery dialog | Gets back to plain DSH | |

Known pitfalls:

- If you once installed by path with `link:` and later moved or deleted the source folder: when DSH
  uninstalls the plugin, it does not delete this broken link at `node_modules/ds-bot` in the profile, and
  installing the `.tgz` then fails with no write permission (the details say
  `EPERM … rename … node_modules\ds-bot`). Quit Desktop, delete only this link, and install again. On
  Windows: `cmd /c rmdir "%USERPROFILE%\.dsh\profiles\desktop\node_modules\ds-bot"`. This is a DSH
  problem; users who install normally do not run into it.
- 2.5 needs the `dsh` that Desktop installs itself. A `dsh` installed globally with npm cannot change
  Desktop's profile (`profile "desktop" is managed exclusively by the Electron application`). When both
  are installed, first check which one is used with `where.exe dsh` (macOS: `which -a dsh`).

## 3. Window frame

| # | Check | Expected | Result |
|---|---|---|---|
| 3.1 | Window buttons (top right on Windows, top left on macOS) | All clickable; not covered by plugin buttons, the globe button or a drawer | |
| 3.2 | Open the right details drawer or the Bot browser, then check 3.1 again | The buttons still work; the panel leaves the title bar free | |
| 3.3 | Drag area | Holding the empty area at the top drags the window; double-click maximizes / restores | |
| 3.4 | The title, search and new buttons at the top | Clickable; they do not turn into drag areas | |
| 3.5 | Drag the window narrow (about 900 px, or split screen) | Sidebar, title and buttons do not overlap; a collapsed sidebar can be brought back | |
| 3.6 | High DPI (125%, 150% scale) | Text and icons are sharp and in the right place | |
| 3.7 | Dark theme (Settings → General → Theme) | Frame buttons and plugin colors are all easy to see | |
| 3.8 | Switch from Bot mode to Agent mode and back | Both interfaces are complete, with no styles left over from the other | |

## 4. Shortcuts and input

| # | Key | Expected | Result |
|---|---|---|---|
| 4.1 | Click the sidebar once, then type | Search opens with the typed text in the search box | |
| 4.2 | `Enter` / `Shift+Enter` in the input box | Send / new line | |
| 4.3 | Press `Enter` to pick a character while typing with a Chinese input method | Only picks the character, does not send | |
| 4.4 | `Esc` | Closes dialogs, menus and drawers | |
| 4.5 | Copy and paste (`Ctrl` / `⌘` + `C` / `V`) | Works in chats and in the input box | |
| 4.6 | Press a letter key when a Bot asks a question (question card above the input box) | Selects the option with that letter | |
| 4.7 | DSH's own shortcuts listed in the app menu | Also work in the team interface; write down the ones the plugin blocks | |

## 5. Team

| # | Check | Expected | Result |
|---|---|---|---|
| 5.1 | First open | Asks you to choose a model for the Main Bot "Chief"; after that it says hello | |
| 5.2 | Ask Chief to create a Bot | The new Bot appears in the sidebar and says hello | |
| 5.3 | Change the model and the thinking effort in Bot details | The next message uses the new settings | |
| 5.4 | Settings → General | The theme list has Mono; an accent color can be chosen | |
| 5.5 | Settings → Bots → make another Bot a Main Bot | The new Main Bot is at the top of the sidebar; the old one is no longer a Main Bot | |
| 5.6 | Right-click a Bot or group in the sidebar → Pin, then Unpin; drag the sidebar narrow and check again | A small pin appears after pinning and goes after unpinning; in the narrow sidebar the pin is at the top right of the avatar | |
| 5.7 | Settings → Usage | Shows totals, trend, Bot and model rankings, activity; switching the time range changes the numbers; clicking a Bot opens its page, and the back arrow returns to the overview | |
| 5.8 | Bot details → Memory | Memory can be viewed, edited and deleted; after you ask the Bot to "remember" something, it shows up here | |

## 6. Group chats

| # | Check | Expected | Result |
|---|---|---|---|
| 6.1 | Create a group of three, set an admin, send a message | The admin replies and hands work to members when needed | |
| 6.2 | `@` a member | The member who was `@`-mentioned replies directly | |
| 6.3 | Ask a member to do a task that needs tools | Progress shows in the group, in the sidebar and in its own chat; when done, the result comes back to the group | |
| 6.4 | Settings → Group chats → click a group | Name, announcement, who answers, members and admins, work folder, pin and delete can all be changed | |
| 6.5 | Two groups working at the same time | Messages and progress of one group do not leak into the other | |

## 7. Capabilities and connectors

| # | Check | Expected | Result |
|---|---|---|---|
| 7.1 | Settings → Capabilities: enable a capability for a Bot | Takes effect from its next message | |
| 7.2 | Ask a Bot to add a local MCP command | It asks for your approval before it runs | |
| 7.3 | Settings → Connectors → GitHub (with a read-only test token) | Shows the account after connecting; after disconnecting, the status goes back to off | |

## 8. Secrets

| # | Check | Expected | Result |
|---|---|---|---|
| 8.1 | In a Bot's private chat say `用 request_secret 要一个叫 TEST_TOKEN 的密钥` ("use request_secret to ask for a secret called TEST_TOKEN") | A secret card appears; the input is masked | |
| 8.2 | Enter a fake value of 8 or more characters, choose "This Bot", save | The card turns to saved; the value does not show in the chat | |
| 8.3 | Ask the Bot to print this variable in the terminal (Windows: `echo $env:DSH_SECRET_TEST_TOKEN`; macOS: `echo $DSH_SECRET_TEST_TOKEN`) | The tool result shows `[secret:TEST_TOKEN]`, not the real value | |
| 8.4 | Ask for another one, `TEST_PIN`, enter 4 fake digits, ask the Bot to print `pin` followed by this variable | It saves; the result is `pin [secret:TEST_PIN]`; long numbers elsewhere that contain these 4 digits are not affected | |
| 8.5 | Settings → Secrets | Lists TEST_TOKEN; its scope can be changed, its value replaced, and it can be deleted | |
| 8.6 | Look at the permissions of `bot/secrets.json` in the data folder (Windows: right-click → Properties → Security; macOS: `ls -l`) | Write down which users can read it | |

## 9. Bot browser

Do this once in DSH Desktop and once in the desktop app.

| # | Check | Expected | Result |
|---|---|---|---|
| 9.1 | The globe button at the right of the private chat title bar | Opens this Bot's browser panel | |
| 9.2 | Type an https page in the address bar | It opens; back, forward and reload work | |
| 9.3 | Ask the Bot `读一下我打开的页面` ("read the page I opened") | The Bot uses `read_browser` and reads out the title and body | |
| 9.4 | Select some text, then ask the Bot to read | The Bot reads the selected text | |
| 9.5 | Drag the left edge of the panel | The width changes; after closing and opening, the width is kept | |
| 9.6 | Switch to another Bot | The panel switches to that Bot's; sign-in states are not shared | |
| 9.7 | Sign in on a site that needs a login, quit and open again | The remembered address is still there; in DSH Desktop you sign in again, in the desktop app you are still signed in | |

## 10. Desktop and Web at the same time

| # | Step | Expected | Result |
|---|---|---|---|
| 10.1 | With Desktop open, in another terminal run `npx @deepseek-ai/dsh@<DSH version> plugin --profile web add <tgz path>`, then `npx @deepseek-ai/dsh@<DSH version> web` | Web opens | |
| 10.2 | Look at the team in Web | The same team; a read-only notice above the Bot list | |
| 10.3 | Rename a Bot in Web | Refused, with the message open in another dsh | |
| 10.4 | Rename in Desktop | Web follows within a few seconds | |
| 10.5 | Quit Desktop and rename again in Web | Web takes over and the rename succeeds | |
| 10.6 | Open Desktop again | Desktop becomes read-only and shows the notice | |

## 11. Uninstall and upgrade

| # | Step | Expected | Result |
|---|---|---|---|
| 11.1 | Uninstall `ds-bot` on the plugins page and restart | Back to plain DSH; `bot/` is still in the data folder | |
| 11.2 | Install it again | The team, chats, memory and secrets are all still there | |
| 11.3 | Upgrade from the previous release to this one | Team, theme, colors, browser width and tabs are all kept | |

## 12. Desktop app (Windows)

When publishing the Release, do not tick "Set as the latest release". The workflow's last job, "Download
table, checksums and Latest", waits until all installers are uploaded, and only its last step marks the
Release as Latest. When the workflow is done, check that the Release has `SHA256SUMS.txt` and files
without a version number (such as `DS-Bot-win-x64.exe`), that the notes start with the
`Download / 下载` (Download) table, and that the Release is marked "Latest". When a job fails, re-run the
failed jobs in that run (Re-run failed jobs). Do not mark it as Latest by hand: then the Release has no
checksums and no download table.

Do 12.7 and 12.8 only after the whole Release workflow is done and the Release page shows "Latest":
Windows auto-update looks only at the Release marked Latest, and until then it keeps saying there is no
new version. The Release must also have the installer, its `.blockmap` and `latest.yml`. When the
previous release has no installer, skip these two items.

| # | Step | Expected | Result |
|---|---|---|---|
| 12.1 | Run the installer, choose an install location, install | No administrator rights; installs only for the current user; DS Bot is in the Start menu | |
| 12.2 | First open: the start window appears (no location line when there is enough disk space); with a DSH team, choose to copy it | Team, chats and model settings are all there; the original team in DSH is unchanged | |
| 12.3 | Send a message to a Bot; then open Settings → About DS Bot | A reply comes; the DS Bot line says "Updates come with the DS Bot app." | |
| 12.4 | Check the window: drag the title bar, double-click the title bar, click minimize, maximize and close; switch between light and dark | No system frame; it drags, double-click maximizes, and a maximized window has no gap at the top; all three buttons work and have the same background as the interface under them; on Windows 11 the sidebar shows Mica, on Windows 10 the title bar has the same color as the sidebar | |
| 12.5 | Press `Ctrl+Alt+B` | The sidebar collapses; press again and it expands | |
| 12.6 | Settings → General → "Location": move the team workspace to another folder and send a message to a Bot; then move the data location to an empty folder | After the team workspace change, the Bot's next turn runs in the new folder; after the data is copied, the app restarts on its own, the team and chats are all there, "Location" shows the new data location, and the old folder is still there | |
| 12.7 | Install the previous release of the app, open it, wait until it says the new version has downloaded, choose "Restart now" | The app closes, installs the new version and opens again; the About page shows the new version number; the team is all there | |
| 12.8 | Install the previous version once more, wait for the downloaded notice, choose "Not now", quit the app from the tray, wait half a minute and open it | The new version opens | |

## 13. Desktop app (macOS)

Do 13.2–13.6 once on an Apple silicon Mac and once on an Intel Mac. 13.6 needs a zip for this Mac in the
previous release; skip it when there is none.

| # | Step | Expected | Result |
|---|---|---|---|
| 13.1 | Publish the Release and wait for the workflow to upload the files | The Release has two zips, arm64 and x64 | |
| 13.2 | With Safari, download the zip for this Mac from the Release page (Safari unzips it), drag DS Bot to Applications, open it for the first time | Gatekeeper blocks it but does not say it is "damaged"; after "Open Anyway" in "System Settings → Privacy & Security" it opens | |
| 13.3 | First open: the start window appears (no location line when there is enough disk space); with a DSH team, choose to copy it; send a message to a Bot | Team, chats and model settings are all there; a reply comes; the About page says "Updates come with the DS Bot app." | |
| 13.4 | Settings → General → "Location": move the team workspace to another folder and send a message to a Bot; then move the data location to an empty folder | After the team workspace change, the Bot's next turn runs in the new folder; after the data is copied, the app restarts on its own, the team and chats are all there, "Location" shows the new data location, and the old folder is still there | |
| 13.5 | Close the window, open it again from the tray or the Dock; finally choose "Quit DS Bot" in the tray | The first close shows a notice that the app stays in the tray and keeps running; after confirming, the window hides and the engine keeps running; clicking the Dock icon or "Open DS Bot" in the tray brings the window back; only "Quit DS Bot" in the tray quits completely | |
| 13.6 | Install the previous release of the app and open it; when the new version notice comes, click "Download" | Opens the release page of this Release; the app does not install the new version itself | |

## 14. Phone app (Android)

The APK is signed with an upload key. The key is in three repository secrets: `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`. Every future APK must use the same key, or Android
does not allow installing over the old one. Without these secrets, the Release's "Phone app (Android)"
job fails.

| # | Step | Expected | Result |
|---|---|---|---|
| 14.1 | Publish the Release and wait for the workflow to upload the files | The Release has `DS-Bot-<version>-android.apk`, and the download table has an Android row | |
| 14.2 | In DS Bot on the computer, open Settings → Phone and turn on "Phone access" | The server is `wss://relay.dsbot.app/v1/link`, and the status turns to on | |
| 14.3 | On an Android phone that never had DS Bot, download the APK from the Release page and install it; open it and scan the QR code on the computer with the camera | It installs; after the scan, pairing succeeds and the team opens | |
| 14.4 | Turn off Wi-Fi and send a message to a Bot over mobile data; open a photo in a chat | A reply comes; the photo shows a preview first, and the full image after a tap | |
| 14.5 | With the previous release's APK installed, install this one | It installs over the old one, and the pairing is still there | |
