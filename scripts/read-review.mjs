import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadQaProject } from "./qa-core.mjs";
import { atomicWriteJson, criteriaHash } from "./review-state.mjs";

function argValue(name, required = false) {
  const index = process.argv.lastIndexOf(name);
  if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
  if (required) throw new Error(`Missing required argument: ${name}`);
  return null;
}

function hasArg(name) {
  return process.argv.includes(name);
}

async function submissionCandidates(submissionsDir) {
  let names = [];
  try {
    names = (await fs.readdir(submissionsDir)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const candidates = [];
  for (const name of names) {
    const filePath = path.join(submissionsDir, name);
    try {
      const state = JSON.parse(await fs.readFile(filePath, "utf8"));
      if (state?.submittedAt) candidates.push({ filePath, state });
    } catch {
      // Ignore a corrupt historical snapshot; current review state remains untouched.
    }
  }
  return candidates.sort((a, b) => String(b.state.submittedAt).localeCompare(String(a.state.submittedAt)));
}

const projectRoot = path.resolve(argValue("--project", true));
const roundFilter = argValue("--round");
const currentStatePath = path.join(projectRoot, ".image-change-qa/review-state.json");
const submissionsDir = path.join(projectRoot, ".image-change-qa/submissions");
const submissionId = argValue("--submission");
const wantsUnapplied = hasArg("--unapplied");
const markApplied = hasArg("--mark-applied");
let statePath = currentStatePath;
let state;

if (submissionId || wantsUnapplied || markApplied) {
  const candidates = await submissionCandidates(submissionsDir);
  const selected = submissionId
    ? candidates.find((candidate) => candidate.state.submissionId === submissionId || path.basename(candidate.filePath).includes(submissionId))
    : candidates.find((candidate) => !candidate.state.appliedAt);
  if (!selected) throw new Error(submissionId ? `Submission not found: ${submissionId}` : "No unapplied QA submission is available");
  statePath = selected.filePath;
  state = selected.state;
} else {
  state = JSON.parse(await fs.readFile(statePath, "utf8"));
}

const submittedItemIds = Array.isArray(state.itemIds) && state.itemIds.length ? state.itemIds : null;
const loaded = await loadQaProject({
  projectRoot,
  itemIds: submittedItemIds,
  roundFilter: submittedItemIds ? null : roundFilter,
  latestRound: submittedItemIds ? false : !hasArg("--all-rounds") && !roundFilter,
  sourceFilter: submittedItemIds ? null : argValue("--source"),
});

const approved = [];
const needsWork = [];
const undecided = [];
const stale = [];

for (const item of loaded.data.items) {
  const review = state.reviews?.[item.id];
  if (!review?.decision) {
    undecided.push({ id: item.id, product: item.product, title: item.title, round: item.round });
    continue;
  }
  const hashChanged = review.versionHash && review.versionHash !== item.afterSha256;
  const criteriaChanged = review.criteriaHash && review.criteriaHash !== criteriaHash(item);
  if (hashChanged || criteriaChanged) {
    stale.push({
      id: item.id,
      product: item.product,
      title: item.title,
      reason: hashChanged ? "Reviewed image changed" : "Review criteria changed",
      reviewedHash: review.versionHash,
      currentHash: item.afterSha256,
    });
    continue;
  }
  if (review.decision === "Needs work" && !String(review.notes || "").trim() && !(review.annotations || []).some((annotation) => String(annotation.text || "").trim())) {
    undecided.push({ id: item.id, product: item.product, title: item.title, round: item.round, reason: "Needs work requires feedback" });
    continue;
  }
  const entry = {
    id: item.id,
    product: item.product,
    sku: item.sku,
    title: item.title,
    channel: item.channel,
    market: item.market,
    assetSlot: item.assetSlot,
    round: item.round,
    versionHash: item.afterSha256,
    notes: review.notes || "",
    annotations: review.annotations || [],
  };
  if (review.decision === "Approved") approved.push(entry);
  else if (review.decision === "Needs work") needsWork.push(entry);
  else undecided.push(entry);
}

for (const id of loaded.missingItemIds || []) {
  const review = state.reviews?.[id];
  if (review?.decision) {
    stale.push({ id, reason: "Reviewed item was removed from the manifest", reviewedHash: review.versionHash, currentHash: null });
  } else {
    undecided.push({ id, reason: "Undecided item is no longer in the manifest" });
  }
}

const complete = undecided.length === 0 && stale.length === 0;
const submitted = Boolean(state.submittedAt);
const manifestCurrent = state.manifestSha256 === loaded.manifestSha256;
const reviewed = approved.length + needsWork.length;
const decidedReviews = Object.values(state.reviews || {}).filter((review) => review?.decision);
const requiresLegacyManifestMatch = decidedReviews.some((review) => !review.criteriaHash);
const contractPassed = submitted
  && stale.length === 0
  && reviewed > 0
  && (!requiresLegacyManifestMatch || manifestCurrent);

if (markApplied) {
  if (!submissionId) throw new Error("Use --submission <id> with --mark-applied");
  if (!contractPassed) throw new Error("Cannot mark an incomplete or stale submission as applied");
  if (!state.appliedAt) {
    state.appliedAt = new Date().toISOString();
    await atomicWriteJson(statePath, state);
  }
  try {
    const current = JSON.parse(await fs.readFile(currentStatePath, "utf8"));
    if (current.submissionId === state.submissionId) {
      current.appliedAt = state.appliedAt;
      await atomicWriteJson(currentStatePath, current);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

console.log(JSON.stringify({
  contract: contractPassed ? "passed" : "incomplete",
  scope: complete ? "complete" : "partial",
  reason: requiresLegacyManifestMatch && !manifestCurrent
    ? "Review criteria changed after the saved handoff"
    : !submitted
      ? "Review decisions have not been submitted"
      : stale.length
        ? "A submitted image or its review criteria changed"
        : !reviewed
          ? "No valid review decisions were submitted"
          : complete
            ? "Submitted review is complete and current"
            : "Submitted partial review is current; undecided items remain untouched",
  submissionId: state.submissionId || null,
  submittedAt: state.submittedAt || null,
  appliedAt: state.appliedAt || null,
  statePath,
  manifestSha256: loaded.manifestSha256,
  reviewManifestSha256: state.manifestSha256 || null,
  counts: { reviewed, approved: approved.length, needsWork: needsWork.length, undecided: undecided.length, stale: stale.length, total: loaded.data.items.length + (loaded.missingItemIds || []).length },
  approved,
  needsWork,
  undecided,
  stale,
}, null, 2));
