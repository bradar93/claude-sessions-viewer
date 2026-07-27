#!/usr/bin/env node
// Claude config sync — mirrors ~/.claude into a git repo and back, rewriting
// absolute paths through named root tokens so the same sessions, memories and
// settings resume cleanly on a machine that keeps its repos somewhere else.
//
//   node sync.js init --repo <dir> --root PROJECTS=D:/projects
//   node sync.js export | import | status | push | pull
//   node sync.js                       (= pull + import + export + push)

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const CLAUDE_DIR = process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
const CLAUDE_JSON = path.join(os.homedir(), ".claude.json");
const CONFIG_FILE = path.join(CLAUDE_DIR, "sync.config.json");

// Everything outside projects/ that is worth carrying between machines. The
// rest of ~/.claude is caches, credentials and per-boot state.
const CONFIG_ITEMS = [
  "CLAUDE.md",
  "settings.json",
  ".mcp.json",
  "statusline-command.sh",
  "skills",
  "hooks",
  "agents",
  "commands",
  "output-styles",
  "plugins/installed_plugins.json",
  "plugins/known_marketplaces.json",
];

// Fields of ~/.claude.json that describe intent rather than machine state.
const CLAUDE_JSON_PROJECT_KEYS = [
  "allowedTools", "mcpServers", "mcpContextUris",
  "enabledMcpjsonServers", "disabledMcpjsonServers", "hasTrustDialogAccepted",
];

// Extensions we rewrite paths inside. Anything else is copied byte-for-byte.
// "" covers extensionless hook scripts.
const TEXT_EXT = new Set([
  "", ".jsonl", ".json", ".md", ".txt", ".sh", ".bash", ".ps1", ".py",
  ".js", ".mjs", ".cjs", ".ts", ".yaml", ".yml", ".toml", ".cfg", ".ini",
]);

// ---- config ----------------------------------------------------------------
const DEFAULTS = {
  repo: "",
  roots: {},        // TOKEN -> absolute path on this machine
  sessions: true,
  memory: true,
  claudeJson: true,
  maxFileMB: 90,    // GitHub rejects blobs over 100MB
  sinceDays: 0,     // 0 = every session, N = only ones touched in N days
  projectMap: {},   // portable cwd -> absolute path here; beats every guess
  scanRoots: [],    // where to look for checkouts; defaults to roots minus HOME
  scanDepth: 4,
};

function loadConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
  catch { die(`No sync config. Run:\n  node sync.js init --repo <dir> --root PROJECTS=${path.join(os.homedir(), "projects").replace(/\\/g, "/")}`); }
  cfg = { ...DEFAULTS, ...cfg };
  if (!cfg.repo) die("sync.config.json has no repo path.");
  return cfg;
}

// Longest local path first, so a root nested inside another still wins.
function rootPairs(cfg) {
  return Object.entries(cfg.roots)
    .map(([tok, p]) => ({ tok, local: path.resolve(p) }))
    .sort((a, b) => b.local.length - a.local.length);
}

// ---- path rewriting --------------------------------------------------------
// A path segment: no whitespace, quotes, separators or bracket/punctuation that
// would normally terminate a path in prose or code. Paths containing spaces are
// left absolute rather than half-rewritten.
const SEG = `[^\\s"'\`\\\\/,;:*?<>|()\\[\\]{}]+`;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// D:/projects -> /D:[\\/]projects/ so it matches "\", "/" and either casing.
// Exactly one separator, never a run: a transcript that quotes a JSON file full
// of "C:\\Users\\..." must round-trip verbatim, not get its escaping collapsed.
function rootRe(local) {
  return local.split(/[\\/]+/).map(escapeRe).join("[\\\\/]");
}

function toPortable(s, pairs) {
  for (const { tok, local } of pairs) {
    const re = new RegExp(rootRe(local) + `((?:[\\\\/]${SEG})*)`, "gi");
    s = s.replace(re, (_m, tail) => `{${tok}}` + tail.replace(/\\/g, "/"));
  }
  return s;
}

function toLocal(s, pairs) {
  for (const { tok, local } of pairs) {
    const re = new RegExp(escapeRe(`{${tok}}`) + `((?:\\/${SEG})*)`, "g");
    s = s.replace(re, (_m, tail) => local + tail.split("/").join(path.sep));
  }
  return s;
}

function mapStrings(v, fn) {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[fn(k)] = mapStrings(v[k], fn);
    return out;
  }
  return v;
}

// JSON files are rewritten through the parser so backslash escaping stays the
// responsibility of JSON.stringify rather than of our regexes.
function transform(text, file, fn) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jsonl") {
    return text.split("\n").map((line) => {
      if (!line.trim()) return line;
      try { return JSON.stringify(mapStrings(JSON.parse(line), fn)); } catch { return fn(line); }
    }).join("\n");
  }
  if (ext === ".json") {
    try { return JSON.stringify(mapStrings(JSON.parse(text), fn), null, 2) + "\n"; } catch { return fn(text); }
  }
  return fn(text);
}

// ~/.claude/projects dir names are the cwd with / \ : . all folded to "-".
function slugify(cwd) { return cwd.replace(/[\\/:.]/g, "-"); }

// ---- copying ---------------------------------------------------------------
const stats = { written: 0, same: 0, skipped: [] };

function copyFile(src, dst, fn, cfg, opts = {}) {
  let st;
  try { st = fs.statSync(src); } catch { return; }
  if (st.size > cfg.maxFileMB * 1024 * 1024) {
    stats.skipped.push(`${src} (${(st.size / 1048576).toFixed(0)}MB > maxFileMB)`);
    return;
  }
  if (opts.sinceDays && st.mtimeMs < Date.now() - opts.sinceDays * 86400000) return;

  const ext = path.extname(src).toLowerCase();
  let data;
  if (TEXT_EXT.has(ext)) {
    data = Buffer.from(transform(fs.readFileSync(src, "utf8"), src, fn), "utf8");
  } else {
    data = fs.readFileSync(src);
  }
  try {
    const cur = fs.readFileSync(dst);
    if (cur.equals(data)) { stats.same++; return; }
    // Sessions are append-only. A shorter incoming copy means the destination
    // has lines the source has not seen yet — writing it would drop them.
    if (ext === ".jsonl" && cur.length > data.length) {
      stats.skipped.push(`${path.basename(dst)} (destination has newer turns)`);
      return;
    }
  } catch {}
  if (DRY) { stats.written++; log(`  + ${path.relative(cfg.repo, dst) || dst}`); return; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, data);
  stats.written++;
}

function copyTree(src, dst, fn, cfg, opts = {}) {
  let entries;
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d, fn, cfg, opts);
    else if (e.isFile()) copyFile(s, d, fn, cfg, opts);
  }
}

// ---- project discovery -----------------------------------------------------
// The projects/ dir name is lossy (- stands in for / \ : and .), so recover the
// real cwd from ~/.claude.json's project map or from a session's own cwd field.
function resolveCwd(slug, dir) {
  try {
    const keys = Object.keys(JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")).projects || {});
    const hit = keys.find((k) => slugify(k) === slug);
    if (hit) return path.resolve(hit);
  } catch {}
  for (const f of safeReaddir(dir).filter((f) => f.endsWith(".jsonl"))) {
    const head = fs.readFileSync(path.join(dir, f), "utf8").split("\n", 40);
    for (const line of head) {
      try { const o = JSON.parse(line); if (o && typeof o.cwd === "string") return path.resolve(o.cwd); } catch {}
    }
  }
  return null;
}

function safeReaddir(p) { try { return fs.readdirSync(p); } catch { return []; } }

// ---- repo identity ---------------------------------------------------------
// A checkout's origin URL survives moving machines, so it is a far better
// handle on "the same repo" than the absolute path ever is.
function gitRemote(dir) {
  try {
    return execFileSync("git", ["-C", dir, "remote", "get-url", "origin"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}

// git@github.com:Qweebi/x.git and https://github.com/Qweebi/x are one repo.
function normRemote(url) {
  if (!url) return null;
  const s = url.trim().replace(/^git\+/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  let m = s.match(/^[\w.+-]+@([^:]+):(.+)$/);            // scp-style
  if (m) return `${m[1]}/${m[2]}`.toLowerCase();
  m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
  if (m) return `${m[1].replace(/:\d+$/, "")}/${m[2]}`.toLowerCase();
  return s.toLowerCase();
}

// Index every checkout under the scan roots by origin. Descent stops at a
// repo boundary, so this is cheap even over a large projects tree.
function scanCheckouts(cfg) {
  const roots = cfg.scanRoots.length
    ? cfg.scanRoots
    : Object.entries(cfg.roots).filter(([t]) => t !== "HOME").map(([, p]) => p);
  const index = new Map();
  const seen = new Set();
  const walk = (dir, depth) => {
    const key = dir.toLowerCase();
    if (depth > cfg.scanDepth || seen.has(key)) return;
    seen.add(key);
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => e.name === ".git")) {
      const r = normRemote(gitRemote(dir));
      if (r) { if (!index.has(r)) index.set(r, []); index.get(r).push(dir); }
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const r of roots) walk(path.resolve(r), 1);
  return index;
}

// Where does this exported project live on *this* machine? Explicit mapping
// wins, then origin URL, then plain root substitution.
function resolveProject(meta, cfg, fn, index) {
  const override = cfg.projectMap[meta.cwd] || cfg.projectMap[meta.slug];
  if (override) return { dir: path.resolve(override), how: "override" };

  const hits = meta.remote ? index.get(meta.remote) : null;
  if (hits && hits.length === 1) return { dir: hits[0], how: "origin" };
  if (hits && hits.length > 1) {
    // Duplicate checkouts and worktrees share an origin. Break the tie on the
    // trailing path, which is what distinguished them on the other machine.
    const want = "/" + meta.cwd.replace(/^\{[^}]+\}[\\/]/, "").toLowerCase();
    const exact = hits.find((h) => h.replace(/\\/g, "/").toLowerCase().endsWith(want));
    if (exact) return { dir: exact, how: "origin+path" };
  }

  if (meta.cwd) {
    const local = fn(meta.cwd);
    if (!/\{[A-Z0-9_]+\}/.test(local)) {
      return { dir: path.resolve(local), how: hits ? "roots (origin ambiguous)" : "roots" };
    }
  }
  return { dir: null, how: "unresolved" };
}

function repoProjectDir(cfg, name) { return path.join(cfg.repo, "projects", name); }

function resolveAll(cfg, fn, index) {
  const out = [];
  for (const name of safeReaddir(path.join(cfg.repo, "projects"))) {
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(repoProjectDir(cfg, name), "project.json"), "utf8")); } catch { continue; }
    out.push({ name, meta, ...resolveProject(meta, cfg, fn, index) });
  }
  // Two checkouts on the exporting machine can share one on this machine — a
  // duplicate clone that was never made here. Merging their transcripts into a
  // single directory would be silent history corruption, so only the closest
  // match keeps the slot and the rest ask to be pinned.
  const claimed = new Map();
  for (const p of out) {
    if (!p.dir) continue;
    const key = p.dir.toLowerCase();
    const prev = claimed.get(key);
    if (!prev) { claimed.set(key, p); continue; }
    const loser = p.how === "origin+path" && prev.how !== "origin+path" ? prev : p;
    if (loser === prev) claimed.set(key, p);
    loser.collision = claimed.get(key);
    loser.dir = null;
    loser.how = "collision";
  }
  return out;
}

// `sync.js projects` — show how every exported project maps onto this machine.
function doProjects(cfg) {
  const pairs = rootPairs(cfg);
  const index = scanCheckouts(cfg);
  log(`${index.size} checkout(s) indexed by origin\n`);
  for (const { meta, dir, how, collision } of resolveAll(cfg, (s) => toLocal(s, pairs), index)) {
    const ok = collision ? "DUP " : dir && fs.existsSync(dir) ? "ok  " : dir ? "MISS" : "??  ";
    log(`${ok} ${meta.cwd || meta.slug}`);
    log(collision
      ? `     -> collides with ${collision.meta.cwd} at ${collision.dir}`
      : `     -> ${dir || "(unresolved)"}   [${how}]`);
    if (meta.remote) log(`     origin ${meta.remote}`);
  }
  log(`\nMISS = resolved to a path that is not here. Pin it in ${CONFIG_FILE}:`);
  log(`  "projectMap": { "{PROJECTS}/some/repo": "/actual/path/here" }`);
}

// {PROJECTS}/qweebi/site -> PROJECTS_qweebi_site
function repoName(portableCwd) {
  return portableCwd.replace(/[{}]/g, "").replace(/^[\\/]+/, "").replace(/[\\/:*?"<>|]/g, "_");
}

// ---- export ----------------------------------------------------------------
function doExport(cfg) {
  const pairs = rootPairs(cfg);
  const fn = (s) => toPortable(s, pairs);

  log("config:");
  for (const item of CONFIG_ITEMS) {
    const src = path.join(CLAUDE_DIR, item), dst = path.join(cfg.repo, item);
    let st; try { st = fs.statSync(src); } catch { continue; }
    if (st.isDirectory()) copyTree(src, dst, fn, cfg);
    else copyFile(src, dst, fn, cfg);
  }

  if (cfg.claudeJson) exportClaudeJson(cfg, fn);

  if (cfg.sessions || cfg.memory) {
    log("projects:");
    const projectsDir = path.join(CLAUDE_DIR, "projects");
    for (const slug of safeReaddir(projectsDir)) {
      const dir = path.join(projectsDir, slug);
      if (!fs.statSync(dir).isDirectory()) continue;
      const cwd = resolveCwd(slug, dir);
      // cwd null means the slug could not be decoded back to a real path; the
      // slug itself is then the only thing worth carrying, and import restores
      // it verbatim rather than re-deriving a wrong one.
      const portable = cwd ? fn(cwd.replace(/\\/g, "/")) : null;
      const out = path.join(cfg.repo, "projects", repoName(portable || slug));

      if (!DRY) {
        fs.mkdirSync(out, { recursive: true });
        const meta = { cwd: portable, slug, remote: cwd ? normRemote(gitRemote(cwd)) : null };
        // Keep a remote recorded by another machine if this one can no longer
        // see the checkout — losing it would downgrade future resolution.
        if (!meta.remote) {
          try { meta.remote = JSON.parse(fs.readFileSync(path.join(out, "project.json"), "utf8")).remote || null; } catch {}
        }
        fs.writeFileSync(path.join(out, "project.json"), JSON.stringify(meta, null, 2) + "\n");
      }
      if (cfg.memory) copyTree(path.join(dir, "memory"), path.join(out, "memory"), fn, cfg);
      if (cfg.sessions) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === "memory") continue;
          const s = path.join(dir, e.name), d = path.join(out, "sessions", e.name);
          if (e.isDirectory()) copyTree(s, d, fn, cfg, { sinceDays: cfg.sinceDays });
          else copyFile(s, d, fn, cfg, { sinceDays: cfg.sinceDays });
        }
      }
    }
  }
  report("export", cfg.repo);
}

function exportClaudeJson(cfg, fn) {
  let j; try { j = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")); } catch { return; }
  const projects = {};
  for (const [k, v] of Object.entries(j.projects || {})) {
    const picked = {};
    for (const key of CLAUDE_JSON_PROJECT_KEYS) if (v && v[key] !== undefined) picked[key] = v[key];
    if (Object.keys(picked).length) projects[fn(k.replace(/\\/g, "/"))] = picked;
  }
  const out = mapStrings({ mcpServers: j.mcpServers || {}, projects }, fn);
  const dst = path.join(cfg.repo, "claude-json.partial.json");
  const data = Buffer.from(JSON.stringify(out, null, 2) + "\n", "utf8");
  try { if (fs.readFileSync(dst).equals(data)) { stats.same++; return; } } catch {}
  if (!DRY) { fs.mkdirSync(cfg.repo, { recursive: true }); fs.writeFileSync(dst, data); }
  stats.written++;
}

// ---- import ----------------------------------------------------------------
function doImport(cfg) {
  const pairs = rootPairs(cfg);
  const fn = (s) => toLocal(s, pairs);

  log("config:");
  for (const item of CONFIG_ITEMS) {
    const src = path.join(cfg.repo, item), dst = path.join(CLAUDE_DIR, item);
    let st; try { st = fs.statSync(src); } catch { continue; }
    if (st.isDirectory()) copyTree(src, dst, fn, cfg);
    else copyFile(src, dst, fn, cfg);
  }

  if (cfg.claudeJson) importClaudeJson(cfg, fn);

  log("projects:");
  const index = scanCheckouts(cfg);
  for (const { name, meta, dir, how, collision } of resolveAll(cfg, fn, index)) {
    if (collision) {
      stats.skipped.push(`${meta.cwd || meta.slug} (would land on the same directory as ${collision.meta.cwd} — pin it in projectMap)`);
      continue;
    }
    let dstSlug;
    if (dir) {
      dstSlug = slugify(dir);
      if (!fs.existsSync(dir)) log(`  ! ${meta.cwd || meta.slug}\n      -> ${dir} (via ${how}) does not exist here`);
    } else if (meta.slug) {
      dstSlug = meta.slug;              // cwd was never decodable; keep it as-is
    } else {
      stats.skipped.push(`${name} (unresolved)`);
      continue;
    }
    if (dstSlug.includes("..") || /[\\/]/.test(dstSlug)) { stats.skipped.push(`${name} (bad slug)`); continue; }
    const dst = path.join(CLAUDE_DIR, "projects", dstSlug);
    if (cfg.memory) copyTree(path.join(repoProjectDir(cfg, name), "memory"), path.join(dst, "memory"), fn, cfg);
    if (cfg.sessions) copyTree(path.join(repoProjectDir(cfg, name), "sessions"), dst, fn, cfg);
  }
  report("import", CLAUDE_DIR);
  if (stats.written) log("\nRestart Claude Code so it picks up the imported config.");
}

function importClaudeJson(cfg, fn) {
  let inc; try { inc = JSON.parse(fs.readFileSync(path.join(cfg.repo, "claude-json.partial.json"), "utf8")); } catch { return; }
  let j; try { j = JSON.parse(fs.readFileSync(CLAUDE_JSON, "utf8")); } catch { return; }
  j.mcpServers = { ...(j.mcpServers || {}), ...mapStrings(inc.mcpServers || {}, fn) };
  j.projects = j.projects || {};
  for (const [k, v] of Object.entries(inc.projects || {})) {
    const localKey = fn(k);
    if (/\{[A-Z0-9_]+\}/.test(localKey)) continue;
    j.projects[localKey] = { ...(j.projects[localKey] || {}), ...mapStrings(v, fn) };
  }
  if (DRY) { stats.written++; log("  + ~/.claude.json (mcpServers + project trust)"); return; }
  fs.copyFileSync(CLAUDE_JSON, CLAUDE_JSON + ".bak-sync");
  fs.writeFileSync(CLAUDE_JSON, JSON.stringify(j, null, 2) + "\n");
  stats.written++;
}

// ---- git -------------------------------------------------------------------
function git(cfg, ...args) {
  return execFileSync("git", args, { cwd: cfg.repo, encoding: "utf8" }).trim();
}

function hasRemote(cfg) {
  try { return git(cfg, "remote").length > 0; } catch { return false; }
}

function doPush(cfg) {
  doExport(cfg);
  git(cfg, "add", "-A");
  let staged = "";
  try { staged = git(cfg, "diff", "--cached", "--name-only"); } catch {}
  if (!staged) { log("\nNothing to commit."); return; }
  git(cfg, "commit", "-m", `sync from ${os.hostname()}`);
  if (!hasRemote(cfg)) { log("\nCommitted. No git remote configured — add one to push."); return; }
  log(git(cfg, "push"));
  log("\nPushed.");
}

function doPull(cfg) {
  if (hasRemote(cfg)) log(git(cfg, "pull", "--rebase"));
  doImport(cfg);
}

function doStatus(cfg) {
  DRY = true;
  log("=== would export ===");
  doExport(cfg);
  Object.assign(stats, { written: 0, same: 0, skipped: [] });
  log("\n=== would import ===");
  doImport(cfg);
  try { const s = git(cfg, "status", "--short"); log("\n=== git ===\n" + (s || "clean")); } catch {}
}

// ---- init ------------------------------------------------------------------
const GITIGNORE = `# Machine-local, never sync these
.credentials.json
sync.config.json
*.bak-sync
.DS_Store
`;

// Transcripts must survive a checkout byte-for-byte, so no eol translation.
const GITATTRIBUTES = `* -text
`;

const README = `# claude-config

Synced Claude Code config, skills, memories and sessions.
Managed by \`node sync.js\` from claude-sessions-viewer.

Paths are stored as \`{TOKEN}/...\` and resolved per machine via
\`~/.claude/sync.config.json\`. **Keep this repo private** — sessions contain
your full conversation history.
`;

function doInit(argv) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch {}
  cfg = { ...DEFAULTS, ...cfg };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo" && argv[i + 1]) cfg.repo = path.resolve(argv[++i]);
    else if (argv[i] === "--root" && argv[i + 1]) {
      const [tok, ...rest] = argv[++i].split("=");
      cfg.roots[tok.toUpperCase()] = path.resolve(rest.join("="));
    }
  }
  if (!cfg.repo) die("init needs --repo <dir>");
  if (!cfg.roots.HOME) cfg.roots.HOME = os.homedir();

  fs.mkdirSync(cfg.repo, { recursive: true });
  if (!fs.existsSync(path.join(cfg.repo, ".git"))) {
    execFileSync("git", ["init", "-q"], { cwd: cfg.repo });
    log(`git init ${cfg.repo}`);
  }
  for (const [f, body] of [[".gitignore", GITIGNORE], [".gitattributes", GITATTRIBUTES], ["README.md", README]]) {
    const p = path.join(cfg.repo, f);
    if (!fs.existsSync(p)) fs.writeFileSync(p, body);
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n");

  log(`\nWrote ${CONFIG_FILE}`);
  for (const [t, p] of Object.entries(cfg.roots)) log(`  {${t}} -> ${p}`);
  log(`\nNext:\n  node sync.js export\n  cd ${cfg.repo} && git add -A && git commit -m init`);
  log(`  gh repo create claude-config --private --source=. --push`);
}

// ---- cli -------------------------------------------------------------------
let DRY = false;
function log(s) { process.stdout.write(s + "\n"); }
function die(msg) { process.stderr.write(msg + "\n"); process.exit(1); }

function report(what, dest) {
  log(`\n${what}: ${stats.written} file(s) ${DRY ? "would change" : "written"}, ${stats.same} unchanged -> ${dest}`);
  for (const s of stats.skipped) log(`  skipped: ${s}`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "sync";
  DRY = argv.includes("--dry");

  if (cmd === "init") return doInit(argv);
  if (cmd === "help" || argv.includes("-h") || argv.includes("--help")) {
    return log(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 9).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  }

  const cfg = loadConfig();
  if (cmd === "export") return doExport(cfg);
  if (cmd === "import") return doImport(cfg);
  if (cmd === "status") return doStatus(cfg);
  if (cmd === "projects") return doProjects(cfg);
  if (cmd === "push") return doPush(cfg);
  if (cmd === "pull") return doPull(cfg);
  if (cmd === "sync") { doPull(cfg); Object.assign(stats, { written: 0, same: 0, skipped: [] }); return doPush(cfg); }
  die(`Unknown command "${cmd}". Try: init, export, import, status, projects, push, pull, sync`);
}

main();
