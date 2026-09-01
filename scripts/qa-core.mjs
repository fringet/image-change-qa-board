import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

function slugify(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "image-change";
}

function isUrl(input) {
  return /^https?:\/\//i.test(input || "");
}

// Rounds write slot names inconsistently ("Main image", "MAIN", "PT06-DIMENSIONS").
// The canonical key decides which recordings are versions of the same picture; the
// label the recorder was given is kept for display.
export function canonicalSlot(value) {
  const key = String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
  if (key.startsWith("MAIN")) return "MAIN";
  const numbered = key.match(/^(?:GALLERY)?PT0*(\d+)/);
  return numbered ? `PT${numbered[1].padStart(2, "0")}` : key || "IMAGE";
}

export function sameProductKey(item) {
  return String(item.sku || item.product || "").trim().toLowerCase();
}

export function truthKey(value) {
  return String(value || "").trim().toLowerCase();
}

// Product truth registered once per SKU in <project>/.image-change-qa/truth.json,
// so every later `commerce-qa add` inherits the same identity anchors.
export async function readTruthRegistry(qaDir) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(qaDir, "truth.json"), "utf8"));
    return raw?.products && typeof raw.products === "object" ? raw.products : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function registeredTruth(source, products) {
  return [source.sku, source.product]
    .map((key) => products[truthKey(key)])
    .find((entry) => entry && (entry.identity?.length || entry.productTruth?.length)) || null;
}

export function withInheritedTruth(source, products) {
  const own = (Array.isArray(source.productTruth) ? source.productTruth : Array.isArray(source.truth) ? source.truth : [])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const inherited = (registeredTruth(source, products)?.productTruth || []).map((entry) => String(entry).trim()).filter(Boolean);
  return [...new Set([...inherited, ...own])];
}

export function withInheritedIdentity(source, products) {
  const own = (source.references || []).map((reference) => (typeof reference === "string" ? { path: reference } : reference));
  const inherited = registeredTruth(source, products)?.identity || [];
  const claimed = new Set(own.map((reference) => String(reference.path || reference.url || "")));
  return [
    ...own,
    ...inherited
      .filter((reference) => !claimed.has(String(reference.path || reference.url || "")))
      .map((reference) => ({ ...reference, role: "identity", inherited: true })),
  ];
}

async function digest(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

// Hashing and preflighting every image is what makes a decision trustworthy, but
// a restart should not pay for work already done. Results are remembered against
// the file's own identity (path, mtime, size); anything that moves invalidates the
// entry and the real work runs again. The cache is advisory — if it cannot be read
// or written, everything still computes normally.
function fileKey(filePath, stat) {
  return `${filePath}|${stat.mtimeMs}|${stat.size}`;
}

async function readWorkCache(qaDir) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(qaDir, "work-cache.json"), "utf8"));
    return {
      digests: raw?.digests && typeof raw.digests === "object" ? raw.digests : {},
      preflight: raw?.preflight && typeof raw.preflight === "object" ? raw.preflight : {},
    };
  } catch {
    return { digests: {}, preflight: {} };
  }
}

async function writeWorkCache(qaDir, cache) {
  if (!cache.dirty) return;
  const payload = { version: 1, digests: cache.digests, preflight: cache.preflight };
  const target = path.join(qaDir, "work-cache.json");
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(payload)}\n`);
    await fs.rename(temporary, target);
  } catch {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

// A file can move or be archived after it was recorded. That must cost the board
// the one item, not every item.
async function cachedDigest(filePath, cache, { optional = false } = {}) {
  const stat = await fs.stat(filePath).catch((error) => {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  const key = fileKey(filePath, stat);
  const known = cache.digests[key];
  if (known) {
    cache.keep.add(key);
    return known;
  }
  const value = await digest(filePath);
  cache.digests[key] = value;
  cache.keep.add(key);
  cache.dirty = true;
  return value;
}

async function cachedPreflight(filePath, profile, sha256, cache) {
  const key = `${sha256}|${profile.id}`;
  const known = cache.preflight[key];
  if (known) {
    cache.keep.add(key);
    return known;
  }
  const value = await buildPreflight(filePath, profile);
  cache.preflight[key] = value;
  cache.keep.add(key);
  cache.dirty = true;
  return value;
}

function profileFor(channel, slot) {
  const normalizedChannel = String(channel || "").toLowerCase();
  const normalizedSlot = String(slot || "").toLowerCase();
  if (normalizedChannel.includes("amazon")) {
    return normalizedSlot.includes("main")
      ? { id: "amazon-main", label: "Amazon main image" }
      : { id: "amazon-secondary", label: "Amazon secondary image" };
  }
  if (normalizedChannel.includes("shopify")) {
    return normalizedSlot.includes("collection") || normalizedSlot.includes("card")
      ? { id: "shopify-collection", label: "Shopify collection image" }
      : { id: "shopify-product", label: "Shopify product media" };
  }
  return { id: "commerce-generic", label: channel || "E-commerce image" };
}

function check(id, label, value, status, detail = "") {
  return { id, label, value, status, detail };
}

async function estimateWhiteBackgroundAndCoverage(filePath) {
  const { data, info } = await sharp(filePath)
    .flatten({ background: "#ffffff" })
    .resize(256, 256, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  let borderPixels = 0;
  let whiteBorderPixels = 0;
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * channels;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const isNearWhite = r >= 248 && g >= 248 && b >= 248;
      const isBorder = x < 8 || y < 8 || x >= info.width - 8 || y >= info.height - 8;
      if (isBorder) {
        borderPixels += 1;
        if (isNearWhite) whiteBorderPixels += 1;
      }
      if (!isNearWhite) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const whiteBorderPercent = borderPixels ? (whiteBorderPixels / borderPixels) * 100 : 0;
  const coverage = maxX >= 0
    ? Math.max((maxX - minX + 1) / info.width, (maxY - minY + 1) / info.height) * 100
    : 0;
  return { whiteBorderPercent, coverage };
}

async function buildPreflight(filePath, profile) {
  const metadata = await sharp(filePath).metadata();
  const stat = await fs.stat(filePath);
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const longest = Math.max(width, height);
  const megapixels = width && height ? (width * height) / 1_000_000 : 0;
  const sizeMb = stat.size / 1_000_000;
  const format = String(metadata.format || path.extname(filePath).slice(1) || "unknown").toUpperCase();
  const checks = [
    check("dimensions", "Dimensions", `${width} × ${height}`, width && height ? "pass" : "fail", "Readable pixel dimensions"),
    check("format", "Format", format, "pass"),
    check("filesize", "File size", `${sizeMb.toFixed(sizeMb >= 10 ? 1 : 2)} MB`, "pass"),
  ];

  if (profile.id.startsWith("amazon")) {
    const accepted = ["JPEG", "JPG", "PNG", "TIFF", "TIF", "GIF"].includes(format);
    checks[1] = check("format", "Amazon format", format, accepted ? "pass" : "fail", "JPEG, PNG, TIFF, or non-animated GIF");
    checks.push(check(
      "amazon-range",
      "Longest edge",
      `${longest}px`,
      longest >= 500 && longest <= 10_000 ? (longest >= 1_000 ? "pass" : "warn") : "fail",
      longest < 1_000 ? "500px is accepted; 1000px or more is preferred for zoom" : "500–10,000px",
    ));
    if (profile.id === "amazon-main") {
      try {
        const estimate = await estimateWhiteBackgroundAndCoverage(filePath);
        checks.push(check(
          "white-border",
          "White background",
          `${estimate.whiteBorderPercent.toFixed(1)}% border`,
          estimate.whiteBorderPercent >= 98 ? "pass" : "warn",
          "Pixel estimate; visually confirm pure white and clean edges",
        ));
        checks.push(check(
          "subject-coverage",
          "Subject coverage",
          `≈${estimate.coverage.toFixed(1)}%`,
          estimate.coverage >= 85 ? "pass" : "warn",
          "Estimated non-white bounding box; visually confirm the product fills the frame",
        ));
      } catch {
        checks.push(check("amazon-visual", "Amazon main image", "Visual review required", "warn", "Confirm actual product, pure white background, framing, and no added graphics"));
      }
    }
  } else if (profile.id.startsWith("shopify")) {
    checks[2] = check("filesize", "Shopify file size", `${sizeMb.toFixed(sizeMb >= 10 ? 1 : 2)} MB`, sizeMb < 20 ? "pass" : "fail", "Must be smaller than 20 MB");
    checks.push(check(
      "shopify-size",
      "Shopify image limit",
      `${megapixels.toFixed(1)} MP`,
      width <= 5_000 && height <= 5_000 && megapixels <= 25 ? "pass" : "fail",
      "Maximum 5000 × 5000px or 25 megapixels",
    ));
    checks.push(check("crop-preview", "Responsive crops", "Review previews", "info", "Confirm subject and copy survive collection, product-page, and mobile crops"));
  } else {
    checks.push(check("commerce-resolution", "Commerce resolution", `${longest}px`, longest >= 1_000 ? "pass" : "warn", "1000px or more is a useful general baseline"));
  }

  checks.push(check("identity", "Product truth", "Human/Codex QA", "info", "Confirm SKU, variant, packaging, quantity, included items, label copy, and unrequested-content preservation"));
  return { profile, metadata: { width, height, format, bytes: stat.size, megapixels }, checks };
}

export async function loadQaProject({
  projectRoot: projectRootInput,
  configPath: configPathInput,
  roundFilter = null,
  latestRound = false,
  sourceFilter = null,
  itemIds = null,
} = {}) {
  if (!projectRootInput && !configPathInput) throw new Error("Provide a project root or manifest path");
  const projectRoot = projectRootInput ? path.resolve(projectRootInput) : null;
  const configPath = configPathInput
    ? path.resolve(configPathInput)
    : path.join(projectRoot, ".image-change-qa/manifest.json");
  const configDir = path.dirname(configPath);
  const rawBytes = await fs.readFile(configPath);
  const rawConfig = JSON.parse(rawBytes.toString("utf8"));
  if (!Array.isArray(rawConfig.items) || rawConfig.items.length === 0) {
    throw new Error("Manifest must contain a non-empty items array");
  }
  const manifestSha256 = createHash("sha256").update(rawBytes).digest("hex");
  const baseDir = rawConfig.projectRoot
    ? path.resolve(configDir, rawConfig.projectRoot)
    : projectRoot || configDir;
  const requestGroups = rawConfig.requestGroups || {};
  const truthProducts = await readTruthRegistry(configDir);
  const cache = { ...(await readWorkCache(configDir)), keep: new Set(), dirty: false };
  let sourceItems = [...rawConfig.items];
  const requestedItemIds = Array.isArray(itemIds) && itemIds.length ? [...new Set(itemIds.map(String))] : null;

  if (requestedItemIds) {
    const requested = new Set(requestedItemIds);
    sourceItems = sourceItems.filter((item) => requested.has(String(item.id || slugify(`${item.product}-${item.title}-${item.round || "Current review"}`))));
  }

  if (roundFilter) sourceItems = sourceItems.filter((item) => (item.round || "Current review") === roundFilter);
  if (latestRound) {
    const latestItem = [...sourceItems].sort((a, b) =>
      String(b.recordedAt || b.createdAt || "").localeCompare(String(a.recordedAt || a.createdAt || "")),
    )[0];
    const selectedRound = latestItem?.round || "Current review";
    sourceItems = sourceItems.filter((item) => (item.round || "Current review") === selectedRound);
  }
  if (sourceFilter) {
    sourceItems = sourceItems.filter((item) => {
      const feedback = item.feedback || [];
      if (feedback.length) return feedback.some((entry) => String(entry.source || item.source || "Client").toLowerCase() === sourceFilter.toLowerCase());
      return (item.requests || []).length > 0 && String(item.source || "Client").toLowerCase() === sourceFilter.toLowerCase();
    });
  }
  if (!sourceItems.length && !requestedItemIds) throw new Error("No manifest items match the requested review scope");
  const selectedIds = new Set(sourceItems.map((item) => String(item.id || slugify(`${item.product}-${item.title}-${item.round || "Current review"}`))));
  const missingItemIds = requestedItemIds ? requestedItemIds.filter((id) => !selectedIds.has(id)) : [];

  const ids = new Set();
  const items = [];
  const staleItems = [];
  const missingItems = [];
  for (const source of sourceItems) {
    const product = source.product;
    const title = source.title;
    const beforeInput = source.beforePath || source.before || null;
    const afterInput = source.afterPath || source.after;
    const round = source.round || "Current review";
    const id = source.id || slugify(`${product}-${title}-${round}`);
    if (!product || !title || !afterInput || !source.finding) throw new Error(`Item ${id} is missing required data`);
    if (ids.has(id)) throw new Error(`Duplicate item id: ${id}`);
    ids.add(id);

    const legacyRequests = [
      ...(source.requests || []),
      ...(source.requestRefs || []).flatMap((key) => {
        if (!Array.isArray(requestGroups[key])) throw new Error(`Unknown request group "${key}" in item ${id}`);
        return requestGroups[key];
      }),
    ];
    const feedback = Array.isArray(source.feedback) && source.feedback.length
      ? source.feedback.map((entry) => typeof entry === "string"
        ? { source: source.source || "Client", text: entry }
        : { source: entry.source || source.source || "Client", text: entry.text })
      : legacyRequests.map((text) => ({ source: source.source || "Client", text }));
    if (!feedback.length || feedback.some((entry) => !entry.text)) throw new Error(`Item ${id} must contain feedback text`);

    const beforePath = beforeInput ? path.resolve(baseDir, beforeInput) : null;
    const afterPath = path.resolve(baseDir, afterInput);
    const beforeSha256 = beforePath ? await cachedDigest(beforePath, cache, { optional: true }) : null;
    const afterSha256 = await cachedDigest(afterPath, cache, { optional: true });
    if (!afterSha256) {
      missingItems.push({ id, product, title, round, path: path.relative(baseDir, afterPath) });
      continue;
    }
    const beforeAvailable = Boolean(beforePath && beforeSha256);
    let stale = Boolean(
      (source.beforeSha256 && beforeSha256 && source.beforeSha256 !== beforeSha256)
      || (source.afterSha256 && source.afterSha256 !== afterSha256),
    );

    const references = [];
    for (const [index, rawReference] of withInheritedIdentity(source, truthProducts).entries()) {
      const reference = typeof rawReference === "string" ? { path: rawReference } : rawReference;
      const input = reference.path || reference.url;
      if (!input) throw new Error(`Reference ${index + 1} in item ${id} has no path or URL`);
      const role = reference.role === "identity" ? "identity" : "reference";
      const inherited = reference.inherited === true;
      const missingReference = !reference.url && !isUrl(input)
        && !(await cachedDigest(path.resolve(baseDir, input), cache, { optional: true }));
      if (missingReference) continue;
      if (reference.url || isUrl(input)) {
        references.push({ kind: "url", role, inherited, url: reference.url || input, label: reference.label || `Reference ${index + 1}`, caption: reference.caption || "" });
      } else {
        const referencePath = path.resolve(baseDir, input);
        const referenceSha256 = await cachedDigest(referencePath, cache);
        if (reference.sha256 && reference.sha256 !== referenceSha256) stale = true;
        references.push({ kind: "image", role, inherited, path: referencePath, label: reference.label || path.basename(input), caption: reference.caption || "", sha256: referenceSha256 });
      }
    }
    if (stale) staleItems.push(id);

    const channel = source.channel || "E-commerce";
    const slot = source.assetSlot || source.slot || "Image";
    const profile = profileFor(channel, slot);
    const preflight = await cachedPreflight(afterPath, profile, afterSha256, cache);
    items.push({
      id,
      product,
      sku: source.sku || product,
      title,
      round,
      channel,
      market: source.market || "",
      assetSlot: slot,
      productTruth: withInheritedTruth(source, truthProducts),
      feedback,
      sourceLabels: [...new Set(feedback.map((entry) => entry.source))],
      beforePath: beforeAvailable ? beforePath : null,
      afterPath,
      beforeName: beforeAvailable ? source.beforeName || path.basename(beforeInput) : null,
      afterName: source.afterName || path.basename(afterInput),
      mode: beforeAvailable ? "revision" : "new-image",
      references,
      finding: stale ? `${source.finding} File content changed after recorded QA; re-inspection is required.` : source.finding,
      qaStatus: stale ? "Needs review" : source.qaStatus || "Ready",
      beforeSha256: beforeAvailable ? beforeSha256 : null,
      afterSha256,
      slotKey: source.slotKey || canonicalSlot(slot),
      parentId: source.parentId || null,
      beforeRound: source.beforeRound || null,
      // Items recorded before lineage was tracked simply do not know; they must not
      // be presented as a deliberate choice.
      beforeSource: source.beforeSource || (beforePath ? "legacy" : "none"),
      recordedAt: source.recordedAt || source.createdAt || "",
      createdAt: source.createdAt || source.recordedAt || "",
      preflight,
    });
  }

  // Only a full, unfiltered load sees every file, so only it may prune. A scoped
  // load would otherwise discard entries the next full load still needs.
  const fullLoad = !roundFilter && !latestRound && !sourceFilter && !requestedItemIds;
  for (const store of fullLoad ? [cache.digests, cache.preflight] : []) {
    for (const key of Object.keys(store)) {
      if (!cache.keep.has(key)) {
        delete store[key];
        cache.dirty = true;
      }
    }
  }
  await writeWorkCache(configDir, cache);

  const feedbackCount = items.reduce((sum, item) => sum + item.feedback.length, 0);
  const referenceCount = items.reduce((sum, item) => sum + item.references.length, 0);
  const identityCount = items.reduce((sum, item) => sum + item.references.filter((reference) => reference.role === "identity").length, 0);
  const rounds = [...new Set(items.map((item) => item.round))];
  return {
    projectRoot: projectRoot || baseDir,
    configPath,
    configDir,
    baseDir,
    manifestSha256,
    staleItems,
    missingItems,
    missingItemIds,
    data: {
      version: 3,
      projectName: rawConfig.projectName || path.basename(projectRoot || baseDir),
      summary: rawConfig.summary || `${items.length} images · ${feedbackCount} feedback items · ${rounds.length} round${rounds.length === 1 ? "" : "s"}`,
      items,
      rounds,
      referenceCount,
      identityCount,
      manifestSha256,
    },
  };
}

export function publicReviewData(loaded, routeForMedia) {
  return {
    ...loaded.data,
    items: loaded.data.items.map((item) => ({
      ...item,
      beforePath: undefined,
      afterPath: undefined,
      before: item.beforePath ? routeForMedia(item.id, "before") : null,
      after: routeForMedia(item.id, "after"),
      thumb: routeForMedia(item.id, "thumb"),
      references: item.references.map((reference, index) => reference.kind === "image"
        ? { ...reference, index, path: undefined, image: routeForMedia(item.id, `reference/${index}`) }
        : { ...reference, index }),
    })),
  };
}
