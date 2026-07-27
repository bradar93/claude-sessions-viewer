# Claude Sessions Viewer

A local, zero-dependency web tool for finding and resuming Claude Code sessions
across all your repos. Points at your `~/.claude/projects` folder, indexes every
session transcript, and lets you browse and search across repos.

## Run

```bash
node server.js
```

Then open http://localhost:4317.

By default it scans `~/.claude/projects`. Override with:

```bash
node server.js --dir "C:\Users\you\.claude\projects" --port 4317
# or
CLAUDE_DIR="/path/to/.claude/projects" node server.js
```

## What it does

- **Left rail** lists every repo with session count, last-active time, and full
  disk path. Repos that share a name (duplicate checkouts) are badged with the
  distinguishing path segment so you can tell them apart.
- **Session ledger** shows each session by its first typed prompt, with relative
  time, git branch, message count, size, model, and short id. Newest first.
- **Two search modes:**
  - *Titles* — instant client-side filter on title, repo, and branch.
  - *Full text* — server-side search inside transcript content (message text and
    tool output, not the JSON envelope), with highlighted snippets and a match
    count per session.
- **Transcript drawer** opens on click: the rendered conversation plus a
  one-click copyable resume command, `cd "<cwd>" && claude --resume <id>`.

## Keyboard

| Key | Action |
| --- | --- |
| `/` | Focus search |
| `↑` / `↓` | Move row selection |
| `Enter` | Open selected session |
| `c` | Copy resume command (drawer open) |
| `Esc` | Close drawer, or clear search |

## Syncing across machines (`sync.js`)

`sync.js` mirrors `~/.claude` into a git repo and back, so sessions, memories,
skills, hooks and settings follow you between computers — even when the repos
live at different absolute paths on each one.

### Setup (once per machine)

```bash
node sync.js init --repo ~/claude-config --root PROJECTS=D:/projects
cd ~/claude-config && gh repo create claude-config --private --source=. --push
```

`--root NAME=path` declares a portable root. Everything under `D:/projects` is
stored in the repo as `{PROJECTS}/...`; on your laptop you point `{PROJECTS}`
at `/Users/you/code` and the same sessions resume there. `{HOME}` is added
automatically. Machine-specific config lives in `~/.claude/sync.config.json`
and is never committed.

### Day to day

```bash
node sync.js            # pull + import + export + commit + push
node sync.js status     # dry run: what would change, both directions
node sync.js export     # ~/.claude -> repo
node sync.js import     # repo -> ~/.claude
```

Run `import` with Claude Code closed, since it rewrites `~/.claude.json`
(backed up to `~/.claude.json.bak-sync` first).

### What travels

| Synced | Left alone |
| --- | --- |
| `CLAUDE.md`, `settings.json`, `.mcp.json`, `statusline-command.sh` | `.credentials.json` |
| `skills/`, `hooks/`, `agents/`, `commands/`, `output-styles/` | `cache/`, `shell-snapshots/`, `debug/`, `telemetry/` |
| `plugins/installed_plugins.json`, `plugins/known_marketplaces.json` | `plugins/cache/` (refetched on demand) |
| `projects/*/` sessions and sidecars | `sessions/`, `session-env/`, `file-history/` |
| `projects/*/memory/` | `history.jsonl` |
| `~/.claude.json`: `mcpServers` + per-project trust and tool allowlists | the rest of `~/.claude.json` (machine state, caches, oauth) |

### Knobs

`~/.claude/sync.config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `roots` | `{HOME: ...}` | token → absolute path on this machine |
| `sessions` | `true` | carry transcripts, not just config |
| `memory` | `true` | carry `projects/*/memory/` |
| `claudeJson` | `true` | merge MCP servers and project trust |
| `sinceDays` | `0` | `0` = all sessions, `30` = only recently touched |
| `maxFileMB` | `90` | skip blobs GitHub would reject |

### Caveats

- Paths containing spaces are left absolute rather than half-rewritten.
- Path *spelling* inside transcripts is normalised to the local separator, so
  `D:/projects/x` reappears as `D:\projects\x` on Windows. Same path, and
  round-tripping is otherwise byte-exact.
- Sessions are treated as append-only: import refuses to overwrite a local
  transcript that is longer than the incoming one.
- **Keep the config repo private.** It contains your full session history.

## How it works

`server.js` is a plain Node HTTP server (no dependencies, no build step). It reads
the `.jsonl` transcripts, extracts metadata (caching per file by mtime), and serves
three JSON endpoints consumed by `public/index.html`:

- `GET /api/projects` — repos and their sessions
- `GET /api/search?q=` — full-text search across transcript content
- `GET /api/session?project=&id=` — one rendered transcript
- `GET /api/refresh` — clear the metadata cache and rescan
