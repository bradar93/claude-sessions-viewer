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

## How it works

`server.js` is a plain Node HTTP server (no dependencies, no build step). It reads
the `.jsonl` transcripts, extracts metadata (caching per file by mtime), and serves
three JSON endpoints consumed by `public/index.html`:

- `GET /api/projects` — repos and their sessions
- `GET /api/search?q=` — full-text search across transcript content
- `GET /api/session?project=&id=` — one rendered transcript
- `GET /api/refresh` — clear the metadata cache and rescan
