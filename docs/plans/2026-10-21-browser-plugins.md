# Browser plugins: one backend for the whole team, one profile per Bot

- Date: 2026-10-21
- Related: changes "Bots do not operate the browser" in [Browser, search, secrets and connectors](2026-10-08-browser-and-secrets.md). The maintainer confirmed that rule was waiting for this work.
- Code: `ds-bot/src/host/browser-plugins.js`, `ds-bot/src/host/browser/`, `browser-plugins/`

## Why

To do work on web pages for the user, a read-only panel is not enough. Many browser backends already exist: browser-use, Playwright, Stagehand, ego lite, Hermes's `browser_exec`, OpenCode's browser tool, and a number of DSH plugins. DSH's official browser-use subsystem can attach only one provider at a time, and the browser belongs to that one live Session, so moving to a new part or reopening loses the login.

A Bot is a long-lived identity. Logins should follow the Bot, not one part of a conversation. At the same time, one Bot must not use one setup while another Bot uses a different one: the team picks one backend. The browsers themselves stay separate, and cookies do not cross between Bots.

## Decided behavior

- The team config sets `browserPlugin` to one of `refs`, `script` or `task`. Without it, things stay as before: only the read-only `read_browser` on the desktop. The three values are never registered at the same time.
- Once one is chosen, every Bot uses the same set of tools. A Bot's own Session, its Session in each group, and the ids those Sessions had before moving to a new part all resolve to the same Bot and open the same profile: `bot/browser-profiles/<botId>/`.
- Different Bots' directories are not copied or shared. If the user wants two Bots logged in to the same site, each logs in once. If "copy this login to another Bot" is wanted later, it will be an explicit action, not an automatic sync.
- In group chats each Bot uses its own browser, that is, its own Bot profile; there is no browser shared by a group.
- Page text is still data, not instructions from the user.
- Browsing, clicking, typing, selecting, filtering, login forms and ordinary settings are allowed by default, without grading by DSH permission preset.
- Only posting, uploading, downloading and deleting need the user's authorization. When the Bot has a pre-authorization for the matching site and action type on the "Browser" page in Settings, it acts directly; otherwise it goes through a DSH approval card, and the approval allows only this one action. A pre-authorization can have an expiry time.
- For a delete, with or without pre-authorization, the tool first returns a snapshot to check; the Bot must check the target and then click the same element again with `browser_click` and `confirm: true`, and both the page URL and the tab must match, before the normal authorization flow starts.
- Paying, buying, transferring money and similar actions are never done by the Bot, and the Bot does not enter payment details either. The Bot calls `browser_handoff` (or `handoff` in a script), and the user completes it. Logins and captchas can also be handed to the user; after a handoff, clicking, typing and opening pages stay stopped until `browser_resume`. There is no separate list of domains, and local network addresses are not blocked.
- When a Bot hands off in its own chat, a card appears in the chat: it states the reason, what the user needs to do and the site of the current page, with the buttons "Skip", "Take over" and "I'm done", in that order. "I'm done" and "Skip" tell the Bot the result and hand the browser back, and the Bot continues or takes another route; "Take over" opens the browser panel and the card stays until the user clicks one of the other two buttons. After the user answers with the card or the panel, the reply message leaves a title and the result in the transcript; after the Bot calls `browser_resume` itself or the app restarts, the old card is not shown and this line is not added.
- Uploads can only use files in the Bot's work directory, the team directory or `browser-downloads/<botId>/`, and link targets are resolved before the check.
- When the result of an authorized post, upload, download or delete is unknown, it is recorded by source and must first be verified with a snapshot; until the page has been observed again, the same action from the same source is not allowed again. Downloaded files are saved to the Bot's work directory, or to the team directory when the Bot has no work directory.
- Three plugins:
  - `refs`: open, snapshot, click and fill by number, screenshot. Each step stays in the Session and can be checked. Snapshots read into open Shadow DOM and same-origin iframes.
  - `script`: submit one piece of JavaScript at a time, with helpers already in scope. This is the shape of Hermes's `browser_exec` and ego's heredoc.
  - `task`: a goal goes in, the plugin runs it through with the `refs` tools itself, and returns the answer and the steps.
- Screenshots go to the model as image blocks. Later models are used as multimodal; Flash is not treated as text only.
- In the desktop app, the Playwright plugin connects to the browser pages that the main process owns; the Bot and the user see the same set of tabs. DSH Desktop still uses a separate Chromium profile. Each Bot's profile and download directory are isolated per Bot.

## Not done

- No cookie sync between Bots.
- Chrome DevTools MCP is not an optional backend. It stays in the research and is not one of the three plugins.
- We do not pretend ego was tested on this machine, which has no ego lite.
- No plugin is turned on by default, so the existing read-only behavior is unchanged. Not merged into `dev` before one is chosen.

## Known limits

- In DSH Desktop the user still operates the browser panel; in the desktop app the panel's pages are shared by the Bot and the user, and the user controls the takeover state.
- A handoff a Bot starts in a group chat or a sub-Agent does not show a chat card; it is handled only in the takeover bar at the top of the browser panel. The tool result reminds the Bot to say in the current conversation what the user needs to do, and handing back in the panel does not notify the Bot.
- When `browser-plugins/*` is installed alone into a DSH profile without DS Bot, profiles are separated by Session id, so moving to a new part loses the login as with the official browser-use. The directory that follows the Bot exists only when DS Bot mounts it.
- `task` calls the model again inside the plugin; the steps are in the tool result, not in the Bot's own step-by-step tool calls.
- This round of testing used self-built multi-step pages plus two arXiv tasks from WebVoyager, not the whole set of more than 600.

## Changes

- 2026-10-21: the maintainer decided on one backend for the whole team, one profile per Bot, and no cookie sync. The three plugins and the tests are on the same branch, off by default.
- 2026-10-22: `browser_task` uses the model the calling Bot has configured in DSH; the benchmark model is configured with `BENCH_BASE_URL`, `BENCH_MODEL` and `BENCH_API_KEY`.
- 2026-10-23: the maintainer decided the permission rules: allowed by default; posting, uploading, downloading and deleting go by pre-authorization or approval; deleting always adds one more round of checking; payments always go to the user; pre-authorizations can have a time limit and are managed on the Browser page in Settings.
- 2026-10-24: in the desktop app, Bots operate the pages in the browser panel; the user can take over, stop the Bot or hand control back. A Bot handoff can be resumed by the Bot; a user takeover can only be handed back by the user.
- 2026-10-27: when a Bot hands off in its own chat, a card appears in the chat with the buttons Skip, Take over and I'm done; clicking "I'm done" or "Skip" notifies the Bot. With this kind of handoff, handing back in the panel also notifies the Bot, but only says that control was handed back, without claiming the step was done. Group chats and sub-Agents show no card; the tool result tells the Bot to say in the current conversation what the user needs to do.
