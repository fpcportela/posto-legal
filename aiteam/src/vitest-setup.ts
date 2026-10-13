import { afterEach, beforeEach } from "vitest";

// Antes de cada teste, o worker confere que o processo principal já respondeu ao
// último "onTaskUpdate" que mandou.
//
// O worker do vitest manda o estado dos testes ao processo principal por RPC
// ("onTaskUpdate") e arma um timer de 60 s por chamada; a resposta só é LIDA
// quando o event loop do worker gira. Os testes que rodam git, hooks e CLIs de
// verdade fazem isso com spawnSync, que bloqueia o loop: um teste de 30 s numa
// máquina carregada vira 60 s, o timer dispara antes de a resposta (já na fila)
// ser lida, e o `npm test` sai com 1 com todos os testes verdes
// (`Timeout calling "onTaskUpdate"`). Reproduzido sem git nenhum: um teste que só
// bloqueia o loop por 70 s (Atomics.wait) derruba o RPC; e ceder o loop de tempos
// em tempos, dentro do teste, não derruba — o que conta é o tempo SEM girar.
//
// O que está em voo quando um teste começa é o update de "teste terminou" do
// anterior, mandado logo depois dos hooks afterEach, sem girar o loop (e, no
// primeiro teste do arquivo, o de "teste começou"). Se o teste novo bloqueia o
// loop por mais de 60 s, é esse timer que estoura. Com a resposta lida ANTES de o
// bloqueio começar, não há timer armado durante o teste, e nenhum teste, por mais
// longo, derruba o RPC. O update de "teste começou" do teste novo vai depois, por
// um trailing de 100 ms (throttle do runner), e só sai quando o loop gira de novo:
// não está em voo durante o bloqueio. Por isso a espera é curta, MENOR que esses
// 100 ms.
//
// Só espera depois de um teste lento (≥ 100 ms) e no primeiro do arquivo: é quando o
// runner manda o update na hora. Depois de um teste rápido o update vai por
// trailing, e basta ceder um macrotask (o que o arquivo já fazia entre os testes).
//
// Medido numa máquina Windows de 22 núcleos saturada: antes, `npm test` com os
// workers padrão saía com 1 e 8 "Timeout calling onTaskUpdate"; com este setup,
// testes de 60 a 100 s seguidos passam sem nenhum.
const ACK_WAIT_MS = 40;
const SLOW_TEST_MS = 100;

let previousWasSlow = true; // o primeiro teste do arquivo também segue um envio imediato
let startedAt = 0;

beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, previousWasSlow ? ACK_WAIT_MS : 0));
  startedAt = Date.now();
});

afterEach(() => {
  previousWasSlow = Date.now() - startedAt >= SLOW_TEST_MS;
});
