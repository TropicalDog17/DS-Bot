# Token Usage Benchmark

Repeatable, read-only benchmark for measuring DS-Bot's prompt-cache efficiency and auxiliary token burn before and after runtime or configuration changes.

## Tool

Script: [`ds-bot/dev/usage-benchmark.mjs`](../../ds-bot/dev/usage-benchmark.mjs)

- Reads `$DSH_HOME/bot/usage.sqlite` (with `sqlite3 -readonly`) and `$DSH_HOME/sessions/*/*/session.v4.jsonl.zstd` (with `zstd -dc`).
- Aggregates numeric token and event counts only; never writes to `DSH_HOME` and never prints prompt text, secrets, or session content.

### Commands

Capture a 24-hour baseline snapshot:

```sh
node ds-bot/dev/usage-benchmark.mjs snapshot \
  --home "$DSH_HOME" \
  --hours 24 \
  --out /tmp/dsb-usage-before.json
```

Capture a post-deploy window (either `--since <ISO>` for an exact deploy timestamp or `--hours 24` after a full day):

```sh
node ds-bot/dev/usage-benchmark.mjs snapshot \
  --home "$DSH_HOME" \
  --since 2026-11-26T09:09:30Z \
  --out /tmp/dsb-usage-after.json
```

Optional: pass `--claude-dir ~/.claude/projects` to also aggregate deduplicated local Claude Code CLI usage (including subagent share) over the same window.

Compare two snapshots:

```sh
node ds-bot/dev/usage-benchmark.mjs diff \
  /tmp/dsb-usage-before.json \
  /tmp/dsb-usage-after.json
```

## Metrics to Watch

Raw token totals fluctuate with workload volume, so compare **rate metrics** first, then 24h totals:

1. **Opus turn cache hit ratio** (`cacheRead / (input + cacheRead)`): healthy multi-step turns should stay around `96%–99%`.
2. **Opus avg uncached input / call**: measures fresh prompt + cache-miss tokens billed per step.
3. **Within-5m miss rate (`>15K` uncached input within 5 minutes of the previous step in the same session)**: isolates cache invalidations from normal 5-minute TTL expirations.
4. **Stale live-image miss calls**: within-5m misses where a live (un-offloaded) image existed strictly before the previous `assistant/message`. Should be `0` after mid-turn offloading (`377d98a0`).
5. **Auxiliary model split (`memory`, `compaction`, `image`, `other`/optchat)**: checks whether background work is routed to `backgroundModel` / `ocrModel` / `optchat.route` instead of the Bot's primary model.
6. **OptChat avg output / call**: checks that the `optchat` summarizer does not inherit extended thinking budgets (target `< 300` output tokens/call for 512-byte summaries).

## Benchmark History

### 2026-11-26 — Reduce Claude token usage (`319d997b` → `377d98a0`)

**Changes measured:**
- Code (`377d98a0`):
  - Mid-turn `image/offload` on `agent/pre-step` for images strictly before `lastAssistantSeq`.
  - Lowest available `reasoningEffort` + `purpose: 'compaction'` in `optchat` summarizer.
  - `backgroundModel` preference (`Settings > Background model`) for memory jobs, part-handoff steward checks, and image OCR.
  - Claude Code CLI system-prompt deduplication on fresh turns and ephemeral side-call flags (`--effort`, `--no-session-persistence`, `--strict-mcp-config`, `--tools ""`).
- Runtime config on the measured host:
  - `prefs.backgroundModel`: `gateway/ocg/deepseek-v4.1-flash`
  - `optchat.route.model`: `claude-code/claude-haiku-5-5` → `ocg/deepseek-v4.1-flash`
  - `bot.ocrModel`: `gateway/chatgpt/gpt-6.1-sol`
  - Unused MCP connectors masked off via `connector-set` (`offFor`).

**Results:**

| Metric | Baseline 24h (`319d997b`) | Post-deploy 52m (`377d98a0`) | Delta / Note |
|---|---:|---:|---|
| Opus turn calls | `1,454` (`60.6`/h) | `210` (`244.2`/h, peak load) | Rate-normalized below |
| Opus turn cache hit ratio | `93.72%` | **`96.06%`** | **+2.34 pp** |
| Opus avg uncached input / call | `7,149` | **`4,606`** | **-35.6%** |
| Opus within-5m miss rate (`>15K` inp) | `8.60%` (`125` calls / `5.64M` inp) | **`3.81%`** (`8` calls / `143K` inp) | **-55.7% relative** |
| Stale live-image cache-freeze misses | `91` calls (`4.28M` inp, `75.9%` of 5m miss inp) | **`0`** | **-100% eliminated** |
| Opus `memory` calls | `104` (`594K` inp / `16.8K` out) | **`0`** (routed to DeepSeek Flash) | **-100% off Opus** |
| Opus `image` OCR calls | `5` (`15.1K` inp / `2.3K` out) | **`0`** (routed to non-Claude OCR model) | **-100% off Opus** |
| Opus `compaction` calls | `52` (`4.13M` total tokens) | `2` condenses (steward on Flash) | Steward moved off Opus |
| Haiku `optchat` (`other`) | `200` calls / `580.6K` out (`2,903` out/call) | **`0`** | **-100% off Haiku** |

### 2026-11-26 — ChatGPT `gpt-6.1-sol` prompt-cache affinity (`openai-completions` → `openai-responses`)

**Root cause:**
- `chatgpt/*` models run on the Codex Responses backend (`/v1/responses`), which uses `session_id` (populated from `prompt_cache_key` by the gateway) for sticky KV-cache shard routing.
- Calling them through `api: openai-completions` on a non-`api.openai.com` proxy omits `prompt_cache_key`, causing the gateway to generate a random `uuid_v4()` `session_id` on every step and spray consecutive steps across cold replicas (`55.4%` zero-cache calls).
- Switching the `chatgpt/*` route to a `gateway-responses` provider with `api: openai-responses` makes `dsh-llm-pi-ai` send `prompt_cache_key: <sessionId>` natively; verified with 6 consecutive probes (`0/7238`, then `7040/7238` × 5 = `97.3%` hit).

**Baseline (24h before switch, `api: openai-completions`):**

| Metric (`gpt-6.1-sol`) | Baseline 24h (`openai-completions`) | Target (`openai-responses`) |
|---|---:|---|
| Turn calls | `287` | — |
| Cache hit ratio | `32.58%` (`10.44M` / `32.05M`) | `> 90%` |
| Avg uncached input / call | `75,302` (`21.61M` total) | `< 10,000` |
| Zero-cache calls (`cacheRead = 0`) | `159 / 287` (`55.4%`) | `< 10%` (mostly >5m idle gaps) |

### Next Run Template

After 24 hours on `377d98a0` (or after changing a Bot's primary model / pruning tools), append a new section with the `diff` output from `ds-bot/dev/usage-benchmark.mjs`.
