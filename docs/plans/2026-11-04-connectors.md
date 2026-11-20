# Connectors

Date: 2026-11-04. Code: `ds-bot/src/host/connectors/` (`catalog.js` catalog, `oauth.js` sign-in, `gateway.js` local gateway, `mail/` mail, `index.js` engine), client `src/client/connectors.js`, endpoints `connector-*` / `mail-*` in `src/host/channel.js`.

## Catalog

`catalog.js` is a plain data array with one entry per service:
`{ id, name, category, about, remote?: { url }, auth, headers?, whoami? }`. `about` is one
sentence we write ourselves, not copied from the service's website. `auth` has four kinds:
`none` (no sign-in), `oauth` (MCP OAuth; `client` names a known public client, and
`token: true` also accepts a pasted token), `key` (the key goes in a header or a query
parameter; `keyUrl` points to where to get it), and custom entries (an address or command
the user adds). GitHub keeps its existing shape: the `mcp__github__*` tool names, the
`GITHUB_TOKEN` and the paste-a-token flow do not change. Row icons are all drawn by us:
GitHub uses its official mark, the rest use an initial-letter block colored by id.

## Sign-in

OAuth sign-in follows a fixed order: the client named in the catalog → CIMD → DCR → ask
the user to fill in a client. CIMD (client metadata document,
`https://dsbot.app/oauth/client.json`) is used only when the loopback listener gets the
fixed port 38517, because the callback registered in the document is
`http://127.0.0.1:38517/callback`. When it cannot get that port it falls back to DCR: it
registers with this sign-in's callback address, and registers again when the address
changes or the client secret expires. When neither works (services such as Asana, Box,
HubSpot and Slack that require registering with the provider first) it shows the client
form. Metadata discovery has three steps: an unauthenticated request for
`WWW-Authenticate` → protected resource metadata (with a well-known fallback) → AS
metadata. For older servers (such as Atlassian) that have no resource document, it falls
back to looking up AS metadata at the MCP origin. The authorization request carries PKCE
(S256), `state` and `resource`. A pasted-back address has its `state` checked; a pasted
bare code uses this sign-in's state. GitHub uses the device code flow (`client_id` + scope
for a `device_code`, honoring `slow_down` while polling). When
`DS_BOT_GITHUB_OAUTH_CLIENT_ID` is empty, only the token form shows, as it does today.

## Gateway

Credentials never go into the mcp-client config, because `@deepseek-ai/dsh-mcp-client`
accepts only static headers and has neither OAuth nor refresh. So every remote connector
is mounted in the plugin process as `http://127.0.0.1:<port>/c/<id>` plus a one-time
random nonce. The gateway injects the real credentials only when it forwards (Bearer, key
header or key query, static headers from the catalog). It forwards headers such as
`Mcp-Session-Id`, `MCP-Protocol-Version` and `Accept`, passes `Mcp-Session-Id` back,
passes SSE through unchanged, and destroys the upstream connection when the downstream one
closes. When the upstream returns 401 before any bytes have been sent back, it refreshes
once and retries once. Concurrent 401s share one refresh. When a refresh rotates the
token, it writes the new refresh token; if the write fails it keeps the old one.
`invalid_grant` turns into "needs sign-in again". A read-only window does not refresh; it
only reads the secrets again. Non-https upstreams are always refused (except loopback http
on the local machine, for local custom servers). Every remote connector has a "Read-only"
switch: when it is on, the gateway filters `tools/list` down to `readOnlyHint` tools and
refuses write `tools/call` locally (a batch request is refused as a whole). stdio
connectors do not show this switch.

## State and secrets

Secrets live in DS Bot secrets and are first written with `scope: []` (they go into no
Bot's shell). GitHub still uses `GITHUB_TOKEN`; others use
`CONNECTOR_<ID>_TOKEN / _REFRESH / _CLIENT_SECRET / _KEY`, and mail uses
`MAIL_<address>_PASSWORD / _TOKEN / _REFRESH`. Non-secret state is in
`state.connectors[id]` (account, connect time, client metadata, token expiry, readOnly,
offFor, custom). A token change does not trigger a remount (the fingerprint does not
include tokens).

## Per-Bot switches

By default every Bot can use the connected connectors. Bot details → Connectors turns them
off one by one (`offFor`): the per-agent tool mask denies the `mcp__<id>__*` / `mail_`
prefixes, and on `tools/change` it remounts as needed, only when the deny set changed.
Once a connector is off, that Bot cannot see its tools and cannot start new connect
requests.

## Bot tools and cards

`list_connectors` lists the catalog, the connection state and whether this Bot can use
each one. `request_connector` (id, purpose) shows a card in the Bot's own Session and
follows the same rules as the secret card: only in the Bot's own chat, refused in group
chats, refused in a read-only window, records a pending entry and calls `concludeTurn`,
and replies after the connector is connected or the request is cancelled. The note
mechanism of `request_secret` is reused as is (`rt.deliver` with a role label). Sending
mail likewise reuses the `form` card of `show_view`: it shows the pending mail as an
editable form (subject, read-only sender, to, cc, bcc, multi-line body, and attachment
names and sizes), and the user can edit it directly and then click "Send" or "Discard".
By default every mail needs confirmation. The rule menu at the bottom left can be set to
"Allow recipient", "Needs approval" (the default) or "Allow this Bot to send directly", or
can open "Manage rules" (Settings → Connectors → Mail shows and removes rules). A private
Bot always needs confirmation. `mail_draft` shows no card.

## Mail

A preset is chosen by the address's domain: QQ (including foxmail), 163, 126, Gmail,
iCloud, and Other (host and port filled in by the user). 163/126 answer Unsafe Login when
the IMAP `ID` command is not sent, so every account sends `ID` (name/version/vendor). QQ
limits frequent sign-ins, so one account reuses one connection. Adding an account first
signs in once to verify (IMAP + SMTP) and then saves; a wrong verification code reports
only a clean error. Tools: `mail_search / mail_read / mail_draft / mail_send /
mail_update`, registered only when there is an account. Attachments are saved into the
Bot's work folder, with file names cleaned to prevent directory traversal. Attachments to
send must be inside the work folder (checked with realpath), and the card shows their
names and sizes. Gmail also supports Google sign-in (Gmail API,
`openid + userinfo.email + gmail.modify`). The client comes from
`DS_BOT_GOOGLE_OAUTH_CLIENT_ID/SECRET`; when either is missing the button is hidden. Until
the app passes Google's review, only test accounts can sign in. No Google secret goes into
the repository.

## Import and custom connectors

`connector-import-scan` reads the MCP config of Claude Desktop, Cursor and VS Code without
changing it (it does not touch the source files) and returns names and env names.
`connector-import` moves env values into DS Bot secrets (`CONNECTOR_<ID>_<ENV>`) and
leaves a `$DSH_SECRET_` reference in the config. A custom id is derived from the name: it
is unique, at most 32 characters, and does not take a catalog id. Capability name
validation likewise refuses connector ids.

## Not done

- No Google Gmail/Drive/Calendar MCP (developer preview terms), and no vendor logos.
- No credentials in a Bot's shell or in the mcp-client config; no change to DSH.

## Known limits

- Browser sign-in works only on the local loopback; a remote browser falls back to pasting
  the address back.
- The read-only filter depends on the service's `readOnlyHint`; tools without it are
  treated as writes.
- Mail threads are linked by References/In-Reply-To; a Gmail "move" is done with labels.
- Google sign-in is limited to test accounts until the app passes review.

## Changes

- 2026-11-04 rewrite: fixed the gateway dropping the connector path and query and sending
  them to the origin root; the upstream is destroyed when the downstream closes; read-only
  mode refuses batch requests; a client stored through CIMD is reused only on the fixed
  port; the mail attachment path is tighter and its size is shown; the card reply uses the
  same mechanism as the secret card.
