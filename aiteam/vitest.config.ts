import * as os from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "evals/**/*.test.ts", "mcp/**/*.test.ts"],
    environment: "node",
    globals: false,
    // Um teste que roda git, hooks ou bash de verdade leva de 1 a 30 s com a máquina
    // livre e 3 a 5 vezes isso com ela saturada (muitos workers, outras suítes, o
    // antivírus do Windows) — e, mesmo síncrono, passa a ser reprovado se passar do
    // teto ("Test timed out"), sem ter nenhum defeito. O teto só pega teste que
    // trava de verdade, e um teste síncrono travado de qualquer jeito não é
    // interrompido; por isso 120 s, com folga para a carga, em vez de 30 s. O mesmo
    // vale para os hooks (o beforeEach que monta repos git de teste, padrão de 10 s).
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Até 4 workers, não "núcleos − 1". Cada worker é um node e vive rodando git,
    // bash e node filhos: com 21 workers numa máquina de 22 núcleos e 16 GB, a
    // suíte satura CPU e memória, o processo principal (que atende o RPC de todos)
    // demora a responder, e os testes passam a levar 3 a 5 vezes mais — medido: o
    // `npm test` saía com 1 por "Timeout calling onTaskUpdate" e por testes que
    // estouravam o teto. --maxWorkers=N na linha de comando continua valendo.
    maxWorkers: Math.max(1, Math.min(4, os.availableParallelism() - 1)),
    // Antes de cada teste, o worker confere que o RPC "onTaskUpdate" anterior foi
    // respondido: sem isso, um teste síncrono de mais de 60 s sai com exit 1 com
    // todos os testes verdes (ver src/vitest-setup.ts).
    setupFiles: ["src/vitest-setup.ts"],
    coverage: {
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
