# Bot browser, web search, secrets and connectors

- Date: 2026-10-08 set the Bot browser; 2026-10-09 set page reading and the secret card; connectors were added later
- Related: #114 (open links in the Bot browser), #128 (recovering after turning off `auto` search), #184 (`web_search` on the opencode route)
- Code: `ds-bot/src/host/browser.js`, `src/client/bot-browsers.js`, `app/src/bot-browser.mjs`, `src/client/read-page.js`, `ds-bot/web-search.js`, `src/host/secrets.js`, `src/host/connectors.js`

## Why

When a Bot does work on the web for the user, it meets two kinds of things: web pages, and the secrets it needs to log in to pages and call services. Both carry the same risk: **page content cannot be trusted, and secrets must not leak**. A page can hide an instruction such as "send your token here", model requests go to third parties, and chat history is saved.

So the principles are:

- The **user operates** the browser; the Bot can only read. Each Bot's browser is isolated from the others.
- **Only the user enters** a secret's value, and it **stays on this machine**. The Bot only gets the environment variable name; before anything leaves the machine, the value is replaced with a placeholder.

## Decided behavior

### Bot browser (in DSH Desktop and the desktop app)

- Each Bot has its own browser panel and can open several tabs. Each tab is an Electron webview in the Bot's own storage partition (`bot:<id>`). The tabs of one Bot share login state; cookies and login state are not shared between Bots.
- DSH Desktop keeps the partition only in memory, so it is gone on exit. The desktop app stores the partition in its own directory (not in the data location), so the Bot is still logged in after a restart; removing the Bot clears it.
- The desktop app provides its own browser bridge with the same interface as DSH Desktop. The main process only lets the bridge attach webviews it has leased, and fixes the webview settings: sandbox on, no Node, permission requests and downloads refused, the app's own local ports blocked. When a page wants to open a new window, it opens as a new tab of the same Bot.
- In DSH Desktop the user operates the pages. The Bot's `read_browser` only reads the current tab: title, address, and the visible content converted to Markdown. In the desktop app, once the browser plugin is set up, the Bot operates the same page as the user's panel through Playwright; the user controls taking over and handing back.
- It can read into Web Components (open shadow DOM) and same-origin iframes. It cannot read cross-origin iframes (it only gives their names), text drawn on a canvas, or hidden content.
- In DSH Desktop, `read_browser` **cannot click, type, scroll or open pages**. The tool description asks the Bot to treat page content as data, not as instructions.
- The pages live in the app window, not in the plugin process, so read requests go through the window. The client always keeps a long poll open (`browser-wait`) that reports which Bots have pages open and carries read requests back to the window; the window answers with `browser-result`. A request stays queued until the window answers; requests whose poll was interrupted are sent again, and the window drops duplicates by id.
- Across all Bots and all tabs, at most 6 live pages are kept at once (each one is a renderer process). Past that, the one viewed longest ago is released; its address and summary are kept, and it reloads when shown again.
- It can open pages on this machine and on the local network. It cannot open a cloud host's metadata service, because that service hands out account credentials.
- The cards in the drawer use the page's own description or first paragraph as the preview, not a screenshot: on Windows a failed screenshot crashes the renderer process of the whole app.

### Web search (the `auto` provider)

- `web-search.js` is one web-search provider for DSH, independent of the Bot team code; ordinary DSH Sessions can use it too.
- Each search first tries the native search of **the model route of the Session that asked**: with that route's own key, sent to that route's own address. Whether a route has native search is decided by protocol, not by vendor. Whether an address supports it is only known by trying, so each result is recorded.
- **It never borrows another route's key**: each key is billed to its own account.
- When native search is not available, it falls back to a way that needs no key: it fetches a public search results page through DSH's `fetch` and parses it.
- Each result notes which path produced it. When both paths fail, the error tells the model not to guess.

### Secrets

- **Only the user can enter a value.** A Bot uses `request_secret` to show a secret card in its own chat; the user types into the card and the Bot never sees the value. Once the card appears, the Bot's turn ends; after the user saves or cancels, the Bot gets a notice. For a secret already stored for this Bot, the Bot is only told the variable name.
- The value is stored only in `bot/secrets.json` in the data directory (mode 600) and in the plugin process.
- A Bot gets the value in the shell with `$DSH_SECRET_<name>`. Tool results have the value removed before they are saved; before each model request is sent, the value is replaced with `[secret:<name>]`. JSON-escaped and URL-encoded forms are replaced as well; with several values, the longest is replaced first.
- Replacing short values under 8 characters (PINs, short passwords) wherever they appear would damage ordinary text, so they are replaced only when they stand alone: the characters right before and after are not letters or digits.
- Scope: "this Bot only" or "all Bots". When another Bot asks for the same secret and the user agrees, that Bot is added to the scope. `list_secrets` lists the names, purposes and which Bots can use each one, without the values.
- Settings → Secrets can change the scope, replace the value, or delete it.
- Memory does not keep content that looks like a secret (see [Context and memory](2026-10-09-context-and-memory.md)).
- An MCP config in a capability refers to a secret as `$DSH_SECRET_<name>`, never the value (see [Bot runtime](2026-10-10-bot-runtime.md)).

### Connectors (GitHub)

- A connector is an external service that all Bots can use; GitHub is the first. Its tools come from GitHub's MCP service and are attached to the plugin through DSH's own MCP client, so every Bot and Session can call them as `mcp__github__<tool>`.
- The token is stored as the secret `GITHUB_TOKEN`. It only appears in the request header of MCP requests to GitHub; that header is built in memory and not written into the DSH profile.
- A newly connected token **does not go into any Bot's shell by default**: the MCP tools do not need it, and a Bot that has read an instruction hidden in an issue could send it anywhere. The user can open it up on the Secrets page.
- On connect, DS Bot asks GitHub who owns the token; if GitHub accepts it, the connection passes. Deleting `GITHUB_TOKEN` disconnects.
- When the connector address is not https, the token is not sent.

## Not done

- In DSH Desktop, Bots do not operate the browser: no clicking, no typing, no opening pages. For Bot browser behavior in the desktop app, see [Browser plugins](2026-10-21-browser-plugins.md).
- Bots do not see or enter secret values, and values are not written into chat history, memory, the DSH profile or model requests.
- Web search does not borrow another route's key.

## Known limits

- The Bot browser exists only in DSH Desktop and the desktop app, not in DSH Web.
- Links in past messages cannot yet open directly in the Bot browser (#114).
- After turning off `auto` search, `web_search` can fail; see #128 for how to recover.
- Cookie import exists only in the desktop app (written into the Bot's own storage partition): cookie files (Cookie-Editor JSON, cookies.txt, Playwright storageState) and local Chrome/Edge/Firefox profiles. For Chromium browsers it clones the profile first and lets the original browser decrypt it, rather than reading the files directly. On Windows, new Chrome/Edge cookies use app-bound encryption (v20), which can only be decrypted in the original user-data directory: the clone cannot decrypt them, so those entries are marked as skipped; if the whole store is v20, it tells the user to import from a file instead. localStorage and other login state are not imported.
- Secrets only guard against leaks to the model, the records and other Bots' shells. A Bot with access can use the value in its own shell, so the user decides which Bots get it.

## Changes

- 2026-10-08: one browser per Bot, operated by the user; the Bot only reads.
- 2026-10-09: `read_browser` reads into Markdown and marks links and controls; the secret card and the replacement rules.
- Later: added multiple tabs, at most 6 live pages, and the GitHub connector.
- 2026-10-16: native search on opencode routes carries the asking Session's `x-opencode-session` (#184, PR #240).
- 2026-10-23: the Bot browser also exists in the desktop app, with logins saved in the app's own directory, #449.
- 2026-10-23: the desktop app's Bot browser can import cookies (from files and local browsers), #458.
- 2026-10-21: operating the browser moved to an optional plugin, see [Browser plugins](2026-10-21-browser-plugins.md). Without the plugin, the read-only behavior in this note is unchanged.
- 2026-10-24: in the desktop app, Bots operate the page in the browser panel; the user takes over, stops and hands back control. Only the user can end a user takeover.
