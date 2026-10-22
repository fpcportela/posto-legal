import { defineConfig } from "vitest/config";

// Só os testes do app: o aiteam/ (framework vendorizado) tem a suíte dele, que roda no job próprio do CI.
export default defineConfig({ test: { include: ["testes/**/*.test.{js,mjs}"] } });
