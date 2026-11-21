/**
 * 调查阶段的工具集。
 *
 * 设计原则：工具只做「看」，不做「改」。Agent 不能写文件、不能建单、不能改状态，
 * 只能读取调用点、目录、漏洞区间与使用面分析结果，据此给出建议。
 *
 * 所有路径参数都必须经过仓内校验，禁止越出被测仓库根目录。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { analyzeUsage } from "../triage/usage.js";
import { matchAdvisories, type AdvisoryFunctionIndex } from "../triage/osv.js";
import type { Tool } from "./types.js";

/** 单次工具输出上限，避免把整份文件塞进模型上下文。 */
const MAX_OUTPUT_CHARS = 8_000;
const MAX_LISTED_FILES = 200;
const MAX_READ_LINES = 200;

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS
    ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n... (已截断，共 ${text.length} 字符)`
    : text;
}

/** 把相对路径解析到仓库内，越界直接抛出。 */
function resolveInside(repoPath: string, relativePath: string): string {
  const root = resolve(repoPath);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`路径越界: ${relativePath}`);
  }
  return target;
}

/** 递归列出仓库内的源码文件，限制数量避免噪声。 */
function listSourceFiles(repoPath: string, limit = MAX_LISTED_FILES): string[] {
  const root = resolve(repoPath);
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (files.length >= limit) return;
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (SOURCE_EXTENSIONS.has(extname(entry))) files.push(full);
      if (files.length >= limit) return;
    }
  };
  walk(join(root, "src"));
  return files;
}

export interface InvestigationToolContext {
  repoPath: string;
  snapshot: unknown;
  advisoryFunctions: AdvisoryFunctionIndex;
}

export function createInvestigationTools(context: InvestigationToolContext): Tool[] {
  return [
    {
      definition: {
        name: "list_source_files",
        description: "列出仓库 src 目录下的源码文件（相对路径），用于定位可疑文件。",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
      async execute() {
        const files = listSourceFiles(context.repoPath).map((file) =>
          file.slice(resolve(context.repoPath).length + 1).split(sep).join("/")
        );
        return truncate(files.join("\n") || "(空)");
      },
    },
    {
      definition: {
        name: "read_source",
        description: "按行号读取仓库内某个源码文件。返回带行号的内容，最多 200 行。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "相对仓库根目录的路径，例如 src/notify.js" },
            startLine: { type: "number", description: "起始行，从 1 开始，可省略" },
            endLine: { type: "number", description: "结束行，含该行，可省略" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      async execute(args) {
        const path = String(args.path ?? "");
        const full = resolveInside(context.repoPath, path);
        const lines = readFileSync(full, "utf8").split(/\r?\n/);

        const start = Math.max(1, Number(args.startLine ?? 1));
        const end = Math.min(
          lines.length,
          Number(args.endLine ?? start + MAX_READ_LINES - 1),
          start + MAX_READ_LINES - 1
        );

        const numbered = lines
          .slice(start - 1, end)
          .map((line, index) => `${start + index}\t${line}`)
          .join("\n");
        return truncate(numbered || "(空文件)");
      },
    },
    {
      definition: {
        name: "check_usage",
        description: "对指定包做使用面静态分析：是否 import、是否存在动态引入、调用了哪些函数。",
        parameters: {
          type: "object",
          properties: { package: { type: "string", description: "npm 包名" } },
          required: ["package"],
          additionalProperties: false,
        },
      },
      async execute(args) {
        const packageName = String(args.package ?? "");
        return truncate(JSON.stringify(analyzeUsage(context.repoPath, packageName), null, 2));
      },
    },
    {
      definition: {
        name: "list_advisories",
        description: "查询冻结 OSV 快照中命中该包与版本的漏洞，含受影响函数与修复版本。",
        parameters: {
          type: "object",
          properties: {
            package: { type: "string", description: "npm 包名" },
            version: { type: "string", description: "已安装版本，例如 4.17.20" },
          },
          required: ["package", "version"],
          additionalProperties: false,
        },
      },
      async execute(args) {
        const packageName = String(args.package ?? "");
        const version = String(args.version ?? "");
        try {
          const matches = matchAdvisories(
            context.snapshot,
            packageName,
            version,
            context.advisoryFunctions
          );
          return truncate(JSON.stringify(matches, null, 2));
        } catch (error) {
          // 数据异常要显式告诉模型，不能让它把「查不到」当成「没有漏洞」
          return `advisory query failed: ${(error as Error).message}`;
        }
      },
    },
  ];
}
