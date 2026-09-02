import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { acquireLock, atomicWriteJson } from "./review-state.mjs";
import { canonicalSlot, sameProductKey } from "./qa-core.mjs";

function slugify(input) {
  return String(input)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "image-change";
}

function normalizeSource(input) {
  const source = String(input || "Client").trim().toLowerCase();
  if (["client", "customer"].includes(source)) return "Client";
  if (["internal", "user", "me", "team"].includes(source)) return "Internal";
  if (["codex", "qa", "agent"].includes(source)) return "Codex";
  return String(input || "Client").trim();
}

function isUrl(input) {
  return /^https?:\/\//i.test(input || "");
}

async function sha256(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function feedbackOf(entry) {
  const raw = Array.isArray(entry.feedback) ? entry.feedback : [];
  return raw
    .map((item) => (typeof item === "string"
      ? { source: "Client", text: item }
      : { source: normalizeSource(item.source), text: String(item.text || "") }))
    .filter((item) => item.text.trim());
}

async function resolveReferences(projectRoot, entry, role) {
  const key = role === "identity" ? "identity" : "references";
  const list = Array.isArray(entry[key]) ? entry[key] : [];
  const resolved = [];
  for (const raw of list) {
    const reference = typeof raw === "string" ? { path: raw } : raw;
    const input = reference.path || reference.url;
    if (!input) continue;
    if (isUrl(input)) {
      if (role === "identity") throw new Error(`identity must be a project-relative image: ${input}`);
      resolved.push({ url: input, label: reference.label || "Reference", caption: reference.caption || "", role: "reference" });
      continue;
    }
    const absolute = path.resolve(projectRoot, input);
    await fs.access(absolute);
    resolved.push({
      path: path.relative(projectRoot, absolute),
      label: reference.label || path.basename(input, path.extname(input)),
      caption: reference.caption || "",
      role,
      sha256: await sha256(absolute),
    });
  }
  return resolved;
}

export async function recordBatch({ projectRoot, batchPath }) {
  const batch = JSON.parse(await fs.readFile(batchPath, "utf8"));
  const defaults = batch.defaults || {};
  const entries = Array.isArray(batch.items) ? batch.items : [];
  if (!entries.length) throw new Error("Batch file contains no items");

  const manifestPath = path.join(projectRoot, ".image-change-qa/manifest.json");
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });

  // Everything is prepared before the lock, so the manifest is held only for the write.
  const prepared = [];
  for (const [index, raw] of entries.entries()) {
    const entry = { ...defaults, ...raw };
    const product = entry.product;
    const title = entry.title || entry.assetSlot;
    const afterInput = entry.after;
    if (!product || !title || !afterInput) {
      throw new Error(`Item ${index + 1} needs product, title (or assetSlot) and after`);
    }
    const afterAbsolute = path.resolve(projectRoot, afterInput);
    await fs.access(afterAbsolute);
    const beforeInput = entry.before || null;
    const beforeAbsolute = beforeInput ? path.resolve(projectRoot, beforeInput) : null;
    if (beforeAbsolute) await fs.access(beforeAbsolute);
    if (beforeAbsolute && entry.noBefore) throw new Error(`Item ${index + 1} sets both before and noBefore`);

    const feedback = feedbackOf(entry);
    if (!feedback.length) throw new Error(`Item ${index + 1} (${title}) has no feedback`);
    const finding = entry.finding;
    if (!finding) throw new Error(`Item ${index + 1} (${title}) has no finding`);

    const round = entry.round || "Current review";
    const idSeed = `${product}-${title}-${round}`;
    const defaultId = entry.round
      ? `${slugify(`${product}-${title}`).slice(0, 52)}-${createHash("sha256").update(idSeed).digest("hex").slice(0, 8)}`
      : slugify(`${product}-${title}`);

    prepared.push({
      id: entry.id || defaultId,
      product,
      sku: entry.sku || product,
      title,
      round,
      channel: entry.channel || "E-commerce",
      market: entry.market || "",
      assetSlot: entry.assetSlot || entry.slot || "Image",
      slotKey: canonicalSlot(entry.assetSlot || entry.slot || "Image"),
      productTruth: (entry.productTruth || []).map((text) => String(text).trim()).filter(Boolean),
      feedback,
      requests: feedback.map((item) => item.text),
      before: beforeAbsolute ? path.relative(projectRoot, beforeAbsolute) : null,
      after: path.relative(projectRoot, afterAbsolute),
      beforeName: beforeAbsolute ? path.basename(beforeAbsolute) : null,
      afterName: path.basename(afterAbsolute),
      references: [
        ...(await resolveReferences(projectRoot, entry, "identity")),
        ...(await resolveReferences(projectRoot, entry, "reference")),
      ],
      finding,
      qaStatus: entry.status || "Ready",
      parentId: null,
      beforeRound: null,
      beforeSource: beforeAbsolute ? "explicit" : entry.noBefore ? "none" : "pending",
      beforeSha256: beforeAbsolute ? await sha256(beforeAbsolute) : null,
      afterSha256: await sha256(afterAbsolute),
      recordedAt: new Date().toISOString(),
    });
  }

  const seen = new Set();
  for (const item of prepared) {
    if (seen.has(item.id)) throw new Error(`Two items resolve to the same id: ${item.id}`);
    seen.add(item.id);
  }

  const releaseLock = await acquireLock(path.join(path.dirname(manifestPath), "manifest.lock"));
  let manifest;
  let historyBefore = new Set();
  try {
    manifest = { version: 2, projectRoot: "..", items: [] };
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!Array.isArray(manifest.items)) manifest.items = [];
    manifest.version = Math.max(Number(manifest.version) || 1, 2);
    // A first round has nothing to chain to; only a product with existing history
    // makes an unchained item worth reporting.
    historyBefore = new Set(manifest.items.map((entry) => sameProductKey(entry)));

    for (const item of prepared) {
      // Same lane rule as a single recording: the parent is the newest existing
      // version of this product and slot, including ones added earlier in this batch.
      const lane = manifest.items
        .filter((entry) => entry.id !== item.id
          && sameProductKey(entry) === sameProductKey(item)
          && canonicalSlot(entry.slotKey || entry.assetSlot) === item.slotKey)
        .sort((a, b) => String(a.recordedAt || a.createdAt || "").localeCompare(String(b.recordedAt || b.createdAt || "")));
      const parent = lane[lane.length - 1] || null;

      if (item.beforeSource === "pending") {
        if (parent) {
          const parentAfter = path.resolve(projectRoot, parent.after);
          if (await fs.access(parentAfter).then(() => true, () => false)) {
            item.before = path.relative(projectRoot, parentAfter);
            item.beforeName = parent.afterName || path.basename(parentAfter);
            item.beforeSha256 = await sha256(parentAfter);
            item.parentId = parent.id;
            item.beforeRound = parent.round || null;
            item.beforeSource = "derived";
          } else {
            item.beforeSource = "none";
          }
        } else {
          item.beforeSource = "none";
        }
      } else if (item.beforeSource === "explicit" && parent) {
        const beforeAbsolute = path.resolve(projectRoot, item.before);
        const named = lane.find((entry) => path.resolve(projectRoot, entry.after) === beforeAbsolute);
        item.parentId = named && named.id === parent.id ? parent.id : null;
        item.beforeRound = named?.round || null;
      }

      const existing = manifest.items.findIndex((entry) => entry.id === item.id);
      if (existing >= 0) {
        item.createdAt = manifest.items[existing].createdAt || manifest.items[existing].recordedAt || item.recordedAt;
        manifest.items[existing] = item;
      } else {
        item.createdAt = item.recordedAt;
        manifest.items.push(item);
      }
    }
    await atomicWriteJson(manifestPath, manifest);
  } finally {
    await releaseLock();
  }

  const unchained = prepared
    .filter((item) => item.beforeSource === "none" && historyBefore.has(sameProductKey(item)))
    .map((item) => ({ title: item.title, slot: item.slotKey, reason: "no earlier version of this slot was found" }));
  const sources = prepared.reduce((counts, item) => {
    counts[item.beforeSource] = (counts[item.beforeSource] || 0) + 1;
    return counts;
  }, {});
  return {
    recorded: prepared.length,
    items: manifest.items.length,
    rounds: [...new Set(prepared.map((item) => item.round))],
    beforeSources: sources,
    ...(unchained.length ? { needsAttention: unchained } : {}),
  };
}
