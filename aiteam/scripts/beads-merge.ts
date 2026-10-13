#!/usr/bin/env tsx
// SUPORTE SÓ AO MODO LEGADO — remover depois da fase 3 da rb-ai-team#37.
// O modelo por bead não usa merge driver (aiteam/docs/beads-schema.md §11).
// O sync manda o consumidor TIRAR o mapeamento `merge=beads-yaml` do
// .gitattributes, também em modo legado: ninguém deve mapear este driver de
// novo. Este arquivo fica só para o intervalo entre o sync e esse hand-merge: um
// consumidor que ainda mapeia .beads/*.yaml, com o merge.beads-yaml no
// .git/config apontando para cá, falharia em todo merge local se o script
// sumisse. O doctor reprova esse caso (e só ele), e só em modo legado: migrado
// + mapeia + script ausente dá WARN.
//
// Git merge driver for .beads/*.yaml (Blueprint 8.1), as the old model set it
// up: registered in .git/config as merge.beads-yaml.driver and mapped from
// .gitattributes. Union-by-id with newest-updated_at wins, so concurrent edits
// to different tasks never conflict.

import { runMergeDriver } from "../src/beads-merge.js";

process.exit(runMergeDriver(process.argv.slice(2)));
