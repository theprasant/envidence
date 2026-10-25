import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: path.join(root, "src/ui"),
  base: "./",
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: path.join(root, "dist/ui"),
    emptyOutDir: true,
    target: "es2022",
    minify: "esbuild",
    cssCodeSplit: false,
    rollupOptions: {
      input: path.join(root, "src/ui/index.html"),
    },
  },
});
