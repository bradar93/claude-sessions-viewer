#!/usr/bin/env node
// Claude Session Browser — zero-dependency local web app.
// Points at a .claude/projects folder, indexes every session (.jsonl),
// and lets you browse / search across all repos.

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

// ---- config ----------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  let dir = null;
  let port = 4317;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--dir" || args[i] === "-d") && args[i + 1]) dir = args[++i];
    else if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) port = parseInt(args[++i], 10);
    else if (!args[i].startsWith("-") && !dir) dir = args[i];
  }
  dir = dir || process.env.CLAUDE_DIR;
  if (!dir) dir = path.join(os.homedir(), ".claude", "projects");
  return { dir, port };
}

const { dir: PROJECTS_DIR, port: PORT } = parseArgs();

// ---- session metadata index ------------------------------------------------
// Cache keyed by file path -> { mtimeMs, meta }
const metaCache = new Map();
// Searchable conversational content per file -> { mtimeMs, content }.
// Populated during buildMeta (same parse pass) so full-text search is an
// in-memory indexOf instead of re-parsing every transcript on each query.
const searchCache = new Map();

// Custom session titles, keyed by session id, persisted next to the server.
const ANNOTATIONS_FILE = path.join(__dirname, "annotations.json");
let annotations = {};
try { annotations = JSON.parse(fs.readFileSync(ANNOTATIONS_FILE, "utf8")); } catch { annotations = {}; }
function saveAnnotations() {
  try { fs.writeFileSync(ANNOTATIONS_FILE, JSON.stringify(annotations, null, 2)); } catch {}
}

// Soft-delete destination: a sibling of the projects dir so it is never scanned.
const TRASH_DIR = path.join(PROJECTS_DIR, "..", ".session-trash");

// A path segment is safe only if it can't escape its directory.
function safeSeg(s) {
  return typeof s === "string" && s.length > 0 && !s.includes("/") && !s.includes("\\") && !s.includes("..") && !s.includes("\0");
}

// Move a session file (and its subagents/tool-results sidecar dir) to trash.
function deleteSession(dirName, id) {
  if (!safeSeg(dirName) || !safeSeg(id)) return { error: "Invalid request." };
  const srcDir = path.join(PROJECTS_DIR, dirName);
  const file = path.join(srcDir, id + ".jsonl");
  if (!fs.existsSync(file)) return { error: "Session not found." };
  const destDir = path.join(TRASH_DIR, dirName);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.renameSync(file, path.join(destDir, id + ".jsonl"));
    const sidecar = path.join(srcDir, id); // subagents/, tool-results/ live here
    if (fs.existsSync(sidecar)) { try { fs.renameSync(sidecar, path.join(destDir, id)); } catch {} }
  } catch (e) {
    return { error: e.message };
  }
  metaCache.delete(file);
  searchCache.delete(file);
  return { ok: true };
}

// Move a soft-deleted session back out of trash (undo).
function restoreSession(dirName, id) {
  if (!safeSeg(dirName) || !safeSeg(id)) return { error: "Invalid request." };
  const trashDir = path.join(TRASH_DIR, dirName);
  const tf = path.join(trashDir, id + ".jsonl");
  if (!fs.existsSync(tf)) return { error: "Nothing to restore." };
  try {
    fs.renameSync(tf, path.join(PROJECTS_DIR, dirName, id + ".jsonl"));
    const sc = path.join(trashDir, id);
    if (fs.existsSync(sc)) { try { fs.renameSync(sc, path.join(PROJECTS_DIR, dirName, id)); } catch {} }
  } catch (e) {
    return { error: e.message };
  }
  return { ok: true };
}

function annotate(id, title) {
  if (!safeSeg(id)) return { error: "Invalid id." };
  const t = (title || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (t) annotations[id] = { title: t };
  else delete annotations[id];
  saveAnnotations();
  return { ok: true, title: t };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

// Strip framing the harness adds so titles read like what the user typed.
function cleanPrompt(text) {
  if (!text) return "";
  let t = text;
  t = t.replace(/<command-name>([\s\S]*?)<\/command-name>/g, "$1");
  t = t.replace(/<command-message>[\s\S]*?<\/command-message>/g, "");
  t = t.replace(/<command-args>[\s\S]*?<\/command-args>/g, "");
  t = t.replace(/<[^>]+>/g, " "); // drop any other tags
  return t.replace(/\s+/g, " ").trim();
}

function isNoisePrompt(text) {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("Caveat:")) return true;
  if (t.startsWith("See ya")) return true;
  return false;
}

// Pull "/command args" out of a slash-command invocation message.
function parseCommand(text) {
  const name = (text.match(/<command-name>([\s\S]*?)<\/command-name>/) || [])[1] || "";
  const args = (text.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || "";
  return (name.trim() + (args.trim() ? " " + args.trim() : "")).trim();
}

// Classify a transcript turn so the reader can foreground the real conversation
// (prompt/reply) and tuck away the plumbing (commands, system output, tools).
function classifyTurn(role, text, isMeta, isToolResult, hasTools) {
  const t = (text || "").trim();
  if (/<command-name>/.test(text || "")) return "command";
  if (isMeta) return "system";
  if (/<local-command-(stdout|stderr|caveat)>/.test(text || "")) return "system";
  if (t.startsWith("Caveat: The messages below")) return "system";
  if (role === "user") return isToolResult && !t ? "tool" : "prompt";
  return !t && hasTools ? "tool" : "reply";
}

function buildMeta(filePath, stat) {
  const id = path.basename(filePath, ".jsonl");
  const meta = {
    id,
    file: filePath,
    bytes: stat.size,
    mtime: stat.mtimeMs,
    title: "",
    cwd: "",
    gitBranch: "",
    version: "",
    firstTs: null,
    lastTs: null,
    userMessages: 0,
    assistantMessages: 0,
    typedPrompts: 0,
    model: "",
  };

  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return meta;
  }
  const lines = raw.split("\n");
  let fallbackTitle = "";
  const searchParts = []; // conversational content only, for full-text search
  for (const line of lines) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    // Collect searchable content: message text, tool names, tool-result text.
    // Excludes the JSON envelope (cwd, branch, ids) so searches match what was
    // actually said, not repeated per-line metadata.
    if ((obj.type === "user" || obj.type === "assistant") && obj.message) {
      const c = obj.message.content;
      if (typeof c === "string") searchParts.push(c);
      else if (Array.isArray(c)) {
        for (const bl of c) {
          if (!bl) continue;
          if (bl.type === "text") searchParts.push(bl.text);
          else if (bl.type === "tool_use") searchParts.push(bl.name || "");
          else if (bl.type === "tool_result") searchParts.push(extractText(bl.content) || (typeof bl.content === "string" ? bl.content : ""));
        }
      }
    }
    if (obj.cwd) meta.cwd = obj.cwd;
    if (obj.gitBranch) meta.gitBranch = obj.gitBranch;
    if (obj.version) meta.version = obj.version;
    if (obj.timestamp) {
      if (!meta.firstTs) meta.firstTs = obj.timestamp;
      meta.lastTs = obj.timestamp;
    }
    if (obj.type === "user" && obj.message && obj.message.role === "user") {
      const text = cleanPrompt(extractText(obj.message.content));
      const isToolResult =
        Array.isArray(obj.message.content) &&
        obj.message.content.some((b) => b && b.type === "tool_result");
      if (!obj.isMeta && !isToolResult) meta.userMessages++;
      if (obj.promptSource === "typed" && !isNoisePrompt(text)) {
        meta.typedPrompts++;
        if (!meta.title) meta.title = text.slice(0, 160);
      }
      if (!fallbackTitle && !obj.isMeta && !isToolResult && !isNoisePrompt(text)) {
        fallbackTitle = text.slice(0, 160);
      }
    } else if (obj.type === "assistant" && obj.message) {
      meta.assistantMessages++;
      if (!meta.model && obj.message.model) meta.model = obj.message.model;
    }
  }
  if (!meta.title) meta.title = fallbackTitle || "(no prompt text)";
  if (!meta.lastTs) meta.lastTs = new Date(stat.mtimeMs).toISOString();
  searchCache.set(filePath, { mtimeMs: stat.mtimeMs, content: searchParts.join("\n") });
  return meta;
}

// Searchable conversational text for a file, cached by mtime. buildMeta
// populates the cache during a normal scan, so this is usually a hash lookup;
// it only re-parses when a file is searched before it has been scanned.
function getSearchable(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return "";
  }
  const c = searchCache.get(filePath);
  if (c && c.mtimeMs === stat.mtimeMs) return c.content;
  buildMeta(filePath, stat); // side-effect: populates searchCache for this mtime
  const fresh = searchCache.get(filePath);
  return fresh ? fresh.content : "";
}

function getMeta(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const cached = metaCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.meta;
  const meta = buildMeta(filePath, stat);
  metaCache.set(filePath, { mtimeMs: stat.mtimeMs, meta });
  return meta;
}

// Decode the encoded folder name as a best-effort fallback path.
function decodeProjectName(name) {
  return name.replace(/^([A-Za-z])--/, "$1:\\").replace(/-/g, "\\");
}

function listProjects() {
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch (e) {
    return { error: `Cannot read ${PROJECTS_DIR}: ${e.message}`, projects: [] };
  }
  const projects = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const projDir = path.join(PROJECTS_DIR, ent.name);
    let files;
    try {
      files = fs.readdirSync(projDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    if (!files.length) continue;
    const sessions = [];
    let realPath = "";
    for (const f of files) {
      const meta = getMeta(path.join(projDir, f));
      if (!meta) continue;
      if (!realPath && meta.cwd) realPath = meta.cwd;
      const a = annotations[meta.id];
      sessions.push(a && a.title ? { ...meta, customTitle: a.title } : meta);
    }
    if (!sessions.length) continue;
    sessions.sort((a, b) => new Date(b.lastTs) - new Date(a.lastTs));
    projects.push({
      dirName: ent.name,
      path: realPath || decodeProjectName(ent.name),
      label: (realPath || decodeProjectName(ent.name)).split(/[\\/]/).pop(),
      sessionCount: sessions.length,
      lastActivity: sessions[0].lastTs,
      sessions,
    });
  }
  projects.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));
  return { dir: PROJECTS_DIR, projects };
}

// ---- full-text search across transcript content ---------------------------
function searchContent(query) {
  const q = query.toLowerCase();
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return { results: [] };
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const projDir = path.join(PROJECTS_DIR, ent.name);
    let files;
    try {
      files = fs.readdirSync(projDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = path.join(projDir, f);
      // Content-only (envelope excluded), cached by mtime — usually no I/O.
      const content = getSearchable(fp);
      if (!content) continue;
      const lower = content.toLowerCase();
      let idx = lower.indexOf(q);
      if (idx === -1) continue;
      const meta = getMeta(fp);
      const snippets = [];
      let total = 0;
      while (idx !== -1) {
        if (snippets.length < 3) {
          const start = Math.max(0, idx - 55);
          const end = Math.min(content.length, idx + q.length + 65);
          snippets.push(content.slice(start, end).replace(/\s+/g, " ").trim());
        }
        total++;
        idx = lower.indexOf(q, idx + q.length);
      }
      const a = annotations[meta.id];
      results.push({ ...meta, customTitle: a && a.title ? a.title : "", dirName: ent.name, matchCount: total, snippets });
    }
  }
  results.sort((a, b) => b.matchCount - a.matchCount || new Date(b.lastTs) - new Date(a.lastTs));
  return { query, results: results.slice(0, 200) };
}

// ---- session detail (rendered messages) ------------------------------------
function getSession(dirName, id) {
  const fp = path.join(PROJECTS_DIR, dirName, id + ".jsonl");
  let raw;
  try {
    raw = fs.readFileSync(fp, "utf8");
  } catch (e) {
    return { error: e.message };
  }
  const messages = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if ((obj.type !== "user" && obj.type !== "assistant") || !obj.message) continue;
    const role = obj.message.role;
    const content = obj.message.content;
    let text = "";
    const tools = [];
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (!b) continue;
        if (b.type === "text") text += (text ? "\n" : "") + b.text;
        else if (b.type === "tool_use") tools.push({ kind: "use", name: b.name });
        else if (b.type === "tool_result") {
          const t = extractText(b.content) || (typeof b.content === "string" ? b.content : "");
          // Keep enough so most search matches inside tool output render in the
          // drawer; the find-bar notes when matches fall beyond this cut.
          tools.push({ kind: "result", text: t.slice(0, 2000) });
        } else if (b.type === "thinking") tools.push({ kind: "thinking" });
      }
    }
    const isToolResult = Array.isArray(content) && content.some((b) => b && b.type === "tool_result");
    const kind = classifyTurn(role, text, !!obj.isMeta, isToolResult, tools.length > 0);
    // Nothing to show: empty turn with no tools.
    if (!text.trim() && !tools.length) continue;
    messages.push({
      role,
      kind,
      // Commands collapse to a slim "/name args" chip; system output is cleaned
      // of its tag wrapper; real conversation text passes through verbatim.
      text: kind === "system" ? cleanPrompt(text) : kind === "command" ? "" : text,
      cmd: kind === "command" ? parseCommand(text) : "",
      tools,
      ts: obj.timestamp || null,
      typed: obj.promptSource === "typed",
      isToolResult,
    });
  }
  const base = getMeta(fp);
  const a = annotations[id];
  const meta = a && a.title ? { ...base, customTitle: a.title } : base;
  return { meta, messages };
}

// ---- sync ------------------------------------------------------------------
// sync.js runs as a child rather than in-process: a 200MB export would block
// the event loop for seconds, and a child gives us its output for free.
const SYNC_JS = path.join(__dirname, "sync.js");
const SYNC_OPS = new Set(["state", "status", "export", "import", "push", "pull", "sync", "projects"]);

function runSync(op, cb) {
  if (!SYNC_OPS.has(op)) return cb(new Error("Unknown sync operation."), "");
  execFile(process.execPath, [SYNC_JS, op], { cwd: __dirname, maxBuffer: 16 * 1024 * 1024 },
    (err, stdout, stderr) => cb(err, (stdout || "") + (stderr || "")));
}

// ---- http server -----------------------------------------------------------
function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (p === "/" || p === "/index.html") {
      const html = fs.readFileSync(path.join(__dirname, "public", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (p === "/api/projects") return sendJson(res, listProjects());
    if (p === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return sendJson(res, { query: "", results: [] });
      return sendJson(res, searchContent(q));
    }
    if (p === "/api/session") {
      const d = url.searchParams.get("project");
      const id = url.searchParams.get("id");
      if (!d || !id) return sendJson(res, { error: "project and id required" });
      return sendJson(res, getSession(d, id));
    }
    if (p === "/api/refresh") {
      metaCache.clear();
      searchCache.clear();
      return sendJson(res, listProjects());
    }
    if (p === "/api/delete") {
      return sendJson(res, deleteSession(url.searchParams.get("project"), url.searchParams.get("id")));
    }
    if (p === "/api/restore") {
      return sendJson(res, restoreSession(url.searchParams.get("project"), url.searchParams.get("id")));
    }
    if (p === "/api/annotate") {
      return sendJson(res, annotate(url.searchParams.get("id"), url.searchParams.get("title") || ""));
    }
    if (p === "/api/sync/state") {
      return runSync("state", (err, out) => {
        if (err) return sendJson(res, { configured: false, error: out.trim() || err.message });
        try { return sendJson(res, { configured: true, ...JSON.parse(out) }); }
        catch { return sendJson(res, { configured: false, error: out.trim() }); }
      });
    }
    if (p === "/api/sync/run") {
      const op = url.searchParams.get("op") || "";
      return runSync(op, (err, out) => {
        // A failed sync still returns its log; that text is the whole diagnosis.
        metaCache.clear();
        searchCache.clear();
        sendJson(res, { ok: !err, op, output: out.trim() });
      });
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Error: " + e.message);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Claude Session Browser`);
  console.log(`  Scanning: ${PROJECTS_DIR}`);
  console.log(`  Open:     http://localhost:${PORT}\n`);
});
