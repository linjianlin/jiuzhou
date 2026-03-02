import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const analyze = env.ANALYZE === "true";

  return {
    plugins: [
      react(),
      analyze &&
        visualizer({
          filename: "dist/stats.html",
          open: false,
          gzipSize: true,
        }),
    ].filter(Boolean),
    base: "/",
    server: {
      host: true,
    },
    build: {
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
