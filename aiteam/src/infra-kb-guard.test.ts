import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "..", "hooks", "infra-kb-guard.mjs");

// Todo teste que executa o hook roda num sandbox descartável, nunca na raiz do
// repo hospedeiro. A versão anterior rodava os ramos de silêncio com
// `cwd: <raiz do repo>` e afirmava que "este repo não declara infra_kb":
// verdade no framework, onde o slot vai vazio de propósito, e falso em todo
// consumidor que liga o slot — este arquivo é vendorizado, então o teste
// passava aqui e quebrava exatamente em quem adotava a feature
// (rb-ai-team#36, resíduo da #27).
//
// O sandbox também isola o tmp do processo filho. O hook grava o marcador de
// disparo único em os.tmpdir(); com o tmp real, uma rodada que falhava deixava
// o marcador para trás e a rodada seguinte, silenciada por ele, passava — o
// teste se mascarava. Aqui o marcador cai no tmp do próprio teste e some com
// o sandbox.
interface Sandbox {
  /** Raiz descartável do teste — some inteira no `finally`. */
  root: string;
  /** TEMP/TMP/TMPDIR do hook: onde o marcador de disparo único cai. */
  tmp: string;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "infra-kb-guard-"));
  const tmp = path.join(root, "tmp");
  mkdirSync(tmp);
  return { root, tmp };
}

function dropSandbox(sandbox: Sandbox) {
  rmSync(sandbox.root, { recursive: true, force: true });
}

// os.tmpdir() lê TEMP/TMP no Windows e TMPDIR/TMP/TEMP no resto — o filho
// recebe os três apontando para o sandbox. As chaves herdadas saem antes, sem
// olhar a caixa: no Windows o nome da variável não diferencia maiúsculas, e
// uma `Temp` herdada ao lado da nossa `TEMP` deixaria a escolha para o SO.
// GIT_CEILING_DIRECTORIES impede o `git` do hook de subir acima do sandbox
// atrás de um repo: mesmo com o tmp do sistema dentro de um checkout, o hook
// nunca enxerga o repo hospedeiro.
const OVERRIDDEN = /^(TEMP|TMP|TMPDIR|GIT_CEILING_DIRECTORIES)$/i;

function hookEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!OVERRIDDEN.test(key)) env[key] = value;
  }
  return {
    ...env,
    TEMP: sandbox.tmp,
    TMP: sandbox.tmp,
    TMPDIR: sandbox.tmp,
    GIT_CEILING_DIRECTORIES: sandbox.root,
  };
}

function runHook(sandbox: Sandbox, cwd: string, input: string) {
  const r = spawnSync(process.execPath, [HOOK], {
    input,
    cwd,
    env: hookEnv(sandbox),
    encoding: "utf8",
    timeout: 15_000,
  });
  return { status: r.status, stdout: String(r.stdout ?? "") };
}

function runGuard(sandbox: Sandbox, cwd: string, payload: unknown) {
  return runHook(sandbox, cwd, JSON.stringify(payload));
}

function specWith(infraKbLines: string[]): string {
  return ["---", 'project: "demo"', "budget_usd: 2.00", ...infraKbLines, "---", "", "# demo", ""].join("\n");
}

// Ponteiro preenchido: o estado em que o hook FALA. Os ramos de silêncio
// antecipado (tool errado, path não-infra, stdin lixo) rodam contra ele, para
// que o silêncio venha do ramo testado e não da falta de ponteiro.
const SPEC_COM_KB = specWith(["infra_kb:", "  remote: vps-infra", "  ref: main", "  entry: README.md"]);

// Os dois estados mudos do slot: sem o bloco, e o bloco do template com
// remote/url vazios (o que o SPEC.md do framework traz).
const SPEC_SEM_BLOCO = specWith([]);
const SPEC_BLOCO_VAZIO = specWith([
  "infra_kb:",
  '  remote: ""',
  '  url: ""',
  '  ref: "main"',
  '  entry: "README.md"',
]);

/** Consumer sem git: só o SPEC.md. Basta para os ramos que não chegam ao `git show`. */
function consumerWithSpec(sandbox: Sandbox, specText: string): string {
  const consumer = path.join(sandbox.root, "consumer");
  mkdirSync(consumer);
  writeFileSync(path.join(consumer, "SPEC.md"), specText);
  return consumer;
}

function guardIn(specText: string, payload: unknown) {
  const sandbox = makeSandbox();
  try {
    return runGuard(sandbox, consumerWithSpec(sandbox, specText), payload);
  } finally {
    dropSandbox(sandbox);
  }
}

const WRITE_COMPOSE = {
  tool_name: "Write",
  tool_input: { file_path: "infra/docker-compose.yml" },
  session_id: "test-compose",
};

describe("infra-kb-guard", () => {
  it("é uma casca com shebang que não exporta lógica", () => {
    const hook = readFileSync(HOOK, "utf8");
    expect(hook.startsWith("#!")).toBe(true);
    expect(hook).not.toMatch(/export function/);
  });

  it("não emite nada para tool fora de Write/Edit", () => {
    const { status, stdout } = guardIn(SPEC_COM_KB, { tool_name: "Bash", tool_input: { command: "ls" } });
    expect(status).toBe(0);
    expect(stdout).toBe("{}");
  });

  it("não emite nada para arquivo que não é de infra", () => {
    const { status, stdout } = guardIn(SPEC_COM_KB, {
      tool_name: "Write",
      tool_input: { file_path: "src/components/Button.tsx" },
      session_id: "test-nao-infra",
    });
    expect(status).toBe(0);
    expect(stdout).toBe("{}");
  });

  // A invariante de silêncio no nível da casca, nos dois estados mudos do
  // slot. O controle logo abaixo prova que o mesmo fixture faz o hook falar
  // quando o ponteiro existe — sem ele, um hook que nunca fala (js-yaml
  // ausente, por exemplo) passaria por estes dois.
  it("fica mudo sem o bloco infra_kb no SPEC.md, mesmo em arquivo de infra", () => {
    const { status, stdout } = guardIn(SPEC_SEM_BLOCO, WRITE_COMPOSE);
    expect(status).toBe(0);
    expect(stdout).toBe("{}");
  });

  it("fica mudo com o bloco infra_kb de remote/url vazios (o template), mesmo em arquivo de infra", () => {
    const { status, stdout } = guardIn(SPEC_BLOCO_VAZIO, WRITE_COMPOSE);
    expect(status).toBe(0);
    expect(stdout).toBe("{}");
  });

  it("controle: no mesmo fixture, com o ponteiro preenchido, o hook fala", () => {
    // Consumer sem git: o `git show` falha e sai o aviso de KB inacessível.
    const { status, stdout } = guardIn(SPEC_COM_KB, WRITE_COMPOSE);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain("⚠️");
  });

  it("nunca quebra com payload lixo", () => {
    const sandbox = makeSandbox();
    try {
      const { status, stdout } = runHook(sandbox, consumerWithSpec(sandbox, SPEC_COM_KB), "não é json");
      expect(status).toBe(0);
      expect(stdout).toBe("{}");
    } finally {
      dropSandbox(sandbox);
    }
  });
});

// Os testes acima só cobrem os ramos de silêncio antecipado (tool errado,
// path não-infra, sem ponteiro, stdin lixo). Nada ali chega em emit(): nem o
// checklist do caminho feliz, nem os avisos, nem a supressão de "já disparou
// nesta sessão" contra um SEGUNDO disparo de verdade. Esta suíte fim-a-fim
// fecha essa lacuna com o mesmo padrão de repo temporário de
// session-brief.test.ts (bare KB + clone fonte + consumer, git de verdade,
// limpeza em `finally`) — mas nunca chamando `git fetch` dentro do hook em
// si: infra-kb-guard.mjs não busca a KB, só lê o ref já sincronizado (esse
// fetch é responsabilidade do SessionStart), então os testes fazem esse
// fetch manualmente para simular "já sincronizado" ou o omitem para simular
// "ainda não sincronizado".

const KB_README = readFileSync(path.join(HERE, "__fixtures__", "infra-kb-readme.md"), "utf8");

function gitOrThrow(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${r.stderr || r.stdout}`);
  }
  return String(r.stdout ?? "").trim();
}

function setupConsumerWithKb(sandbox: Sandbox): string {
  const kbBare = path.join(sandbox.root, "kb.git");
  const kbSrc = path.join(sandbox.root, "kb-src");
  const consumer = path.join(sandbox.root, "consumer");
  for (const dir of [kbBare, kbSrc, consumer]) mkdirSync(dir);

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
  writeFileSync(path.join(consumer, "SPEC.md"), SPEC_COM_KB);
  gitOrThrow(consumer, ["add", "SPEC.md"]);
  gitOrThrow(consumer, ["commit", "-q", "-m", "init"]);
  gitOrThrow(consumer, ["remote", "add", "vps-infra", kbBare]);

  return consumer;
}

describe("infra-kb-guard fim-a-fim (subprocess) — extrato, avisos e disparo único por sessão", () => {
  it("caminho feliz: KB sincronizada injeta a tabela de portas e o checklist", () => {
    const sandbox = makeSandbox();

    try {
      const consumer = setupConsumerWithKb(sandbox);
      gitOrThrow(consumer, ["fetch", "-q", "vps-infra", "main"]);

      const { status, stdout } = runGuard(sandbox, consumer, {
        tool_name: "Write",
        tool_input: { file_path: "infra/docker-compose.yml" },
        session_id: "guard-e2e-happy-path",
      });

      expect(status).toBe(0);
      const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      expect(context).not.toContain("⚠️");
      expect(context).toContain("3100"); // linha do registro de portas no fixture
      expect(context).toContain("Checklist:");
      expect(context).toContain("mem_limit");
    } finally {
      dropSandbox(sandbox);
    }
  });

  it("dispara uma vez por sessão: a segunda chamada com o mesmo session_id fica muda", () => {
    const sandbox = makeSandbox();
    const sessionId = "guard-e2e-once-per-session";

    try {
      const consumer = setupConsumerWithKb(sandbox);
      gitOrThrow(consumer, ["fetch", "-q", "vps-infra", "main"]);

      const first = runGuard(sandbox, consumer, {
        tool_name: "Write",
        tool_input: { file_path: "infra/docker-compose.yml" },
        session_id: sessionId,
      });
      expect(first.status).toBe(0);
      expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain("Checklist:");

      // Mesma sessão, arquivo de infra DIFERENTE — o marcador é por sessão,
      // não por arquivo, então o segundo disparo tem que ficar mudo mesmo
      // assim, provando que é o marcador (não uma coincidência de path) que
      // suprime.
      const second = runGuard(sandbox, consumer, {
        tool_name: "Write",
        tool_input: { file_path: "infra/Dockerfile" },
        session_id: sessionId,
      });
      expect(second.status).toBe(0);
      expect(second.stdout).toBe("{}");
    } finally {
      dropSandbox(sandbox);
    }
  });

  // A trava do isolamento: o marcador tem de cair no tmp do sandbox, e o tmp
  // real do sistema não pode ganhar nada. Sem isso, um teste que falha
  // "conserta" a si mesmo na rodada seguinte (rb-ai-team#36).
  it("o marcador de disparo único cai no tmp do próprio teste, nunca no tmp real do sistema", () => {
    const sandbox = makeSandbox();
    // Único por rodada: um resto de rodada anterior no tmp real não pode
    // decidir esta asserção, nem para um lado nem para o outro.
    const sessionId = `guard-e2e-isolamento-${process.pid}-${Date.now()}`;
    // Mesmo nome de markerPath() em aiteam/hooks/infra-kb-guard.mjs; o id já
    // é só [\w-], então a sanitização de lá não o altera.
    const markerName = `aiteam-infra-kb-${sessionId}`;

    try {
      const consumer = setupConsumerWithKb(sandbox);
      gitOrThrow(consumer, ["fetch", "-q", "vps-infra", "main"]);

      const { status, stdout } = runGuard(sandbox, consumer, {
        tool_name: "Write",
        tool_input: { file_path: "infra/docker-compose.yml" },
        session_id: sessionId,
      });
      expect(status).toBe(0);
      expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain("Checklist:");

      expect(existsSync(path.join(sandbox.tmp, markerName))).toBe(true);
      expect(existsSync(path.join(tmpdir(), markerName))).toBe(false);
    } finally {
      dropSandbox(sandbox);
      // Se o isolamento regredir, não deixa o vazamento para a próxima rodada.
      rmSync(path.join(tmpdir(), markerName), { force: true });
    }
  });

  // Cobre a regressão do review: um aviso (KB ainda não sincronizada) não
  // pode gastar o tiro único da sessão. Sem fetch algum, o primeiro `git
  // show` do hook falha (não há ref remoto local ainda) e emite o aviso de
  // "inacessível" em vez do extrato — isso NÃO deve marcar a sessão como
  // disparada. Depois de simular o `git fetch` que o próprio aviso pede, uma
  // chamada seguinte na MESMA sessão precisa entregar o checklist de
  // verdade.
  it("um aviso de KB inacessível não consome o tiro — uma chamada bem-sucedida depois ainda injeta", () => {
    const sandbox = makeSandbox();
    const sessionId = "guard-e2e-warning-then-success";

    try {
      const consumer = setupConsumerWithKb(sandbox);

      // Remote registrado, mas nenhum fetch ainda: `git show vps-infra/main:...`
      // falha porque não existe ref de tracking local — a mesma situação de
      // "primeira edição de infra da sessão, antes do SessionStart sincronizar".
      const first = runGuard(sandbox, consumer, {
        tool_name: "Write",
        tool_input: { file_path: "infra/docker-compose.yml" },
        session_id: sessionId,
      });
      expect(first.status).toBe(0);
      const firstContext = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
      expect(firstContext).toContain("⚠️");
      expect(firstContext).toMatch(/git fetch/);

      // O agente roda o fetch que o aviso pediu.
      gitOrThrow(consumer, ["fetch", "-q", "vps-infra", "main"]);

      const second = runGuard(sandbox, consumer, {
        tool_name: "Write",
        tool_input: { file_path: "infra/docker-compose.yml" },
        session_id: sessionId,
      });
      expect(second.status).toBe(0);
      const secondContext = JSON.parse(second.stdout).hookSpecificOutput.additionalContext;
      expect(secondContext).not.toContain("⚠️");
      expect(secondContext).toContain("Checklist:");
    } finally {
      dropSandbox(sandbox);
    }
  });

  // Cobre a segunda regressão do review: sem session_id, o fallback antigo
  // ("nosession") colapsava duas invocações distintas numa única chave de
  // marcador — a segunda ficava muda mesmo nunca tendo recebido o extrato.
  // O fix trata session_id ausente como "nunca disparou", sempre. Um marcador
  // "nosession" que o fallback antigo voltasse a gravar cairia no tmp do
  // sandbox e sumiria com ele.
  it("sem session_id, duas chamadas seguidas nunca colapsam num marcador compartilhado — ambas injetam", () => {
    const sandbox = makeSandbox();

    try {
      const consumer = setupConsumerWithKb(sandbox);
      gitOrThrow(consumer, ["fetch", "-q", "vps-infra", "main"]);

      const first = runGuard(sandbox, consumer, {
        tool_name: "Write",
        tool_input: { file_path: "infra/docker-compose.yml" },
        // session_id ausente de propósito.
      });
      expect(first.status).toBe(0);
      expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain("Checklist:");

      const second = runGuard(sandbox, consumer, {
        tool_name: "Write",
        tool_input: { file_path: "infra/Dockerfile" },
        // Também sem session_id — se colapsasse na mesma chave "nosession"
        // do fallback antigo, esta chamada ficaria muda mesmo nunca tendo
        // recebido o extrato.
      });
      expect(second.status).toBe(0);
      expect(JSON.parse(second.stdout).hookSpecificOutput.additionalContext).toContain("Checklist:");
    } finally {
      dropSandbox(sandbox);
    }
  });
});
