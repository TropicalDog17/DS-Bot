# Mobile client API

- Date: 2026-10-24
- Related: the Bot page of dsh-go (the DSH client on Android); [Desktop app](2026-10-16-desktop-app.md),
  "Interface"; [Group chat](2026-10-07-group-chat.md)

## Why

The interface of both the web version and the desktop app is the DSH web front end plus the `ds-bot`
plugin: group chat history comes from the plugin splitting `group_relay` results in the browser, a round
in progress comes from polling `room-progress` every second, and other status comes from polling
`state`. A phone is different:

1. **It draws its own interface.** The phone client (dsh-go) draws Bots, group chats and details with
   native controls; it runs neither the DSH web front end nor the plugin's interface code. There can be
   only one copy of the rule for how a group chat is split into speakers from the Session, and it lives on
   the server.
2. **It drops connections and gets sent to the background.** The system cuts SSE connections in the
   background, and on return the client needs to know what it missed: which Bot spoke, who in a group
   finished their work, which card waits for someone.
3. **The two sides upgrade separately.** The app on the phone, the `ds-bot` installed on the phone and the
   `ds-bot` in Docker on a NAS will not be at the same version, so a handshake is needed to state what
   each side can do.
4. **Traffic and size.** Bot avatar photos are data URLs, and every `state` carries all photos, which is
   too heavy for a phone on a remote connection.

Trade-offs:

- **Transport and Remote methods.** Local / LAN / SSH still use `POST api/bot` and `GET api/bot/feed`,
  authenticated with the DSH Session cookie, like the desktop app's window. When the client can reach the
  host only through a link that forwards DSH Typert Gateway Remote methods, the plugin also registers two
  Gateway Remote methods in source mode that reuse the same channel and event stream (a pure-JS plugin
  has no Typert generator): `dsBot/call { endpoint, payload }` returns the same `{ ok, value | error }`
  as `POST api/bot` (like the phone pairing link, it refuses the `phone-*` pairing management and the
  `folder-pick` native dialog, which run only on the computer itself, with `bot/refused`), and
  `dsBot/feed {}` pushes `{ event, data }` as a stream (the first item is `hello`). The cost: if the relay
  itself has an interface allow list (such as `ds-harness-remote`), it must allow both `dsBot/call` and
  `dsBot/feed`; see "Known limits".
- **Display entries, not raw events.** Group chats and Bot own chats both give "who, said what, when"
  entries, so the client need not understand DSH Session events or DS Bot's internal source markers.
- **Notices are kept in memory.** A notice is only an index for "catch up on return", not the record
  itself; the real content is still in the Sessions and `state.json`. So notices are not saved to disk,
  and after a restart the count starts over (`boot` changes), and the client reads the team again.

## Decided behavior

### Versions and handshake

- `hello`: `{ client?: { name, version, platform }, api?: [1] }` →
  `{ api, apiMin, apiMax, plugin: { name, version }, capabilities, boot, seq, revision, readOnly, memory, feed, rpc? }`.
  - `api` is the highest version both sides support; when the client sends none, it is the server's
    current version; with no overlap it is `null`, and the client asks for an update.
  - `capabilities` lists what the server supports (`room-chat`, `notices`, `avatar`, `memory-edit`,
    `usage-summary`, `rpc` when Gateway Remote is mounted, and others).
  - When the host mounts the DSH Typert Gateway and `dsBot/call` and `dsBot/feed` are ready, it includes
    `rpc: { call: 'dsBot/call', feed: 'dsBot/feed' }`; when it is not mounted, neither `rpc` nor the
    `rpc` capability is returned.
  - `boot` changes on every DSH start; `seq` is the sequence number of the latest notice.
- Version rules:
  - Additions only (new endpoints, new fields, new entry or notice kinds, new feed events) do not raise
    `api`; they go into `capabilities`. Clients skip fields, kinds and events they do not know.
  - Only changes that old clients would read wrongly raise `api`; the server answers normally for any
    version in `apiMin..apiMax`.
- An old `ds-bot` without `hello` answers `bot/not-found`, from which the client knows the version is too
  old.

### Team and avatars

- `state` as before. With `avatars: 'ref'`, each photo is replaced by `avatar.imageRef` (the first 16
  characters of the SHA-256 of the photo content); nothing else changes.
- A phone's `bot` call over the link (`{ endpoint, payload }`) can carry an extra `state` field, whose
  content is the request body for the `state` endpoint: when a write succeeds and the team revision
  changed, the response has an extra `state`, equal to the answer of asking `state` on the spot. Reads,
  writes that did not change the revision, and failed writes do not include it.
- `avatar`: `{ botId }` → `{ botId, ref, image }`; with no photo, `ref` and `image` are both `null`. The
  client caches by `ref` and fetches again when `ref` changes.
- The character shape (`avatar.shape`) and default color are still computed by the client from the Bot id
  (`defaultColor` in `characters.js`).

### Own chat

- `chat`, `send`, and the feed's `message` and `stream` as before (see `feed.js`). User messages in
  `chat` also carry `images` / `imageRefs`.
- `image`: `{ sessionId, attachmentId }` → `{ mime, data }`, where `data` is the image bytes in base64.
  `sessionId` accepts only team Sessions (a Bot's own chat parts, group Sessions, old parts left by part
  switches); others answer `bot/not-found`; an attachment that is not in the Session is also
  `bot/not-found`. Needs the `images` capability. With `preview: true`, JPEG and PNG images whose long
  side is over 512 pixels and whose file is over 100 KB are replaced by a JPEG preview with a long side
  of 512, answering `{ mime: 'image/jpeg', data, preview: true }`; others still return the original. The
  chat uses previews and fetches the original when opened. Needs the `image-preview` capability.

### Bot browser

- `state.browserHolds`: who holds each Bot's browser right now (the shape of `holdSnapshot()`): the Bot
  asked the user to take over (with `callId`, `reason`, `note`), or the user took over.
- `browser-frame`: `{ botId }` → `{ mime, data, url, title }`, a screenshot of the Bot browser's current
  page (JPEG, base64). If this machine does not run the Bot browser it answers `bot/browser-off`; if this
  Bot has no open browser, `bot/not-found`.
- Take over, give back and stop still use `browser-takeover`, `browser-give-back` and `browser-stop`.

### Group chat

- `room-chat`: `{ roomId, cursor? }` → `{ roomId, items, cursor, running, speaking }`, paged from newest
  to oldest, at most 60 messages per page, oldest to newest within a page.
- Entries:
  - `{ id, kind: 'user', text, images?, imageRefs?, time }`: a user message, including ones inserted
    during a round in progress. `images` is the number of images, `imageRefs` is a
    `{ attachmentId, mime?, name? }` for each; fetch the content with `image`.
  - `{ id, kind: 'bot', botId, name, color?, text, time, duration?, whole?, live? }`: a member's
    message, or a post a Bot sent in from outside the group. `whole: { length, file }` means the post was
    too long and was turned into a file; read the full text with `file-text`.
  - `{ id, kind: 'event', event, botId?, name?, text?, code?, time }`: an event in a round; `event` is
    `working`, `approval`, `done`, `stopped`, `failed`, `missed`, `lookup`, `resumed`, `cut`, or
    `schedule` for a scheduled task.
- While a round is in progress, the newest page holds the messages so far at that round's position
  (`live: true`), `running` is true, and `speaking` is the member who is speaking. After the round ends,
  the same message keeps the same `id` (`<callId>:<index>`), so the client can replace it directly.
- Sending still uses `send` (`sessionId` is the group's id); stopping a member's work still uses
  `stop-member-work`; approvals for members in a group still use `approval-answer`.

### Notices

- Kinds:
  - `message`: a Bot said something in its own chat (hidden turns between Bots and the fixed replies of
    part switches do not count).
  - `group`: a member spoke in a group.
  - `done`: a member finished the work handed to it.
  - `question`, `view`: a question card or view card in a Bot's own chat waits for the user.
  - `approval`: a Bot waits for user approval (with the group when in a group).
- Each one: `{ seq, kind, botId, name, roomId?, title?, sessionId?, text, time }`. `name` is the Bot's
  current name, `title` is the group name, `text` is at most 300 characters, squeezed into one line.
- `notices`: `{ boot?, since? }` → `{ boot, seq, reset, notices }`. When `boot` does not match (there was
  a restart) or notices after `since` have already been pushed out, `reset` is true and the client reads
  the team again. At most 200 notices are kept in memory.
- A notice only says "something happened"; it does not record read state. Read state and how
  notifications pop up are up to the client.

### Live stream (feed)

- `hello` also carries `api`, `boot` and `seq`; after reconnecting, the client first catches up with
  `notices`.
- New event `notice`: one notice, with the content above.
- New event `room`: `{ roomId }`, a new line in a group, or a round started or ended; events within 150
  milliseconds are merged into one. The client reads the first page of that group again.
- Each subscription to the `dsBot/feed` stream first sends a `hello`, then forwards all live events; when
  the plugin is unloaded and reloaded, or a single subscription has 512 unconsumed events backed up, the
  subscription ends at once (the old backlog is not drained), and the client reconnects and catches up
  with `hello` and `notices`.

### Memory

- `memory-add`: `{ botId | roomId, scope?, topic?, text }`; `memory-edit`:
  `{ botId | roomId, scope?, topic?, text, next }`. Entries the user writes themselves, without the
  model; the checks are the same as for the tools (length, and content that looks like a key is refused
  with `bot/invalid`). Both return the same result as `memory-view`. Removal still uses `memory-forget`.

### Usage

- `usage-summary`: `{ botId, timeZone? }` → `{ botId, day, week, month, models, scanning }`. `day`,
  `week` and `month` are `{ input, cacheRead, cacheWrite, output, calls }` for the last 24 hours, 7 days
  and 30 days; `models` is the same numbers for the last 30 days, per model.

### Read-only DSH

- `hello`, `notices`, `avatar`, `room-chat` and `usage-summary` also answer on a read-only DSH;
  `memory-add` and `memory-edit` are refused like other changes (`bot/read-only`).

## Not done

- No read state stored on the server: each device keeps its own.
- No push to the phone system (FCM and the like): the client receives notices only while connected, and
  relies on its own keep-alive in the background.
- No separate usage for group chats: a member's usage in a group counts under the member itself.
- No change to the endpoints and events used by the web version and the desktop app.

## Known limits

- If a remote relay (such as `ds-harness-remote`) keeps its own allow list of Remote interfaces, it can
  be used through the relay only after its allow list includes `dsBot/call` and `dsBot/feed`; SSH
  tunnels, direct LAN connections and the local machine are not affected.
- In old groups (created under the PTC preset) a round runs inside `run_code`, and `room-chat` cannot
  recognize the messages of such rounds.
- Notices are not saved to disk: notices not delivered before DSH restarts are lost, and the client can
  only read the team again.

## Changes


## File download chunks

`file-download` accepts an `offset` in bytes. It returns at most 512 KiB of file
content as base64, with `nextOffset`, `done`, `size`, and `version`. Subsequent
requests repeat the returned version so a changed presented file cannot be spliced
into an earlier download. Presented-file coordinates require their exact Session
part; a Bot id never searches matching sequence numbers in other parts.

New clients request one chunk at a time. Android and iOS write each chunk through an
Expo file handle before requesting the next; the browser collects Blob parts. There
is no total-file limit for chunk clients. Older clients that omit `offset` retain
the existing whole-file response and its 16 MiB compatibility limit.
