import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repositoryRoot, "");

  return {
    envDir: repositoryRoot,
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      proxy: {
        "/api": {
          target: env.VITE_API_PROXY_TARGET || "http://localhost:4310",
          changeOrigin: true,
        },
      },
    },
  };
});
