# Start page copy: layers, keys and one table

- Date: 2026-10-29
- Related: [Start window](2026-10-26-start-window.md) (sections 3, 4, 5, 6, 7, 11), [Windows onboarding](2026-10-26-windows-onboarding.md) (sections 3, 4, 8, wording), [UI standard](../design/ui-standard.md) section 11
- Code: `app/src/start/text.mjs` (the one table), `app/src/start/start.html`, `app/src/start/start.js`, `app/src/first-run.mjs`, `app/src/updates.mjs`, `app/src/main.mjs`, `app/test/start-page.test.mjs`

## Why

The start page text was decided sentence by sentence in two design notes, but in the code it was spread
over three tables: the page's `text.mjs` (118 keys), and the main process's `first-run.mjs` (30) and
`updates.mjs` (11). The last two built sentences with functions, and no test watched them. Key names
followed where they came from, not which line of text they are on the page: the whale's line had both
`voice.*` and `title.*`, the hint line had a `slow.45.later`, half of the buttons were bare keys (`retry`)
and half hung under a card (`card.recommend.use`), and card body text was spread over `card.*`,
`import.*`, `newer.*`, `update.*` and bare keys. So the same sentence was written twice
(`「换个位置…」` ("Change the location…"), `「DS Bot 没有权限在 … 里写文件。」` ("DS Bot can't write files
in ….")), the same meaning had two or three wordings (`「不复制 / 先不复制」` ("Don't copy / Don't copy
yet"), `「不带团队开始 / 先不带团队开始」` ("Start without the team / Start without the team for now")),
punctuation depended on the case (among the whale's lines only `「团队界面没有加载出来。」` ("The team view
didn't load.") had a full stop; on the hint line only `「比平时慢，请再等一会儿。」` ("Slower than usual,
please wait a little longer.") had one), and the wording drifted (`聊天记录` against `对话`, both "chats";
`群` against `群聊`, both "group chat"; in English, chats and conversations mixed). A review of the tables
on 2026-10-29 found no dead key; all the problems were in the structure.

This note does one thing: **layer the text by where it sits on the page, one writing rule per layer, one
sentence per key, one table, one set of tests.** Decided sentences do not change by a single character,
unless they break the rule of their own layer; each change is listed in "Changes to decided designs".

## Decided behavior

### 1. One table

- All text in the shell that the user can see is in `TEXT` in `app/src/start/text.mjs`: the start
  page's, and that of the system dialogs attached to the start window or the main window (choose folder,
  move data, import, update). `first-run.mjs` and `updates.mjs` no longer have their own tables.
- The copy is English only (it was Chinese first, with English key by key, until the interface became
  English only).
- Placeholders are `{name}`. Paths, sizes, names and versions are filled from the snapshot or the
  arguments and are not written in the table. English plurals are written in the placeholder:
  `{bots|Bot|Bots}` fills as "1 Bot", "6 Bots" (`t()` picks by whether the value is 1).
- There is one lookup function, `t(key, vars)`, for the page and the main process alike.
- Product names are not copy: the dialog titles `DS Bot`, `DSH Desktop` and `DSH Web` are constants. They
  are not in the table and are not translated.
- Outside the table there is no more Chinese or English text that the user can see. English error
  strings in the main process meant for Bots or developers (browser, cookie import, IPC refusals) are not
  copy and are not in the table.

### 2. Layers: the first segment of a key

Keys are written `<layer>.<thing>[.<part>]`. The first segment can only be one of the ten below. It says
where the line of text is on the page, not why it exists. Each layer has one writing rule (for Chinese;
for English see section 4).

| Layer | Where | Who speaks | Rule |
|---|---|---|---|
| `voice.*` | The line under the whale, with text only on errors: 180 seconds, failure | The whale, first person, spoken style | One line, no wrapping, at most 16 characters; no full stop, a question mark is allowed; spoken verbs are allowed (`「搬过来」` ("move it over")) |
| `say.*` | The first line of a card (15/20, 600) | The whale | At most 12 characters; no full stop |
| `hint.*` | The hint line, only the sentence in the first 10 seconds when the disk is short | The app, neutral | Only one thing the user needs to know now, at most 22 characters; no full stop |
| `card.*` | Card body | The app | Full sentences that end in 。 or ？; say what happened and leave what to do to the buttons; paths go in `code`; `card.<card>.<part>`, and what several cards share goes in `card.update.*` |
| `reason.*` | Reasons reused in card bodies | The app | Full sentences end in 。 (`reason.place.*`, the nine reasons a location cannot be used; `reason.start.*`, the five reasons a start fails); fragments embedded in a sentence have no punctuation (`reason.copy.*`, the three reasons a copy fails) |
| `btn.*` | Buttons | The user's action | At most 10 characters, starts with a verb or an action phrase; a button that opens a picker or leaves this card ends in …; no full stop; small link-style buttons can be noun phrases (`「其他位置…」` ("Another location…"), `「详细」` ("Details")) |
| `note.*` | Card footnote | The app | One sentence that ends in 。 and says where to change it later |
| `foot.*` | The location line in the footer | The app | No full stop (`「数据放在 C 盘（剩 412 GB）」` ("Data on drive C, 412 GB free")) |
| `status.*` | Only for screen readers | The app | No full stop: the hidden list `「启动进度」` ("Start progress"), the three stage names, the four state words, the spoken sentences |
| `dialog.*` | Body text of cards in the team window (system dialogs before 2026-11-01), picker titles, and hints and errors in the picker (`dialog.picker.*`) | The app | Body text is full sentences that end in 。 or ？ and can be two paragraphs (`\n\n`); picker titles have no full stop; buttons use `btn.*` |
| `picker.*` | Picker labels and buttons (since 2026-11-02 the picker is the app's own) | The user's action | Noun or verb phrases, no full stop |

- Each sentence has only one key. When two layers need the same sentence, each layer gets its own key
  (the hint line's `「C 盘只剩 1.2 GB」` and the card's `「C 盘只剩 1.2 GB。」`, both "Only 1.2 GB left on
  drive C", are two keys in two layers).
- Each meaning has only one wording: `「先不复制」` ("Don't copy yet": do not copy the team, go on) and
  `「先不带团队开始」` ("Start without the team": give up the copy and start with a blank team) are two
  meanings, each with one wording. The dialog's old `「不复制」` and `「不带团队开始」` become these two.
- One thing, one name (onboarding note, "wording"): `对话` (chats, not `聊天记录`), `群聊` (group chat,
  not `群`), `API Key` (not `密钥`), `附件` (attachments), `总工作区` (team workspace), `数据文件夹` (data
  folder), `位置` (the setting; English Location, singular). The whale may speak casually
  (`「正在搬过来」` ("moving it over")); buttons and body text use the formal names (`「复制过来」` ("Copy them
  over"), `「停止复制」` ("Stop copying")).
- No process words: `马上`, `稍后`, `下个版本` ("right away", "later", "next version") (UI standard
  section 11; the test scans the whole table).

### 3. Key mapping

Old key → new key. Where the Chinese stays the same it is not written; where it changed, it is written
out.

Whale lines `voice.*`: `voice.slow45 / watchdog` unchanged; `title.moving` → `voice.moving`,
`title.failed` → `voice.failed`, `title.viewFailed` → `voice.viewFailed` `「团队界面没有加载出来」` ("The
team view didn't load") (full stop removed), `slow.45.later` → `voice.slowLater`
`「比平时慢，请再等一会儿」` ("Slower than usual, please wait a little longer") (full stop removed; on later
starts and during data moves the whale says it from 45 seconds on). The start window says nothing when
all goes well ([Start window](2026-10-26-start-window.md) section 3), so the table has no greeting, no
lines for each stage and no "go in" (`voice.hello / helloName / helloBack / data / found / engine /
slow10 / team / ready`), and `title.later` `「正在打开你的团队…」` ("Opening your team…") has no key either.

Card first lines `say.*`: `say.space / permission / rejected / picked / missing / importSpace / inUse /
newer` unchanged. The import card's first line has numbers. It is `card.import.line`
`「找到你以前的团队了：{bots} 个 Bot、{groups} 个群聊」` ("Found your old team: {bots} Bots, {groups} group
chats") (not a sentence, no full stop). There is no card during the copy, so there is no `say.copying`.

Hint line `hint.*`: only `hint.space`, unchanged. The three sentences about connecting a model, the
preview notice and reinstalling (`hint.model / preview / reinstall`) have no keys: the start page does
not tell ahead of time what comes after the user is in.

Card body `card.*`:

| Old | New | Chinese |
|---|---|---|
| `card.recommend.ask` | `card.recommend.ask` | `放到 {rec} 盘（剩 {recFree}）？` ("Put it on drive {rec} ({recFree} free)?") |
| `card.reason.space`, `card.reason.permission` | see `reason.place.*` | |
| `card.rejected.*` | see `reason.place.*` | The card uses `reason.place.{reason}` directly |
| `card.missing` | `card.missing.lead` | |
| `card.missing.retryMissed` | `card.missing.retryMissed` | |
| `card.picked` | `card.picked.lead` | `会放在 {path}。` ("It will go in {path}.") (full stop added) |
| `import.extra / model` | `card.import.extra / model` | Only under "Details"; `lead / found / scope` are gone |
| `import.opt.regen / skipWork` | `card.import.optRegen / optSkipWork` | Checkbox labels |
| `import.space` | `card.importSpace.lead` | |
| `inUse` | `card.inUse.lead` | |
| `newer.updating`, `newer.unreadable` | `card.newerUpdating.lead`, `card.newer.lead` | |
| `importFailed` | `card.importFailed.lead` | |
| (new) | `card.importFailed.do` | The card for a failed copy: what to do |
| (new) | `card.viewFailed.lead`, `card.viewFailed.do` | The card for a team view that did not load: what happened, what to do |
| (new) | `card.failed.do.{reason}` | "What to do" under the reason on the recovery card, one sentence for each of the six reasons of `reason.start.*` |
| `failed.reason.*` | see `reason.start.*` | The card uses `reason.start.{reason}` directly |
| `update.available / downloading / installing / failed / slow` | `card.update.available / downloading / installing / failed / slow` | |

Reasons `reason.*`:

| New | Chinese | From |
|---|---|---|
| `reason.place.space` | `{drive} 盘只剩 {free}。` ("Only {free} left on drive {drive}.") | `card.reason.space` |
| `reason.place.permission` | `DS Bot 没有权限在 {path} 里写文件。` ("DS Bot can't write files in {path}.") | `card.reason.permission` and `card.rejected.permission` merged |
| `reason.place.onedrive` | `{path} 在 OneDrive 里，同步会打断正在写入的对话。` ("{path} is in OneDrive; syncing interrupts chats while they are being written.") | `card.rejected.onedrive` (`聊天记录` → `对话`) |
| `reason.place.foreign / dsh / program / nested` | As before | `card.rejected.*` |
| `reason.place.drive / workspace` | `{path} 是整块磁盘，要选它里面的一个文件夹。`／`{path} 和总工作区互相包含。` ("{path} is a whole drive; choose a folder on it." / "{path} and the team workspace contain each other.") | New (2026-10-31): "this place won't work" when data moves on later starts; same meaning as `dialog.move.drive / workspace` |
| `reason.start.permission / space / files / engine / other` | As before, with a full stop | `failed.reason.*` |
| `reason.copy.inUse / permission / full` | As before, fragments | `importFailed.*` |

Buttons `btn.*`:

| Old | New | Chinese |
|---|---|---|
| `retry`, `wait`, `openLogs`, `freshStart` | `btn.retry`, `btn.wait`, `btn.openLogs`, `btn.freshStart` | |
| `card.recommend.use`, `card.recommend.keep` | `btn.useRec`, `btn.keepDrive` | `放到 {rec} 盘`, `仍然放在 {drive} 盘` ("Put it on drive {rec}", "Keep it on drive {drive}") |
| `card.recommend.other` | `btn.otherPlace` | `其他位置…` ("Another location…") (link style) |
| `pickOther` | `btn.pickPlace` | `选择其他位置…` ("Choose another location…") |
| `place.change`, `changePlace` | `btn.changePlace` | `换个位置…` (merged; English Change the location…) |
| `card.missing.relocate` | `btn.relocate` | `重新找到它…` ("Find it again…") |
| `card.picked.use`, `card.picked.repick` | `btn.continue`, `btn.repick` | `继续`, `重新选…` ("Continue", "Choose again…") (… added: it opens the picker) |
| `import.copy`, `import.skip` | `btn.copy`, `btn.skipCopy` | `复制过来`, `先不复制` ("Copy them over", "Don't copy yet") |
| `import.more`, `import.change` | `btn.more`, `btn.changeModel` | `详细`, `更换` ("Details", "Change") |
| `startWithout` | `btn.startWithout` | `先不带团队开始` ("Start without the team") |
| `copyDetails`, `copied`, `details` | `btn.copyDetails`, `btn.copied`, `btn.details` | |
| `update.install`, `manualDownload`, `reload` | `btn.install`, `btn.manualDownload`, `btn.reload` | |
| The dialogs' `move`, `cancel`, `quit`, `restart`, `download` | `btn.move`, `btn.cancel`, `btn.quit`, `btn.restart`, `btn.download` | `移动并重启`, `取消`, `退出`, `立即重启`, `下载` ("Move and restart", "Cancel", "Quit", "Restart now", "Download") |
| The dialogs' `copy`, `skip`, `startEmpty` | merged into `btn.copy`, `btn.skipCopy`, `btn.startWithout` | `复制过来`, `先不复制`, `先不带团队开始` |
| The update box's `later` | `btn.notNowRestart`, `btn.notNowDownload` | `先不重启`, `先不下载` ("Not now" for the restart, "Not now" for the download) (`稍后`, "later", is a process word) |
| Hard-coded `'OK'` | `btn.ok` | `确定` ("OK") |

Footnotes `note.*`: `card.footnote` → `note.changeLater` `「以后可以在 设置 → 通用 → 位置 里改。」` ("You can
change this later in Settings → General → Location."); `import.footnote` → `note.copyLater`
`「也可以在 设置 → 通用 → 位置 里复制。」` ("You can also copy the team in Settings → General → Location.");
`newer.footnote` → `note.copyAgain` `「以后可以在 设置 → 通用 → 位置 里复制。」` ("You can copy the team later
in Settings → General → Location.") (the same sentence pattern as `note.changeLater`).

Footer `foot.*`: `place.drive / driveOnly / path / pathOnly` → `foot.place.drive / driveOnly / path /
pathOnly`. `footer` (`「社区开源项目，不是 DeepSeek 官方产品」`, "A community open-source project, not an
official DeepSeek product") has no key: since 2026-10-31 the start page has no footer note.

Status `status.*`: `track.label` → `status.track`; `phase.*` → `status.phase.*`; `state.*` →
`status.state.*`; `sr.*` → `status.sr.*`. `elapsed` (`「已用 N 秒」`, "N seconds so far") has no new key:
the start page does not show elapsed seconds.

Dialogs `dialog.*` (before in `first-run.mjs` and `updates.mjs`):

| New | Chinese |
|---|---|
| `dialog.pickRoot` | `选择 DS Bot 放数据的位置` ("Choose where DS Bot keeps its data") |
| `dialog.pickMove` | `选择 DS Bot 数据的新文件夹` ("Choose a new folder for DS Bot's data") |
| `dialog.move.inDsh` | `请选择 DeepSeek Harness 数据（{home}）以外的文件夹。` ("Choose a folder outside the DeepSeek Harness data ({home}).") |
| `dialog.move.inProgram / drive / nested / workspace / notEmpty` | As before |
| `dialog.move.confirm`, `dialog.move.detail` | `把 DS Bot 的数据移到 {to} 吗？` / `DS Bot 会把数据复制过去，然后重新启动。{from} 会原样保留，确认一切正常后可以自己删掉。` ("Move DS Bot's data to {to}?" / "DS Bot copies its data there and starts again. {from} stays as it is; you can delete it yourself once everything works.") |
| `dialog.move.inUse`, `dialog.move.failed` | As before (`{message}`) |
| `dialog.import.found` | `DeepSeek Harness 里有 {bots} 个 Bot 和 {groups} 个群聊。要复制到 DS Bot 吗？` ("DeepSeek Harness has {bots} Bots and {groups} group chats. Copy them to DS Bot?") (before, groups were left out when there were 0 group chats; now they are always written, the same as on the import card) |
| `dialog.import.foundDetail` | `会复制 Bot、群聊、记忆、对话、附件、模型设置和 API Key。{home} 里的内容不会改变，复制以后两边各用各的。` ("Copies Bots, group chats, memory, chats, attachments, model settings and the API Key. Nothing in {home} changes, and after the copy each side goes its own way.") (`群` → `群聊`, `密钥` → `API Key`, `文件` → `附件`, consistent with `card.import.scope`) |
| `dialog.import.inUse` | `DeepSeek Harness 正在使用这个团队。请先关掉它，再重试。` ("DeepSeek Harness is using this team. Close it first, then try again.") |
| `dialog.import.newer` | `有 {n} 段对话是更新版本的 DeepSeek Harness 写的，这个版本的 DS Bot 读不了。请先更新 DS Bot，再打开它来复制团队。` ("{n} chats were written by a newer DeepSeek Harness, and this version of DS Bot can't read them. Update DS Bot first, then open it to copy the team.") |
| `dialog.import.whichModels` | `DS Bot 用哪一份模型设置？` ("Which model settings should DS Bot use?") |
| `dialog.import.failed` | `团队没有复制完：{message}\n\nDS Bot 会用一个新团队开始。DeepSeek Harness 里的团队没有变化。` ("The team wasn't fully copied: {message}\n\nDS Bot starts with a new team. The team in DeepSeek Harness is unchanged.") (`没有复制成功` ("was not copied successfully") → `没有复制完` ("wasn't fully copied"), consistent with `card.importFailed.lead`) |
| `dialog.update.ready`, `dialog.update.readyDetail` | `DS Bot {version} 已经下载好。` / `现在重启就能更新；不重启的话，下次退出时安装。` ("DS Bot {version} has finished downloading." / "Restart now to update; if you don't, it installs the next time you quit.") (the English becomes has finished downloading; before, it said ready to install) |
| `dialog.update.available`, `dialog.update.availableDetail` | As before |
| `dialog.update.onFailure`, `dialog.update.onFailurePage` | As before |

### 4. English

- English follows the meaning of the Chinese key by key and is not a separate set: the location line is
  written in full, "Data on drive {drive}, {free} free" (before, it was only "Drive C, 412 GB free").
- The first word is capitalized; `voice / say / hint / btn / foot / status` have no full stop;
  `card / reason (full sentences) / note / dialog` end in a full stop or a question mark; … follows the
  Chinese.
- Nouns: chats (not conversations), group chats, attachments, API Key, Settings → General → Location
  (singular), team workspace, data folder, local engine.
- Plurals use `{n|one|many}`: `card.import.line` "Found your old team: {bots|Bot|Bots},
  {groups|group chat|group chats}", `dialog.import.found`, `dialog.import.newer`.
- `「先不复制」` is Don't copy yet, `「先不带团队开始」` is Start without the team, `「先不重启」` is Not now
  (restart box), `「先不下载」` is Not now (download box).

### 5. Tests

`app/test/start-page.test.mjs` scans the whole `text.mjs` table, `start.html`, `start.js` and `whale.js`,
as well as `main.mjs`, `first-run.mjs` and `updates.mjs`:

- Existing: the Chinese and English key sets and placeholders are the same; the Chinese has no English
  outside the allowlist; no `马上` / `稍后` / `下个版本`; every key the page uses is in the table.
- New:
  - The first segment of every key is one of the eleven layers (`picker` for the picker was added on
    2026-11-02).
  - The Chinese of `voice / say / hint / btn / foot / status / picker` does not end in 。, and the
    English does not end in .; full sentences in `card / note / dialog` end in 。 or ？ (exceptions, listed
    in the test: `reason.copy.*`, `card.update.slow` `「下载太慢？」` ("Download too slow?"), picker titles,
    `card.copying.step*`, `card.copying.eta*`, `card.import.model`, `card.import.opt*` and the progress
    line `card.update.downloading`).
  - Length limits (after removing placeholders): `voice` 16, `say` 12, `hint` 22, `btn` 10.
  - For buttons with `data-act="pick"` in `start.html`, the key's Chinese ends in ….
  - Every key used by `tx('…')` in the three main process files is in the table; `first-run.mjs` and
    `updates.mjs` have no string tables of their own.
  - Plurals in `t()`: `{bots|Bot|Bots}` fills correctly for 1 and for 6.
  - The `voice` layer has only three keys (`voice.failed / viewFailed / watchdog`), the `hint` layer has
    only `hint.space`, and there is no `status.elapsed`.

## Changes to decided designs

| Before | Now | Reason |
|---|---|---|
| Start window note section 7, onboarding section 3: the whale's line `「团队界面没有加载出来。」` ("The team view didn't load.") | `「团队界面没有加载出来」` | The whale's line has no full stop, consistent with `「DS Bot 没能启动」` ("DS Bot couldn't start") |
| Start window note section 5, onboarding section 8: at 45 seconds `「比平时慢，请再等一会儿。」` ("Slower than usual, please wait a little longer.") | `「比平时慢，请再等一会儿」` | The hint line has no full stop |
| Start window note section 6, onboarding section 3: `「会放在 D:\DS Bot」` ("It will go in D:\DS Bot") [`继续`] [`重新选`] ("Continue", "Choose again") | `「会放在 D:\DS Bot。」` [`继续`] [`重新选…`] | Card body text ends in a full stop; a button that opens the picker ends in … (the same for [`重新选…`] on the rejected card) |
| Start window note section 6: `「…在 OneDrive 里，同步会打断正在写入的聊天记录。」` ("…is in OneDrive; syncing interrupts the chat history being written.") | `「…正在写入的对话。」` | One thing, one name (`聊天记录` → `对话`, both "chats") |
| Onboarding section 4: the footnote of the newer-version card `「可以在 设置 → 通用 → 位置 里再复制。」` ("You can copy again in Settings → General → Location.") | `「以后可以在 设置 → 通用 → 位置 里复制。」` ("You can copy the team later in Settings → General → Location.") | The same sentence pattern as `「以后可以在 … 里改。」` ("You can change this later in ….") |
| `first-run.mjs`: the import dialog's [`复制`] [`不复制`] [`不带团队开始`] ("Copy", "Don't copy", "Start without the team") | [`复制过来`] [`先不复制`] [`先不带团队开始`] | The same wording as the import card; the dialog stays only until the import card lands (M5) |
| `first-run.mjs`: `「DeepSeek Harness 里有一个 Bot 团队：6 个 Bot、2 个群。」` ("DeepSeek Harness has a Bot team: 6 Bots, 2 groups.") `「会复制 Bot、群、记忆、对话、文件、密钥和模型设置。」` ("Copies Bots, groups, memory, chats, files, keys and model settings.") | `「DeepSeek Harness 里有 6 个 Bot 和 2 个群聊。要复制到 DS Bot 吗？」` `「会复制 Bot、群聊、记忆、对话、附件、模型设置和 API Key。…」` | `群聊`, `附件` and `API Key` are the decided names |
| Desktop app note, "Install and update", and `updates.mjs`: the update box's [`稍后`] ("Later") | [`先不重启`] [`先不下载`] | `稍后` is a process word, UI standard section 11 |
| `main.mjs`: the box for a refused data move had only an English [OK] | [`确定`] / [OK] by language | No text the user can see outside the table |
| Section 3 of this note: `voice.hello / helloName / helloBack / data / found / engine / slow10 / team / ready` unchanged, `title.later` → `voice.opening`; `hint.model / preview / reinstall` unchanged; `elapsed` → `status.elapsed`; section 2: "`「待会儿要接一个模型」` ("You'll connect a model in a moment") …… stays" | All these 14 keys are gone (ten `voice`, three `hint`, one `status`), and that explanation is removed too | The start window's look changed to a ring (the 2026-10-30 rows in "Changes to decided designs" of [Start window](2026-10-26-start-window.md)): it says nothing when all goes well, shows no elapsed seconds, and does not tell ahead of time what comes after the user is in. Discussion the maintainer forwarded on 2026-10-30: "this version is a bit noisy now", "actually I think maybe just the whale is enough, and then we can do interactive animation; text and such isn't really needed" |
| Section 3 of this note: `slow.45.later` → `hint.slowLater` `「比平时慢，请再等一会儿」`, on the hint line | `voice.slowLater`, the same sentence | On later starts and during data moves, the whale says this sentence from 45 seconds on, on the same line as the first start's `voice.slow45`; the hint line keeps only [`打开日志文件夹`] ("Open log folder") |
| Section 2 of this note, `status.*`: "only for screen readers and counting" | Only for screen readers | The start page does not show elapsed seconds |
| Sections 2 and 3 of this note: `foot.*` is the footer note line, `footer` → `foot.community` `「社区开源项目，不是 DeepSeek 官方产品」` ("A community open-source project, not an official DeepSeek product") | `foot.*` keeps only the location line, and this key is gone | The maintainer on 2026-10-31: "remove the community unofficial notice at the bottom left" (the last row of "Changes to decided designs" in [Start window](2026-10-26-start-window.md)) |

## Not done

- No sentence changes its meaning; sentences not listed above do not change by a single character.
- The plugin's copy (team interface, settings, cards in the Main Bot chat) does not move into this
  table: it is in `i18n.js`, and its source language is English (UI standard section 11). The sentences
  in onboarding sections 4 and 8 that belong to settings and the chat are not here.
- No new sentences are added to the start page. Onboarding section 3 decided that when [`重新找到它…`]
  ("Find it again…") picks a folder without data, it says `「这里没有 DS Bot 的数据。」` ("There is no DS Bot
  data here."). The `.ds-bot` marker has not landed yet, so this sentence is added together with that
  step (`card.missing.noData`).
- `dialog.move.detail`'s `「{from} 会原样保留」` ("{from} stays as it is") does not change: it describes
  what the code does today. It changes when onboarding section 8, "a move is a move, the old location
  keeps no copy", lands.
- The wording of the `应用程序` ("Applications") folder in `dialog.update.availableDetail` does not change
  (the macOS wording is also shown for the Linux deb): it belongs to the update flow and is tracked
  separately.

## Known limits

- Length limits count Chinese characters after removing placeholders; a run of English letters or digits
  (DeepSeek, GB) counts as one character. English has no length limit: whether English wraps is up to
  the styles, and when a line does not fit, change the sentence first.
- Plurals have only two English forms, one and many, which is enough for the start page; other languages
  are out of scope.
- The "ends in …" test checks only buttons with `data-act="pick"`; dialog buttons that open a picker
  (there are none) are not included.

## Changes

- 2026-10-29 first draft: ten layers, one table, the key mapping, tests; matching the reordered
  `text.mjs`, the `first-run.mjs` and `updates.mjs` tables merged into it, and the key changes in
  `start.html` and `start.js`. Basis: the 2026-10-29 review of the three tables (all 30 dialog keys and
  11 update keys are in use, no dead keys; comparing the page table sentence by sentence with the two
  design notes found only one difference, the full stops in `failed.reason.*`; 30 style issues, all
  checked again).
- 2026-10-30: the start window's look changed to a ring (the change of the same day in
  [Start window](2026-10-26-start-window.md)): the whale keeps only the few lines the user needs to know
  or answer. 14 keys are removed from the table (`voice.hello / helloName / helloBack / data / found /
  engine / slow10 / team / ready / opening`, `hint.model / preview / reinstall`, `status.elapsed`), and
  `hint.slowLater` is renamed `voice.slowLater` (the same sentence; on later starts and during data moves
  the whale says it from 45 seconds on). The explanation of the `voice`, `hint` and `status` layers in
  section 2, the mapping in section 3 and the plural example in section 4 change with it, and section 5
  gets one more test. Basis: the discussion the maintainer forwarded on 2026-10-30 ("this version is a
  bit noisy now") and the ring prototype the maintainer chose.
- 2026-10-31: the start page's footer note is removed (the change of the same day in
  [Start window](2026-10-26-start-window.md)), and `foot.community` is removed from the table; the `foot`
  layer keeps only the location line, sections 2 and 3 change with it, and "Changes to decided designs"
  gets a row. Data moves on later starts now ask on a card: adds `say.move` `「搬到这个文件夹？」` ("Move the
  data here?"), `card.move.lead` and `reason.place.drive / workspace` (one row added to the mapping table
  in section 3; `reason.*` in section 2 becomes nine reasons); the buttons use the existing
  `btn.move / repick / cancel`. Basis: the maintainer, "remove the community unofficial notice at the
  bottom left" and "let's avoid any default pop-ups like this in the system as much as we can".
- 2026-11-01: the start page rarely shows text (the change of the same day in
  [Start window](2026-10-26-start-window.md)): `voice.slow45 / slowLater / moving` and `btn.openLogs` are
  removed from the table, and `btn.saveLog` `「保存日志…」` ("Save log…") is added (it opens the system save
  box, so it ends in …); the `voice` layer keeps only the three lines for errors. The old key mapping in
  section 3 is a record of that time and does not change.
- 2026-11-02: the import moves into the ring (the change of the same day in
  [Start window](2026-10-26-start-window.md)): adds `card.import.line`, `say.stopCopy` and
  `status.phase.import` `「复制以前的团队」` ("Copy your old team"); removes `say.import / copying`,
  `card.import.lead / leadBare / found / scope` and `card.copying.step1 / 2 / 3 / eta / etaSoon`.
- 2026-11-02: the copy has no stop button (the change of the same day in
  [Start window](2026-10-26-start-window.md)): removes `say.stopCopy`, `card.copying.stopConfirm`,
  `btn.stopCopy` and `btn.keepCopying`.
- 2026-11-02: the recovery card says what to do (the change of the same day in
  [Start window](2026-10-26-start-window.md)): adds `card.failed.do.permission / space / files / engine /
  other`.
- 2026-11-02: the card for a team view that did not load (the change of the same day in
  [Start window](2026-10-26-start-window.md)): adds `card.viewFailed.lead / do`.
- 2026-11-02: the card for a failed copy (the change of the same day in
  [Start window](2026-10-26-start-window.md)): adds `card.importFailed.do`.
- 2026-11-02: the data folder cannot be found (the change of the same day in
  [Start window](2026-10-26-start-window.md)): adds `reason.start.missing` and `card.failed.do.missing`.
