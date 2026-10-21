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

`sync.js` mirrors `~/.claude` into a zip archive and back, so
sessions, memories, skills, hooks and settings follow you between computers —
even when the repos live at different absolute paths on each one.

> **Never commit or publish the archive.** It holds your full conversation
> history: every prompt, every file you have had open, anything that ever
> appeared in tool output. `claude-data/` and `*.zip` are gitignored here.

### Setup (once per machine)

```bash
node sync.js init --repo ./claude-data --zip ~/OneDrive/claude-data.zip --root PROJECTS=D:/projects
node sync.js push
```

`--root NAME=path` declares a portable root. Everything under `D:/projects` is
stored as `{PROJECTS}/...`; on your laptop you point `{PROJECTS}` at
`/Users/you/code` and the same sessions resume there. `{HOME}` is added
automatically. Machine-specific config lives in `~/.claude/sync.config.json`
and is never committed.

`--repo` is an unpacked staging directory; `--zip` is the archive you carry
between machines (defaults to `<repo>.zip`). Point it at a folder a cloud drive
already syncs, or copy it across by hand.

### Day to day

Everything is reachable from the app — `node server.js`, then **Sync** in the
header. The panel shows what is stored, how each project maps onto this
machine, and when the archive was last written, with buttons for unzip-and-import,
export-to-zip, or both. A dot on the button means no archive has been written yet. The same operations from the terminal:

```bash
node sync.js            # unzip + import + export + zip
node sync.js status     # dry run: what would change, both directions
node sync.js projects   # how each project maps onto this machine
node sync.js state      # the same, as JSON (what the app's panel consumes)
node sync.js push       # ~/.claude -> claude-data/ -> zip
node sync.js pull       # zip -> claude-data/ -> ~/.claude
node sync.js export     # ~/.claude -> claude-data/
node sync.js import     # claude-data/ -> ~/.claude
```

### How a project is matched across machines

Export records each project's `origin` URL alongside its portable path, so a
repo is identified by what it *is* rather than only by where it sits. On import,
in order:

1. **`projectMap`** — an explicit pin in `sync.config.json`. Always wins.
2. **Origin URL**, when exactly one local checkout has it. Normalised, so
   `git@github.com:Qweebi/x.git` matches `https://github.com/Qweebi/x`. This is
   what survives a machine that nests or names its checkouts differently.
3. **Origin URL + trailing path**, when several checkouts share an origin —
   duplicate clones and worktrees are common, so the one whose tail matches the
   exporting machine's path wins.
4. **Root substitution** — `{PROJECTS}/qweebi/x` under this machine's
   `{PROJECTS}`. The fallback when there is no origin or no local clone.

`node sync.js projects` prints the whole table:

```
ok   {PROJECTS}/qweebi/qweebi-website
     -> /Users/you/code/site   [origin]
     origin github.com/qweebi/qweebi-website
MISS {PROJECTS}/qweebi/dashboard
     -> /Users/you/code/qweebi/dashboard   [roots]
DUP  {PROJECTS}/qweebi/qweebi-website-tmp/qweebi-website
     -> collides with {PROJECTS}/qweebi/qweebi-website at /Users/you/code/site
```

`MISS` means the resolved path is not on this machine — harmless, but those
sessions stay invisible until you clone the repo or pin it. `DUP` means two
exported projects resolve to one local directory; import **skips** the loser
rather than merge two session histories into it. Both are fixed the same way:

```json
"projectMap": { "{PROJECTS}/qweebi/qweebi-website-tmp/qweebi-website": "/Users/you/code/site-tmp" }
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
| `zip` | `<repo>.zip` | the archive carried between machines |
| `maxFileMB` | `90` | skip transcripts larger than this |
| `projectMap` | `{}` | portable cwd → absolute path here; beats every guess |
| `scanRoots` | roots minus `HOME` | where to look for checkouts to match by origin |
| `scanDepth` | `4` | how deep that scan descends before giving up |

### Caveats

- Paths containing spaces are left absolute rather than half-rewritten.
- Path *spelling* inside transcripts is normalised to the local separator, so
  `D:/projects/x` reappears as `D:\projects\x` on Windows. Same path, and
  round-tripping is otherwise byte-exact.
- Sessions are treated as append-only: import refuses to overwrite a local
  transcript that is longer than the incoming one.
- **Never commit the archive.** It contains your full session history.
- On Linux, `zip`/`unzip` must be installed; Windows and macOS use the built-in `tar`.

## How it works

`server.js` is a plain Node HTTP server (no dependencies, no build step). It reads
the `.jsonl` transcripts, extracts metadata (caching per file by mtime), and serves
three JSON endpoints consumed by `public/index.html`:

- `GET /api/projects` — repos and their sessions
- `GET /api/search?q=` — full-text search across transcript content
- `GET /api/session?project=&id=` — one rendered transcript
- `GET /api/refresh` — clear the metadata cache and rescan
- `GET /api/sync/state` — sync standing and per-project resolution
- `GET /api/sync/run?op=` — run a sync operation, returns its log

`sync.js` runs as a child process rather than in-process: exporting 200MB would
block the event loop for seconds, and a child hands back its output for free.
