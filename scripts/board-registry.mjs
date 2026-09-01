import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson } from "./review-state.mjs";

export const DEFAULT_PORT = 43119;

export function stateDirectory(override = null) {
  return path.resolve(
    override
      || process.env.COMMERCE_QA_STATE_DIR
      || path.join(os.homedir(), "Documents", "Codex", ".commerce-qa"),
  );
}

export function servicePaths(stateDir) {
  return {
    service: path.join(stateDir, "service.json"),
    registry: path.join(stateDir, "registry.json"),
    lock: path.join(stateDir, "starting.lock"),
    log: path.join(stateDir, "service.log"),
  };
}

function slugify(value) {
  return String(value || "commerce-qa")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "commerce-qa";
}

export async function canonicalProjectRoot(projectRoot) {
  const resolved = path.resolve(projectRoot);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

export async function ensureBoardMetadata(projectRootInput, requestedName = null) {
  const projectRoot = await canonicalProjectRoot(projectRootInput);
  const qaDir = path.join(projectRoot, ".image-change-qa");
  const metadataPath = path.join(qaDir, "board.json");
  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const name = String(requestedName || existing?.name || path.basename(projectRoot)).trim();
  const hash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 10);
  const board = {
    version: 1,
    id: existing?.id || `${slugify(name)}-${hash}`,
    token: existing?.token || randomBytes(18).toString("base64url"),
    name,
    projectRoot,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteJson(metadataPath, board);
  return board;
}

// The service keeps the skill's modules in memory, so an edited skill would keep
// serving the old behaviour until someone noticed. Stamping the code lets the
// launcher retire a service that no longer matches the files on disk.
export async function codeStamp() {
  const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const parts = [];
  for (const directory of ["scripts", "assets"]) {
    const full = path.join(skillDir, directory);
    const names = await fs.readdir(full).catch(() => []);
    for (const name of names.sort()) {
      const stat = await fs.stat(path.join(full, name)).catch(() => null);
      if (stat?.isFile()) parts.push(`${directory}/${name}:${stat.mtimeMs}:${stat.size}`);
    }
  }
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}
