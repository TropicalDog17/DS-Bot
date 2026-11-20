# Mobile app

- Date: 2026-10-24
- Related: [vision](../vision.md) "A standalone app" and "Data stays on the user's computer",
  [desktop app](2026-10-16-desktop-app.md), [roles and permissions](2026-10-07-roles-and-permissions.md)

## Why

When the user is away from the computer, the Bots keep working: there are approvals to give,
questions to answer, results to look at and more work to hand out. The mobile app lets the user
control the DS Bot team on their own computer remotely, from iOS and Android.

Trade-offs:

- **The phone runs no agent.** Bot turns, tools, models, memory and chat history all stay on the
  computer, as on the desktop. The phone only shows and controls.
- **We build the connection ourselves, learning from DSH Remote.** DSH Remote (MIT) already has a
  mature way to connect: end-to-end encryption, the computer only connects outward, and a relay is
  used automatically when a direct connection fails. We use its connection code, changed to DS Bot's
  own protocol, and improve it ourselves from there, without depending on its plugin, servers or
  versions. The files we use are listed in `NOTICE`.
- **We build the whole interface ourselves.** The pages for the Bot team, group chats and cards
  follow DS Bot's own design, not a generic remote-session interface.
- **One codebase for both platforms.** Expo React Native, with native builds.

## Decided behavior

### Structure

| Part | Where | What it does |
|---|---|---|
| Mobile app | `mobile/` | iOS and Android. Interface, team state, encrypted connection |
| Host module | On the computer, built into the desktop app; the plugin can use it too | Recognizes paired phones and passes the phone's actions to `ds-bot`'s `api/bot`, using the same actions as the desktop interface |
| Relay server | DS Bot provides one; users can also run their own and change the address in the app | Pairing, device list, relay, push. It only forwards ciphertext and cannot see the content |

- The computer only connects outward: no public IP and no open ports are needed.
- The phone and the computer are encrypted end to end (Noise). They connect directly when they can
  and go through the relay when they cannot.
- The actions the phone can use are released with the same version of `ds-bot`. When `ds-bot` adds
  an action, the phone can use it too.

### Pairing and devices

- The computer shows a QR code, and the phone scans it to pair. No account is needed.
- The phone remembers the computer's identity on the first connection. If the identity changes
  later, the phone refuses to connect and shows a warning.
- The computer shows the paired phones and can remove them. A removed phone is disconnected at once
  and cannot connect again.
- The phone's keys are stored in the system keychain (iOS Keychain, Android Keystore).

### What the phone can do

Full features: whatever DS Bot can do on the desktop, the phone can do too.

| Page | Contents |
|---|---|
| Computer list | Paired computers, online state, pair again |
| Team | List of Bots and groups, search, unread; "Needs you": every approval, question and card waiting for you |
| Private chat | Messages, images, earlier history, Side chat, stopping a Bot's work |
| Group chat | Messages, progress; stopping the work in a group |
| Approvals, questions, cards | The same options as on the desktop; cards can be filled in and answered |
| Bots and groups | Create, edit, copy, delete; set a Main Bot; model, thinking effort, permission preset; member agents |
| Memory | Each Bot's and group's memory: view, ask, forget |
| Secrets | Answer a Bot's secret card; add, update and delete in the settings. Values travel only over the encrypted connection and are not shown back on the phone |
| Connectors | Connect, disconnect, retry |
| Schedules | Create, delete, view |
| Capabilities | MCP, skills, capability packs: view, save, approve, delete |
| Model providers | Add, delete, enter the key, pick models |
| Work folders | Pick from a folder list; team workspace |
| Bot browser | Watch the screen, take over, hand back, answer browser waits |
| Usage and stats | View |
| Updates and diagnostics | Check for updates, install updates; view diagnostic logs, clean up |

- Only things that must happen on the computer itself work differently: the system dialog for
  picking a folder becomes a folder list on the phone; the Bot browser still runs on the computer,
  and the phone watches the screen and takes over.
- Roles and permissions are the same as on the desktop; see
  [roles and permissions](2026-10-07-roles-and-permissions.md).

### High-privilege actions

- Changing secrets, model provider keys, connectors or capabilities, and installing updates, each
  needs the phone to be unlocked first (Face ID, fingerprint or the screen-lock passcode). Without
  unlocking, nothing is sent.

### Sync

- Team state syncs by version number, fetching only what changed.
- The app stops refreshing while in the background and catches up when it comes back to the
  foreground.
- When disconnected, pages show "Disconnected" and catch up after reconnecting. Write actions are
  not retried automatically, so that one message is not sent twice.

### Push

- When something needs you (an approval, a question, a Bot reply, a task finishing), a push
  notification is sent.
- Push content is encrypted end to end. The phone decrypts it locally and shows it, for example
  "Chief asks for your approval: …". The relay server only sees ciphertext.

### Security

- Only paired phones are accepted. Parameters can only be plain JSON objects.
- Cards sent by Bots are untrusted content: they render only in a fixed format, with limits on depth
  and size, and they run no web pages or scripts and access no network.

## Not done

- No agent running on the phone, and no team data or chat history stored on the phone.
- No remote desktop or terminal.

## Known limits

- Publishing on iOS needs an Apple developer account; test builds go through TestFlight. Android can
  install the APK directly.
- When the computer is off or asleep, the phone cannot connect.
- End-to-end encrypted push needs a native notification extension; first check that it can be done.

## Changes
