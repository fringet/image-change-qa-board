import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadQaProject } from "./qa-core.mjs";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

function argValues(name) {
  const result = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && index + 1 < process.argv.length) {
      result.push(process.argv[index + 1]);
    }
  }
  return result;
}

function argValue(name, required = false) {
  const values = argValues(name);
  if (values.length) return values[values.length - 1];
  if (required) throw new Error(`Missing required argument: ${name}`);
  return null;
}

function hasArg(name) {
  return process.argv.includes(name);
}




const projectArg = argValue("--project");
const configArg = argValue("--config");
if (!projectArg && !configArg) {
  throw new Error("Provide --project <root> or --config <manifest.json>");
}

const projectRoot = projectArg ? path.resolve(projectArg) : null;
const configPath = configArg
  ? path.resolve(configArg)
  : path.join(projectRoot, ".image-change-qa/manifest.json");
const configDir = path.dirname(configPath);
const outputPath = path.resolve(
  argValue("--output") || path.join(configDir, "board.html"),
);
const templatePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../assets/qa-board-fragment.html",
);

const loaded = await loadQaProject({
  projectRoot,
  configPath,
  roundFilter: argValue("--round"),
  latestRound: hasArg("--latest-round"),
  sourceFilter: argValue("--source"),
});
const rawConfig = { summary: loaded.data.summary };
const normalizedItems = loaded.data.items;
const staleItems = loaded.staleItems;
const missingItems = loaded.missingItems || [];


async function encodeImage(filePath, maxEdge, quality) {
  const bytes = await sharp(filePath)
    .resize(maxEdge, maxEdge, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

async function buildData(maxEdge, quality) {
  const items = [];
  for (const item of normalizedItems) {
    const references = [];
    for (const reference of item.references) {
      references.push(reference.kind === "image"
        ? { ...reference, path: undefined, image: await encodeImage(reference.path, Math.min(maxEdge, 520), quality) }
        : reference);
    }
    items.push({
      ...item,
      beforePath: undefined,
      afterPath: undefined,
      before: item.beforePath ? await encodeImage(item.beforePath, maxEdge, quality) : null,
      after: await encodeImage(item.afterPath, maxEdge, quality),
      references,
    });
  }
  const feedbackCount = items.reduce((sum, item) => sum + item.feedback.length, 0);
  const referenceCount = items.reduce((sum, item) => sum + item.references.length, 0);
  const rounds = [...new Set(items.map((item) => item.round))];
  return {
    summary: rawConfig.summary || `${items.length} images · ${feedbackCount} feedback items · ${rounds.length} round${rounds.length === 1 ? "" : "s"}`,
    items,
    rounds,
    referenceCount,
  };
}

const template = await fs.readFile(templatePath, "utf8");
for (const requiredToken of [
  "__QA_DATA__",
  'id="icq-viewer"',
  'id="icq-send-top"',
  'id="icq-send-all"',
  'id="icq-batch-body"',
  'id="icq-reference-list"',
]) {
  if (!template.includes(requiredToken)) {
    throw new Error(`Board template is missing required contract token: ${requiredToken}`);
  }
}

let output = "";
for (const [maxEdge, quality] of [[640, 72], [520, 64], [420, 58], [360, 52]]) {
  const data = await buildData(maxEdge, quality);
  output = template.replace("__QA_DATA__", JSON.stringify(data).replaceAll("<", "\\u003c"));
  if (Buffer.byteLength(output) < 1_950_000) break;
}

if (Buffer.byteLength(output) >= 2_000_000) {
  throw new Error("QA board exceeds 2 MB; use --round or --latest-round to keep the review lightweight");
}
for (const requiredOutput of [
  "New image",
  "Reference examples",
  "Send complete QA to Codex",
  "sendFollowUpMessage",
]) {
  if (!output.includes(requiredOutput)) {
    throw new Error(`Generated board failed contract check: ${requiredOutput}`);
  }
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, output);
console.log(JSON.stringify({
  outputPath,
  bytes: Buffer.byteLength(output),
  items: normalizedItems.length,
  rounds: [...new Set(normalizedItems.map((item) => item.round))],
  staleItems,
  contract: "passed",
}));
