/**
 * 调用面静态分析（usage-based filtering）。
 *
 * 能力边界必须诚实：
 *   - 支持：静态 import / require、字面量动态 import、同文件内的属性调用
 *   - 不支持：跨文件调用链、变量形式的动态 import / require、反射与依赖注入
 * 遇到无法静态解析的动态引入时返回 dynamicImport=true，由上层升级人工，
 * 绝不允许猜测成「未调用」。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import ts from "typescript";

/** 一处函数调用位置。 */
export interface CallSite {
  file: string;
  line: number;
  symbol: string;
}

/** 单个仓库对某个包的静态使用情况。 */
export interface UsageResult {
  /** 是否通过静态 import / require 引用了该包。 */
  importsPackage: boolean;
  /** 是否存在无法静态解析的动态引入。 */
  dynamicImport: boolean;
  /** 调用到的函数位置。 */
  callSites: CallSite[];
}

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

/** 判断模块说明符是否指向目标包（含子路径，如 lodash/template）。 */
function isTargetPackage(specifier: string, packageName: string): boolean {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function scriptKindOf(filePath: string): ts.ScriptKind {
  const ext = extname(filePath);
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return ts.ScriptKind.TS;
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  return ts.ScriptKind.JS;
}

/** 递归收集 src 目录下的源码文件；目录不存在时返回空列表。 */
function collectSourceFiles(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }
    if (SOURCE_EXTENSIONS.has(extname(entry))) files.push(fullPath);
  }
  return files;
}

/** 分析单个文件对一个包的引用与调用，结果累加到 accumulator。 */
function analyzeFile(
  filePath: string,
  repoPath: string,
  packageName: string,
  accumulator: UsageResult
): void {
  const content = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(filePath)
  );
  const displayPath = relative(repoPath, filePath).split("\\").join("/");
  const bindings = { defaultName: null as string | null, named: new Map<string, string>() };

  const lineOf = (node: ts.Node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (isTargetPackage(node.moduleSpecifier.text, packageName)) {
        accumulator.importsPackage = true;
        const clause = node.importClause;
        if (clause?.name) bindings.defaultName = clause.name.text;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            const importedName = (element.propertyName ?? element.name).text;
            bindings.named.set(importedName, element.name.text);
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const firstArg = node.arguments[0];

      // 动态 import()
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        if (firstArg && ts.isStringLiteral(firstArg)) {
          if (isTargetPackage(firstArg.text, packageName)) accumulator.importsPackage = true;
        } else {
          accumulator.dynamicImport = true;
        }
      }

      // require()
      if (ts.isIdentifier(callee) && callee.text === "require") {
        if (firstArg && ts.isStringLiteral(firstArg)) {
          if (isTargetPackage(firstArg.text, packageName)) accumulator.importsPackage = true;
        } else {
          accumulator.dynamicImport = true;
        }
      }

      // 默认导入别名上的属性调用：_.template(...)
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        bindings.defaultName !== null &&
        callee.expression.text === bindings.defaultName
      ) {
        accumulator.callSites.push({
          file: displayPath,
          line: lineOf(node),
          symbol: callee.name.text,
        });
      }

      // 具名导入的直接调用：template(...)
      if (ts.isIdentifier(callee)) {
        for (const [importedName, localName] of bindings.named) {
          if (localName === callee.text) {
            accumulator.callSites.push({
              file: displayPath,
              line: lineOf(node),
              symbol: importedName,
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

/**
 * 分析仓库对指定包的使用情况。
 *
 * @param repoPath 仓库根目录
 * @param packageName 目标包名
 */
export function analyzeUsage(repoPath: string, packageName: string): UsageResult {
  const result: UsageResult = { importsPackage: false, dynamicImport: false, callSites: [] };
  const files = collectSourceFiles(join(repoPath, "src"));
  for (const file of files) {
    analyzeFile(file, repoPath, packageName, result);
  }
  return result;
}
