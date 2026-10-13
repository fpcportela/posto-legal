import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "infra-kb-claim.mjs");

describe("infra-kb-claim", () => {
  // Fixture, nunca a raiz do repo hospedeiro. A versão anterior rodava o
  // script com `cwd` na raiz e afirmava que ELA não declara infra_kb —
  // verdade no framework, falso em todo consumidor que ligue o slot, que é o
  // ponto inteiro da feature. Como este arquivo é vendorizado, o teste passava
  // aqui e quebrava em quem adotasse a feature como documentado
  // (rb-ai-team#27) — e pior: com o slot preenchido o `--dry-run` chegava a
  // clonar a KB de verdade pela rede dentro da suíte.
  //
  // Precisa ser um repo git de verdade (ainda que sem commit): o script
  // resolve a raiz com `git rev-parse --show-toplevel` ANTES de ler o
  // ponteiro, então um diretório solto falharia pelo motivo errado.
  let semSlot: string;

  beforeAll(() => {
    semSlot = mkdtempSync(path.join(tmpdir(), "infra-kb-claim-sem-slot-"));
    gitOrThrow(semSlot, ["init", "-q"]);
    writeFileSync(
      path.join(semSlot, "SPEC.md"),
      ["---", 'project: "demo"', "budget_usd: 2.00", "---", "", "# demo", ""].join("\n")
    );
  });

  afterAll(() => {
    rmSync(semSlot, { recursive: true, force: true });
  });

  it("é uma casca com shebang que não exporta lógica", () => {
    const s = readFileSync(SCRIPT, "utf8");
    expect(s.startsWith("#!")).toBe(true);
    expect(s).not.toMatch(/export function claimPort/);
  });

  it("recusa sem os argumentos obrigatórios", () => {
    const { status, out } = runClaim(semSlot, ["--port", "3300"]);
    expect(status).not.toBe(0);
    expect(out).toMatch(/--app/);
  });

  it("recusa quando o repo não declara infra_kb", () => {
    const { status, out } = runClaim(semSlot, [
      "--port",
      "3300",
      "--app",
      "x",
      "--service",
      "web",
      "--notes",
      "n",
      "--dry-run",
    ]);
    expect(status).not.toBe(0);
    expect(out).toMatch(/infra_kb/);
  });
});

// Os 3 testes acima só cobrem validação de argumentos e a recusa antecipada
// (sem ponteiro). Nada ali chega no clone/commit/push de verdade — e este é
// o componente de maior raio de explosão da feature inteira (escreve direto
// no branch default de um repo compartilhado). Esta suíte fim-a-fim fecha
// essa lacuna com o mesmo padrão de repo temporário de session-brief.test.ts
// e infra-kb-guard.test.ts (bare KB + clone fonte + consumer, git de
// verdade, limpeza em `finally`) — mas aqui pointer.url aponta DIRETO para o
// bare (o script clona por url, não usa um remote já configurado no
// consumidor).
//
// pointer.url usa file:// (via pathToFileURL), não o caminho puro: um clone
// "local" (caminho de filesystem sem protocolo) faz o git ignorar --depth
// silenciosamente ("--depth is ignored in local clones; use file:// instead"),
// então o clone do script nunca fica raso e o `git fetch --unshallow` dele
// falha com "on a complete repository does not make sense" — um artefato só
// deste atalho local do git, que uma KB real por http(s)/ssh não tem. file://
// força o git a tratar como remoto de verdade e exercitar o mesmo caminho
// raso→unshallow→rebase→push que a KB real percorre.

const KB_README = readFileSync(path.join(HERE, "__fixtures__", "infra-kb-readme.md"), "utf8");

function gitOrThrow(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${r.stderr || r.stdout}`);
  }
  return String(r.stdout ?? "").trim();
}

function readBareReadme(kbBare: string): string {
  return gitOrThrow(kbBare, ["show", "main:README.md"]);
}

function bareCommitAuthor(kbBare: string): string {
  return gitOrThrow(kbBare, ["log", "-1", "--format=%an <%ae>", "main"]);
}

function setupConsumerWithKb(): { kbBare: string; kbSrc: string; consumer: string } {
  const kbBare = mkdtempSync(path.join(tmpdir(), "infra-kb-claim-bare-"));
  const kbSrc = mkdtempSync(path.join(tmpdir(), "infra-kb-claim-src-"));
  const consumer = mkdtempSync(path.join(tmpdir(), "infra-kb-claim-consumer-"));

  gitOrThrow(kbBare, ["init", "-q", "--bare"]);

  gitOrThrow(kbSrc, ["init", "-q"]);
  gitOrThrow(kbSrc, ["config", "user.email", "test@example.com"]);
  gitOrThrow(kbSrc, ["config", "user.name", "test"]);
  writeFileSync(path.join(kbSrc, "README.md"), KB_README);
  gitOrThrow(kbSrc, ["add", "README.md"]);
  gitOrThrow(kbSrc, ["commit", "-q", "-m", "kb"]);
  gitOrThrow(kbSrc, ["remote", "add", "origin", kbBare]);
  gitOrThrow(kbSrc, ["push", "-q", "origin", "HEAD:main"]);

  gitOrThrow(consumer, ["init", "-q"]);
  gitOrThrow(consumer, ["config", "user.email", "test@example.com"]);
  gitOrThrow(consumer, ["config", "user.name", "test"]);
  writeFileSync(
    path.join(consumer, "SPEC.md"),
    [
      "---",
      'project: "demo"',
      "budget_usd: 2.00",
      "infra_kb:",
      "  remote: vps-infra",
      "  ref: main",
      `  url: ${pathToFileURL(kbBare).href}`,
      "  entry: README.md",
      "---",
      "",
      "# demo",
      "",
    ].join("\n")
  );
  gitOrThrow(consumer, ["add", "SPEC.md"]);
  gitOrThrow(consumer, ["commit", "-q", "-m", "init"]);

  return { kbBare, kbSrc, consumer };
}

function runClaim(cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM (git >= 2.32) apontando pra um caminho
// que não existe fazem `git config` não achar NENHUMA identidade global ou de
// sistema, não importa o que esteja configurado de verdade na máquina que
// roda a suíte — confirmado manualmente antes de escrever este teste
// (`git config user.name` volta vazio/exit 1 com o override, e resolve pro
// identity real do host sem ele). Sem isso, este teste passaria neste
// desenvolvimento (que tem identity global configurada) por um motivo
// errado, e falharia de verdade só num runner sem identity — exatamente o
// bug que estamos cobrindo.
function bogusGitConfigEnv(): NodeJS.ProcessEnv {
  const bogus = path.join(tmpdir(), "infra-kb-claim-bogus-gitconfig-nao-existe");
  return { ...process.env, GIT_CONFIG_GLOBAL: bogus, GIT_CONFIG_SYSTEM: bogus };
}

function runClaimNoIdentity(cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: bogusGitConfigEnv(),
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// Mesmo setup de setupConsumerWithKb, exceto que o consumer NUNCA recebe
// `git config user.*` local — precisa ficar sem identidade local de
// propósito. O commit inicial do SPEC.md abaixo ainda roda com o ambiente
// normal do processo de teste (identidade do host, sem o override), porque
// esse commit não é o que está sob teste; só a invocação do script (via
// runClaimNoIdentity) precisa rodar sem identidade nenhuma visível.
function setupIdentitylessConsumer(): { kbBare: string; kbSrc: string; consumer: string } {
  const kbBare = mkdtempSync(path.join(tmpdir(), "infra-kb-claim-bare-"));
  const kbSrc = mkdtempSync(path.join(tmpdir(), "infra-kb-claim-src-"));
  const consumer = mkdtempSync(path.join(tmpdir(), "infra-kb-claim-consumer-noid-"));

  gitOrThrow(kbBare, ["init", "-q", "--bare"]);

  gitOrThrow(kbSrc, ["init", "-q"]);
  gitOrThrow(kbSrc, ["config", "user.email", "test@example.com"]);
  gitOrThrow(kbSrc, ["config", "user.name", "test"]);
  writeFileSync(path.join(kbSrc, "README.md"), KB_README);
  gitOrThrow(kbSrc, ["add", "README.md"]);
  gitOrThrow(kbSrc, ["commit", "-q", "-m", "kb"]);
  gitOrThrow(kbSrc, ["remote", "add", "origin", kbBare]);
  gitOrThrow(kbSrc, ["push", "-q", "origin", "HEAD:main"]);

  gitOrThrow(consumer, ["init", "-q"]);
  writeFileSync(
    path.join(consumer, "SPEC.md"),
    [
      "---",
      'project: "demo"',
      "budget_usd: 2.00",
      "infra_kb:",
      "  remote: vps-infra",
      "  ref: main",
      `  url: ${pathToFileURL(kbBare).href}`,
      "  entry: README.md",
      "---",
      "",
      "# demo",
      "",
    ].join("\n")
  );
  gitOrThrow(consumer, ["add", "SPEC.md"]);
  // `-c user.name=... -c user.email=...` só nesta invocação: dá identidade
  // suficiente pra ESTE commit existir sem persistir nada em
  // consumer/.git/config. Sem isso, o setup dependia da identidade AMBIENTE
  // do processo de teste (nem suprimida pelo runClaimNoIdentity, que só
  // afeta a invocação do script) — em CI, onde não há identidade global
  // nenhuma no runner, nem esse commit de setup existiria, e o teste morria
  // antes mesmo do script rodar (visto na prática: "Author identity
  // unknown... fatal: empty ident name" no runner, não no script). O
  // consumer continua genuinamente sem identidade LOCAL — só o script sob
  // teste roda com GIT_CONFIG_GLOBAL/SYSTEM suprimidos.
  gitOrThrow(consumer, ["-c", "user.name=fixture-setup", "-c", "user.email=fixture-setup@example.com", "commit", "-q", "-m", "init"]);

  return { kbBare, kbSrc, consumer };
}

function cleanup(dirs: string[]) {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

describe("infra-kb-claim fim-a-fim (subprocess, bare repo descartável)", () => {
  it("reserva com sucesso: a linha nova chega no branch default do bare", () => {
    const { kbBare, kbSrc, consumer } = setupConsumerWithKb();

    try {
      const { status, out } = runClaim(consumer, [
        "--port",
        "9401",
        "--app",
        "e2e-app",
        "--service",
        "web",
        "--notes",
        "reservado pelo teste e2e",
      ]);

      expect(status).toBe(0);
      expect(out).toMatch(/✓/);

      const readmeDepois = readBareReadme(kbBare);
      expect(readmeDepois).toContain("| 9401 | e2e-app | web | reservado pelo teste e2e |");

      // O commit no registro compartilhado precisa carregar a autoria de
      // verdade do operador (herdada do consumer via `git config` local→
      // global→system), não uma identidade anônima/inventada pelo script —
      // o fixture configura user.name=test/user.email=test@example.com no
      // consumer (setupConsumerWithKb acima), e é exatamente essa identidade
      // que deve chegar no commit dentro do clone temporário e, por extensão,
      // no bare.
      expect(bareCommitAuthor(kbBare)).toBe("test <test@example.com>");
    } finally {
      cleanup([kbBare, kbSrc, consumer]);
    }
  });

  it("--dry-run não altera nada no bare remoto", () => {
    const { kbBare, kbSrc, consumer } = setupConsumerWithKb();
    const readmeAntes = readBareReadme(kbBare);
    const headAntes = gitOrThrow(kbBare, ["rev-parse", "main"]);

    try {
      const { status, out } = runClaim(consumer, [
        "--port",
        "9402",
        "--app",
        "e2e-dry-run-app",
        "--service",
        "web",
        "--notes",
        "não deve chegar no bare",
        "--dry-run",
      ]);

      expect(status).toBe(0);
      expect(out).toMatch(/--dry-run/);

      expect(readBareReadme(kbBare)).toBe(readmeAntes);
      expect(gitOrThrow(kbBare, ["rev-parse", "main"])).toBe(headAntes);
    } finally {
      cleanup([kbBare, kbSrc, consumer]);
    }
  });

  it("recusa quando a porta já pertence a outro app — e não escreve nada no bare", () => {
    const { kbBare, kbSrc, consumer } = setupConsumerWithKb();
    const readmeAntes = readBareReadme(kbBare);
    const headAntes = gitOrThrow(kbBare, ["rev-parse", "main"]);

    try {
      // Porta 3100 já é do omni-chat/api no fixture — reivindicar para outro
      // app tem que ser recusado antes de qualquer commit ou push.
      const { status, out } = runClaim(consumer, [
        "--port",
        "3100",
        "--app",
        "outro-app",
        "--service",
        "web",
        "--notes",
        "tentativa de roubo de porta",
      ]);

      expect(status).not.toBe(0);
      expect(out).toMatch(/já é de/);

      expect(readBareReadme(kbBare)).toBe(readmeAntes);
      expect(gitOrThrow(kbBare, ["rev-parse", "main"])).toBe(headAntes);
    } finally {
      cleanup([kbBare, kbSrc, consumer]);
    }
  });

  // Achado de self-review: process.exit() NÃO desenrola a pilha como uma
  // exceção, então um `finally` que só depende dele nunca roda nos caminhos
  // que chamam process.exit() diretamente (die() e os process.exit(0) de
  // no-op/--dry-run). Confirmado na prática antes do fix: uma bateria de
  // recusas/dry-runs deixava um diretório `aiteam-infra-kb-*` órfão em
  // os.tmpdir() por chamada — o script precisa limpar o próprio clone antes
  // de cada saída antecipada, não só na saída de sucesso.
  it("não vaza o clone temporário em os.tmpdir() nem na recusa nem no --dry-run", () => {
    const { kbBare, kbSrc, consumer } = setupConsumerWithKb();

    function leakedDirs(): Set<string> {
      return new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("aiteam-infra-kb-")));
    }

    try {
      const beforeDryRun = leakedDirs();
      runClaim(consumer, ["--port", "9403", "--app", "leak-check-app", "--service", "web", "--notes", "n", "--dry-run"]);
      expect([...leakedDirs()].filter((d) => !beforeDryRun.has(d))).toEqual([]);

      const beforeConflict = leakedDirs();
      runClaim(consumer, ["--port", "3100", "--app", "outro-app-leak-check", "--service", "web", "--notes", "n"]);
      expect([...leakedDirs()].filter((d) => !beforeConflict.has(d))).toEqual([]);
    } finally {
      cleanup([kbBare, kbSrc, consumer]);
    }
  });

  // Regressão de PR #25 (CI vermelho): o clone temporário não herda
  // identidade nenhuma, e process.exit() nos outros die() já provou que
  // "funciona na minha máquina" não é garantia — um runner sem
  // user.name/user.email global não consegue `git commit` no clone, e sem
  // este teste isso só aparece como falha crua de git dentro do `stdio:
  // "inherit"`, não como a recusa clara que o script deve dar. Usa
  // GIT_CONFIG_GLOBAL/SYSTEM apontando pro nada (ver bogusGitConfigEnv) para
  // simular um runner sem identidade de verdade, mesmo rodando numa máquina
  // de desenvolvimento que TEM identidade global configurada — sem isso o
  // teste passaria aqui por acidente e falharia num runner de verdade, que é
  // o bug exato que esta suíte existe para travar.
  it("recusa quando não há identidade git configurada (nem local, nem global) — e não commita nada", () => {
    const { kbBare, kbSrc, consumer } = setupIdentitylessConsumer();
    const readmeAntes = readBareReadme(kbBare);
    const headAntes = gitOrThrow(kbBare, ["rev-parse", "main"]);

    try {
      const { status, out } = runClaimNoIdentity(consumer, [
        "--port",
        "9404",
        "--app",
        "e2e-sem-identidade",
        "--service",
        "web",
        "--notes",
        "não deve commitar sem autoria",
      ]);

      expect(status).not.toBe(0);
      expect(out).toMatch(/identidade git ausente/);

      expect(readBareReadme(kbBare)).toBe(readmeAntes);
      expect(gitOrThrow(kbBare, ["rev-parse", "main"])).toBe(headAntes);
    } finally {
      cleanup([kbBare, kbSrc, consumer]);
    }
  });
});
