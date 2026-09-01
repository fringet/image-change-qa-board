import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { acquireLock } from "./review-state.mjs";
import { canonicalSlot, sameProductKey } from "./qa-core.mjs";

function values(name) {
  const result = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && index + 1 < process.argv.length) {
      result.push(process.argv[index + 1]);
    }
  }
  return result;
}

function value(name, required = false) {
  const result = values(name);
  if (result.length) return result[result.length - 1];
  if (required) throw new Error(`Missing required argument: ${name}`);
  return null;
}

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
  if (["codex", "qa"].includes(source)) return "Codex";
  return String(input || "Client").trim();
}

function isUrl(input) {
  return /^https?:\/\//i.test(input);
}

async function sha256(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filePath);
}

const projectRoot = path.resolve(value("--project", true));
const manifestPath = path.join(projectRoot, ".image-change-qa/manifest.json");
const product = value("--product", true);
const title = value("--title", true);
const roundInput = value("--round");
const round = roundInput || "Current review";
const afterInput = value("--after", true);
const beforeInput = value("--before");
const afterAbsolute = path.resolve(projectRoot, afterInput);
const beforeAbsolute = beforeInput ? path.resolve(projectRoot, beforeInput) : null;
const finding = value("--finding", true);
const channel = value("--channel") || "E-commerce";
const market = value("--market") || "";
const sku = value("--sku") || product;
const assetSlot = value("--asset-slot") || value("--slot") || "Image";
const productTruth = values("--product-truth").map((text) => text.trim()).filter(Boolean);

const feedback = [
  ...values("--client-feedback").map((text) => ({ source: "Client", text })),
  ...values("--internal-feedback").map((text) => ({ source: "Internal", text })),
  ...values("--codex-note").map((text) => ({ source: "Codex", text })),
  ...values("--request").map((text) => ({ source: normalizeSource(value("--source")), text })),
].filter((entry) => entry.text.trim());

if (!feedback.length) {
  throw new Error("Provide at least one --client-feedback, --internal-feedback, --codex-note, or --request");
}

await fs.access(afterAbsolute);
if (beforeAbsolute) await fs.access(beforeAbsolute);
const noBefore = process.argv.includes("--no-before");
if (beforeAbsolute && noBefore) throw new Error("Use either --before or --no-before, not both");

const identityInputs = values("--identity");
const identityLabels = values("--identity-label");
const identityCaptions = values("--identity-caption");
const identity = [];
for (let index = 0; index < identityInputs.length; index += 1) {
  const input = identityInputs[index];
  if (isUrl(input)) {
    throw new Error(`--identity must be a project-relative image so it can be fingerprinted: ${input}`);
  }
  const absolute = path.resolve(projectRoot, input);
  await fs.access(absolute);
  identity.push({
    path: path.relative(projectRoot, absolute),
    label: identityLabels[index] || path.basename(input, path.extname(input)),
    caption: identityCaptions[index] || "",
    role: "identity",
    sha256: await sha256(absolute),
  });
}

const referenceInputs = values("--reference");
const referenceLabels = values("--reference-label");
const referenceCaptions = values("--reference-caption");
const references = [];
for (let index = 0; index < referenceInputs.length; index += 1) {
  const input = referenceInputs[index];
  const label = referenceLabels[index] || (isUrl(input) ? `Reference ${index + 1}` : path.basename(input));
  const caption = referenceCaptions[index] || "";
  if (isUrl(input)) {
    references.push({ url: input, label, caption, role: "reference" });
    continue;
  }
  const absolute = path.resolve(projectRoot, input);
  await fs.access(absolute);
  references.push({
    path: path.relative(projectRoot, absolute),
    label,
    caption,
    role: "reference",
    sha256: await sha256(absolute),
  });
}

const idSeed = `${product}-${title}-${round}`;
const defaultId = roundInput
  ? `${slugify(`${product}-${title}`).slice(0, 52)}-${createHash("sha256").update(idSeed).digest("hex").slice(0, 8)}`
  : slugify(`${product}-${title}`);
const now = new Date().toISOString();
const item = {
  id: value("--id") || defaultId,
  product,
  sku,
  title,
  round,
  channel,
  market,
  assetSlot,
  productTruth,
  feedback,
  requests: feedback.map((entry) => entry.text),
  slotKey: canonicalSlot(assetSlot),
  before: beforeAbsolute ? path.relative(projectRoot, beforeAbsolute) : null,
  after: path.relative(projectRoot, afterAbsolute),
  beforeName: beforeAbsolute ? value("--before-name") || path.basename(beforeAbsolute) : null,
  afterName: value("--after-name") || path.basename(afterAbsolute),
  references: [...identity, ...references],
  finding,
  qaStatus: value("--status") || "Ready",
  parentId: null,
  beforeRound: null,
  beforeSource: beforeAbsolute ? "explicit" : noBefore ? "none" : "pending",
  beforeSha256: beforeAbsolute ? await sha256(beforeAbsolute) : null,
  afterSha256: await sha256(afterAbsolute),
  recordedAt: now,
};

await fs.mkdir(path.dirname(manifestPath), { recursive: true });
const releaseLock = await acquireLock(path.join(path.dirname(manifestPath), "manifest.lock"));
let manifest;
try {
  manifest = { version: 2, projectRoot: "..", items: [] };
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!Array.isArray(manifest.items)) manifest.items = [];
  manifest.version = Math.max(Number(manifest.version) || 1, 2);

  // A slot is a lane and every recording is a version in it. The version this one
  // supersedes is simply the newest existing version of the same lane, so it is
  // looked up rather than passed in — a caller cannot get it wrong by omission.
  const lane = manifest.items
    .filter((entry) => entry.id !== item.id
      && sameProductKey(entry) === sameProductKey(item)
      && canonicalSlot(entry.slotKey || entry.assetSlot) === item.slotKey)
    .sort((a, b) => String(a.recordedAt || a.createdAt || "").localeCompare(String(b.recordedAt || b.createdAt || "")));
  const parent = lane[lane.length - 1] || null;

  if (item.beforeSource === "pending") {
    if (parent) {
      const parentAfter = path.resolve(projectRoot, parent.after);
      await fs.access(parentAfter);
      item.before = path.relative(projectRoot, parentAfter);
      item.beforeName = parent.afterName || path.basename(parentAfter);
      item.beforeSha256 = await sha256(parentAfter);
      item.parentId = parent.id;
      item.beforeRound = parent.round || null;
      item.beforeSource = "derived";
    } else {
      item.beforeSource = "none";
    }
  } else if (item.beforeSource === "explicit" && parent) {
    // An explicit before that is not the lane's newest version is a deliberate
    // choice (a reset to an earlier design, or an original baseline). Record which
    // version it actually is so the board can say so instead of implying lineage.
    const named = lane.find((entry) => path.resolve(projectRoot, entry.after) === beforeAbsolute);
    item.parentId = named && named.id === parent.id ? parent.id : null;
    item.beforeRound = named?.round || null;
  }
  const existingIndex = manifest.items.findIndex((entry) => entry.id === item.id);
  if (existingIndex >= 0) {
    item.createdAt = manifest.items[existingIndex].createdAt || manifest.items[existingIndex].recordedAt || now;
    manifest.items[existingIndex] = item;
  } else {
    item.createdAt = now;
    manifest.items.push(item);
  }
  await atomicWriteJson(manifestPath, manifest);
} finally {
  await releaseLock();
}
console.log(JSON.stringify({
  manifestPath,
  itemId: item.id,
  round: item.round,
  slot: item.slotKey,
  mode: item.before ? "revision" : "new-image",
  before: item.before,
  beforeSource: item.beforeSource,
  parentId: item.parentId,
  identitySlots: identity.length,
  references: references.length,
  items: manifest.items.length,
}));
