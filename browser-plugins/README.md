# Bot browser plugins

The team picks only one backend, with one Chromium profile per Bot. Without one, `read_browser` in the desktop
stays read-only.

| Directory | Plugin | How a Bot uses it |
|---|---|---|
| `refs/` | `ds-bot-browser-refs` | Snapshot, click and fill by number, screenshot |
| `script/` | `ds-bot-browser-script` | Submit one script at a time |
| `task/` | `ds-bot-browser-task` | One goal; returns the answer and the steps |

In DS Bot, set `browserPlugin` to `refs`, `script` or `task`. The three are never loaded together. Profiles live
in `bot/browser-profiles/<botId>/`; group Sessions use the same Bot's profile. Cookies are not copied between
Bots.

For sign-in, payment and CAPTCHA, the Bot calls `browser_handoff`; after the user is done, it calls
`browser_resume`.

```sh
npm install
npx playwright install chromium
npm test
node bench/run.mjs
node bench/render-report.mjs
```

`browser_task` uses the model that the calling Bot has configured in DSH. Before running the benchmark, set
`BENCH_BASE_URL`, `BENCH_MODEL` and `BENCH_API_KEY`.

```sh
BENCH_BASE_URL=... BENCH_MODEL=... BENCH_API_KEY=... node bench/run.mjs
```

The design note is `docs/plans/2026-10-21-browser-plugins.md`.
