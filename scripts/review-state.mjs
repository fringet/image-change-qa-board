import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filePath);
}

function cleanText(value, maxLength = 10_000) {
  return String(value || "").slice(0, maxLength);
}

export async function acquireLock(lockPath, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      return async () => {
        await handle.close();
        await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 25)));
    }
  }
  throw new Error(`Timed out waiting for ${path.basename(lockPath)}`);
}

export function reviewReady(review) {
  if (review?.decision === "Approved") return true;
  if (review?.decision !== "Needs work") return false;
  return Boolean(
    String(review.notes || "").trim()
    || (review.annotations || []).some((annotation) => String(annotation.text || "").trim()),
  );
}

export function criteriaHash(item) {
  const criteria = {
    id: item.id,
    product: item.product,
    sku: item.sku,
    title: item.title,
    round: item.round,
    channel: item.channel,
    market: item.market,
    assetSlot: item.assetSlot,
    productTruth: item.productTruth,
    feedback: item.feedback,
    finding: item.finding,
    afterSha256: item.afterSha256,
  };
  const identity = (item.references || [])
    .filter((reference) => reference.role === "identity" && reference.sha256)
    .map((reference) => `${reference.label}:${reference.sha256}`);
  if (identity.length) criteria.identity = identity;
  return createHash("sha256").update(JSON.stringify(criteria)).digest("hex");
}

export function sanitizeState(input, loaded, { submitted = false, submissionId = null } = {}) {
  const allowedItems = new Map(loaded.data.items.map((item) => [item.id, item]));
  const reviews = {};
  for (const [id, rawReview] of Object.entries(input.reviews || {})) {
    const item = allowedItems.get(id);
    if (!item || !rawReview || typeof rawReview !== "object") continue;
    const decision = ["Approved", "Needs work"].includes(rawReview.decision) ? rawReview.decision : "";
    const annotations = Array.isArray(rawReview.annotations)
      ? rawReview.annotations.slice(0, 100).map((annotation, index) => ({
        id: cleanText(annotation.id || `${id}-pin-${index + 1}`, 160),
        x: Math.min(1, Math.max(0, Number(annotation.x) || 0)),
        y: Math.min(1, Math.max(0, Number(annotation.y) || 0)),
        text: cleanText(annotation.text),
        against: cleanText(annotation.against, 160),
      }))
      : [];
    reviews[id] = {
      versionHash: item.afterSha256,
      criteriaHash: criteriaHash(item),
      decision,
      notes: cleanText(rawReview.notes),
      annotations,
      updatedAt: new Date().toISOString(),
    };
  }
  const reviewed = Object.values(reviews).filter(reviewReady).length;
  const submittedAt = submitted ? new Date().toISOString() : null;
  return {
    version: 2,
    manifestSha256: loaded.manifestSha256,
    projectName: loaded.data.projectName,
    itemIds: loaded.data.items.map((item) => item.id),
    reviews,
    updatedAt: new Date().toISOString(),
    submittedAt,
    submissionId: submitted ? submissionId : null,
    scope: submitted ? (reviewed === loaded.data.items.length ? "complete" : "partial") : null,
    appliedAt: null,
  };
}

export function compatibleSavedState(saved, loaded) {
  const sameManifest = saved?.manifestSha256 === loaded.manifestSha256;
  const allowedItems = new Map(loaded.data.items.map((item) => [item.id, item]));
  const reviews = {};
  const dropped = [];
  for (const [id, review] of Object.entries(saved?.reviews || {})) {
    const item = allowedItems.get(id);
    if (
      item
      && (!review.versionHash || review.versionHash === item.afterSha256)
      && (!review.criteriaHash || review.criteriaHash === criteriaHash(item))
    ) {
      reviews[id] = review;
      continue;
    }
    // A decision taken against a different image or different criteria cannot be
    // carried forward, but the reviewer has to be told it was reset.
    if (review?.decision) {
      dropped.push({
        id,
        title: item?.title || id,
        reason: !item
          ? "No longer in this review"
          : review.versionHash && review.versionHash !== item.afterSha256
            ? "Image changed"
            : "Product truth or criteria changed",
      });
    }
  }
  return {
    dropped,
    version: 2,
    manifestSha256: loaded.manifestSha256,
    projectName: loaded.data.projectName,
    itemIds: loaded.data.items.map((item) => item.id),
    reviews,
    updatedAt: saved?.updatedAt || null,
    submittedAt: sameManifest ? saved?.submittedAt || null : null,
    submissionId: sameManifest ? saved?.submissionId || null : null,
    scope: sameManifest ? saved?.scope || null : null,
    appliedAt: sameManifest ? saved?.appliedAt || null : null,
  };
}

export async function readSavedState(statePath, loaded) {
  let saved = { version: 2, reviews: {} };
  try {
    saved = JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const { dropped, ...state } = compatibleSavedState(saved, loaded);
  return { state, dropped };
}
