import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, codeStamp, ensureBoardMetadata, readJson, servicePaths, stateDirectory } from "./board-registry.mjs";
import { canonicalSlot, loadQaProject, publicReviewData } from "./qa-core.mjs";
import { atomicWriteJson, readSavedState, reviewReady, sanitizeState } from "./review-state.mjs";

function argValue(name) {
  const index = process.argv.lastIndexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

const require = createRequire(import.meta.url);
const sharp = require("sharp");

// Gallery tiles must not be full-size masters: nine 2000px JPEGs are ~150 MB of
// decoded bitmap. Thumbnails are built the first time a sheet is opened — never
// while recording — and cached under the image's own hash, so they are computed
// once per image for the life of the project.
async function thumbnailFor(qaDir, filePath, sha256) {
  const target = path.join(qaDir, "thumbs", `${sha256}.jpg`);
  try {
    await fs.access(target);
    return target;
  } catch {
    // Not built yet.
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await sharp(filePath)
    .resize(480, 480, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 72, progressive: true })
    .toFile(temporary);
  await fs.rename(temporary, target);
  return target;
}

function mimeType(filePath) {
  return ({
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".avif": "image/avif",
  })[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function jsonResponse(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function requestJson(request, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const stateDir = stateDirectory(argValue("--state-dir"));
const paths = servicePaths(stateDir);
const preferredPort = Number(argValue("--port") || process.env.COMMERCE_QA_PORT || DEFAULT_PORT);
const serviceKey = argValue("--key") || randomBytes(24).toString("base64url");
const instanceId = randomUUID();
const host = "127.0.0.1";
const appPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/qa-review-app.html");
const appHtml = await fs.readFile(appPath);
await fs.mkdir(stateDir, { recursive: true });

let registry = await readJson(paths.registry, { version: 1, boards: {} });
if (!registry || typeof registry !== "object") registry = { version: 1, boards: {} };
if (!registry.boards || typeof registry.boards !== "object") registry.boards = {};
const boardQueues = new Map();
const eventStreams = new Map();
let registryQueue = Promise.resolve();

function boardUrl(board, port) {
  return `http://${host}:${port}/b/${encodeURIComponent(board.id)}/${encodeURIComponent(board.token)}/`;
}

function persistRegistry() {
  registryQueue = registryQueue.then(() => atomicWriteJson(paths.registry, registry));
  return registryQueue;
}

function withBoardQueue(boardId, task) {
  const previous = boardQueues.get(boardId) || Promise.resolve();
  const next = previous.then(task, task);
  const tracked = next.finally(() => {
    if (boardQueues.get(boardId) === tracked) boardQueues.delete(boardId);
  });
  boardQueues.set(boardId, tracked);
  return tracked;
}

function authorized(request) {
  return request.headers["x-commerce-qa-key"] === serviceKey;
}

function boardFromRoute(pathname) {
  const match = pathname.match(/^\/b\/([^/]+)\/([^/]+)\/(.*)$/);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  const token = decodeURIComponent(match[2]);
  const board = registry.boards[id];
  if (!board || board.token !== token) return null;
  return { board, relativePath: match[3] };
}

// A media request only needs one file path, but loading a project re-reads the
// manifest, re-hashes every image and re-runs preflight. Cache the loaded
// project and revalidate it with cheap stats: any touched file — including an
// image swapped underneath a recorded decision — changes mtime or size and
// forces a real reload, so stale detection keeps its guarantee.
const boardCache = new Map();

async function dependencyStamp(board, loaded) {
  const qaDir = path.join(board.projectRoot, ".image-change-qa");
  const files = [path.join(qaDir, "manifest.json"), path.join(qaDir, "truth.json")];
  for (const item of loaded.data.items) {
    if (item.beforePath) files.push(item.beforePath);
    files.push(item.afterPath);
    for (const reference of item.references) if (reference.kind === "image") files.push(reference.path);
  }
  const stamps = await Promise.all([...new Set(files)].sort().map(async (file) => {
    const stat = await fs.stat(file).catch(() => null);
    return `${file}:${stat ? `${stat.mtimeMs}:${stat.size}` : "-"}`;
  }));
  return stamps.join("|");
}

function scopeKey(board) {
  return `${board.roundFilter || ""}|${board.sourceFilter || ""}|${board.latestRound !== false}`;
}

// The board reviews one round; the gallery has to answer "does this product hold
// together", which spans every round. Cached and stat-revalidated like the board,
// so asking costs nothing after the first time.
function normalizeKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}


// Rounds disagree about which field identifies a product: one project kept the SKU
// stable while the name drifted, another did the reverse. Treat items as the same
// product when they agree on either, following the links transitively.
function groupIndex(items) {
  const parent = new Map();
  const find = (key) => {
    while (parent.get(key) !== key) {
      parent.set(key, parent.get(parent.get(key)));
      key = parent.get(key);
    }
    return key;
  };
  const add = (key) => { if (!parent.has(key)) parent.set(key, key); return key; };
  const union = (a, b) => { const ra = find(add(a)); const rb = find(add(b)); if (ra !== rb) parent.set(ra, rb); };

  for (const item of items) {
    const sku = `sku:${normalizeKey(item.sku)}`;
    const product = `product:${normalizeKey(item.product)}`;
    add(sku);
    add(product);
    if (normalizeKey(item.sku) && normalizeKey(item.product)) union(sku, product);
  }

  const groups = new Map();
  for (const item of items) {
    groups.set(item.id, find(add(normalizeKey(item.sku) ? `sku:${normalizeKey(item.sku)}` : `product:${normalizeKey(item.product)}`)));
  }
  return groups;
}

function productGallery(items) {
  const groups = groupIndex(items);
  const newest = new Map();
  for (const item of items) {
    const group = groups.get(item.id);
    const slot = canonicalSlot(item.slotKey || item.assetSlot || item.title);
    const key = `${group}|${slot}`;
    const stamp = String(item.recordedAt || item.createdAt || "");
    const previous = newest.get(key);
    if (!previous || stamp > previous.stamp) newest.set(key, { stamp, item: { ...item, group, assetSlot: slot } });
  }
  return [...newest.values()]
    .map(({ item }) => item)
    .sort((a, b) => String(a.assetSlot).localeCompare(String(b.assetSlot), undefined, { numeric: true }));
}

async function pruneThumbnails(board, loaded) {
  const directory = path.join(board.projectRoot, ".image-change-qa", "thumbs");
  const names = await fs.readdir(directory).catch(() => []);
  if (!names.length) return;
  const live = new Set(loaded.data.items.map((item) => `${item.afterSha256}.jpg`));
  for (const name of names) {
    if (!live.has(name)) await fs.rm(path.join(directory, name), { force: true }).catch(() => {});
  }
}

async function loadEveryRound(board) {
  const key = `${board.id}::all`;
  const cached = boardCache.get(key);
  if (cached && await dependencyStamp(board, cached.loaded) === cached.stamp) return cached.loaded;
  const loaded = await loadQaProject({ projectRoot: board.projectRoot });
  boardCache.set(key, { scope: "all", stamp: await dependencyStamp(board, loaded), loaded });
  // This load sees every item, so it is the only safe place to drop thumbnails whose
  // source image no longer exists in any round. They rebuild on demand if needed.
  pruneThumbnails(board, loaded).catch(() => {});
  return loaded;
}

async function loadBoard(board) {
  const cached = boardCache.get(board.id);
  let loaded = null;
  if (cached && cached.scope === scopeKey(board) && await dependencyStamp(board, cached.loaded) === cached.stamp) {
    loaded = cached.loaded;
  }
  if (!loaded) {
    loaded = await loadQaProject({
      projectRoot: board.projectRoot,
      roundFilter: board.roundFilter || null,
      latestRound: board.latestRound !== false && !board.roundFilter,
      sourceFilter: board.sourceFilter || null,
    });
    boardCache.set(board.id, { scope: scopeKey(board), stamp: await dependencyStamp(board, loaded), loaded });
  }
  const statePath = path.join(board.projectRoot, ".image-change-qa", "review-state.json");
  const { state, dropped } = await readSavedState(statePath, loaded);
  return { loaded, state, statePath, droppedReviews: dropped };
}

function notifyBoard(boardId, event = "board-updated") {
  const streams = eventStreams.get(boardId);
  if (!streams) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify({ boardId, at: new Date().toISOString() })}\n\n`;
  for (const stream of streams) stream.write(payload);
}

async function registerBoard(input, port) {
  if (!input.projectRoot) throw new Error("projectRoot is required");
  const metadata = await ensureBoardMetadata(input.projectRoot, input.name || null);
  const prior = registry.boards[metadata.id] || {};
  const now = new Date().toISOString();
  const board = {
    ...prior,
    id: metadata.id,
    token: metadata.token,
    name: metadata.name,
    projectRoot: metadata.projectRoot,
    roundFilter: input.roundFilter || null,
    sourceFilter: input.sourceFilter || null,
    latestRound: input.allRounds ? false : !input.roundFilter,
    createdAt: prior.createdAt || metadata.createdAt || now,
    updatedAt: now,
  };
  await loadBoard(board);
  const lastOpened = Date.parse(prior.lastOpenedAt || 0);
  const intent = input.openIntent || "never";
  const shouldOpen = intent === "force" || (intent === "if-needed" && (!lastOpened || Date.now() - lastOpened > 20 * 60 * 1000));
  if (shouldOpen) board.lastOpenedAt = now;
  registry.boards[board.id] = board;
  registry.activeBoardId = board.id;
  registry.updatedAt = now;
  await persistRegistry();
  notifyBoard(board.id);
  return { board, url: boardUrl(board, port), shouldOpen };
}

function dashboardHtml(port) {
  const boards = Object.values(registry.boards)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  const cards = boards.map((board) => `<a href="${boardUrl(board, port)}"><strong>${escapeHtml(board.name)}</strong><span>${escapeHtml(board.projectRoot)}</span></a>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Commerce QA</title><style>color-scheme:dark;*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#0b0c0b;color:#f2f4f1;font:14px ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;place-items:center}.wrap{width:min(640px,calc(100vw - 32px))}h1{font-size:18px;margin:0 0 16px}.list{display:grid;gap:8px}a{display:grid;gap:4px;padding:14px;border:1px solid rgba(242,244,241,.11);border-radius:12px;background:#151716;color:inherit;text-decoration:none}a:hover{background:#1b1e1c}span{color:#969c97;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.empty{color:#969c97}</style></head><body><main class="wrap"><h1>Commerce QA</h1>${cards ? `<div class="list">${cards}</div>` : '<p class="empty">No review boards yet.</p>'}</main></body></html>`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]);
}

let activePort = preferredPort;
const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${host}:${activePort}`);
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}:${activePort}`) {
      response.writeHead(403).end("Origin rejected");
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      if (!authorized(request)) return jsonResponse(response, 403, { error: "Forbidden" });
      jsonResponse(response, 200, { ok: true, instanceId, pid: process.pid, port: activePort, boardCount: Object.keys(registry.boards).length });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/boards/register") {
      if (!authorized(request)) return jsonResponse(response, 403, { error: "Forbidden" });
      const result = await registerBoard(await requestJson(request), activePort);
      jsonResponse(response, 200, { registered: true, id: result.board.id, name: result.board.name, url: result.url, shouldOpen: result.shouldOpen });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/boards") {
      if (!authorized(request)) return jsonResponse(response, 403, { error: "Forbidden" });
      jsonResponse(response, 200, {
        activeBoardId: registry.activeBoardId || null,
        boards: Object.values(registry.boards).map((board) => ({ id: board.id, name: board.name, projectRoot: board.projectRoot, url: boardUrl(board, activePort), updatedAt: board.updatedAt })),
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/shutdown") {
      if (!authorized(request)) return jsonResponse(response, 403, { error: "Forbidden" });
      jsonResponse(response, 200, { stopping: true, instanceId });
      setTimeout(stop, 20);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/") {
      const active = registry.boards[registry.activeBoardId];
      if (active) {
        response.writeHead(302, { Location: boardUrl(active, activePort), "Cache-Control": "no-store" });
        response.end();
      } else {
        const body = dashboardHtml(activePort);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
        response.end(body);
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/boards") {
      const body = dashboardHtml(activePort);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
      response.end(body);
      return;
    }

    const routed = boardFromRoute(requestUrl.pathname);
    if (!routed) {
      response.writeHead(404).end("Not found");
      return;
    }
    const { board, relativePath } = routed;
    const basePath = `/b/${encodeURIComponent(board.id)}/${encodeURIComponent(board.token)}/`;

    if (request.method === "GET" && (relativePath === "" || relativePath === "index.html")) {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": appHtml.length,
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      response.end(appHtml);
      return;
    }

    if (request.method === "GET" && relativePath === "api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write(`event: connected\ndata: ${JSON.stringify({ boardId: board.id })}\n\n`);
      if (!eventStreams.has(board.id)) eventStreams.set(board.id, new Set());
      eventStreams.get(board.id).add(response);
      const keepalive = setInterval(() => response.write(": keepalive\n\n"), 25_000);
      request.on("close", () => {
        clearInterval(keepalive);
        eventStreams.get(board.id)?.delete(response);
      });
      return;
    }

    if (request.method === "GET" && relativePath === "api/review") {
      const { loaded, state, droppedReviews } = await loadBoard(board);
      const routeForMedia = (id, kind) => `${basePath}media/${encodeURIComponent(id)}/${kind}`;
      jsonResponse(response, 200, { project: publicReviewData(loaded, routeForMedia), state, staleItems: loaded.staleItems, missingItems: loaded.missingItems || [], droppedReviews, board: { id: board.id, name: board.name } });
      return;
    }

    if (request.method === "GET" && relativePath === "api/gallery") {
      const loaded = await loadEveryRound(board);
      jsonResponse(response, 200, {
        items: productGallery(loaded.data.items).map((item) => ({
          id: item.id,
          group: item.group,
          sku: item.sku,
          product: item.product,
          assetSlot: item.assetSlot,
          title: item.title,
          round: item.round,
          after: `${basePath}media/${encodeURIComponent(item.id)}/after`,
          thumb: `${basePath}media/${encodeURIComponent(item.id)}/thumb`,
        })),
      });
      return;
    }

    if (request.method === "GET" && relativePath === "api/lane") {
      const wanted = requestUrl.searchParams.get("item");
      const everyRound = await loadEveryRound(board);
      const anchorItem = everyRound.data.items.find((entry) => entry.id === wanted);
      if (!anchorItem) return jsonResponse(response, 404, { error: "Unknown item" });
      const slot = canonicalSlot(anchorItem.slotKey || anchorItem.assetSlot);
      const groups = groupIndex(everyRound.data.items);
      const mine = groups.get(anchorItem.id);
      const versions = everyRound.data.items
        .filter((entry) => groups.get(entry.id) === mine
          && canonicalSlot(entry.slotKey || entry.assetSlot) === slot)
        .sort((a, b) => String(a.recordedAt || a.createdAt || "").localeCompare(String(b.recordedAt || b.createdAt || "")))
        .map((entry) => ({
          id: entry.id,
          round: entry.round,
          title: entry.title,
          recordedAt: entry.recordedAt || entry.createdAt || "",
          feedback: entry.feedback || [],
          after: `${basePath}media/${encodeURIComponent(entry.id)}/after`,
          thumb: `${basePath}media/${encodeURIComponent(entry.id)}/thumb`,
        }));
      // The first recorded version was made against something — the client's original,
      // usually. It is a genuine earlier state of this picture, so the timeline must
      // include it even though it was never recorded as a version of its own.
      const first = versions[0];
      const origin = first && everyRound.data.items.find((entry) => entry.id === first.id);
      const produced = new Set(everyRound.data.items.filter((entry) => versions.some((v) => v.id === entry.id)).map((entry) => entry.afterSha256));
      if (origin?.beforePath && origin.beforeSha256 && !produced.has(origin.beforeSha256)) {
        versions.unshift({
          id: `${origin.id}::origin`,
          round: "Original",
          title: origin.beforeName || "Original",
          recordedAt: "",
          origin: true,
          feedback: [],
          after: `${basePath}media/${encodeURIComponent(origin.id)}/before`,
          thumb: `${basePath}media/${encodeURIComponent(origin.id)}/thumb-before`,
        });
      }
      jsonResponse(response, 200, { slot, product: anchorItem.product, versions });
      return;
    }

    if (request.method === "PUT" && relativePath === "api/review") {
      const input = await requestJson(request);
      const result = await withBoardQueue(board.id, async () => {
        const { loaded, statePath } = await loadBoard(board);
        const state = sanitizeState(input, loaded);
        await atomicWriteJson(statePath, state);
        return state;
      });
      jsonResponse(response, 200, { saved: true, updatedAt: result.updatedAt });
      return;
    }

    if (request.method === "POST" && relativePath === "api/submit") {
      const input = await requestJson(request);
      const result = await withBoardQueue(board.id, async () => {
        const { loaded, statePath } = await loadBoard(board);
        const submissionId = randomUUID();
        const state = sanitizeState(input, loaded, { submitted: true, submissionId });
        const decided = Object.values(state.reviews).filter(reviewReady).length;
        if (!decided) return { error: "Review at least one image before sending.", status: 400 };
        const submissionsDir = path.join(board.projectRoot, ".image-change-qa", "submissions");
        await atomicWriteJson(statePath, state);
        await fs.mkdir(submissionsDir, { recursive: true });
        const stamp = state.submittedAt.replaceAll(":", "-");
        const submissionPath = path.join(submissionsDir, `${stamp}--${submissionId}.json`);
        await atomicWriteJson(submissionPath, state);
        return { state, decided, total: loaded.data.items.length, submissionPath };
      });
      if (result.error) return jsonResponse(response, result.status, { error: result.error });
      const partial = result.decided < result.total;
      jsonResponse(response, 200, {
        submitted: true,
        submissionId: result.state.submissionId,
        decided: result.decided,
        total: result.total,
        partial,
        submissionPath: result.submissionPath,
        message: partial
          ? `${result.decided} reviewed item${result.decided === 1 ? "" : "s"} sent; ${result.total - result.decided} undecided item${result.total - result.decided === 1 ? " remains" : "s remain"} untouched.`
          : "Review saved. Return to Codex and say “Apply the QA.”",
      });
      return;
    }

    if (request.method === "GET" && relativePath.startsWith("media/")) {
      const parts = relativePath.split("/").map((value) => decodeURIComponent(value));
      const itemId = parts[1];
      const kind = parts[2];
      const { loaded } = await loadBoard(board);
      let item = loaded.data.items.find((entry) => entry.id === itemId);
      if (!item) {
        // The gallery shows the newest version of every slot, which may come from a
        // round this board is not scoped to.
        const everyRound = await loadEveryRound(board);
        item = everyRound.data.items.find((entry) => entry.id === itemId);
      }
      if (!item) return response.writeHead(404).end("Media not found");
      let filePath = kind === "before" || kind === "thumb-before" ? item.beforePath
        : kind === "after" || kind === "thumb" ? item.afterPath
          : null;
      if (kind === "reference") {
        const reference = item.references[Number(parts[3])];
        filePath = reference?.kind === "image" ? reference.path : null;
      }
      if (!filePath) return response.writeHead(404).end("Media not found");
      if (kind === "thumb" || kind === "thumb-before") {
        try {
          const sha = kind === "thumb" ? item.afterSha256 : item.beforeSha256;
          if (!sha) return response.writeHead(404).end("Media not found");
          filePath = await thumbnailFor(path.join(board.projectRoot, ".image-change-qa"), filePath, sha);
        } catch {
          // A thumbnail is an optimisation; fall back to the master image.
        }
      }
      const stat = await fs.stat(filePath);
      response.writeHead(200, {
        "Content-Type": mimeType(filePath),
        "Content-Length": stat.size,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(await fs.readFile(filePath));
      return;
    }

    response.writeHead(404).end("Not found");
  } catch (error) {
    jsonResponse(response, 500, { error: error.message });
  }
});

async function listen(port) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

// Node closes an idle connection after five seconds by default while browsers keep
// pooled sockets far longer, so a reused socket can be reset mid-request and surface
// as "Failed to fetch". Outlive the browser's reuse window instead.
server.keepAliveTimeout = 72_000;
server.headersTimeout = 75_000;

try {
  await listen(preferredPort);
} catch (error) {
  if (error.code !== "EADDRINUSE" || preferredPort === 0) throw error;
  await listen(0);
}
activePort = server.address().port;
await atomicWriteJson(paths.service, {
  version: 1,
  instanceId,
  pid: process.pid,
  host,
  port: activePort,
  key: serviceKey,
  codeStamp: await codeStamp(),
  startedAt: new Date().toISOString(),
});
await fs.rm(paths.lock, { force: true });
console.log(JSON.stringify({ service: "commerce-qa", contract: "passed", pid: process.pid, port: activePort, stateDir }));

let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;
  for (const streams of eventStreams.values()) for (const stream of streams) stream.end();
  const exit = async () => {
    try {
      const current = await readJson(paths.service, null);
      if (current?.instanceId === instanceId) await fs.rm(paths.service, { force: true });
    } catch {
      // The record may be unreadable or already gone; shutting down is still correct.
    }
    process.exit(0);
  };
  server.close(() => { exit(); });
  setTimeout(exit, 2_000).unref();
}

// A review in progress must survive an unexpected failure in one request.
function surviveFailure(scope) {
  return (error) => {
    process.stderr.write(`${JSON.stringify({ service: "commerce-qa", level: "error", scope, error: String(error?.stack || error) })}\n`);
    if (stopping) process.exit(0);
  };
}

process.on("uncaughtException", surviveFailure("uncaughtException"));
process.on("unhandledRejection", surviveFailure("unhandledRejection"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
