import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { acquireLock, atomicWriteJson } from "./review-state.mjs";
import { readTruthRegistry, truthKey } from "./qa-core.mjs";

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

function hasArg(name) {
  return process.argv.includes(name);
}

async function sha256(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

const projectRoot = path.resolve(value("--project", true));
const qaDir = path.join(projectRoot, ".image-change-qa");
const truthPath = path.join(qaDir, "truth.json");
const key = value("--sku") || value("--product");
const listOnly = hasArg("--list") || !key;

if (listOnly) {
  const products = await readTruthRegistry(qaDir);
  console.log(JSON.stringify({
    truthPath,
    products: Object.entries(products).map(([productKey, entry]) => ({
      key: productKey,
      label: entry.label || productKey,
      identity: (entry.identity || []).map((reference) => ({ path: reference.path, label: reference.label, caption: reference.caption || "" })),
      productTruth: entry.productTruth || [],
    })),
  }, null, 2));
  process.exit(0);
}

const inputs = values("--identity");
const labels = values("--identity-label");
const captions = values("--identity-caption");
const productTruth = values("--product-truth").map((entry) => entry.trim()).filter(Boolean);
const clear = hasArg("--clear");
if (!inputs.length && !productTruth.length && !clear) {
  throw new Error("Provide at least one --identity <project-relative image> or --product-truth <invariant>, or --clear to drop the registered truth");
}

const identity = [];
for (let index = 0; index < inputs.length; index += 1) {
  const input = inputs[index];
  if (/^https?:\/\//i.test(input)) {
    throw new Error(`--identity must be a project-relative image so it can be fingerprinted: ${input}`);
  }
  const absolute = path.resolve(projectRoot, input);
  await fs.access(absolute);
  identity.push({
    path: path.relative(projectRoot, absolute),
    label: labels[index] || path.basename(input, path.extname(input)),
    caption: captions[index] || "",
    role: "identity",
    sha256: await sha256(absolute),
  });
}

await fs.mkdir(qaDir, { recursive: true });
const releaseLock = await acquireLock(path.join(qaDir, "truth.lock"));
let registry;
try {
  registry = { version: 1, products: {} };
  try {
    const raw = JSON.parse(await fs.readFile(truthPath, "utf8"));
    if (raw?.products && typeof raw.products === "object") registry = { version: 1, ...raw, products: raw.products };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const productKey = truthKey(key);
  const previous = registry.products[productKey] || {};
  const replacements = new Map(identity.map((reference) => [reference.path, reference]));
  const merged = clear
    ? identity
    : [
      ...(previous.identity || []).map((reference) => replacements.get(reference.path) || reference),
      ...identity.filter((reference) => !(previous.identity || []).some((entry) => entry.path === reference.path)),
    ];
  const mergedTruth = clear ? productTruth : [...new Set([...(previous.productTruth || []), ...productTruth])];
  if (!merged.length && !mergedTruth.length) delete registry.products[productKey];
  else registry.products[productKey] = { label: key, identity: merged, productTruth: mergedTruth, updatedAt: new Date().toISOString() };
  await atomicWriteJson(truthPath, registry);
} finally {
  await releaseLock();
}

const stored = registry.products[truthKey(key)] || {};
console.log(JSON.stringify({
  truthPath,
  sku: key,
  identitySlots: (stored.identity || []).length,
  identity: (stored.identity || []).map((reference) => ({ path: reference.path, label: reference.label, caption: reference.caption || "" })),
  productTruth: stored.productTruth || [],
  appliesTo: "every recorded image whose --sku or --product matches, in this project, from any chat",
}, null, 2));
