import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { probePattern } from "./regex-probe.mjs";
import { classifyTier, guardDecision, isAskEligibleTier3 } from "./tier-core.mjs";

// ReDoS no gate de tiers. O tier-guard roda cada padrão do mapa contra o comando
// inteiro. Um padrão com backtracking exponencial deixa quem escreve o comando
// escolher quanto tempo o hook leva — e o timeout de um hook é falha ABERTA: o
// comando roda sem passar pelo gate. O padrão de ssh que executa um script por
// caminho (`ssh host ./deploy.sh`) tinha esse defeito: `ssh` + 36 flags `-a`
// (111 bytes) levava 1 s e crescia ~2,6x a cada duas flags.
//
// Este arquivo trava duas coisas na cópia canônica (aiteam/templates/tier-rules.json):
//  1. nenhum padrão degenera, medido contra entradas adversárias até 4 KB;
//  2. o padrão de ssh reescrito casa tudo o que o antigo casava.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(HERE, "..", "templates", "tier-rules.json");
const LEGACY_PATH = path.join(HERE, "__fixtures__", "legacy-tier-patterns.json");

const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
const OLD_SSH: string = JSON.parse(readFileSync(LEGACY_PATH, "utf8")).sshScriptByPath;

// O padrão de ssh por caminho (`ssh host ./deploy.sh`), achado pelo que ele tem de próprio: o laço de
// opções (`-\S*`, com `--` e `-oK=v` colado) e o argumento que não começa por `-`.
const SSH_PATH_MARK = "(?!-)\\S+)?)*";

// O tamanho realista de um comando que um agente manda ao Bash: 4 KB. Acima disso
// quase sempre é um heredoc, que o tier-core tira do caminho antes de classificar.
const MAX_COMMAND_BYTES = 4096;

// Todo padrão que o guard roda: as três listas e os `match` das deny_hints.
const PATTERNS: string[] = [
  ...new Set<string>([
    ...template.tier3.patterns,
    ...(template.tier3.ask_patterns ?? []),
    ...template.tier2.patterns,
    ...(template.tier3.deny_hints ?? []).map((h: { match: string }) => h.match),
  ]),
];

describe("aiteam/templates/tier-rules.json — todo padrão tem custo limitado até 4 KB", () => {
  it("o template tem padrões para medir", () => {
    expect(PATTERNS.length).toBeGreaterThan(15);
  });

  // `maxSize` 4 KB. A escada de tamanhos (regex-probe.mjs) para no primeiro degrau
  // que estoura o orçamento (250 ms, medido de novo uma vez antes de reprovar) ou cujo
  // expoente local passa de 3 em dois degraus seguidos, então um padrão ruim que volte
  // reprova em segundos em vez de pendurar a suíte. Quadrático (o `.*` depois de `\s+`)
  // fica em ~15 ms a 4 KB e passa; cúbico (o ssh+shell antigo, "ssh sh " repetido, 0,6 s
  // a 4 KB) reprova pelo orçamento; exponencial reprova perto de 100 bytes. O corte era
  // 5 e o cúbico passava: este comentário dizia que a sondagem pegava "tudo que não é
  // quadrático", e não pegava. Ela cobre as famílias de entrada que gera (palavras do
  // padrão, uma e duas por vez) e NÃO prova ausência de ReDoS: o que garante o gate é o
  // prazo de 2 s do hook, que nega o que estourar.
  it.each(PATTERNS.map((p) => [p]))("%s", (source) => {
    const r = probePattern(source, { maxSize: MAX_COMMAND_BYTES, budgetMs: 250 });
    expect(r, `padrão com custo catastrófico: ${JSON.stringify(r)}`).toMatchObject({ ok: true });
  });

  // A medida de tempo em n contra 2n: linear dobra e quadrático quadruplica;
  // exponencial explode. O teto de 8x folga o ruído de uma máquina carregada.
  // Só roda depois da sondagem (que PARA no primeiro degrau ruim): medir 2 KB de
  // `-a` direto contra um padrão exponencial penduraria a suíte em vez de reprovar.
  it("o padrão de ssh por caminho: dobrar o comando não passa de 8x o tempo", () => {
    const source: string = template.tier3.patterns.find((p: string) => p.includes(SSH_PATH_MARK));
    expect(probePattern(source, { maxSize: MAX_COMMAND_BYTES })).toMatchObject({ ok: true });
    const ssh = new RegExp(source, "i");
    const time = (n: number): number => {
      const text = "ssh" + " -a".repeat(Math.floor(n / 3)) + " host";
      let best = Infinity;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        ssh.test(text);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    time(1024); // aquece
    const small = Math.max(time(2048), 0.05);
    const large = time(4096);
    expect(large / small, `2048 B ${small.toFixed(2)} ms, 4096 B ${large.toFixed(2)} ms`).toBeLessThan(8);
    expect(large).toBeLessThan(100);
  });

  // O comando do relato do QA: `ssh` + flags e nenhum script depois (a falha é o
  // que força o backtracking). Em-processo e curto: com o padrão antigo, 36 flags
  // levam ~1 s em vez de um tempo sem fim.
  it("classifyTier e isAskEligibleTier3 respondem na hora a `ssh` + 36 flags (111 bytes)", () => {
    const command = "ssh" + " -a".repeat(36);
    const t0 = performance.now();
    expect(classifyTier(command, template)).toBeLessThan(3);
    expect(isAskEligibleTier3(command, template)).toBe(false);
    const ms = performance.now() - t0;
    expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(100);
  });

  it("e a mesma linha com o script no fim continua sendo um deploy a perguntar", () => {
    const command = "ssh" + " -a".repeat(36) + " deploy@vps ./deploy.sh";
    expect(classifyTier(command, template)).toBe(3);
    expect(isAskEligibleTier3(command, template)).toBe(true);
  });
});

// Onda 2, item 8: o padrão passou a aceitar `--` e a opção colada (`-oK=v`, `-L8080:h:80`), então é um
// SUPERCONJUNTO do da onda 1: tudo o que o antigo casava ele casa, e o que ele casa a mais tem uma opção
// que o antigo não reconhecia como opção.
describe("o padrão de ssh por caminho: a reescrita casa tudo o que o antigo casava", () => {
  const found = template.tier3.patterns.filter((p: string) => p.includes(SSH_PATH_MARK));
  const NEW_SSH: string = found[0];

  it("o template tem o padrão, em tier3.patterns e em ask_patterns, e não é o antigo", () => {
    expect(found).toHaveLength(1);
    expect(NEW_SSH).not.toBe(OLD_SSH);
    expect(template.tier3.ask_patterns).toContain(NEW_SSH);
  });

  const oldRe = new RegExp(OLD_SSH, "i");
  const newRe = new RegExp(NEW_SSH, "i");
  // O que o novo casa a mais: uma opção que o antigo não lia (`--`, `-x=1`, `-L8080:h:80`, `-é` e um `-`
  // sozinho).
  const NEW_OPTION_FORM = /(^|\s)-(?:(?=\s|$)|-(?=\s|$)|\S*[^\w\s])/;
  const classify = (text: string, lost: string[], unexplained: string[]): void => {
    const before = oldRe.test(text);
    const after = newRe.test(text);
    if (before && !after && lost.length < 10) lost.push(JSON.stringify(text));
    else if (!before && after && !NEW_OPTION_FORM.test(text) && unexplained.length < 10) unexplained.push(JSON.stringify(text));
  };

  // Todas as sequências de até 5 tokens (e as mais curtas) depois de `ssh`: flag
  // solta, flag com argumento, argumento que parece flag, `--`, usuário@host,
  // script por caminho com e sem aspas, `~/`, `./`, absoluto. O antigo é lento só
  // em entradas longas; em 5 tokens ele responde na hora.
  it("exaustivo: todas as sequências de tokens até o tamanho 5", () => {
    const tokens = [
      "-a", "-p", "22", "host", "-o", "X=1", "-x=1", "--", "-", "./a.sh", "'./b.sh'", '"/c.bash"', "~/d.sh", "e.sh", "ssh", "x.sh.bak", "-p22", "u@h",
    ];
    const lost: string[] = [];
    const unexplained: string[] = [];
    let total = 0;
    const walk = (prefix: string, depth: number): void => {
      total++;
      classify(`ssh${prefix}`, lost, unexplained);
      if (depth === 5) return;
      for (const t of tokens) walk(`${prefix} ${t}`, depth + 1);
    };
    walk("", 0);
    expect(total).toBeGreaterThan(1_000_000);
    expect(lost).toEqual([]);
    expect(unexplained).toEqual([]);
  });

  // Entradas aleatórias com separadores variados (tab, quebra de linha, vários
  // espaços), prefixos (sudo, FOO=1, aspas) e caracteres soltos. Semente fixa.
  it("aleatório: separadores, prefixos e caracteres soltos (semente fixa)", () => {
    const atoms = [
      "ssh", "SSH", "-a", "-p", "-i", "-o", "-A", "-", "--", "22", "host", "u@h", "X=1", "./a.sh", "'./b.sh'", '"/c.bash"', "~/d.sh", "/e.SH",
      ".sh", ".bash", "x.sh", "bash", "sh", "'", '"', "-v", "-vvv", "-p22", "-x=1", "-é", "-_", "a-b", "$(x)", ";", "|", "&&", "/", "~", ".", "-6",
    ];
    const seps = [" ", " ", " ", "  ", "\t", "\n", " \t "];
    let seed = 12345;
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)] as T;
    const lost: string[] = [];
    const unexplained: string[] = [];
    for (let i = 0; i < 200_000; i++) {
      let s = rnd() < 0.2 ? pick(["sudo ", "FOO=1 ", "echo x && ", "'", '"', "nohup "]) : "";
      const len = 2 + Math.floor(rnd() * 9);
      for (let k = 0; k < len; k++) {
        s += (k ? pick(seps) : "") + pick(atoms);
        if (rnd() < 0.05) s += pick(["", "x", "1", "_"]);
      }
      classify(s, lost, unexplained);
    }
    expect(lost).toEqual([]);
    expect(unexplained).toEqual([]);
  });

  // As lacunas do A5 que este padrão fecha: `--` e a opção colada.
  it.each([
    "ssh -- host ./deploy.sh",
    "ssh -oStrictHostKeyChecking=no host ./deploy.sh",
    "ssh -oX=y host ./deploy.sh",
    "ssh -p 22 -- deploy@vps /opt/app/deploy.sh",
    "ssh -L8080:localhost:80 host ./deploy.sh",
  ])("passa a pegar %s (Tier 3, ask-eligible)", (cmd) => {
    expect(oldRe.test(cmd), `${cmd} (antigo)`).toBe(false);
    expect(newRe.test(cmd), cmd).toBe(true);
    expect(classifyTier(cmd, template), cmd).toBe(3);
    expect(isAskEligibleTier3(cmd, template), cmd).toBe(true);
  });

  it.each([
    "ssh root@vps /opt/app/deploy.sh",
    "ssh -p 22 deploy@vps ./deploy.sh",
    "ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no root@vps /opt/app/deploy.sh",
    "ssh -o ServerAliveInterval=30 -p 2222 -i key deploy@vps ~/bin/release.sh",
    "ssh -t vps '~/bin/release.sh'",
    'ssh vps "./scripts/deploy.bash"',
    "ssh -vvv -A vps ./x.sh",
    "ssh -p 22 -p 23 -p 24 vps ./x.sh",
    "ssh vps\t./deploy.sh",
  ])("segue pegando %s (Tier 3, ask-eligible)", (cmd) => {
    expect(newRe.test(cmd), cmd).toBe(true);
    expect(classifyTier(cmd, template), cmd).toBe(3);
    expect(isAskEligibleTier3(cmd, template), cmd).toBe(true);
  });

  it.each([
    "ssh vps cat ./deploy.sh",
    "ssh vps ls -la",
    "ssh -p 22 vps ls ./x",
    "ssh vps ./deploy.txt",
    "scp ./deploy.sh vps:/tmp",
  ])("segue sem pegar %s", (cmd) => {
    expect(newRe.test(cmd), cmd).toBe(false);
  });
});

// Onda 2, item 3 — o padrão cúbico. `\bssh\b.*\b(bash|sh|zsh)\s+[^|;&]*\.(sh|bash)\b` tem três
// escolhas livres (qual `ssh`, qual shell, onde para o `[^|;&]*`): "ssh sh " repetido leva 0,6 s
// a 4 KB e 17,5 s a 16 KB. A reescrita as torna determinísticas: só o primeiro `ssh` da linha
// importa (um `ssh` mais adiante tem menos opções), e em cada trecho entre `|;&` só o primeiro
// shell importa (se ele não tem `.sh` depois, os seguintes também não têm).
describe("o padrão de ssh com shell e script: linear, e casa tudo o que o antigo casava", () => {
  const OLD_CUBIC: string = JSON.parse(readFileSync(LEGACY_PATH, "utf8")).sshShellScriptCubic;
  const found: string[] = template.tier3.patterns.filter((p: string) => p.includes("(?!\\b(?:bash|sh|zsh)\\s)"));
  const NEW_CUBIC: string = found[0] ?? "";
  const oldRe = new RegExp(OLD_CUBIC, "i");
  const newRe = new RegExp(NEW_CUBIC, "i");

  it("o template tem o padrão novo, em tier3.patterns e em ask_patterns, e já não tem o cúbico", () => {
    expect(found).toHaveLength(1);
    expect(NEW_CUBIC).not.toBe("");
    expect(NEW_CUBIC).not.toBe(OLD_CUBIC);
    expect(template.tier3.ask_patterns).toContain(NEW_CUBIC);
    expect(template.tier3.patterns).not.toContain(OLD_CUBIC);
    expect(template.tier3.ask_patterns).not.toContain(OLD_CUBIC);
  });

  // Tempo em n contra a família que fazia o antigo cúbico, e as que quebram o novo se a
  // determinização falhar (delimitadores, quebras de linha). Linear: 64 KB cabem em milissegundos;
  // o antigo levava 3,6 s a 8 KB e 34 s a 16 KB.
  it.each([["ssh sh "], ["ssh sh ;"], ["sh "], ["ssh "], ["ssh;sh "], ["a ssh sh ssh sh |"], ["ssh h sh a "], ["ssh bash x |"]])(
    "%j repetido: 64 KB em poucos milissegundos",
    (unit) => {
      for (const n of [8192, 65_536]) {
        const text = unit.repeat(Math.ceil(n / unit.length)).slice(0, n) + "!";
        const t0 = performance.now();
        newRe.test(text);
        const ms = performance.now() - t0;
        expect(ms, `${n} B: ${ms.toFixed(1)} ms`).toBeLessThan(100);
      }
    }
  );

  it("o crescimento é linear: quadruplicar a entrada não passa de ~16x o tempo (folga de máquina carregada)", () => {
    const time = (n: number): number => {
      const text = "ssh sh ".repeat(Math.ceil(n / 7)).slice(0, n) + "!";
      let best = Infinity;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        newRe.test(text);
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    time(16_384); // aquece
    const small = Math.max(time(65_536), 0.05);
    const large = time(262_144);
    expect(large / small, `64 KB ${small.toFixed(2)} ms, 256 KB ${large.toFixed(2)} ms`).toBeLessThan(16);
    expect(large).toBeLessThan(100);
  });

  const TOKENS = [
    "ssh", "sh", "bash", "zsh", "SSH", "Bash", "x", ".sh", "a.sh", ".bash", ".shx", ".sh.", "./d.sh", "-p", "22", " ", "  ", "\t", "\n", "\r",
    "\u2028", "|", ";", "&", "&&", "'", '"', "_", ".", "/", "ssh ", "sh ", "bash ", " .sh", " ", "\v",
  ];

  // Todas as sequências de até 4 tokens de um alfabeto com as quebras de linha (que o `.` do
  // antigo não cruza e o `[^|;&]` cruza), os delimitadores `|;&` e espaços de várias formas.
  // Uma varredura maior (62 milhões de sequências exaustivas de até 5 tokens e 30 milhões
  // aleatórias, 0 divergências) foi feita à parte quando o padrão foi escrito.
  it("exaustivo: todas as sequências de tokens até o tamanho 4", () => {
    const diffs: string[] = [];
    let total = 0;
    let positives = 0;
    const walk = (text: string, depth: number): void => {
      total++;
      const a = oldRe.test(text);
      if (a) positives++;
      if (a !== newRe.test(text) && diffs.length < 10) diffs.push(JSON.stringify(text));
      if (depth === 4) return;
      for (const t of TOKENS) walk(text + t, depth + 1);
    };
    walk("", 0);
    expect(total).toBeGreaterThan(1_500_000);
    expect(positives).toBeGreaterThan(1_000); // o fuzz enxerga casos positivos, não só negativos
    expect(diffs).toEqual([]);
  });

  it("aleatório: sequências de até 24 tokens (semente fixa)", () => {
    let seed = 20_261_006;
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const diffs: string[] = [];
    let positives = 0;
    for (let i = 0; i < 400_000; i++) {
      const len = 1 + Math.floor(rnd() * 24);
      let s = "";
      for (let k = 0; k < len; k++) s += TOKENS[Math.floor(rnd() * TOKENS.length)];
      const a = oldRe.test(s);
      if (a) positives++;
      if (a !== newRe.test(s) && diffs.length < 10) diffs.push(JSON.stringify(s));
    }
    expect(positives).toBeGreaterThan(5_000);
    expect(diffs).toEqual([]);
  });

  // O que o `.*` do antigo cobria e a reescrita tem de continuar cobrindo, e o que continua livre.
  it.each([
    'ssh host "cd x; bash ./deploy.sh"',
    "ssh host 'cd /app && sh deploy.sh'",
    "ssh -p 22 deploy@vps bash /opt/app/release.sh",
    "ssh vps zsh ~/bin/up.bash --now",
    "ssh vps 'echo ok | bash ./x.sh'",
    'ssh vps "bash\n  ./deploy.sh"',
    "SSH VPS BASH ./DEPLOY.SH",
  ])("segue pegando %s (Tier 3, ask-eligible)", (cmd) => {
    expect(oldRe.test(cmd), cmd).toBe(true);
    expect(newRe.test(cmd), cmd).toBe(true);
    expect(classifyTier(cmd, template), cmd).toBe(3);
    expect(isAskEligibleTier3(cmd, template), cmd).toBe(true);
  });

  it.each([
    "ssh vps bash -c 'echo hi'",
    "ssh vps cat deploy.sh",
    "bash ./deploy.sh",
    "ssh vps 'bash; ./x.sh'",
    "ssh vps ls ./x.sh",
  ])("segue sem pegar %s", (cmd) => {
    expect(newRe.test(cmd), cmd).toBe(oldRe.test(cmd));
  });
});

// Onda 2, item 8 (A5). Cinco formas de deploy por ssh passavam como allow: `ssh -- host ./deploy.sh`,
// `ssh -oX=y host ./deploy.sh` (o primeiro e o segundo, no padrão de caminho acima),
// `ssh host "cd /app && ./deploy.sh"`, `ssh host bash -c 'cd /app && ./deploy.sh'` (um script depois de
// um separador DENTRO da linha de comando remota entre aspas) e `ssh host bash -s <<'EOF'` (o shell lê o
// script do stdin). O heredoc de um ssh é script remoto (tier-core, STDIN_INTERPRETERS e as linhas
// remotas). Os dois padrões novos têm a forma dos outros: só o primeiro `ssh` importa e nenhum laço
// tem duas leituras para o mesmo texto.
describe("ssh: script depois de um separador entre aspas e shell que lê o script do stdin (A5)", () => {
  const SEP_MARK = "(?:&&|\\|\\||[;|(\\n\\r])";
  const STDIN_MARK = "(?:\\s+-\\w+)*\\s+-s\\b";
  const sep: string[] = template.tier3.patterns.filter((p: string) => p.includes(SEP_MARK));
  const stdin: string[] = template.tier3.patterns.filter((p: string) => p.includes(STDIN_MARK));
  const SEP_PATTERN = sep[0] ?? "";
  const STDIN_PATTERN = stdin[0] ?? "";

  it("o template tem os dois, em tier3.patterns e em ask_patterns (deploy por ssh é ask)", () => {
    expect(sep).toHaveLength(1);
    expect(stdin).toHaveLength(1);
    for (const p of [SEP_PATTERN, STDIN_PATTERN]) {
      expect(p).not.toBe("");
      expect(template.tier3.ask_patterns).toContain(p);
    }
  });

  // A referência ingênua de cada um: a mesma linguagem sem o truque do primeiro `ssh`, que é polinomial
  // mas inocente. A forma rápida tem de casar exatamente o mesmo texto.
  const NAIVE_SEP = new RegExp(String.raw`\bssh\b[\s\S]*(?:&&|\|\||[;|(\n\r])\s*["']?[~./][^\s;&|"']*\.(?:sh|bash)\b`, "i");
  const NAIVE_STDIN = new RegExp(String.raw`\bssh\b[\s\S]*\b(?:bash|sh|zsh)(?:\s+-\w+)*\s+-s\b`, "i");
  const sepRe = new RegExp(SEP_PATTERN, "i");
  const stdinRe = new RegExp(STDIN_PATTERN, "i");

  const TOKENS = [
    "ssh", "host", "-p", "22", "--", "bash", "sh", "zsh", "-s", "-c", "-x", "'", '"', "&&", "||", ";", "|", "(", "\n", "\r", " ", "  ",
    "./d.sh", "a.sh", "~/b.bash", ".sh", ".shx", "x", "/", ".", "cd /app", "sudo ", "ssh ", "deploy", "bash ", "sh ",
  ];

  it("exaustivo: todas as sequências de até 4 tokens casam como a referência ingênua", () => {
    const diffs: string[] = [];
    let total = 0;
    let positives = 0;
    const walk = (text: string, depth: number): void => {
      total++;
      const a = NAIVE_SEP.test(text);
      const b = NAIVE_STDIN.test(text);
      if (a || b) positives++;
      if ((a !== sepRe.test(text) || b !== stdinRe.test(text)) && diffs.length < 10) diffs.push(JSON.stringify(text));
      if (depth === 4) return;
      for (const t of TOKENS) walk(text + t, depth + 1);
    };
    walk("", 0);
    expect(total).toBeGreaterThan(1_500_000);
    expect(positives).toBeGreaterThan(1_000);
    expect(diffs).toEqual([]);
  });

  it("aleatório: sequências de até 20 tokens (semente fixa)", () => {
    let seed = 8_675_309;
    const rnd = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const diffs: string[] = [];
    let positives = 0;
    for (let i = 0; i < 300_000; i++) {
      const len = 1 + Math.floor(rnd() * 20);
      let s = "";
      for (let k = 0; k < len; k++) s += TOKENS[Math.floor(rnd() * TOKENS.length)];
      const a = NAIVE_SEP.test(s);
      const b = NAIVE_STDIN.test(s);
      if (a || b) positives++;
      if ((a !== sepRe.test(s) || b !== stdinRe.test(s)) && diffs.length < 10) diffs.push(JSON.stringify(s));
    }
    expect(positives).toBeGreaterThan(3_000);
    expect(diffs).toEqual([]);
  });

  // Famílias que degradariam uma leitura ambígua: repetir o separador, o shell, as opções.
  it.each([["ssh ;"], ["ssh ;./"], ["ssh &&./a"], ["ssh bash -x "], ["ssh sh -a -a "], ["ssh bash x |"], ["ssh h sh a "], ["ssh \n"], ["ssh ; ./a.shx "]])(
    "%j repetido: 64 KB em poucos milissegundos nos dois",
    (unit) => {
      for (const n of [8192, 65_536]) {
        const text = unit.repeat(Math.ceil(n / unit.length)).slice(0, n) + "!";
        for (const re of [sepRe, stdinRe]) {
          const t0 = performance.now();
          re.test(text);
          const ms = performance.now() - t0;
          expect(ms, `${n} B: ${ms.toFixed(1)} ms`).toBeLessThan(100);
        }
      }
    }
  );

  // A decisão ponta a ponta, com o mapa canônico inteiro.
  const DECISION: Array<[string, "ask" | "deny" | "allow"]> = [
    // As cinco lacunas do A5:
    ["ssh -- host ./deploy.sh", "ask"],
    ["ssh -oX=y host ./deploy.sh", "ask"],
    ['ssh host "cd /app && ./deploy.sh"', "ask"],
    ["ssh host bash -c 'cd /app && ./deploy.sh'", "ask"],
    ["ssh host bash -s <<'EOF'\ncd /app\n./deploy.sh\nEOF", "ask"],
    // Variações do mesmo formato:
    ["ssh host 'cd /app; ./deploy.sh'", "ask"],
    ["ssh -p 22 deploy@vps \"cd /srv/app || exit 1; ~/bin/release.sh\"", "ask"],
    ["ssh host bash -s < ./deploy.sh", "ask"],
    ["ssh host sh -s", "ask"],
    ["ssh host bash -x -s", "ask"],
    ["ssh host <<'EOF'\ncd /app\n./deploy.sh\nEOF", "ask"],
    ["ssh host <<'EOF'\ncd /app\ndocker compose up -d\nEOF", "ask"],
    // O que segue livre (leitura remota, comandos que não são deploy):
    ["ssh host cat ./deploy.sh", "allow"],
    ['ssh host "cd /app && ls -la"', "allow"],
    ["ssh host uptime", "allow"],
    ["ssh host 'cat x | grep y'", "allow"],
    ['ssh host "cd /app && ./deploy.txt"', "allow"],
    ["ssh host bash -c 'echo -s'", "allow"],
    ["ssh host bash -c 'echo hi'", "allow"],
    ["ssh host <<'EOF'\nls -la\nuptime\nEOF", "allow"],
    ["echo ssh host bash -s", "allow"],
    ["cat > deploy.sh <<'EOF'\n./a.sh\nEOF", "allow"],
    // O que nega, ainda que perto de um deploy:
    ["ssh host bash -s <<'EOF'\nrm -rf /srv/app\nEOF", "deny"],
    ["ssh host <<'EOF'\nsudo reboot\nEOF", "deny"],
    ['ssh host "cd /app && ./deploy.sh; reboot"', "deny"],
    ["ssh host sudo reboot", "deny"],
  ];
  it.each(DECISION)("%j → %s", (command, expected) => {
    expect(guardDecision(command, template, false), command).toBe(expected);
  });
});
