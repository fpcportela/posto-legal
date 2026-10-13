#!/usr/bin/env node
// Filho da sondagem de ReDoS do doctor (readTierRulesProbe, aiteam/src/doctor-io.mjs).
// Lê do stdin `{"entries": [{"source": "<padrão>"}], "options": {...}}` e, para cada
// padrão, escreve uma linha JSON `{"start": i}` ao começar e `{"done": i, "result": ...}`
// ao terminar (o resultado de probePattern, aiteam/src/regex-probe.mjs).
//
// Por que um processo à parte: um padrão exponencial não termina, e um regex em
// andamento só se interrompe matando o processo. O pai espera com timeout, mata este
// filho e usa as linhas já escritas para saber qual padrão estava em andamento (o que
// tem `start` e não tem `done`). As linhas saem com writeSync para não sobrar nada num
// buffer assíncrono quando o filho for morto.
//
// Node puro, sem dependências: roda mesmo com o aiteam/node_modules incompleto.

import { readFileSync, writeSync } from "node:fs";
import { probePattern } from "../src/regex-probe.mjs";

function emit(obj) {
  const line = `${JSON.stringify(obj)}\n`;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      writeSync(1, line);
      return;
    } catch (e) {
      if (e?.code !== "EAGAIN") throw e; // pipe cheio: tenta de novo
    }
  }
}

const { entries, options } = JSON.parse(readFileSync(0, "utf8"));
entries.forEach((entry, i) => {
  emit({ start: i });
  emit({ done: i, result: probePattern(entry.source, options ?? {}) });
});
