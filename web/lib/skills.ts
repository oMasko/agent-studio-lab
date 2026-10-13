import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, normalize, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import JSZip from "jszip";
import { parse as parseYaml } from "yaml";


export type SkillScope = "main" | "subagent" | "both";

export type SkillFileEntry = {
  path: string;
  size: number;
  kind: "file" | "directory";
};

export type InstalledSkill = {
  name: string;
  description: string;
  requiredCapabilities: string[];
  enabled: boolean;
  scope: SkillScope;
  path: string;
  fileCount: number;
  totalSize: number;
  updatedAt: number;
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
  files?: SkillFileEntry[];
};

type SkillState = Record<string, { enabled: boolean; scope: SkillScope }>;
type InstallFile = { path: string; data: Uint8Array };

const projectRoot = resolve(process.cwd(), "..");
const skillsRoot = join(projectRoot, ".agents", "skills");
const statePath = join(projectRoot, ".agent-studio", "skills-state.json");
const maxArchiveSize = 50 * 1024 * 1024;
const maxFileSize = 25 * 1024 * 1024;
const maxExpandedSize = 100 * 1024 * 1024;
const maxFiles = 500;

export class SkillPackageError extends Error {}

async function ensureRoots() {
  await mkdir(skillsRoot, { recursive: true });
  await mkdir(dirname(statePath), { recursive: true });
}

async function readState(): Promise<SkillState> {
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as SkillState;
  } catch {
    return {};
  }
}

async function writeState(state: SkillState) {
  await ensureRoots();
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function validateSkillName(name: string): string {
  const clean = name.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(clean)) {
    throw new SkillPackageError("Skill name 只能使用小写字母、数字和短横线，且最长 64 个字符。");
  }
  return clean;
}

function safeRelativePath(input: string): string {
  const unix = input.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!unix || unix.startsWith("/") || unix.includes("\0")) throw new SkillPackageError("Skill 包含无效文件路径。");
  const parts = unix.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new SkillPackageError("Skill 包含不安全的路径穿越片段。");
  return parts.join("/");
}

function parseSkillManifest(content: string) {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/);
  if (!match) throw new SkillPackageError("SKILL.md 缺少有效的 YAML frontmatter。");
  let metadata: unknown;
  try {
    metadata = parseYaml(match[1]);
  } catch (error) {
    throw new SkillPackageError(`SKILL.md frontmatter 解析失败：${error instanceof Error ? error.message : "未知错误"}`);
  }
  if (!metadata || typeof metadata !== "object") throw new SkillPackageError("SKILL.md frontmatter 必须是对象。");
  const value = metadata as Record<string, unknown>;
  const name = validateSkillName(typeof value.name === "string" ? value.name : "");
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (!description) throw new SkillPackageError("SKILL.md 必须包含非空 description。");
  const requiredCapabilities = Array.isArray(value.requires)
    ? [...new Set(value.requires.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))]
    : [];
  if (requiredCapabilities.length > 20) throw new SkillPackageError("SKILL.md 最多声明 20 个 requires 能力。");
  if (requiredCapabilities.some((item) => !/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(item))) {
    throw new SkillPackageError("SKILL.md 的 requires 必须使用 namespace:capability 格式。");
  }
  return { name, description, requiredCapabilities, body: match[2].trim() };
}

async function walkDirectory(root: string, current = root): Promise<SkillFileEntry[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const output: SkillFileEntry[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = join(current, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    if (entry.isDirectory()) {
      output.push({ path, size: 0, kind: "directory" });
      output.push(...await walkDirectory(root, absolute));
    } else if (entry.isFile()) {
      const info = await stat(absolute);
      output.push({ path, size: info.size, kind: "file" });
    }
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

export async function listInstalledSkills(includeFiles = false): Promise<InstalledSkill[]> {
  await ensureRoots();
  const state = await readState();
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const skills: InstalledSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".install-")) continue;
    const directory = join(skillsRoot, entry.name);
    try {
      const skillMd = await readFile(join(directory, "SKILL.md"), "utf8");
      const manifest = parseSkillManifest(skillMd);
      if (entry.name !== manifest.name) continue;
      const files = await walkDirectory(directory);
      const rootInfo = await stat(directory);
      const setting = state[manifest.name] ?? { enabled: false, scope: "both" as const };
      skills.push({
        name: manifest.name,
        description: manifest.description,
        requiredCapabilities: manifest.requiredCapabilities,
        enabled: setting.enabled,
        scope: setting.scope,
        path: directory,
        fileCount: files.filter((file) => file.kind === "file").length,
        totalSize: files.reduce((total, file) => total + file.size, 0),
        updatedAt: rootInfo.mtimeMs,
        hasScripts: files.some((file) => file.path.startsWith("scripts/")),
        hasReferences: files.some((file) => file.path.startsWith("references/")),
        hasAssets: files.some((file) => file.path.startsWith("assets/")),
        files: includeFiles ? files : undefined,
      });
    } catch {
      // Invalid directories are not exposed as installable skills.
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function stripSingleTopDirectory(files: InstallFile[]): InstallFile[] {
  const paths = files.map((file) => safeRelativePath(file.path));
  const hasRootManifest = paths.some((path) => path.toLowerCase() === "skill.md");
  if (hasRootManifest) return files.map((file, index) => ({ ...file, path: paths[index] }));
  const firstSegments = new Set(paths.map((path) => path.split("/")[0]));
  if (firstSegments.size !== 1) throw new SkillPackageError("ZIP 或目录必须只包含一个 Skill 项目。");
  return files.map((file, index) => ({ ...file, path: paths[index].split("/").slice(1).join("/") })).filter((file) => file.path);
}

export async function installSkillFiles(inputFiles: InstallFile[]): Promise<InstalledSkill> {
  inputFiles = inputFiles.filter((file) => {
    const path = file.path.replaceAll("\\", "/");
    const parts = path.split("/");
    return !parts.some((part) => part === ".git" || part === "node_modules" || part === ".DS_Store" || part.startsWith("._"));
  });
  if (inputFiles.length === 0) throw new SkillPackageError("没有收到任何文件。");
  if (inputFiles.length > maxFiles) throw new SkillPackageError(`Skill 最多包含 ${maxFiles} 个文件。`);
  if (inputFiles.some((file) => file.data.byteLength > maxFileSize)) throw new SkillPackageError("Skill 中存在超过 25 MB 的单个文件。");
  const files = stripSingleTopDirectory(inputFiles);
  const manifests = files.filter((file) => file.path.toLowerCase() === "skill.md");
  if (manifests.length !== 1) throw new SkillPackageError("Skill 根目录必须且只能包含一个 SKILL.md。");
  const manifest = parseSkillManifest(new TextDecoder().decode(manifests[0].data));

  await ensureRoots();
  const target = join(skillsRoot, manifest.name);
  try {
    await stat(target);
    throw new SkillPackageError(`Skill「${manifest.name}」已存在，请先删除旧版本。`);
  } catch (error) {
    if (error instanceof SkillPackageError) throw error;
  }

  const staging = join(skillsRoot, `.install-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    for (const file of files) {
      const path = safeRelativePath(file.path);
      const absolute = join(staging, ...path.split("/"));
      const resolved = normalize(absolute);
      if (!resolved.startsWith(`${staging}${sep}`)) throw new SkillPackageError("Skill 文件路径越界。");
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, file.data);
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  const state = await readState();
  state[manifest.name] = { enabled: false, scope: "both" };
  await writeState(state);
  const installed = (await listInstalledSkills(true)).find((skill) => skill.name === manifest.name);
  if (!installed) throw new SkillPackageError("Skill 安装后校验失败。");
  return installed;
}

export async function installSkillZip(data: Uint8Array): Promise<InstalledSkill> {
  if (data.byteLength > maxArchiveSize) throw new SkillPackageError("ZIP 不能超过 50 MB。");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data, { checkCRC32: true });
  } catch {
    throw new SkillPackageError("无法解析 ZIP 文件。");
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir && !entry.name.startsWith("__MACOSX/") && !basename(entry.name).startsWith("._"));
  if (entries.length > maxFiles) throw new SkillPackageError(`Skill 最多包含 ${maxFiles} 个文件。`);
  const files: InstallFile[] = [];
  let expandedSize = 0;
  for (const entry of entries) {
    const data = await entry.async("uint8array");
    expandedSize += data.byteLength;
    if (expandedSize > maxExpandedSize) throw new SkillPackageError("Skill 解压后的总大小不能超过 100 MB。");
    files.push({ path: entry.name, data });
  }
  return installSkillFiles(files);
}

export async function updateSkillState(name: string, patch: { enabled?: boolean; scope?: SkillScope }) {
  const skillName = validateSkillName(name);
  const installed = (await listInstalledSkills()).some((skill) => skill.name === skillName);
  if (!installed) throw new SkillPackageError("Skill 不存在。");
  const state = await readState();
  const current = state[skillName] ?? { enabled: false, scope: "both" as const };
  state[skillName] = { enabled: patch.enabled ?? current.enabled, scope: patch.scope ?? current.scope };
  await writeState(state);
}

export async function deleteSkill(name: string) {
  const skillName = validateSkillName(name);
  const target = join(skillsRoot, skillName);
  const resolved = normalize(target);
  if (dirname(resolved) !== skillsRoot) throw new SkillPackageError("Skill 路径无效。");
  await rm(resolved, { recursive: true, force: false });
  const state = await readState();
  delete state[skillName];
  await writeState(state);
}

export async function readSkillFile(name: string, requestedPath: string): Promise<string> {
  const skillName = validateSkillName(name);
  const path = safeRelativePath(requestedPath);
  const root = join(skillsRoot, skillName);
  const absolute = normalize(join(root, ...path.split("/")));
  if (!absolute.startsWith(`${root}${sep}`)) throw new SkillPackageError("文件路径越界。");
  const info = await stat(absolute);
  if (!info.isFile()) throw new SkillPackageError("请求路径不是文件。");
  if (info.size > 1024 * 1024) throw new SkillPackageError("Agent 单次只能读取不超过 1 MB 的 Skill 文本文件。");
  const buffer = await readFile(absolute);
  if (buffer.includes(0)) throw new SkillPackageError("该文件是二进制资源，不能作为文本读取。");
  return buffer.toString("utf8");
}

export async function loadSkillForAgent(name: string) {
  const skill = (await listInstalledSkills(true)).find((item) => item.name === name && item.enabled);
  if (!skill) throw new SkillPackageError("Skill 未安装或未启用。");
  const instructions = await readSkillFile(skill.name, "SKILL.md");
  return {
    name: skill.name,
    description: skill.description,
    requiredCapabilities: skill.requiredCapabilities,
    instructions,
    files: skill.files?.filter((file) => file.kind === "file").map((file) => file.path) ?? [],
    note: "scripts/ 中的文件仅供检查，本运行时不会直接执行任意 Skill 脚本。可按 SKILL.md 的路由读取 references/ 或文本 assets/。",
  };
}

export async function buildSkillBackup(name: string): Promise<Uint8Array> {
  const skill = (await listInstalledSkills(true)).find((item) => item.name === name);
  if (!skill?.files) throw new SkillPackageError("Skill 不存在。");
  const zip = new JSZip();
  for (const file of skill.files.filter((entry) => entry.kind === "file")) {
    zip.file(`${skill.name}/${file.path}`, await readFile(join(skill.path, ...file.path.split("/"))));
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
