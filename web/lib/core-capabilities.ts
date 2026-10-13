import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { tool } from "@openai/agents";
import { z } from "zod";

import type { ManagedTool, ToolSecurityProfile } from "@/lib/tool-capabilities";

export type CoreCapabilityId = "time" | "calculator" | "web_reader";

export type CapabilityRegistration = {
  id: CoreCapabilityId;
  label: string;
  enabled: boolean;
  tools: ManagedTool[];
};

const readProfile = (input: Omit<ToolSecurityProfile, "source" | "effect">): ToolSecurityProfile => ({
  source: "function",
  effect: "read",
  ...input,
});

type Token = { type: "number"; value: number } | { type: "identifier"; value: string } | { type: "symbol"; value: string };

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([()+\-*/%^,]))/giy;
  let index = 0;
  while (index < expression.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(expression);
    if (!match) {
      if (/^\s*$/.test(expression.slice(index))) break;
      throw new Error(`无法识别位置 ${index + 1} 附近的表达式。`);
    }
    index = pattern.lastIndex;
    if (match[1]) tokens.push({ type: "number", value: Number(match[1]) });
    else if (match[2]) tokens.push({ type: "identifier", value: match[2].toLowerCase() });
    else tokens.push({ type: "symbol", value: match[3] });
  }
  return tokens;
}

const functions: Record<string, { min: number; max: number; run: (...values: number[]) => number }> = {
  abs: { min: 1, max: 1, run: Math.abs },
  ceil: { min: 1, max: 1, run: Math.ceil },
  cos: { min: 1, max: 1, run: Math.cos },
  floor: { min: 1, max: 1, run: Math.floor },
  log: { min: 1, max: 1, run: Math.log },
  max: { min: 1, max: 100, run: Math.max },
  min: { min: 1, max: 100, run: Math.min },
  pow: { min: 2, max: 2, run: Math.pow },
  round: { min: 1, max: 1, run: Math.round },
  sin: { min: 1, max: 1, run: Math.sin },
  sqrt: { min: 1, max: 1, run: Math.sqrt },
  tan: { min: 1, max: 1, run: Math.tan },
};

export function calculateExpression(expression: string): number {
  if (!expression.trim() || expression.length > 500) throw new Error("表达式长度必须在 1 到 500 个字符之间。");
  const tokens = tokenize(expression);
  let position = 0;
  const peek = () => tokens[position];
  const takeSymbol = (symbol: string) => peek()?.type === "symbol" && peek().value === symbol ? (position += 1, true) : false;

  const parsePrimary = (): number => {
    const token = tokens[position++];
    if (!token) throw new Error("表达式意外结束。");
    if (token.type === "number") return token.value;
    if (token.type === "symbol" && token.value === "(") {
      const value = parseExpression();
      if (!takeSymbol(")")) throw new Error("缺少右括号。");
      return value;
    }
    if (token.type !== "identifier") throw new Error(`不应在这里出现 ${JSON.stringify(token.value)}。`);
    if (token.value === "pi") return Math.PI;
    if (token.value === "e") return Math.E;
    const definition = functions[token.value];
    if (!definition) throw new Error(`不支持函数或常量 ${JSON.stringify(token.value)}。`);
    if (!takeSymbol("(")) throw new Error(`函数 ${token.value} 后缺少左括号。`);
    const args: number[] = [];
    if (!takeSymbol(")")) {
      do { args.push(parseExpression()); } while (takeSymbol(","));
      if (!takeSymbol(")")) throw new Error(`函数 ${token.value} 缺少右括号。`);
    }
    if (args.length < definition.min || args.length > definition.max) {
      throw new Error(`函数 ${token.value} 的参数数量无效。`);
    }
    return definition.run(...args);
  };
  const parseUnary = (): number => takeSymbol("+") ? parseUnary() : takeSymbol("-") ? -parseUnary() : parsePrimary();
  const parsePower = (): number => {
    const left = parseUnary();
    return takeSymbol("^") ? Math.pow(left, parsePower()) : left;
  };
  const parseTerm = (): number => {
    let value = parsePower();
    while (true) {
      if (takeSymbol("*")) value *= parsePower();
      else if (takeSymbol("/")) {
        const divisor = parsePower();
        if (divisor === 0) throw new Error("不能除以零。");
        value /= divisor;
      } else if (takeSymbol("%")) {
        const divisor = parsePower();
        if (divisor === 0) throw new Error("不能对零取模。");
        value %= divisor;
      } else break;
    }
    return value;
  };
  const parseExpression = (): number => {
    let value = parseTerm();
    while (true) {
      if (takeSymbol("+")) value += parseTerm();
      else if (takeSymbol("-")) value -= parseTerm();
      else break;
    }
    return value;
  };

  const result = parseExpression();
  if (position !== tokens.length) throw new Error(`表达式在 ${JSON.stringify(tokens[position]?.value)} 附近无法继续解析。`);
  if (!Number.isFinite(result)) throw new Error("计算结果不是有限数值。");
  return Object.is(result, -0) ? 0 : result;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateIpv4(normalized.slice(7));
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff");
}

async function validatePublicUrl(value: string): Promise<URL> {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("URL 格式无效。"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许读取 HTTP 或 HTTPS URL。");
  if (url.username || url.password) throw new Error("URL 不允许包含用户名或密码。");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("只允许访问标准 HTTP/HTTPS 端口。");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("不允许访问本机或内部网络地址。");
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("目标域名解析到了本机、内网或保留地址，已拒绝访问。");
  }
  return url;
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\"" };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
    const hex = entity[1]?.toLowerCase() === "x";
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function readableText(body: string, contentType: string): string {
  if (!contentType.includes("html")) return body.trim().slice(0, 30_000);
  return decodeHtml(body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|header|footer|main|aside|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim()
    .slice(0, 30_000);
}

async function fetchPublicPage(input: string): Promise<{ url: string; status: number; contentType: string; text: string }> {
  let url = await validatePublicUrl(input);
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { "Accept": "text/html,text/plain,application/json,application/xml,text/xml;q=0.9", "User-Agent": "AgentStudio/0.1 read-only-web-fetch" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw new Error("网页重定向次数过多或缺少目标地址。");
      url = await validatePublicUrl(new URL(location, url).toString());
      continue;
    }
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!/(^text\/|json|xml|javascript)/i.test(contentType)) throw new Error(`不支持读取内容类型 ${contentType || "unknown"}。`);
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > 1_000_000) throw new Error("网页响应超过 1 MB 限制。");
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_000_000) {
          await reader.cancel();
          throw new Error("网页响应超过 1 MB 限制。");
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { url: url.toString(), status: response.status, contentType, text: readableText(new TextDecoder().decode(bytes), contentType) };
  }
  throw new Error("网页读取失败。");
}

export function createDefaultCapabilityRegistry(options: { webEnabled: boolean }): CapabilityRegistration[] {
  const timeTool = tool({
    name: "get_current_time",
    description: "获取可信的当前日期、时间和时区。涉及今天、现在、截止日期或相对时间时使用。",
    parameters: z.object({ timeZone: z.string().nullable().describe("IANA 时区，例如 Asia/Shanghai；传 null 使用服务器时区") }),
    async execute({ timeZone }) {
      const zone = timeZone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
      try {
        return JSON.stringify({
          utc: new Date().toISOString(),
          timeZone: zone,
          local: new Intl.DateTimeFormat("zh-CN", { timeZone: zone, dateStyle: "full", timeStyle: "long", hour12: false }).format(new Date()),
          unixMilliseconds: Date.now(),
        });
      } catch { throw new Error(`无效的 IANA 时区：${zone}`); }
    },
  });
  const calculatorTool = tool({
    name: "calculate",
    description: "精确计算算术表达式。支持 + - * / % ^、括号、pi、e，以及 sqrt/abs/min/max/pow/round/floor/ceil/sin/cos/tan/log。",
    parameters: z.object({ expression: z.string().describe("要计算的表达式，例如 (12.5 * 8) + sqrt(81)") }),
    async execute({ expression }) { return JSON.stringify({ expression, result: calculateExpression(expression) }); },
  });
  const webFetchTool = tool({
    name: "web_fetch",
    description: "读取一个已知的公开 HTTP/HTTPS 网页并提取正文。不能搜索网页；需要发现链接时先使用 web_search。",
    parameters: z.object({ url: z.string().describe("要读取的完整公开网页 URL") }),
    async execute({ url }) { return JSON.stringify(await fetchPublicPage(url)); },
  });

  return [
    {
      id: "time",
      label: "当前时间",
      enabled: true,
      tools: [{ tool: timeTool, profile: readProfile({ capabilities: ["time:read"], riskLevel: "low", description: "读取服务器当前时间并按指定时区格式化" }) }],
    },
    {
      id: "calculator",
      label: "精确计算",
      enabled: true,
      tools: [{ tool: calculatorTool, profile: readProfile({ capabilities: ["compute:calculate"], riskLevel: "low", description: "在无代码执行环境中解析并计算受限数学表达式" }) }],
    },
    {
      id: "web_reader",
      label: "公开网页读取",
      enabled: options.webEnabled,
      tools: [{ tool: webFetchTool, profile: readProfile({ capabilities: ["network:access"], riskLevel: "medium", description: "只读访问经过 SSRF 检查的公开 HTTP/HTTPS 页面" }) }],
    },
  ];
}

export function enabledCapabilityTools(registry: CapabilityRegistration[]): ManagedTool[] {
  return registry.filter((entry) => entry.enabled).flatMap((entry) => entry.tools);
}
