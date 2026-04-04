import { defineConfig, loadEnv, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { APP_VERSION_MANIFEST_PATH } from "./src/constants/appVersion";

/**
 * 作用：集中解析布尔型构建环境变量，避免在配置文件里重复散落 `"true"` 字符串判断。
 * 不做什么：不负责加载 `.env` 文件，不做默认值兜底或类型转换以外的逻辑。
 * 输入/输出：输入为环境变量对象与变量名，输出为该变量是否显式等于 `"true"`。
 * 数据流/状态流：`loadEnv` / `process.env` -> 本函数归一化 -> 交给各构建开关消费。
 * 关键边界条件与坑点：
 * 1. 仅把字符串 `"true"` 视为启用，避免把其它模糊值误判为开启。
 * 2. 保持纯函数，方便后续新增构建开关时直接复用，而不是继续复制判断语句。
 */
function readBooleanEnvFlag(
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  return env[key] === "true";
}

/**
 * 作用：统一定义“图片资源”文件后缀匹配规则，避免构建流程中重复维护同类判断逻辑。
 * 不做什么：不参与 JS/CSS chunk 命名，不参与业务资源路径拼接。
 * 输入/输出：输入为产物文件名字符串，输出为是否命中图片后缀的布尔结果。
 * 数据流/状态流：由构建插件在 `generateBundle` 阶段读取该规则并决定是否删除对应资产。
 * 关键边界条件与坑点：
 * 1. 仅覆盖常见图片后缀（png/jpg/jpeg/gif/svg/webp/avif/ico），不包含字体等其它静态资源。
 * 2. 使用大小写不敏感匹配，避免文件名大小写差异导致遗漏。
 */
const IMAGE_ASSET_EXT_REGEXP = /\.(png|jpe?g|gif|svg|webp|avif|ico)$/i;

/**
 * 作用：在“无图片构建模式”下集中删除 Rollup 图片资产，确保 dist 中不产出图片文件。
 * 不做什么：不处理业务代码逻辑，不改动 JS/CSS 的分包策略与命名规则。
 * 输入/输出：输入 `enabled`（是否启用无图片模式），输出 Vite 插件对象或 `false`。
 * 数据流/状态流：Vite 构建 -> Rollup `generateBundle` -> 遍历产物 -> 删除命中的图片 asset。
 * 关键边界条件与坑点：
 * 1. 仅删除 `asset` 类型且文件名命中图片后缀的产物，避免误删代码 chunk。
 * 2. 插件通过 `apply: "build"` 仅在构建阶段生效，不影响 `vite dev`。
 */
function createStripImageAssetsPlugin(enabled: boolean): PluginOption {
  if (!enabled) {
    return false;
  }

  return {
    name: "strip-image-assets",
    apply: "build",
    generateBundle(_, bundle) {
      for (const fileName of Object.keys(bundle)) {
        const outputArtifact = bundle[fileName];
        if (
          outputArtifact.type === "asset" &&
          IMAGE_ASSET_EXT_REGEXP.test(fileName)
        ) {
          delete bundle[fileName];
        }
      }
    },
  };
}

/**
 * 作用：把构建时间格式化为稳定的纯数字版本号，作为当前前端构建的唯一指纹。
 * 不做什么：不读取 git、不依赖手填版本号，也不尝试兼容历史构建格式。
 * 输入/输出：输入为构建开始时生成的 `Date`，输出为 `YYYYMMDDHHmmss` 形式的版本字符串。
 * 数据流/状态流：构建启动时间 -> 本函数格式化 -> 注入 `define` 常量与 `version.json`。
 * 关键边界条件与坑点：
 * 1. 必须统一按本次构建同一时刻生成，保证运行时代码与 `version.json` 中的版本号完全一致。
 * 2. 使用两位补零，避免字符串排序与展示出现位数漂移。
 */
function formatBuildVersion(buildDate: Date): string {
  const pad2 = (value: number): string => String(value).padStart(2, "0");
  return [
    buildDate.getFullYear(),
    pad2(buildDate.getMonth() + 1),
    pad2(buildDate.getDate()),
    pad2(buildDate.getHours()),
    pad2(buildDate.getMinutes()),
    pad2(buildDate.getSeconds()),
  ].join("");
}

/**
 * 作用：统一生成写入静态目录的应用版本清单，让前端运行时能以极低成本轮询最新构建指纹。
 * 不做什么：不改动业务代码分包结果，不读取产物内容，也不参与开发模式热更新。
 * 输入/输出：输入为本次构建版本号与构建时间，输出为仅在 build 阶段生效的 Vite 插件。
 * 数据流/状态流：构建版本常量 -> `generateBundle` -> 追加 `version.json` asset -> 部署后供前端轮询。
 * 关键边界条件与坑点：
 * 1. 清单文件名必须与运行时常量保持一致，避免构建能写出文件但前端读错路径。
 * 2. 插件只产出极小 JSON，不能把无关构建信息一并塞入，避免增加轮询体积与泄漏无关实现细节。
 */
function createAppVersionManifestPlugin(
  buildVersion: string,
  builtAt: string,
): PluginOption {
  const fileName = APP_VERSION_MANIFEST_PATH.replace(/^\/+/, "");

  return {
    name: "app-version-manifest",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName,
        source: JSON.stringify(
          {
            version: buildVersion,
            builtAt,
          },
          null,
          2,
        ),
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const buildEnv: Record<string, string | undefined> = {
    ...env,
    ...process.env,
  };
  const analyze = readBooleanEnvFlag(buildEnv, "ANALYZE");
  const disableImageAssets = readBooleanEnvFlag(
    buildEnv,
    "VITE_DISABLE_IMAGE_ASSETS",
  );
  const buildDate = new Date();
  const buildVersion = formatBuildVersion(buildDate);
  const builtAt = buildDate.toISOString();

  return {
    define: {
      __APP_VERSION__: JSON.stringify(buildVersion),
      __APP_BUILT_AT__: JSON.stringify(builtAt),
    },
    plugins: [
      react(),
      analyze &&
        visualizer({
          filename: "dist/stats.html",
          open: false,
          gzipSize: true,
        }),
      createAppVersionManifestPlugin(buildVersion, builtAt),
      createStripImageAssetsPlugin(disableImageAssets),
    ].filter(Boolean),
    base: "/",
    server: {
      host: true,
    },
    build: {
      copyPublicDir: !disableImageAssets,
      rollupOptions: {
        output: {
          assetFileNames: "assets/[name]-[hash][extname]",
          chunkFileNames: "assets/[name]-[hash].js",
          entryFileNames: "assets/[name]-[hash].js",
          // 基于模块路径的智能分包策略
          manualChunks(id) {
            if (id.includes("node_modules")) {
              // Ant Design 全家桶（图标、组件、rc-*）
              if (
                id.includes("antd") ||
                id.includes("@ant-design") ||
                id.includes("rc-")
              ) {
                return "antd-vendor";
              }
              // React 核心
              if (
                id.includes("react-dom") ||
                id.includes("node_modules/react/")
              ) {
                return "react-vendor";
              }
              // 路由
              if (id.includes("react-router")) {
                return "router";
              }
              // 网络相关
              if (id.includes("socket.io") || id.includes("axios")) {
                return "network";
              }
            }
          },
        },
      },
    },
  };
});
