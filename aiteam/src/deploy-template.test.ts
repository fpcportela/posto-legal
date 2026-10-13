import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "./repo-root.js";

// O template é o workflow que os consumidores COPIAM (copy-once). Um deploy
// que pendura um build pesado na sessão SSH cai com "Broken pipe" (exit 255)
// sob contenção de CPU num host compartilhado — e falha DEPOIS de ter buildado.
// Achado real: trabalhista, 2026-07-21. Contrato: AGENTS.md §CI/CD Mandate.
const template = fs.readFileSync(
  path.resolve(repoRoot(), "aiteam", "templates", "deploy.yml.example"),
  "utf8",
);

describe("deploy.yml.example — contrato de resiliência", () => {
  it("o ssh de exemplo leva keepalive", () => {
    expect(template).toMatch(/ServerAliveInterval=\d+/);
    expect(template).toMatch(/ServerAliveCountMax=\d+/);
  });

  it("a janela de tolerância do keepalive é de pelo menos 5 minutos", () => {
    // Guarda a INTENÇÃO (tolerar um build longo), não a string literal —
    // ajustar os números continua livre desde que a janela não encolha.
    const interval = Number(/ServerAliveInterval=(\d+)/.exec(template)?.[1]);
    const count = Number(/ServerAliveCountMax=(\d+)/.exec(template)?.[1]);
    expect(Number.isFinite(interval * count)).toBe(true);
    expect(interval * count).toBeGreaterThanOrEqual(300);
  });

  it("aponta o leitor para a cláusula do mandate", () => {
    expect(template).toMatch(/CI\/CD Mandate/);
  });
});

// rb-ai-team#32: o contrato era "gate + health check + rollback-by-rerun" em
// prosa, e o consumidor que servia de dogfood violava dois itens sem que nada
// percebesse — o passo remoto fazia `git pull` (re-rodar com a tag anterior
// subia main de novo) e o health check olhava só o status, que não distingue
// "a versão nova subiu" de "a antiga nunca caiu". Estes testes fixam no
// template o que o deploy-contract-core confere na cópia do consumidor.
interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string> | string;
  outputs?: Record<string, string>;
  steps: Step[];
}
interface DeployWorkflow {
  permissions?: Record<string, string> | string;
  jobs: { deploy: Job; tag: Job };
}

const wf = yaml.load(template) as DeployWorkflow;
const steps = wf.jobs.deploy.steps;
const tagSteps = wf.jobs.tag?.steps ?? [];
const indexOf = (pred: (s: Step) => boolean): number => steps.findIndex(pred);
const SHA_EXPR = "${{ steps.version.outputs.sha }}";
// O comentário que explica "nunca git pull" não é o passo fazendo git pull.
const code = (run: string | undefined): string =>
  (run ?? "")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

describe("deploy.yml.example — versão conferida e tag de rollback", () => {
  const resolve = indexOf((s) => s.id === "version");
  const deploy = indexOf((s) => /Deploy to VPS/.test(s.name ?? ""));
  const health = indexOf((s) => s.env?.VERSION_URL !== undefined);
  const tagStep = tagSteps.find((s) => /\bgit push\b/.test(code(s.run)));

  it("a ref vira um SHA uma vez, e o build recebe esse SHA como APP_VERSION", () => {
    expect(resolve).toBeGreaterThan(-1);
    expect(steps[resolve]?.run).toMatch(/git rev-parse HEAD/);
    expect(steps[resolve]?.run).toMatch(/sha=.*GITHUB_OUTPUT/);
    const build = steps.find((s) => s.name === "Build");
    expect(build?.env?.APP_VERSION).toBe(SHA_EXPR);
  });

  // Rodada 4 da revisão da #32: o APP_VERSION do build vinha do runner. Se o
  // host pousasse noutro commit por um idioma que a análise estática não vê
  // (merge --ff-only, reset --hard FETCH_HEAD, @{u}), o rótulo mentia e o
  // health check aprovava. Derivado no host, o pouso errado vira falha alta.
  it("o passo remoto faz checkout do SHA recebido e deriva o APP_VERSION no host — nunca git pull", () => {
    const run = code(steps[deploy]?.run);
    expect(steps[deploy]?.env?.APP_VERSION).toBe(SHA_EXPR);
    expect(run).toMatch(/git checkout --detach \$APP_VERSION/);
    expect(run).toMatch(/APP_VERSION=\\\$\(git rev-parse HEAD\) docker compose up/);
    expect(run).not.toMatch(/APP_VERSION=\$APP_VERSION/);
    expect(run).not.toMatch(/git pull/);
  });

  it("o comentário do passo diz que a versão sai do host", () => {
    expect(steps[deploy]?.run).toMatch(/sai do host/);
  });

  it("o health check consulta o endpoint de versão sem cache, em laço, até ele devolver o SHA", () => {
    expect(health).toBeGreaterThan(deploy);
    const s = steps[health];
    expect(s?.env?.SHA).toBe(SHA_EXPR);
    const run = s?.run ?? "";
    expect(run).toMatch(/curl[^\n]*no-cache[^\n]*"\$\{VERSION_URL\}/);
    expect(run).toMatch(/\bwhile\b|\bfor\b/);
    expect(run).toMatch(/\$SHA/);
  });

  it("se a versão antiga continua no ar ao fim da janela, o deploy falha apontando a tag de rollback", () => {
    const run = steps[health]?.run ?? "";
    expect(run).toMatch(/exit 1\s*$/);
    expect(run).toMatch(/deploy\//);
  });

  it("depois do health check verde, um job que depende do deploy cria e envia a tag deploy/<YYYYMMDD-HHMM>-<sha7>", () => {
    expect([wf.jobs.tag?.needs].flat()).toContain("deploy");
    expect(wf.jobs.tag?.if).toBeUndefined();
    const run = tagStep?.run ?? "";
    expect(run).toMatch(/deploy\/\$\(date -u \+%Y%m%d-%H%M\)-\$\{SHA:0:7\}/);
    expect(run).toMatch(/git push origin/);
  });

  // `git tag -l 'deploy/*' --sort=-creatordate` é como o Release Loop acha a
  // tag anterior. Numa tag leve o creatordate é a data do commit, não a do
  // deploy: um rollback para um commit antigo ficaria no fim da lista.
  it("a tag é anotada, para o --sort=-creatordate do rollback ordenar pela data do deploy", () => {
    expect(tagStep?.run).toMatch(/\btag -a\b/);
  });

  // Revisão de segurança da #32, robustez barata (itens 8a–8f do revisor).
  describe("robustez: SHA validado, consulta sem cache, leitura estrita, push idempotente", () => {
    const SHA_RE = /\[\[ "\$\w+" =~ \^\[0-9a-f\]\{40\}\$ \]\]/;
    const healthRun = steps[health]?.run ?? "";

    it("o SHA é validado com ^[0-9a-f]{40}$ antes de ser usado: no Resolve, no deploy, no health check e na tag", () => {
      expect(steps[resolve]?.run).toMatch(SHA_RE);
      expect(code(steps[deploy]?.run)).toMatch(SHA_RE);
      expect(healthRun).toMatch(SHA_RE);
      expect(tagStep?.run).toMatch(SHA_RE);
      // A validação vem antes do primeiro uso.
      const deployRun = code(steps[deploy]?.run);
      expect(deployRun.search(SHA_RE)).toBeLessThan(deployRun.indexOf("ssh "));
    });

    it("o curl segue redirect (-L) e fura cache com ?_=<timestamp>, respeitando query existente", () => {
      expect(healthRun).toMatch(/curl -fsSL\b/);
      expect(healthRun).toMatch(/_=\$\(date \+%s\)/);
      expect(healthRun).toMatch(/\*\\\?\*\) sep='&'/);
    });

    it("lê o version sem sed guloso e compara em minúsculas", () => {
      expect(healthRun).not.toMatch(/s\/\.\*"version"/);
      expect(healthRun).toMatch(/grep -o '"version"/);
      expect(healthRun).toMatch(/tr 'A-F' 'a-f'/);
    });

    it("o push da tag é idempotente: já existindo no mesmo SHA, sai 0; noutro SHA, falha", () => {
      const run = tagStep?.run ?? "";
      expect(run).toMatch(/git ls-remote --tags origin "refs\/tags\/\$TAG" "refs\/tags\/\$TAG\^\{\}"/);
      expect(run).toMatch(/"\$remota" = "\$SHA"[\s\S]*exit 0/);
      expect(run.indexOf("git ls-remote")).toBeLessThan(run.indexOf("git push"));
    });

    it("o comentário diz que a ref nunca é interpolada em script — não que nunca chega a um shell", () => {
      expect(template).not.toMatch(/nunca chega a um\s+(?:#\s+)?shell/);
      expect(template).toMatch(/nunca é interpolad/);
    });
  });

  // Revisão de segurança da #32: com contents: write no workflow, o npm ci e
  // os scripts de terceiros do build rodavam com um token de escrita
  // persistido no checkout. Só o job da tag escreve.
  describe("privilégio mínimo: só o job da tag escreve no repo", () => {
    const writes = (p: Job["permissions"] | DeployWorkflow["permissions"]): boolean =>
      p === "write-all" || (typeof p === "object" && p !== null && p.contents === "write");

    it("o workflow fica em contents: read, e o job do build não tem write", () => {
      expect(wf.permissions).toEqual({ contents: "read" });
      expect(writes(wf.jobs.deploy.permissions ?? wf.permissions)).toBe(false);
    });

    it("o checkout do build não persiste o token", () => {
      const checkout = steps.find((s) => /^actions\/checkout@/.test(s.uses ?? ""));
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    });

    it("o job da tag tem contents: write e faz checkout do SHA que o deploy implantou", () => {
      expect(wf.jobs.tag?.permissions).toEqual({ contents: "write" });
      expect(wf.jobs.deploy.outputs?.sha).toBe(SHA_EXPR);
      const checkout = tagSteps.find((s) => /^actions\/checkout@/.test(s.uses ?? ""));
      expect(checkout?.with?.ref).toBe("${{ needs.deploy.outputs.sha }}");
      expect(tagStep?.env?.SHA).toBe("${{ needs.deploy.outputs.sha }}");
    });
  });

  it("o cabeçalho diz: checkout da ref no passo remoto, git pull não vale, rollback com a tag deploy/ anterior", () => {
    const header = template.slice(0, template.search(/^name:/m));
    expect(header).toMatch(/checkout/);
    expect(header).toMatch(/git pull.*NÃO é adaptação válida/s);
    expect(header).toMatch(/[Rr]ollback.*tag deploy\/ anterior/s);
    expect(header).toMatch(/gh workflow run deploy\.yml -f ref=/);
  });
});

// O Release Engineer é quem aperta o botão; o template é o botão. Se o comando
// que a persona manda rodar não casar com o contrato de input do workflow, o
// rollback documentado ("re-run com a tag anterior") deploya a tag errada em
// silêncio — `--ref` escolhe a VERSÃO DO ARQUIVO de workflow, não o input `ref`
// que o passo de checkout consome.
const persona = fs.readFileSync(
  path.resolve(repoRoot(), "aiteam", "agents", "release-engineer.md"),
  "utf8",
);

describe("release-engineer.md × deploy.yml.example — contrato de disparo", () => {
  it("o template recebe o alvo do deploy como input `ref` do workflow_dispatch", () => {
    expect(template).toMatch(/workflow_dispatch:/);
    expect(template).toMatch(/inputs:\s*\n\s*ref:/);
    expect(template).toMatch(/github\.event\.inputs\.ref/);
  });

  it("o roteiro de deploy da persona é o Release Loop completo", () => {
    // O que a issue #5 procurou e não achou por não saber onde olhar.
    for (const passo of [/Preconditions/i, /Approval/i, /Trigger/i, /Verify/i, /Rollback/i]) {
      expect(persona, String(passo)).toMatch(passo);
    }
  });

  it("a persona dispara passando o input (`-f ref=`), nunca via `--ref`", () => {
    const trigger = /gh\s+workflow\s+run\s+\S*deploy\S*[^\n]*/g;
    const comandos = persona.match(trigger) ?? [];
    expect(comandos.length).toBeGreaterThan(0);
    for (const cmd of comandos) {
      expect(cmd, cmd).toMatch(/(-f|--field|--raw-field)\s+ref=/);
      expect(cmd, cmd).not.toMatch(/--ref\b/);
    }
  });
});

// rb-ai-team#32: o passo 5 dependia de o workflow aceitar a ref, e nenhuma
// precondição o conferia — o agente descobriria no meio do incidente que o
// rollback não roda. E "a tag anterior" não existia em 6 de 7 consumidores.
describe("Release Loop × contrato de deploy — cada passo sabe o que conferir", () => {
  const passo = (n: number): string => {
    const m = new RegExp(`^${n}\\. [\\s\\S]*?(?=^${n + 1}\\. |^## )`, "m").exec(persona);
    return m?.[0] ?? "";
  };

  it("passo 1: a pipeline aceita a ref e o health check confere a versão — e o doctor responde isso", () => {
    const p1 = passo(1);
    expect(p1).toMatch(/Preconditions/);
    expect(p1).toMatch(/`ref`/);
    expect(p1).toMatch(/vers(ão|ion)/i);
    expect(p1).toMatch(/doctor/);
    expect(p1).toMatch(/deploy:/);
  });

  // Revisão da #32: o passo 1 dizia que o doctor responde "o health check
  // espera o SHA", e o núcleo lê o YAML — não vê o host nem a lógica do laço.
  it("passo 1: diz que o doctor lê o workflow estaticamente, e o que um PASS não prova", () => {
    const p1 = passo(1);
    expect(p1).toMatch(/statically/);
    expect(p1).toMatch(/git pull/);
    expect(p1).toMatch(/contents: write/);
    expect(p1).toMatch(/does not see/);
    expect(p1).not.toMatch(/polls the version endpoint until it serves/);
  });

  it("passo 4: a versão servida é o SHA implantado, não só um 200", () => {
    const p4 = passo(4);
    expect(p4).toMatch(/Verify/);
    expect(p4).toMatch(/version_url/);
    expect(p4).toMatch(/SHA/);
  });

  it("passo 5: rollback re-rodando com a tag deploy/ anterior, achada pelo git tag", () => {
    const p5 = passo(5);
    expect(p5).toMatch(/Rollback/);
    expect(p5).toContain("git tag -l 'deploy/*' --sort=-creatordate");
    expect(p5).toMatch(/gh workflow run deploy\.yml -f ref=<tag deploy\/ anterior>/);
  });

  // Revisão de segurança da #32: o primeiro deploy de um projeto não tem tag
  // deploy/ nenhuma (6 dos 7 consumidores não tinham tag), e "a anterior" é
  // ambígua quando o deploy que falhou já ganhou tag ou redeployou um SHA.
  it("passo 3: antes do disparo, registra o SHA que a version_url está servindo", () => {
    const p3 = passo(3);
    expect(p3).toMatch(/[Bb]efore (?:you )?trigger/);
    expect(p3).toMatch(/version_url/);
    expect(p3).toMatch(/record/i);
    expect(p3).toMatch(/SHA/);
  });

  it("passo 5: sem tag deploy/ na lista, o rollback re-roda com o SHA completo do passo 3", () => {
    const p5 = passo(5);
    expect(p5).toMatch(/empty/i);
    expect(p5).toMatch(/gh workflow run deploy\.yml -f ref=<SHA completo do passo 3> -f confirm=deploy/);
  });

  // Re-verificação da #32: o mesa-crm serve 12 caracteres, e o actions/checkout
  // só aceita SHA de 40 — o rollback por SHA falharia no checkout, no meio do
  // incidente. O SHA servido é expandido antes do disparo.
  it("passo 3: o SHA servido, se abreviado, é expandido para os 40 caracteres antes do disparo", () => {
    const p3 = passo(3);
    expect(p3).toContain("git fetch && git rev-parse <curto>");
    expect(p3).toMatch(/40/);
  });

  it("o input ref do template pede o SHA completo", () => {
    const desc = /inputs:\s*\n\s*ref:\s*\n\s*description:\s*"([^"]*)"/.exec(template)?.[1] ?? "";
    expect(desc).toMatch(/SHA completo/);
  });

  it("passo 5: \"anterior\" é a tag deploy/ mais nova cujo sha7 difere do SHA de onde se está saindo", () => {
    const p5 = passo(5);
    expect(p5).toMatch(/newest `deploy\/` tag whose sha7 differs/);
  });
});

// O roteiro certo existir não adianta se ninguém for mandado ler no momento da
// decisão: no quase-incidente do trabalhista (2026-07-25) o Release Loop já
// estava escrito e o agente, de chapéu de remediação, propôs SSH cru sem nunca
// abrir o arquivo. A tabela de leituras sob demanda do BOOT.md é o único ponto
// que o agente vê em TODA sessão — é onde o ponteiro tem que estar.
const boot = fs.readFileSync(path.resolve(repoRoot(), "aiteam", "BOOT.md"), "utf8");

// O mandato deixou de nomear o GitHub Actions como mecanismo (issue #13, opção
// C). Isso abre um buraco silencioso se ninguém avisar: o tier-guard casa
// comandos por padrão e só conhece `gh workflow run …deploy`. Um trigger de
// outro provedor não é "negado por padrão" — ele cai em Tier 1 e roda SEM
// prompt, que é exatamente o furo do deploy por SSH cru. A obrigação de
// registrar o trigger em ask_patterns é a parte que não pode se perder numa
// futura edição do mandato.
describe("CI/CD Mandate — agnóstico de provedor sem perder o gate", () => {
  const mandate = fs.readFileSync(path.resolve(repoRoot(), "aiteam", "AGENTS.md"), "utf8");

  it("exige registrar o trigger de deploy em ask_patterns quando não for GitHub", () => {
    expect(mandate).toMatch(/ask_patterns/);
    expect(mandate).toMatch(/tier-rules\.json/);
  });

  it("avisa que um trigger não listado roda sem prompt, não que é negado", () => {
    expect(mandate).toMatch(/Tier 1/);
  });

  // A proibição virou condicional em 2026-07-29 (#13): a pipeline segue sendo o
  // caminho padrão e ninguém a contorna enquanto ela funciona, mas pipeline
  // indisponível não pode significar produção sem via de deploy. O que o
  // mandato não pode perder é o preço escrito — e em 2026-07-30 esse preço
  // MUDOU DE NATUREZA: com a layer 3 removida, os dois caminhos passaram a ter
  // exatamente o mesmo gate (o ASK), então "camada 2 no lugar da 3" virou
  // afirmação falsa. O que sobra separando-os é rastreabilidade: a pipeline
  // deixa registro auditável fora do terminal do operador, o SSH direto só
  // deixa o nó no `.beads`. É essa a garantia menor que precisa continuar
  // escrita — a asserção muda de string, não de intenção.
  it("o fallback de deploy direto é condicionado e declara a garantia menor de rastreabilidade", () => {
    expect(mandate).toMatch(/pipeline is unavailable/i);
    expect(mandate).toMatch(/traceability, not gate strength/i);
    expect(mandate).toMatch(/weaker guarantee/i);
    expect(mandate).toMatch(/recorded.*\.beads|`\.beads`/i);
  });

  it("controle de host segue fora do fallback", () => {
    expect(mandate).toMatch(/reboot\|shutdown\|\s*poweroff/i);
  });

  // rb-ai-team#32: "o contrato é fixo" era prosa que nada conferia. O mandato
  // tem de dizer onde o projeto o declara e o que o confere.
  it("o health check com versão cita a version_url do bloco deploy: e a falha com a versão antiga no ar", () => {
    const bullet = /^\s*- \*\*The health check must[\s\S]*?(?=^\s*- \*\*)/m.exec(mandate)?.[0] ?? "";
    expect(bullet).toMatch(/`deploy:`/);
    expect(bullet).toMatch(/`version_url`/);
    expect(bullet).toMatch(/SHA/);
    expect(bullet).toMatch(/old version[^.]*still up[^.]*fail/i);
  });

  it("o parágrafo Reference workflow cita o bloco deploy:, quem o confere e a tag deploy/ de rollback", () => {
    // \r?: num checkout Windows (core.autocrlf) o AGENTS.md chega em CRLF.
    const paragrafo = /^Reference workflow:[\s\S]*?(?=\r?\n\r?\n)/m.exec(mandate)?.[0] ?? "";
    expect(paragrafo).toMatch(/`deploy:`/);
    expect(paragrafo).toMatch(/deploy-contract\.test\.ts/);
    expect(paragrafo).toMatch(/doctor/);
    expect(paragrafo).toMatch(/`deploy\/`/);
    expect(paragrafo).toMatch(/git tag -l 'deploy\/\*' --sort=-creatordate/);
  });

  // A checagem é estática: o script que o forced-command roda no host não
  // aparece no workflow (trabalhista, robo-pb-raspagem). Um git pull ali passa
  // pelo núcleo; o mandato tem de dizer quem o pega.
  // Revisão de segurança da #32: o texto prometia mais do que o núcleo
  // confere ("once the health check passes", e só o forced-command
  // escapando). Ele diz agora o que a checagem estática lê, e o que não vê.
  it("o parágrafo diz que a checagem é estática, o que ela confere e o que ela não vê", () => {
    const paragrafo = /^Reference workflow:[\s\S]*?(?=\r?\n\r?\n)/m.exec(mandate)?.[0] ?? "";
    expect(paragrafo).not.toMatch(/once the health check passes/);
    expect(paragrafo).toMatch(/statically/);
    expect(paragrafo).toMatch(/github\.sha/);
    expect(paragrafo).toMatch(/\|\| true/);
    expect(paragrafo).toMatch(/always\(\)/);
    expect(paragrafo).toMatch(/not that it works/);
    expect(paragrafo).toMatch(/comparison logic/);
  });

  // Rodada 4: a checagem estática é heurística; o que segura um pouso errado
  // que ela não vê é a versão derivada no host, comparada no health check.
  it("o parágrafo diz que a checagem é heurística e que a defesa final é a versão derivada no host", () => {
    const paragrafo = /^Reference workflow:[\s\S]*?(?=\r?\n\r?\n)/m.exec(mandate)?.[0] ?? "";
    expect(paragrafo).toMatch(/heuristic/);
    expect(paragrafo).toMatch(/derived on the host/);
  });

  it("o parágrafo declara o limite: o script do forced-command no host só é pego pela comparação de versão", () => {
    const paragrafo = /^Reference workflow:[\s\S]*?(?=\r?\n\r?\n)/m.exec(mandate)?.[0] ?? "";
    expect(paragrafo).toMatch(/forced-command/);
    expect(paragrafo).toMatch(/git pull/);
    expect(paragrafo).toMatch(/only[^.]*version comparison/i);
    expect(paragrafo).toMatch(/contents: write/);
  });
});

describe("BOOT.md — o caminho sancionado é descobrível no ponto de decisão", () => {
  const linhaDeploy = boot
    .split("\n")
    .find((l) => l.startsWith("|") && /deploy/i.test(l));

  it("a tabela de leituras sob demanda tem uma linha de deploy", () => {
    expect(boot).toMatch(/Leituras sob demanda/);
    expect(linhaDeploy, "nenhuma linha da tabela menciona deploy").toBeDefined();
  });

  it("essa linha aponta para o Release Loop e para o CI/CD Mandate", () => {
    expect(linhaDeploy).toMatch(/release-engineer\.md/);
    expect(linhaDeploy).toMatch(/CI\/CD Mandate/);
  });

  it("o ponteiro não é um link morto", () => {
    const alvo = /`?(aiteam\/agents\/release-engineer\.md)`?/.exec(linhaDeploy ?? "")?.[1];
    expect(alvo).toBeDefined();
    expect(fs.existsSync(path.resolve(repoRoot(), alvo!)), alvo).toBe(true);
  });
});

// Re-verificação da #32: com bash -eo pipefail (o `shell: bash` que um
// consumidor põe), o grep -o sem casamento derrubava o pipe da leitura do
// version e matava o laço na primeira tentativa — justo no 502 de quando a
// app ainda sobe. O passo roda aqui de verdade, sob bash -e e sob bash -eo
// pipefail, com curl, date e sleep de mentira.
//
// No Windows o `bash` do PATH pode ser o do WSL; procura-se o do Git. Sem bash
// que funcione, o teste é pulado (o CI roda em ubuntu).
function findBash(): string | null {
  const candidates: string[] = [];
  if (process.platform === "win32") {
    try {
      const exec = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
      candidates.push(path.join(path.resolve(exec, "..", "..", ".."), "bin", "bash.exe"));
    } catch {
      /* sem git: sem bash conhecido */
    }
  } else {
    candidates.push("bash");
  }
  for (const c of candidates) {
    const r = spawnSync(c, ["-c", "echo ok"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "ok") return c;
  }
  return null;
}

const BASH = findBash();

describe.skipIf(BASH === null)("deploy.yml.example — o health check roda de verdade, sob -e e sob pipefail", () => {
  const healthRun = steps.find((s) => s.env?.VERSION_URL !== undefined)?.run ?? "";
  const SHA = "efe9142112c7aaaabbbbccccddddeeeeffff0000";
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  // curl falso: as primeiras `bad` chamadas devolvem `badBody` (ou falham, com
  // `badExit`), as seguintes devolvem `goodBody`. date +%s anda 60s por chamada,
  // então a janela de 600s fecha em poucas voltas.
  const roda = (flags: string, o: { bad: number; badBody: string; badExit?: number; goodBody: string }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-health-"));
    dirs.push(dir);
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const exe = (name: string, body: string) => {
      fs.writeFileSync(path.join(bin, name), body);
      fs.chmodSync(path.join(bin, name), 0o755);
    };
    exe(
      "curl",
      [
        "#!/usr/bin/env bash",
        'n=$(( $(cat "$PWD/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$PWD/n"',
        'if [ "$n" -le "$BAD" ]; then',
        '  if [ "$BAD_EXIT" != 0 ]; then echo "curl: (22) error" >&2; exit "$BAD_EXIT"; fi',
        '  printf "%s" "$BAD_BODY"; exit 0',
        "fi",
        'printf "%s" "$GOOD_BODY"',
        "",
      ].join("\n"),
    );
    exe(
      "date",
      ['#!/usr/bin/env bash', 'if [ "$1" = "+%s" ]; then t=$(cat "$PWD/t" 2>/dev/null || echo 1000000); echo $((t + 60)) > "$PWD/t"; echo "$t"; else /usr/bin/date "$@"; fi', ""].join("\n"),
    );
    exe("sleep", "#!/usr/bin/env bash\nexit 0\n");
    fs.writeFileSync(path.join(dir, "health.sh"), healthRun);
    fs.writeFileSync(path.join(dir, "run.sh"), '#!/usr/bin/env bash\nexport PATH="$PWD/bin:$PATH"\nexec bash $FLAGS ./health.sh\n');
    const r = spawnSync(BASH!, ["./run.sh"], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        FLAGS: flags,
        SHA,
        VERSION_URL: "https://app.example/api/version",
        BAD: String(o.bad),
        BAD_EXIT: String(o.badExit ?? 0),
        BAD_BODY: o.badBody,
        GOOD_BODY: o.goodBody,
      },
    });
    const n = Number(fs.readFileSync(path.join(dir, "n"), "utf8").trim() || "0");
    return { status: r.status, tentativas: n, saida: `${r.stdout}${r.stderr}` };
  };

  for (const flags of ["-e", "-eo pipefail"]) {
    it(`bash ${flags}: corpo sem "version" (a app subindo) não mata o laço — ele tenta de novo até a versão nova`, () => {
      const r = roda(flags, { bad: 2, badBody: '{"status":"starting"}', goodBody: `{"version":"${SHA.slice(0, 12)}"}` });
      expect(r.saida, r.saida).toMatch(/no ar/);
      expect(r.status).toBe(0);
      expect(r.tentativas).toBe(3);
    });

    it(`bash ${flags}: 502 com corpo HTML, e curl que falha, também não`, () => {
      expect(roda(flags, { bad: 2, badBody: "<html>502 Bad Gateway</html>", goodBody: `{"version":"${SHA}"}` }).status).toBe(0);
      const falha = roda(flags, { bad: 2, badBody: "", badExit: 22, goodBody: `{"version":"${SHA}"}` });
      expect(falha.status).toBe(0);
      expect(falha.tentativas).toBe(3);
    });

    it(`bash ${flags}: o passo Deploy manda ao host o SHA expandido e o $(git rev-parse HEAD) intacto`, () => {
      const deployRun = steps.find((s) => /Deploy to VPS/.test(s.name ?? ""))?.run ?? "";
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-ssh-"));
      dirs.push(dir);
      const bin = path.join(dir, "bin");
      fs.mkdirSync(bin);
      // ssh falso: guarda o último argumento, que é o comando remoto.
      fs.writeFileSync(path.join(bin, "ssh"), '#!/usr/bin/env bash\nfor a in "$@"; do last="$a"; done\nprintf "%s" "$last" > "$PWD/remoto"\n');
      fs.chmodSync(path.join(bin, "ssh"), 0o755);
      fs.writeFileSync(path.join(dir, "deploy.sh"), deployRun);
      fs.writeFileSync(path.join(dir, "run.sh"), '#!/usr/bin/env bash\nexport PATH="$PWD/bin:$PATH" HOME="$PWD"\nexec bash $FLAGS ./deploy.sh\n');
      const r = spawnSync(BASH!, ["./run.sh"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, FLAGS: flags, APP_VERSION: SHA, VPS_HOST: "h", VPS_USER: "u", VPS_SSH_KEY: "k" },
      });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      const remoto = fs.readFileSync(path.join(dir, "remoto"), "utf8");
      expect(remoto).toContain(`git checkout --detach ${SHA}`);
      expect(remoto).toContain("APP_VERSION=$(git rev-parse HEAD) docker compose up");
    });

    it(`bash ${flags}: a versão antiga no ar até o fim da janela reprova, apontando a tag de rollback`, () => {
      const r = roda(flags, { bad: 99, badBody: '{"version":"0123456789ab"}', goodBody: "" });
      expect(r.status).toBe(1);
      expect(r.saida).toMatch(/ainda serve '0123456789ab'/);
      expect(r.saida).toMatch(/deploy\//);
    });
  }
});
