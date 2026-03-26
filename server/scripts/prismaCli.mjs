/**
 * Prisma CLI 包装脚本
 *
 * 作用（做什么 / 不做什么）：
 * 1. 做什么：统一定位 pnpm 虚拟仓中的 Prisma CLI，给 `db:pull` / `db:push` / `db:generate` 复用。
 * 2. 做什么：在 `server` 目录下转发 Prisma 命令，保证 `prisma.config.ts` 与 `.env` 按服务端上下文解析。
 * 3. 做什么：把 `db push` 的高风险确认参数集中到单一入口，避免启动脚本和容器命令重复维护。
 * 4. 不做什么：不处理数据库业务逻辑，也不兜底吞掉 CLI 错误。
 *
 * 输入/输出：
 * - 输入：命令行参数，例如 `db push --skip-generate`。
 * - 输出：转发 Prisma CLI 的退出码与标准输出/错误输出。
 *
 * 数据流/状态流：
 * - package script / Docker CMD -> 本脚本扫描 `node_modules/.pnpm` -> 整理 Prisma 参数 -> `node <prisma-cli> ...args`。
 *
 * 关键边界条件与坑点：
 * 1. 当前工作区没有暴露 `prisma` 到 `.bin`，所以必须把 CLI 定位逻辑集中到这里，避免每个脚本都硬编码版本路径。
 * 2. `db push` 的 `--accept-data-loss` 必须只在这一类命令追加，避免影响 `generate`、`db pull` 等其他 Prisma 子命令。
 * 3. 若未来 Prisma 依赖未安装，本脚本应直接失败并暴露原始问题，而不是静默回退到其他实现。
 */
import './shared/installConsoleLogger.mjs';
import { existsSync, readdirSync } from "node:fs";
import { delimiter } from "node:path";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(serverRoot, "..");
const pnpmStoreDir = resolve(workspaceRoot, "node_modules/.pnpm");

const resolvePrismaCliPath = () => {
  const storeEntries = readdirSync(pnpmStoreDir)
    .filter((entry) => entry.startsWith("prisma@"))
    .sort();

  for (const entry of storeEntries) {
    const cliPath = join(pnpmStoreDir, entry, "node_modules/prisma/build/index.js");
    if (existsSync(cliPath)) {
      return cliPath;
    }
  }

  throw new Error("未找到 Prisma CLI，请先安装 server 依赖");
};

const isDbPushCommand = (args) => args[0] === "db" && args[1] === "push";

const hasAcceptDataLossFlag = (args) => args.includes("--accept-data-loss");

const resolvePrismaArgs = (args) => {
  if (!isDbPushCommand(args) || hasAcceptDataLossFlag(args)) {
    return args;
  }

  return [...args, "--accept-data-loss"];
};

const prismaCliPath = resolvePrismaCliPath();
const prismaNodeModulesPath = resolve(prismaCliPath, "../../..");
const nodePathSegments = [prismaNodeModulesPath];
const prismaArgs = resolvePrismaArgs(process.argv.slice(2));

if (process.env.NODE_PATH) {
  nodePathSegments.push(process.env.NODE_PATH);
}

const child = spawn(process.execPath, [prismaCliPath, ...prismaArgs], {
  cwd: serverRoot,
  env: {
    ...process.env,
    NODE_PATH: nodePathSegments.join(delimiter),
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
