import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { tool } from "@openai/agents";
import { z } from "zod";

import type { SafetySettings } from "@/lib/safety-store";
import type { ManagedTool, ToolSecurityProfile } from "@/lib/tool-capabilities";

const workspaceRoot = resolve(process.cwd(), "..");
const maxReadBytes = 1024 * 1024;
const maxWriteBytes = 2 * 1024 * 1024;
const maxCommandOutput = 96 * 1024;
const ignoredDirectories = new Set([
  ".git", ".next", "node_modules", "dist", "build", "coverage",
  ".data", ".venv", ".pytest_cache", ".cache", "__pycache__",
]);
const blockedExecutables = new Set([
  "sudo", "su", "ssh", "scp", "sftp", "shutdown", "reboot", "halt", "mount", "umount",
  "diskutil", "launchctl", "osascript", "open", "killall", "pkill",
]);

export class WorkspaceToolError extends Error {}

function normalizedRelativePath(input: string, allowRoot = false): string {
  const value = input.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (allowRoot && (!value || value === ".")) return ".";
  if ((!value && !allowRoot) || value.includes("\0") || isAbsolute(value)) {
    throw new WorkspaceToolError("路径必须是工作区内的相对路径。");
  }
  const parts = value.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new WorkspaceToolError("路径不能包含 . 或 ..。");
  return parts.join("/") || ".";
}

function blockedPathReason(relativePath: string): string | undefined {
  const parts = relativePath.split("/").filter((part) => part && part !== ".");
  const lower = parts.map((part) => part.toLowerCase());
  if (lower.some((part) => ignoredDirectories.has(part))) return "构建产物、依赖目录或版本控制目录不可访问";
  if (lower[0] === ".agent-studio") return "Agent Studio 的策略、Trace 和运行状态目录不可由 Agent 修改或读取";
  const name = lower.at(-1) ?? "";
  if (name === ".env" || name.startsWith(".env.")) return "环境变量文件可能包含密钥";
  if (/\.(pem|key|p12|pfx|jks|keystore)$/.test(name) || /^(id_rsa|id_ed25519|credentials)$/.test(name)) {
    return "证书或凭据文件不可访问";
  }
  return undefined;
}

async function resolveWorkspacePath(input: string, options: { allowRoot?: boolean; mustExist?: boolean } = {}): Promise<{ absolute: string; relative: string }> {
  const relativePath = normalizedRelativePath(input, options.allowRoot);
  const blocked = blockedPathReason(relativePath);
  if (blocked) throw new WorkspaceToolError(`拒绝访问 ${JSON.stringify(relativePath)}：${blocked}。`);
  const absolute = resolve(/*turbopackIgnore: true*/ workspaceRoot, relativePath);
  if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}${sep}`)) throw new WorkspaceToolError("路径超出工作区。");

  const parts = relativePath === "." ? [] : relativePath.split("/");
  let cursor = workspaceRoot;
  for (const part of parts) {
    cursor = resolve(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new WorkspaceToolError(`拒绝访问符号链接路径：${relativePath}。`);
    } catch (error) {
      if (error instanceof WorkspaceToolError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (options.mustExist) throw new WorkspaceToolError(`路径不存在：${relativePath}。`);
      break;
    }
  }
  if (options.mustExist) {
    const canonicalRoot = await realpath(workspaceRoot);
    const canonical = await realpath(/*turbopackIgnore: true*/ absolute);
    if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) throw new WorkspaceToolError("真实路径超出工作区。");
  }
  return { absolute, relative: relativePath };
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0);
}

async function walkFiles(rootPath: string, rootRelative: string, depth: number, output: string[], maxEntries: number): Promise<void> {
  if (output.length >= maxEntries) return;
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (output.length >= maxEntries) return;
    const childRelative = rootRelative === "." ? entry.name : `${rootRelative}/${entry.name}`;
    if (blockedPathReason(childRelative)) continue;
    output.push(entry.isDirectory() ? `${childRelative}/` : childRelative);
    if (entry.isDirectory() && depth > 1) await walkFiles(resolve(rootPath, entry.name), childRelative, depth - 1, output, maxEntries);
  }
}

async function searchableFiles(rootPath: string, rootRelative: string, output: Array<{ absolute: string; relative: string }>, maxFiles = 1_500): Promise<void> {
  if (output.length >= maxFiles) return;
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    if (output.length >= maxFiles) return;
    const childRelative = rootRelative === "." ? entry.name : `${rootRelative}/${entry.name}`;
    if (blockedPathReason(childRelative)) continue;
    const absolute = resolve(rootPath, entry.name);
    if (entry.isDirectory()) await searchableFiles(absolute, childRelative, output, maxFiles);
    else if (entry.isFile()) output.push({ absolute, relative: childRelative });
  }
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = resolve(dirname(target), `.agent-write-${randomUUID()}.tmp`);
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

function profile(input: Omit<ToolSecurityProfile, "source">): ToolSecurityProfile {
  return { source: "function", ...input };
}

function readTools(): ManagedTool[] {
  return [
    {
      tool: tool({
        name: "workspace_list_files",
        description: "列出当前 Agent Studio 项目工作区内的文件。会跳过依赖、构建产物、密钥和内部运行状态目录。",
        parameters: z.object({
          path: z.string().default(".").describe("工作区内相对目录，默认项目根目录"),
          depth: z.number().int().min(1).max(4).default(2).describe("递归深度，1 到 4"),
        }),
        async execute({ path, depth }) {
          const target = await resolveWorkspacePath(path, { allowRoot: true, mustExist: true });
          const info = await stat(/*turbopackIgnore: true*/ target.absolute);
          if (!info.isDirectory()) throw new WorkspaceToolError("workspace_list_files 的 path 必须是目录。");
          const files: string[] = [];
          await walkFiles(target.absolute, target.relative, depth, files, 400);
          return JSON.stringify({ workspace: ".", path: target.relative, entries: files, truncated: files.length >= 400 });
        },
      }),
      profile: profile({ capabilities: ["filesystem:read"], riskLevel: "low", effect: "read", description: "列出工作区文件" }),
    },
    {
      tool: tool({
        name: "workspace_read_file",
        description: "读取 Agent Studio 项目工作区内的 UTF-8 文本文件，可指定行号范围。密钥和内部状态文件不可读取。",
        parameters: z.object({
          path: z.string().describe("工作区内相对文件路径"),
          startLine: z.number().int().min(1).default(1),
          endLine: z.number().int().min(1).max(10_000).optional(),
        }),
        async execute({ path, startLine, endLine }) {
          const target = await resolveWorkspacePath(path, { mustExist: true });
          const info = await stat(/*turbopackIgnore: true*/ target.absolute);
          if (!info.isFile()) throw new WorkspaceToolError("请求路径不是文件。");
          if (info.size > maxReadBytes) throw new WorkspaceToolError("单次不能读取超过 1 MB 的文件。");
          const buffer = await readFile(/*turbopackIgnore: true*/ target.absolute);
          if (isProbablyBinary(buffer)) throw new WorkspaceToolError("不能读取二进制文件。");
          const lines = buffer.toString("utf8").split(/\r?\n/);
          const last = Math.min(endLine ?? Math.min(startLine + 499, lines.length), lines.length);
          if (last < startLine) throw new WorkspaceToolError("endLine 不能小于 startLine。");
          const content = lines.slice(startLine - 1, last).map((line, index) => `${startLine + index}: ${line}`).join("\n");
          return JSON.stringify({ path: target.relative, startLine, endLine: last, totalLines: lines.length, content });
        },
      }),
      profile: profile({ capabilities: ["filesystem:read"], riskLevel: "low", effect: "read", description: "读取工作区文本文件" }),
    },
    {
      tool: tool({
        name: "workspace_search",
        description: "在 Agent Studio 项目工作区的文本文件中搜索普通文本，返回文件、行号和匹配内容。",
        parameters: z.object({
          query: z.string().min(1).max(300).describe("要搜索的普通文本，不是正则表达式"),
          path: z.string().default(".").describe("工作区内相对目录或文件"),
          caseSensitive: z.boolean().default(false),
          maxResults: z.number().int().min(1).max(200).default(50),
        }),
        async execute({ query, path, caseSensitive, maxResults }) {
          const target = await resolveWorkspacePath(path, { allowRoot: true, mustExist: true });
          const info = await stat(/*turbopackIgnore: true*/ target.absolute);
          const files: Array<{ absolute: string; relative: string }> = [];
          if (info.isFile()) files.push(target);
          else if (info.isDirectory()) await searchableFiles(target.absolute, target.relative, files);
          const needle = caseSensitive ? query : query.toLocaleLowerCase();
          const matches: Array<{ path: string; line: number; text: string }> = [];
          for (const file of files) {
            if (matches.length >= maxResults) break;
            const info = await stat(file.absolute);
            if (info.size > maxReadBytes) continue;
            const buffer = await readFile(file.absolute);
            if (isProbablyBinary(buffer)) continue;
            const lines = buffer.toString("utf8").split(/\r?\n/);
            for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
              const haystack = caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
              if (haystack.includes(needle)) matches.push({ path: file.relative, line: index + 1, text: lines[index].slice(0, 500) });
            }
          }
          return JSON.stringify({ query, path: target.relative, matches, truncated: matches.length >= maxResults });
        },
      }),
      profile: profile({ capabilities: ["filesystem:read"], riskLevel: "low", effect: "read", description: "搜索工作区文本" }),
    },
  ];
}

function writeTool(): ManagedTool {
  return {
    tool: tool({
      name: "workspace_apply_patch",
      description: "真实修改工作区文件。支持创建、精确文本替换、追加和可恢复删除；每次调用都必须由用户审批。",
      parameters: z.object({
        operation: z.enum(["create", "replace", "append", "delete"]),
        path: z.string().describe("工作区内相对文件路径"),
        content: z.string().max(maxWriteBytes).optional().describe("create 或 append 使用的内容"),
        oldText: z.string().max(maxWriteBytes).optional().describe("replace 要精确匹配的旧文本"),
        newText: z.string().max(maxWriteBytes).optional().describe("replace 使用的新文本"),
        replaceAll: z.boolean().default(false),
      }),
      needsApproval: true,
      async execute({ operation, path, content, oldText, newText, replaceAll }) {
        const target = await resolveWorkspacePath(path, { mustExist: operation !== "create" });
        if (operation === "delete") {
          const info = await stat(/*turbopackIgnore: true*/ target.absolute);
          if (!info.isFile()) throw new WorkspaceToolError("只能删除文件，不能删除目录。");
          const trash = resolve(workspaceRoot, ".agent-studio", "trash");
          await mkdir(trash, { recursive: true });
          const destination = resolve(trash, `${Date.now()}-${randomUUID()}-${basename(target.absolute)}`);
          await rename(target.absolute, destination);
          return JSON.stringify({ operation, path: target.relative, recoverable: true, message: "文件已移动到项目内的受保护回收目录。" });
        }
        if (operation === "create") {
          if (typeof content !== "string") throw new WorkspaceToolError("create 操作必须提供 content。");
          try { await lstat(target.absolute); throw new WorkspaceToolError("目标文件已存在，请使用 replace。"); }
          catch (error) { if (error instanceof WorkspaceToolError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          await atomicWrite(target.absolute, content);
          return JSON.stringify({ operation, path: target.relative, bytes: Buffer.byteLength(content) });
        }
        const info = await stat(/*turbopackIgnore: true*/ target.absolute);
        if (!info.isFile() || info.size > maxWriteBytes) throw new WorkspaceToolError("只能修改不超过 2 MB 的普通文件。");
        const buffer = await readFile(/*turbopackIgnore: true*/ target.absolute);
        if (isProbablyBinary(buffer)) throw new WorkspaceToolError("不能修改二进制文件。");
        const current = buffer.toString("utf8");
        let next: string;
        if (operation === "append") {
          if (typeof content !== "string") throw new WorkspaceToolError("append 操作必须提供 content。");
          next = `${current}${content}`;
        } else {
          if (!oldText || typeof newText !== "string") throw new WorkspaceToolError("replace 操作必须提供非空 oldText 和 newText。");
          const occurrences = current.split(oldText).length - 1;
          if (occurrences === 0) throw new WorkspaceToolError("oldText 在目标文件中不存在，请先重新读取文件。");
          if (!replaceAll && occurrences > 1) throw new WorkspaceToolError("oldText 出现多次；请提供更多上下文或明确 replaceAll=true。");
          next = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);
        }
        if (Buffer.byteLength(next) > maxWriteBytes) throw new WorkspaceToolError("修改后的文件不能超过 2 MB。");
        await atomicWrite(target.absolute, next);
        return JSON.stringify({ operation, path: target.relative, beforeBytes: buffer.byteLength, afterBytes: Buffer.byteLength(next) });
      },
    }),
    profile: profile({ capabilities: ["filesystem:write"], riskLevel: "high", effect: "write", description: "创建、修改或可恢复删除工作区文件" }),
  };
}

function commandTool(maxSeconds: number): ManagedTool {
  return {
    tool: tool({
      name: "workspace_run_command",
      description: "在 Agent Studio 项目目录内真实执行一个非交互命令。命令和参数分开传递，不经过隐式 Shell；执行前始终需要用户审批。",
      parameters: z.object({
        command: z.string().min(1).max(300).describe("可执行程序，例如 npm、node、bash"),
        args: z.array(z.string().max(4_000)).max(100).default([]).describe("独立参数数组；使用 bash -lc 时完整命令必须作为一个参数显示"),
        cwd: z.string().default(".").describe("工作区内的相对工作目录"),
        timeoutSeconds: z.number().int().min(1).max(maxSeconds).default(Math.min(20, maxSeconds)),
      }),
      needsApproval: true,
      async execute({ command, args, cwd, timeoutSeconds }) {
        const target = await resolveWorkspacePath(cwd, { allowRoot: true, mustExist: true });
        if (!(await stat(/*turbopackIgnore: true*/ target.absolute)).isDirectory()) throw new WorkspaceToolError("命令 cwd 必须是工作区内的目录。");
        const executableName = basename(command).toLowerCase();
        if (blockedExecutables.has(executableName)) throw new WorkspaceToolError(`命令 ${JSON.stringify(executableName)} 被运行时硬性禁止。`);
        if (/\s/.test(command) || command.includes("\0")) throw new WorkspaceToolError("command 必须只包含可执行程序，参数请放入 args。");
        if (command.includes("/")) {
          if (isAbsolute(command)) {
            const allowedPrefixes = ["/bin/", "/usr/bin/", "/usr/local/bin/", "/opt/homebrew/bin/"];
            if (!allowedPrefixes.some((prefix) => command.startsWith(prefix))) throw new WorkspaceToolError("绝对可执行程序只能来自受信任的系统 bin 目录。");
          } else {
            await resolveWorkspacePath(relative(workspaceRoot, resolve(target.absolute, command)), { mustExist: true });
          }
        }

        const runtimeHome = resolve(workspaceRoot, ".agent-studio", "runtime-home");
        const runtimeTmp = resolve(runtimeHome, "tmp");
        await mkdir(runtimeTmp, { recursive: true });
        const env: NodeJS.ProcessEnv = {
          NODE_ENV: process.env.NODE_ENV,
          PATH: process.env.PATH,
          LANG: process.env.LANG ?? "en_US.UTF-8",
          LC_ALL: process.env.LC_ALL,
          TERM: "dumb",
          HOME: runtimeHome,
          TMPDIR: runtimeTmp,
          CI: "1",
          NO_COLOR: "1",
          npm_config_yes: "true",
          npm_config_cache: resolve(runtimeHome, "npm-cache"),
        };
        const child = spawn(command, args, {
          cwd: target.absolute,
          env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let truncated = false;
        const append = (current: string, chunk: Buffer) => {
          const remaining = maxCommandOutput - Buffer.byteLength(current);
          if (remaining <= 0) { truncated = true; return current; }
          const text = chunk.toString("utf8");
          if (Buffer.byteLength(text) > remaining) truncated = true;
          return current + Buffer.from(text).subarray(0, remaining).toString("utf8");
        };
        child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
        child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutSeconds * 1_000);
        const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveOutcome, reject) => {
          child.once("error", reject);
          child.once("close", (exitCode, signal) => resolveOutcome({ exitCode, signal }));
        }).finally(() => clearTimeout(timeout));
        return JSON.stringify({
          command,
          args,
          cwd: target.relative,
          ...outcome,
          timedOut,
          truncated,
          stdout,
          stderr,
          security: "环境变量已清理且 cwd 受限；这是本地主机进程，不是操作系统级容器。",
        });
      },
    }),
    profile: profile({ capabilities: ["process:execute", "filesystem:read", "filesystem:write", "network:access"], riskLevel: "critical", effect: "execute", description: "在本地主机执行工作区命令" }),
  };
}

export function createWorkspaceTools(settings: SafetySettings, options: { mutating: boolean }): ManagedTool[] {
  const tools: ManagedTool[] = [];
  if (settings.workspace.readEnabled) tools.push(...readTools());
  if (options.mutating && settings.workspace.writeEnabled) tools.push(writeTool());
  if (options.mutating && settings.workspace.shellEnabled) tools.push(commandTool(settings.workspace.maxCommandSeconds));
  return tools;
}

export function getWorkspaceRoot(): string {
  return workspaceRoot;
}
