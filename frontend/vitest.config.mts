import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

const rootDir = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([a-zA-Z]:)/, "$1");

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },
});
