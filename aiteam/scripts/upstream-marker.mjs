#!/usr/bin/env node
// aiteam/UPSTREAM — de qual commit do rb-ai-team o aiteam/ deste repo veio (rb-ai-team#39).
//
//   node aiteam/scripts/upstream-marker.mjs write      grava o marcador (depois do sync); commite-o junto
//   node aiteam/scripts/upstream-marker.mjs changes    o que mudou nos arquivos de raiz desde o último sync
//   ... --ref <ref>                                    outra ref que não a do upstream (main, master ou o HEAD dele)
//
// O aiteam/ é um checkout do upstream: o consumidor não compartilha histórico com ele, então "o que mudou
// desde o último sync" só se mede se o sync registrar de que commit veio. O tools/aiteam-sync grava o
// marcador sozinho; quem puxa o update à mão (consuming-as-upstream.md) roda o `write`.
//
// Só leitura de git e sem rede: nunca roda fetch. Quem quer a ref fresca roda `git fetch upstream` antes.
// Node puro, sem dependências, para rodar mesmo com o toolchain pela metade.

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runMarkerCommand } from "../src/upstream-marker-cli.mjs";

const aiteam = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // aiteam

function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: aiteam, encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

const r = runMarkerCommand(repoRoot(), process.argv.slice(2));
if (r.out) process.stdout.write(r.out);
if (r.err) process.stderr.write(r.err);
process.exit(r.code);
