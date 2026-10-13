import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { DEFAULT_MAIN_INSTRUCTIONS, DEFAULT_SUBAGENT_INSTRUCTIONS } from "@/lib/config-types";

export type PromptPreset = {
  id: string;
  name: string;
  description: string;
  mainInstructions: string;
  subagentInstructions: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type PromptStore = { version: 1; prompts: PromptPreset[] };

const storePath = resolve(process.cwd(), "..", ".agent-studio", "prompts.json");

export class PromptStoreError extends Error {}

function defaults(): PromptStore {
  const now = new Date().toISOString();
  return {
    version: 1,
    prompts: [{
      id: "default",
      name: "通用 Agent",
      description: "项目默认的通用 Main Agent 与 Subagent 提示词。",
      mainInstructions: DEFAULT_MAIN_INSTRUCTIONS,
      subagentInstructions: DEFAULT_SUBAGENT_INSTRUCTIONS,
      active: true,
      createdAt: now,
      updatedAt: now,
    }],
  };
}

async function readStore(): Promise<PromptStore> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as PromptStore;
    return parsed.version === 1 && Array.isArray(parsed.prompts) ? parsed : defaults();
  } catch {
    return defaults();
  }
}

async function saveStore(store: PromptStore) {
  await mkdir(dirname(storePath), { recursive: true });
  const temporary = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, storePath);
}

function validateInput(input: Pick<PromptPreset, "name" | "description" | "mainInstructions" | "subagentInstructions">) {
  const name = input.name.trim();
  const mainInstructions = input.mainInstructions.trim();
  const subagentInstructions = input.subagentInstructions.trim();
  if (!name) throw new PromptStoreError("提示词方案名称不能为空。");
  if (!mainInstructions || !subagentInstructions) throw new PromptStoreError("Main Agent 和 Subagent 提示词不能为空。");
  if (name.length > 80 || input.description.length > 300) throw new PromptStoreError("提示词方案名称或描述过长。");
  if (mainInstructions.length > 30_000 || subagentInstructions.length > 30_000) throw new PromptStoreError("单段提示词不能超过 30000 字符。");
  return { name, description: input.description.trim(), mainInstructions, subagentInstructions };
}

export async function listPromptPresets() {
  return (await readStore()).prompts;
}

export async function getActivePrompt(): Promise<PromptPreset> {
  const store = await readStore();
  return store.prompts.find((item) => item.active) ?? store.prompts[0] ?? defaults().prompts[0];
}

export async function createPromptPreset(input: Pick<PromptPreset, "name" | "description" | "mainInstructions" | "subagentInstructions">) {
  const store = await readStore();
  const value = validateInput(input);
  const now = new Date().toISOString();
  const preset: PromptPreset = { id: randomUUID(), ...value, active: false, createdAt: now, updatedAt: now };
  store.prompts.push(preset);
  await saveStore(store);
  return preset;
}

export async function updatePromptPreset(id: string, input: Pick<PromptPreset, "name" | "description" | "mainInstructions" | "subagentInstructions">) {
  const store = await readStore();
  const index = store.prompts.findIndex((item) => item.id === id);
  if (index < 0) throw new PromptStoreError("提示词方案不存在。");
  store.prompts[index] = { ...store.prompts[index], ...validateInput(input), updatedAt: new Date().toISOString() };
  await saveStore(store);
  return store.prompts[index];
}

export async function activatePromptPreset(id: string) {
  const store = await readStore();
  if (!store.prompts.some((item) => item.id === id)) throw new PromptStoreError("提示词方案不存在。");
  const now = new Date().toISOString();
  store.prompts = store.prompts.map((item) => ({ ...item, active: item.id === id, updatedAt: item.id === id ? now : item.updatedAt }));
  await saveStore(store);
  return store.prompts.find((item) => item.id === id)!;
}

export async function deletePromptPreset(id: string) {
  const store = await readStore();
  const target = store.prompts.find((item) => item.id === id);
  if (!target) throw new PromptStoreError("提示词方案不存在。");
  if (target.active) throw new PromptStoreError("当前启用的提示词方案不能删除，请先启用其他方案。");
  store.prompts = store.prompts.filter((item) => item.id !== id);
  await saveStore(store);
}
