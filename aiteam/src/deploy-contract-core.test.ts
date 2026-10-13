import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { readCiBlock } from "./ci-contract-core.mjs";
import { contractBlockers, evaluateDeployContract, readDeployBlock } from "./deploy-contract-core.mjs";
import type { DeployEvaluation } from "./deploy-contract-core.mjs";
import { extractFrontmatter } from "./frontmatter.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const crlf = (s: string) => s.replace(/\n/g, "\r\n");
const spec = (frontmatter: string) => `---\n${frontmatter}\n---\n\n# Spec\n`;

// O doctor carrega este núcleo em node puro, sem tsx e sem garantia de
// aiteam/node_modules — mesmo invariante do ci-contract-core.mjs.
describe("deploy-contract-core.mjs — carregável pelo doctor em node puro", () => {
  const src = readFileSync(path.join(HERE, "deploy-contract-core.mjs"), "utf8");

  it("não tem shebang", () => {
    expect(src.startsWith("#!")).toBe(false);
  });

  it("só importa módulo local (./), nunca pacote", () => {
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const s of imports) expect(s, s).toMatch(/^\.\//);
  });
});

describe("readDeployBlock — o bloco deploy: do frontmatter do SPEC.md", () => {
  it("lê o workflow e a version_url; o que não foi declarado vem null", () => {
    const r = readDeployBlock(
      spec("budget_usd: 2.00\ndeploy:\n  workflow: deploy.yml\n  version_url: https://mesa.example.com/api/version\nlast_updated: \"\""),
    );
    expect(r).toEqual({
      state: "ok",
      deploy: { workflow: "deploy.yml", version_url: "https://mesa.example.com/api/version", reason: null },
    });
  });

  it("lê o opt-out workflow: none com reason", () => {
    const r = readDeployBlock(spec('deploy:\n  workflow: none\n  reason: "distribuído por sync, sem deploy de produção"'));
    expect(r).toEqual({
      state: "ok",
      deploy: { workflow: "none", version_url: null, reason: "distribuído por sync, sem deploy de produção" },
    });
  });

  it("o workflow pode vir com o caminho .github/workflows/ — vale o nome do arquivo", () => {
    for (const w of [".github/workflows/deploy.yml", "./.github/workflows/deploy.yml", ".github\\workflows\\deploy.yml"]) {
      expect(readDeployBlock(spec(`deploy:\n  workflow: ${w}`)), w).toMatchObject({ deploy: { workflow: "deploy.yml" } });
    }
    expect(readDeployBlock(spec("deploy:\n  workflow: release.yaml"))).toMatchObject({ deploy: { workflow: "release.yaml" } });
  });

  it("CRLF e LF dão o mesmo resultado", () => {
    const s = spec("deploy:  # o deploy de produção\n  workflow: deploy.yml   # em .github/workflows\n\n  # comentário no meio\n  version_url: 'https://x.example.com/api/version'");
    expect(readDeployBlock(crlf(s))).toEqual(readDeployBlock(s));
    expect(readDeployBlock(s)).toMatchObject({
      state: "ok",
      deploy: { workflow: "deploy.yml", version_url: "https://x.example.com/api/version" },
    });
  });

  it("o bloco termina na próxima chave de coluna 0, e convive com o bloco ci:", () => {
    const fm = "ci:\n  test: npm test\ndeploy:\n  workflow: deploy.yml\n# comentário na coluna 0\n\n  version_url: https://x.example.com/v\nreason: isto é outra chave de topo";
    expect(readDeployBlock(spec(fm))).toEqual({
      state: "ok",
      deploy: { workflow: "deploy.yml", version_url: "https://x.example.com/v", reason: null },
    });
    expect(readCiBlock(spec(fm))).toMatchObject({ state: "ok", ci: { test: "npm test" } });
  });

  it("ausente: sem frontmatter, sem a chave deploy de topo, ou deploy só aninhado/comentado", () => {
    expect(readDeployBlock("# Spec sem frontmatter\n")).toEqual({ state: "absent" });
    expect(readDeployBlock(spec("budget_usd: 2.00"))).toEqual({ state: "absent" });
    expect(readDeployBlock(spec("infra_kb:\n  deploy:\n    workflow: deploy.yml"))).toEqual({ state: "absent" });
    expect(readDeployBlock(spec("# deploy:\n#   workflow: deploy.yml"))).toEqual({ state: "absent" });
    expect(readDeployBlock(null)).toEqual({ state: "absent" });
    expect(readDeployBlock(undefined)).toEqual({ state: "absent" });
  });

  it("deploy: sem nenhuma chave é um bloco declarado e vazio (o núcleo cobra o workflow), não ausência", () => {
    expect(readDeployBlock(spec("deploy:\nbudget_usd: 2.00"))).toEqual({
      state: "ok",
      deploy: { workflow: null, version_url: null, reason: null },
    });
  });

  // O que o leitor não sabe ler com certeza vira "malformed" com o motivo —
  // nunca um palpite silencioso que deixaria um typo desligar a checagem.
  describe("malformado — com o motivo", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["deploy: none na mesma linha (o opt-out é workflow: none + reason:)", "deploy: none", /workflow: none/],
      ["valor de fluxo na mesma linha", "deploy: { workflow: deploy.yml }", /bloco/],
      ["chave desconhecida (typo)", "deploy:\n  version-url: https://x/v", /version-url/],
      ["chave duplicada", "deploy:\n  workflow: a.yml\n  workflow: b.yml", /duas vezes/],
      ["bloco deploy: duplicado", "deploy:\n  workflow: a.yml\ndeploy:\n  workflow: b.yml", /duas vezes/],
      ["mapa aninhado", "deploy:\n  workflow:\n    file: deploy.yml", /linha só/],
      ["tab na indentação", "deploy:\n\tworkflow: deploy.yml", /tab/],
      ["chave sem espaço depois dos dois-pontos", "deploy:\n  workflow:deploy.yml", /chave: valor/],
      ["valor em fluxo do YAML", "deploy:\n  workflow: [deploy.yml]", /deploy:/],
      ["aspas sem fechamento", 'deploy:\n  version_url: "https://x/v', /aspas/],
      ["booleano no lugar do workflow", "deploy:\n  workflow: true", /booleano/],
      ["workflow fora de .github/workflows/", "deploy:\n  workflow: ci/deploy.yml", /\.github\/workflows/],
      ["workflow que sai do repo", "deploy:\n  workflow: ../deploy.yml", /\.github\/workflows/],
      ["workflow que não é .yml", "deploy:\n  workflow: deploy.sh", /\.yml/],
      ["workflow com variável", "deploy:\n  workflow: $WF", /variável/],
    ];
    for (const [label, fm, motivo] of cases) {
      it(label, () => {
        const r = readDeployBlock(spec(fm));
        expect(r.state, JSON.stringify(r)).toBe("malformed");
        if (r.state === "malformed") expect(r.reason).toMatch(motivo);
      });
    }

    it("o motivo cita a linha do SPEC.md e nunca fala do bloco ci:", () => {
      const r = readDeployBlock(spec("budget_usd: 2.00\ndeploy:\n  workflow: {a: b}"));
      expect(r).toMatchObject({ state: "malformed", reason: expect.stringMatching(/SPEC\.md:4/) });
      if (r.state === "malformed") expect(r.reason).not.toMatch(/\bci:/);
    });
  });

  // O leitor sem dependência e o js-yaml não podem discordar no subconjunto aceito.
  it("concorda com o js-yaml em tudo que aceita", () => {
    const fixtures = [
      "deploy:\n  workflow: deploy.yml\n  version_url: https://mesa.example.com/api/version",
      "deploy:  # comentário\n  workflow: deploy.yml   # o arquivo\n\n  version_url: 'https://x.example.com/v?a=1'",
      'deploy:\n  workflow: none\n  reason: "framework distribuído por sync"',
      "ci:\n  test: npm test\ndeploy:\n    workflow: release.yaml\n    version_url: \"https://x.example.com/version\"\nlast_updated: \"\"",
    ];
    for (const fm of fixtures) {
      const ours = readDeployBlock(spec(fm));
      const theirs = (yaml.load(extractFrontmatter(spec(fm)) ?? "") as { deploy: Record<string, string> }).deploy;
      expect(ours.state, fm).toBe("ok");
      if (ours.state !== "ok") continue;
      for (const key of ["workflow", "version_url", "reason"] as const) {
        expect(ours.deploy[key], `${key} em ${JSON.stringify(fm)}`).toBe(theirs[key] ?? null);
      }
    }
  });
});

// ── O contrato: o workflow declarado aceita a ref, confere a versão e cria a tag ──
type Wf = { file: string; doc?: unknown; error?: string };
const wf = (file: string, text: string): Wf => ({ file, doc: yaml.load(text) });
const fails = (r: DeployEvaluation) => r.findings.filter((f) => f.level === "fail");
const warns = (r: DeployEvaluation) => r.findings.filter((f) => f.level === "warn");
const failKeys = (r: DeployEvaluation) => fails(r).map((f) => f.key);
const failText = (r: DeployEvaluation) => fails(r).map((f) => f.message).join("\n");
const noFiles = () => null;
const filesAt =
  (byPath: Record<string, string>) =>
  (rel: string): string | null =>
    byPath[rel] ?? null;

const URL_ = "https://mesa.example.com/api/version";
const DECLARED = spec(`deploy:\n  workflow: deploy.yml\n  version_url: ${URL_}`);
const evaluate = (
  workflows: Wf[] | null,
  readFile: (rel: string) => string | null = noFiles,
  specText: string | null = DECLARED,
) => evaluateDeployContract({ specText, workflows, readFile });

// Um deploy.yml montado por partes: cada teste troca só a peça que examina.
const step = (...lines: string[]) => lines.map((l) => `      ${l}`).join("\n") + "\n";
const DISPATCH_REF = [
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  "      ref:",
  "        required: true",
  "        default: main",
  "      confirm:",
  "        required: true",
  "",
].join("\n");
const CHECKOUT_ONLY = [
  "      - uses: actions/checkout@v4",
  "        with:",
  "          ref: ${{ github.event.inputs.ref }}",
  "",
].join("\n");
// A forma do template: a ref vira um SHA no runner, e o passo remoto recebe o SHA.
const RESOLVE = step("- name: Resolve", "  id: version", '  run: echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"');
const DEPLOY = step(
  "- name: Deploy",
  "  env:",
  "    SHA: ${{ steps.version.outputs.sha }}",
  '  run: ssh h "cd /opt/app && git checkout --detach $SHA && docker compose up -d --build"',
);
const CHECKOUT_REF = CHECKOUT_ONLY + RESOLVE + DEPLOY;
// O health check que compara: a versão servida tem de conter o SHA resolvido.
const HEALTH = [
  "      - name: Health",
  "        env:",
  "          SHA: ${{ steps.version.outputs.sha }}",
  "        run: |",
  `          for i in 1 2 3; do curl -fsS -H 'Cache-Control: no-cache' "${URL_}" | grep -q "$SHA" && exit 0; sleep 5; done; exit 1`,
  "",
].join("\n");
const TAG = [
  "      - name: Tag",
  "        run: |",
  '          TAG="deploy/$(date -u +%Y%m%d-%H%M)-${SHA:0:7}"',
  '          git tag -a "$TAG" -m deploy "$SHA"',
  '          git push origin "refs/tags/$TAG"',
  "",
].join("\n");
const WRITE = "permissions:\n  contents: write\n";
const deployYml = (parts: { on?: string; permissions?: string; job?: string; steps: string }) =>
  wf(
    "deploy.yml",
    `${parts.on ?? DISPATCH_REF}${parts.permissions ?? WRITE}jobs:\n  deploy:\n    runs-on: ubuntu-latest\n${parts.job ?? ""}    steps:\n${parts.steps}`,
  );
const COMPLETE = deployYml({ steps: CHECKOUT_REF + HEALTH + TAG });
// O passo remoto de um workflow reutilizável que recebe a ref no input `alvo`.
const CALLED_DEPLOY = step("- name: Deploy", '  run: ssh h "cd /opt/app && git checkout ${{ inputs.alvo }}"');

describe("evaluateDeployContract — o bloco deploy: em si", () => {
  it("SPEC.md sem bloco deploy: falha dizendo o que declarar, o opt-out e onde está o modelo", () => {
    const r = evaluate([COMPLETE], noFiles, spec("budget_usd: 2.00"));
    expect(failKeys(r)).toEqual(["deploy"]);
    const msg = failText(r);
    for (const re of [/deploy:/, /workflow:/, /version_url:/, /workflow: none/, /reason:/, /deploy\.yml\.example/, /AGENTS\.md/]) {
      expect(msg).toMatch(re);
    }
  });

  it("SPEC.md ausente falha", () => {
    expect(failKeys(evaluate([COMPLETE], noFiles, null))).toEqual(["spec"]);
  });

  it("bloco ilegível falha com o motivo do leitor", () => {
    expect(failText(evaluate([COMPLETE], noFiles, spec("deploy:\n  url: x")))).toMatch(/deploy\.url/);
  });

  it("deploy: sem workflow falha: workflow é obrigatório", () => {
    const r = evaluate([COMPLETE], noFiles, spec(`deploy:\n  version_url: ${URL_}`));
    expect(failKeys(r)).toEqual(["workflow"]);
    expect(failText(r)).toMatch(/obrigatório/);
  });

  it("opt-out workflow: none com reason passa, e o motivo fica visível como aviso", () => {
    const r = evaluate(null, noFiles, spec('deploy:\n  workflow: none\n  reason: "distribuído por sync"'));
    expect(fails(r)).toEqual([]);
    expect(warns(r)).toEqual([
      expect.objectContaining({ key: "workflow", message: expect.stringMatching(/distribuído por sync/) }),
    ]);
  });

  it("opt-out sem reason falha", () => {
    const r = evaluate(null, noFiles, spec("deploy:\n  workflow: none"));
    expect(fails(r)).toEqual([expect.objectContaining({ key: "workflow", message: expect.stringMatching(/reason/) })]);
  });

  it("version_url ausente ou que não é http(s) falha", () => {
    const sem = evaluate([COMPLETE], noFiles, spec("deploy:\n  workflow: deploy.yml"));
    expect(failKeys(sem)).toContain("version_url");
    const ftp = evaluate([COMPLETE], noFiles, spec("deploy:\n  workflow: deploy.yml\n  version_url: ftp://x/v"));
    expect(failKeys(ftp)).toContain("version_url");
    expect(failText(ftp)).toMatch(/https?/);
  });

  it("o workflow declarado que não existe falha apontando o template", () => {
    const r = evaluate([wf("ci.yml", "on: pull_request\njobs: {}\n")]);
    expect(failKeys(r)).toEqual(["workflow"]);
    expect(failText(r)).toMatch(/\.github\/workflows\/deploy\.yml/);
    expect(failText(r)).toMatch(/deploy\.yml\.example/);
  });

  it("o workflow declarado que não é YAML válido falha, com o erro", () => {
    const r = evaluate([{ file: "deploy.yml", error: "bad indentation" }]);
    expect(failKeys(r)).toEqual(["workflow"]);
    expect(failText(r)).toMatch(/bad indentation/);
  });

  it("sem os workflows (sem parser YAML) avisa que não conferiu, e ainda julga o bloco", () => {
    const r = evaluate(null);
    expect(fails(r)).toEqual([]);
    expect(warns(r)).toEqual([expect.objectContaining({ key: "workflows" })]);
    expect(failKeys(evaluate(null, noFiles, spec("budget_usd: 2.00")))).toEqual(["deploy"]);
  });
});

describe("evaluateDeployContract — o template de referência cumpre o contrato", () => {
  const template = readFileSync(path.join(HERE, "..", "templates", "deploy.yml.example"), "utf8");

  it("deploy.yml.example passa no núcleo com a URL do próprio template", () => {
    const r = evaluateDeployContract({
      specText: spec("deploy:\n  workflow: deploy.yml\n  version_url: https://SEU_DOMINIO/api/version"),
      workflows: [wf("deploy.yml", template)],
      readFile: noFiles,
    });
    expect(r.findings).toEqual([]);
    expect(r.located.map((l) => l.key).sort()).toEqual(["ref", "tag", "version"]);
  });
});

describe("evaluateDeployContract — o input ref chega ao deploy", () => {
  it("o workflow completo passa e diz onde achou cada peça", () => {
    const r = evaluate([COMPLETE]);
    expect(r.findings).toEqual([]);
    const where = Object.fromEntries(r.located.map((l) => [l.key, l.where]));
    expect(where.ref).toMatch(/deploy\.yml › deploy › Deploy \(env SHA\)/);
    expect(where.version).toMatch(/Health/);
    expect(where.tag).toMatch(/Tag/);
  });

  it("sem input ref no workflow_dispatch falha — o mesa-crm antes do infra-410", () => {
    const on = [
      "on:",
      "  workflow_dispatch:",
      "    inputs:",
      "      confirm:",
      "        required: true",
      "      skip_changelog_check:",
      "        default: ''",
      "",
    ].join("\n");
    const r = evaluate([deployYml({ on, steps: step("- uses: actions/checkout@v4") + HEALTH + TAG })]);
    expect(failKeys(r)).toEqual(["ref"]);
    expect(failText(r)).toMatch(/workflow_dispatch/);
    expect(failText(r)).toMatch(/-f ref=/);
    expect(failText(r)).toMatch(/deploy\.yml\.example/);
  });

  it("on: workflow_dispatch em escalar ou lista não tem input — falha", () => {
    for (const on of ["on: workflow_dispatch\n", "on: [workflow_dispatch, push]\n"]) {
      expect(failKeys(evaluate([deployYml({ on, steps: CHECKOUT_REF + HEALTH + TAG })])), on).toEqual(["ref"]);
    }
  });

  it("input ref declarado que não chega a passo nenhum falha — o git pull do passo remoto", () => {
    const pull = step(
      "- uses: actions/checkout@v4",
      "- name: Deploy",
      "  run: ssh \"$VPS_USER@$VPS_HOST\" 'cd /opt/app && git pull --ff-only && docker compose up -d --build'",
    );
    const r = evaluate([deployYml({ steps: pull + HEALTH + TAG })]);
    expect(failKeys(r).sort()).toEqual(["pull", "ref"]);
    expect(failText(r)).toMatch(/não chega/);
    expect(failText(r)).toMatch(/git pull/);
  });

  it("o ref via env: do passo, usado no run: — o trabalhista e o robo-pb-raspagem", () => {
    const viaEnv = step(
      "- name: Deploy to VPS",
      "  env:",
      "    REF: ${{ github.event.inputs.ref }}",
      "  run: ssh -i k \"$VPS_USER@$VPS_HOST\" \"$REF\"",
    );
    const r = evaluate([deployYml({ steps: viaEnv + HEALTH + TAG })]);
    expect(r.findings).toEqual([]);
    expect(r.located.find((l) => l.key === "ref")?.where).toMatch(/Deploy to VPS.*env REF/);
  });

  it("o ref via env: do job ou do workflow conta, e ${VAR} também", () => {
    const steps = step("- name: Deploy", '  run: ssh h "cd /opt/app && git checkout ${ALVO}"') + HEALTH + TAG;
    const jobEnv = wf("deploy.yml", `${DISPATCH_REF}${WRITE}jobs:\n  deploy:\n    env:\n      ALVO: \${{ inputs.ref }}\n    steps:\n${steps}`);
    expect(evaluate([jobEnv]).findings).toEqual([]);
    const wfEnv = wf("deploy.yml", `${DISPATCH_REF}${WRITE}env:\n  ALVO: \${{ inputs.ref }}\njobs:\n  deploy:\n    steps:\n${steps}`);
    expect(evaluate([wfEnv]).findings).toEqual([]);
  });

  it("env: com o ref que nenhum run: usa não conta", () => {
    const unused = step("- name: Deploy", "  env:", "    REF: ${{ inputs.ref }}", "  run: ssh h 'cd /opt/app && ./deploy.sh'");
    expect(failKeys(evaluate([deployYml({ steps: unused + HEALTH + TAG })]))).toEqual(["ref"]);
  });

  it("o ref direto no run: conta; num comentário, não", () => {
    const direto = step("- name: Deploy", '  run: ssh h "git checkout ${{ inputs.ref }}"');
    expect(evaluate([deployYml({ steps: direto + HEALTH + TAG })]).findings).toEqual([]);
    const comentario = step("- name: Deploy", "  run: |", "    # depois: git checkout ${{ inputs.ref }}", "    ssh h './deploy.sh'");
    expect(failKeys(evaluate([deployYml({ steps: comentario + HEALTH + TAG })]))).toEqual(["ref"]);
  });

  it("o ref no with: de uma action de deploy conta (ssh-action)", () => {
    const action = step(
      "- uses: appleboy/ssh-action@v1",
      "  with:",
      "    script: cd /opt/app && git checkout ${{ github.event.inputs.ref }}",
    );
    expect(evaluate([deployYml({ steps: action + HEALTH + TAG })]).findings).toEqual([]);
  });

  it("inputs.refs ou inputs.ref_name não são o input ref", () => {
    for (const nome of ["ref_name", "refs", "ref-x"]) {
      const outro = step("- uses: actions/checkout@v4", "  with:", `    ref: \${{ inputs.${nome} }}`);
      expect(failKeys(evaluate([deployYml({ steps: outro + HEALTH + TAG })])), nome).toEqual(["ref"]);
    }
  });
});

// Revisão de segurança da #32: a checagem aceitava o primeiro passo de qualquer
// tipo que citasse a ref — o checkout do runner, o passo da tag, um echo — e
// aprovava o template com o passo remoto trocado por git pull. Agora a ref (ou
// o SHA que um git rev-parse tirou do checkout dela) tem de chegar a um passo
// que fala com o host; git pull reprova onde estiver; e github.sha, que num
// workflow_dispatch é o HEAD da main, não pode estar no lugar do SHA da ref.
describe("evaluateDeployContract — a ref chega a um passo de deploy, e nada a desfaz", () => {
  const templateText = readFileSync(path.join(HERE, "..", "templates", "deploy.yml.example"), "utf8");
  const TEMPLATE_SPEC = spec("deploy:\n  workflow: deploy.yml\n  version_url: https://SEU_DOMINIO/api/version");
  const onTemplate = (text: string, files: Record<string, string> = {}) =>
    evaluateDeployContract({ specText: TEMPLATE_SPEC, workflows: [wf("deploy.yml", text)], readFile: filesAt(files) });

  it("regressão: o template com o passo remoto trocado por git pull reprova", () => {
    const pull = templateText.replace(
      /git fetch --all --tags && git checkout --detach \$APP_VERSION && APP_VERSION=\\\$\(git rev-parse HEAD\) docker compose up -d --build/,
      "git pull --ff-only && docker compose up -d --build",
    );
    expect(pull).not.toBe(templateText);
    const r = onTemplate(pull);
    expect(failKeys(r)).toContain("pull");
    expect(failKeys(r)).toContain("ref");
    expect(failText(r)).toMatch(/Deploy to VPS/);
  });

  it("regressão: checkout sem ref e remoto com git pull reprova, mesmo com a ref no passo da tag", () => {
    const steps =
      step("- uses: actions/checkout@v4") +
      step("- name: Deploy", "  run: ssh h 'cd /opt/app && git pull --ff-only && docker compose up -d --build'") +
      HEALTH +
      step("- name: Tag", "  env:", "    REF: ${{ github.event.inputs.ref }}", "  run: |", '    TAG="deploy/x"', '    git tag -a "$TAG" -m "deploy: $REF"', '    git push origin "refs/tags/$TAG"');
    const r = evaluate([deployYml({ steps })]);
    expect(failKeys(r).sort()).toEqual(["pull", "ref"]);
    expect(r.located.find((l) => l.key === "ref")).toBeUndefined();
  });

  it("regressão: a ref só num echo não chega ao deploy", () => {
    const steps = step('- run: echo "deploying ${{ inputs.ref }}"', "- name: Deploy", "  run: ssh h 'cd /opt/app && ./deploy.sh'") + HEALTH + TAG;
    expect(failKeys(evaluate([deployYml({ steps })]))).toEqual(["ref"]);
  });

  it("regressão: o template com github.sha no lugar do SHA resolvido reprova", () => {
    const ghsha = templateText.replaceAll("${{ steps.version.outputs.sha }}", "${{ github.sha }}");
    expect(ghsha).not.toBe(templateText);
    const r = onTemplate(ghsha);
    expect(failKeys(r)).toContain("sha");
    expect(failText(r)).toMatch(/github\.sha/);
    expect(failText(r)).toMatch(/HEAD da main|main/);
  });

  it("no passo remoto, a ref num echo não conta; num comando, conta", () => {
    const eco = step("- name: Deploy", "  env:", "    REF: ${{ inputs.ref }}", "  run: |", '    echo "subindo $REF"', "    ssh h './deploy.sh'");
    expect(failKeys(evaluate([deployYml({ steps: eco + HEALTH + TAG })]))).toEqual(["ref"]);
  });

  it("o SHA de um git rev-parse só carrega a ref se vier depois do checkout dela", () => {
    const semRef = step("- uses: actions/checkout@v4") + RESOLVE + DEPLOY;
    expect(failKeys(evaluate([deployYml({ steps: semRef + HEALTH + TAG })]))).toEqual(["ref"]);
    const antes = RESOLVE + CHECKOUT_ONLY + DEPLOY;
    expect(failKeys(evaluate([deployYml({ steps: antes + HEALTH + TAG })]))).toEqual(["ref"]);
  });

  it("variável de shell montada com a ref conta — a forma do omni-chat", () => {
    const omni = step(
      "- name: Deploy to VPS",
      "  env:",
      "    DEPLOY_REF: ${{ github.event.inputs.ref }}",
      "  run: |",
      '    REMOTE_CMD="cd /opt/omni-chat && bash scripts/deploy.sh"',
      '    if [ -n "$DEPLOY_REF" ]; then',
      '      REMOTE_CMD="cd /opt/omni-chat && DEPLOY_REF=$DEPLOY_REF bash scripts/deploy.sh"',
      "    fi",
      '    ssh -i k "$VPS_USER@$VPS_HOST" "$REMOTE_CMD"',
    );
    const r = evaluate([deployYml({ steps: omni + HEALTH + TAG })]);
    expect(r.findings).toEqual([]);
  });

  it("checkout da ref sem passo remoto é aviso: o deploy roda no runner, onde o núcleo não o vê", () => {
    const r = evaluate([deployYml({ steps: CHECKOUT_ONLY + step("- run: npm ci && npm run deploy") + HEALTH + TAG })]);
    expect(fails(r)).toEqual([]);
    expect(warns(r)).toEqual([expect.objectContaining({ key: "ref", message: expect.stringMatching(/runner/) })]);
    expect(warns(r)[0]?.message).toMatch(/aiteam\/templates\/deploy\.yml\.example/);
  });

  // Re-verificação da #32: o ssh embrulhado (timeout, sudo -E) ou dentro de um
  // script do repo não era reconhecido como passo remoto — o workflow caía no
  // aviso de "deploy no runner" em vez de reprovar a ref que não chega.
  describe("embrulhos e remoto em script: o passo que fala com o host é reconhecido", () => {
    const deploy = (run: string, env = "") => step("- name: Deploy", ...(env ? ["  env:", `    ${env}`] : []), `  run: ${run}`);
    const avalia = (d: string, files: Record<string, string> = {}) =>
      evaluate([deployYml({ steps: CHECKOUT_ONLY + RESOLVE + d + HEALTH + TAG })], filesAt(files));
    const SHA_ENV = "SHA: ${{ steps.version.outputs.sha }}";

    it("timeout 900 ssh com branch fixo reprova a ref", () => {
      const r = avalia(deploy(`timeout 900 ssh h "cd /opt/app && git fetch && git checkout main && docker compose up -d"`));
      expect(failKeys(r)).toEqual(["ref"]);
      // Nada de "deploy no runner"; o aviso que sobra é o do branch fixo.
      expect(warns(r).map((f) => f.key)).toEqual(["pinned"]);
    });

    it("sudo -E ssh com branch fixo reprova a ref", () => {
      expect(failKeys(avalia(deploy('sudo -E ssh h "git checkout main"')))).toEqual(["ref"]);
      expect(failKeys(avalia(deploy('sudo -u deploy --preserve-env ssh h "git checkout main"')))).toEqual(["ref"]);
    });

    it("run: ./infra/deploy.sh com ssh dentro e branch fixo reprova a ref", () => {
      const r = avalia(deploy("./infra/deploy.sh"), { "infra/deploy.sh": "ssh h 'cd /opt/app && git fetch && git checkout origin/main && docker compose up -d'\n" });
      expect(failKeys(r)).toEqual(["ref"]);
      expect(warns(r).map((f) => f.key)).toEqual(["pinned"]);
    });

    // Rodada 3: eval "ssh …", "$SSH" h, stdbuf e flock escapavam do
    // remoteCommand e caíam no aviso de "deploy no runner". Basta a palavra
    // ssh/scp/rsync no código sem comentário.
    it("ssh como palavra no código conta como remoto: eval, binário em variável, stdbuf, flock", () => {
      for (const run of [
        "eval \"ssh h 'git checkout main && docker compose up -d'\"",
        "SSH=ssh; \"$SSH\" h 'git checkout main && docker compose up -d'",
        "stdbuf -oL ssh h 'git checkout main && docker compose up -d'",
        "flock /tmp/deploy.lock ssh h 'git checkout main && docker compose up -d'",
        "flock /tmp/deploy.lock rsync -a dist/ h:/srv/app/",
      ]) {
        const r = avalia(deploy(run));
        expect(failKeys(r), run).toEqual(["ref"]);
        expect(warns(r).map((f) => f.key), run).not.toContain("ref");
      }
    });

    it("~/.ssh, ssh-keyscan, ssh_config e ssh num comentário não fazem o passo remoto", () => {
      for (const run of ["mkdir -p ~/.ssh && ssh-keyscan h >> ~/.ssh/known_hosts", "cp ssh_config /tmp/ && npm run deploy", "npm run deploy # via ssh, um dia"]) {
        const r = avalia(deploy(run));
        expect(fails(r), run).toEqual([]);
        expect(warns(r).map((f) => f.key), run).toEqual(["ref"]);
      }
    });

    it("com o SHA chegando ao comando embrulhado, ou ao script pelo env:, passa", () => {
      expect(avalia(deploy('timeout 900 ssh h "git checkout --detach $SHA"', SHA_ENV)).findings).toEqual([]);
      expect(avalia(deploy('nice -n 10 nohup env X=1 ssh h "git checkout --detach $SHA"', SHA_ENV)).findings).toEqual([]);
      expect(avalia(deploy(`bash -c 'ssh h "git checkout --detach $SHA"'`, SHA_ENV)).findings).toEqual([]);
      const script = { "infra/deploy.sh": 'ssh h "cd /opt/app && git checkout --detach $SHA && docker compose up -d"\n' };
      const r = avalia(deploy("./infra/deploy.sh", SHA_ENV), script);
      expect(r.findings).toEqual([]);
      expect(r.located.find((l) => l.key === "ref")?.where).toMatch(/Deploy → infra\/deploy\.sh/);
    });
  });

  // Rodada 3: a ref chegando só ao passo que confere a versão dava verde. O
  // deploy fazia `git reset --hard origin/main` e o smoke por ssh recebia o
  // $SHA — a topologia do mesa-crm. O passo que consulta a version_url não é
  // o deploy quando há outro passo remoto; e pousar o host num branch fixo é
  // aviso que o contract test barra.
  describe("a ref chega ao deploy, não só à checagem; o host não pousa num branch fixo", () => {
    const SMOKE_SH = { "infra/prod/smoke.sh": `v=$(curl -fsS ${URL_} | jq -r .version)\n[ "$v" = "$1" ] || exit 1\n` };
    const smoke = step("- name: Smoke", "  env:", "    SHA: ${{ steps.version.outputs.sha }}", '  run: ssh h "cd /opt/app && bash infra/prod/smoke.sh $SHA"');
    const deploy = (run: string) => step("- name: Deploy", `  run: ${run}`);
    const pinFindings = (r: DeployEvaluation) => r.findings.filter((f) => f.key === "pinned");

    it("regressão (mesa-crm): deploy com reset --hard origin/main + smoke por ssh com $SHA reprova a ref, e avisa do branch fixo", () => {
      const steps = CHECKOUT_ONLY + RESOLVE + deploy("ssh h 'cd /opt/app && git fetch && git reset --hard origin/main && docker compose up -d --build'") + smoke + TAG;
      const r = evaluate([deployYml({ steps })], filesAt(SMOKE_SH));
      expect(failKeys(r)).toEqual(["ref"]);
      expect(pinFindings(r)).toEqual([expect.objectContaining({ level: "warn", message: expect.stringMatching(/reset --hard origin\/main/) })]);
      expect(pinFindings(r)[0]?.message).toMatch(/aiteam\/templates\/deploy\.yml\.example/);
      expect(contractBlockers(r).length).toBe(2);
    });

    it("o health check por ssh num passo separado não conta como o deploy", () => {
      const health = step("- name: Health", "  env:", "    SHA: ${{ steps.version.outputs.sha }}", `  run: ssh h "curl -fsS ${URL_} | grep -q $SHA"`);
      const steps = CHECKOUT_ONLY + RESOLVE + deploy("ssh h 'cd /opt/app && ./deploy.sh'") + health + TAG;
      expect(failKeys(evaluate([deployYml({ steps })]))).toEqual(["ref"]);
    });

    it("o único passo remoto que faz deploy e checagem juntos continua contando", () => {
      const junto = step(
        "- name: Deploy e health",
        "  env:",
        "    SHA: ${{ steps.version.outputs.sha }}",
        `  run: ssh h "git checkout --detach $SHA && docker compose up -d && curl -fsS ${URL_} | grep -q $SHA"`,
      );
      expect(evaluate([deployYml({ steps: CHECKOUT_ONLY + RESOLVE + junto + TAG })]).findings).toEqual([]);
    });

    it("checkout ou switch de branch literal, e reset --hard origin/<branch>, no ssh ou em script seguido, avisam", () => {
      for (const remoto of ["git checkout main", "git switch main", "git -C /opt/app reset --hard origin/release", "git checkout -B deploy origin/main"]) {
        const steps = CHECKOUT_REF + deploy(`ssh h 'cd /opt/app && git fetch && ${remoto} && docker compose up -d'`) + HEALTH + TAG;
        expect(pinFindings(evaluate([deployYml({ steps })])).map((f) => f.level), remoto).toEqual(["warn"]);
      }
      const script = { "infra/deploy.sh": "ssh h 'cd /opt/app && git checkout main && docker compose up -d'\n" };
      const viaScript = evaluate([deployYml({ steps: CHECKOUT_REF + deploy("./infra/deploy.sh") + HEALTH + TAG })], filesAt(script));
      expect(pinFindings(viaScript)).toHaveLength(1);
      expect(pinFindings(viaScript)[0]?.message).toMatch(/infra\/deploy\.sh/);
    });

    // Rodada 4: vermelhos falsos do pinned. Restaurar arquivo (checkout .,
    // checkout HEAD -- arquivo) não muda de versão; e um checkout de branch
    // seguido de reset --hard / checkout --detach do SHA recebido pousa no SHA.
    it("checkout . e checkout HEAD -- arquivo não avisam", () => {
      for (const antes of ["git checkout .", "git checkout HEAD -- .env.example", "git checkout origin/main -- package-lock.json"]) {
        const steps =
          CHECKOUT_ONLY +
          RESOLVE +
          step("- name: Deploy", "  env:", "    V: ${{ steps.version.outputs.sha }}", `  run: ssh h "cd /opt/app && ${antes} && git fetch && git checkout --detach $V && docker compose up -d"`) +
          HEALTH +
          TAG;
        expect(pinFindings(evaluate([deployYml({ steps })])), antes).toEqual([]);
      }
    });

    it("branch literal seguido, na mesma cadeia, de reset --hard ou checkout --detach do SHA recebido não avisa", () => {
      for (const depois of ["git reset --hard $V", "git checkout --detach $V", "git switch --detach ${V}"]) {
        const steps =
          CHECKOUT_ONLY +
          RESOLVE +
          step("- name: Deploy", "  env:", "    V: ${{ steps.version.outputs.sha }}", `  run: ssh h "cd /opt/app && git fetch && git checkout main && ${depois} && docker compose up -d"`) +
          HEALTH +
          TAG;
        expect(pinFindings(evaluate([deployYml({ steps })])), depois).toEqual([]);
      }
      // reset --hard de outra coisa depois não desfaz o branch fixo.
      const outra = CHECKOUT_REF + deploy("ssh h 'cd /opt/app && git checkout main && git reset --hard origin/main && docker compose up -d'") + HEALTH + TAG;
      expect(pinFindings(evaluate([deployYml({ steps: outra })])).length).toBe(1);
    });

    it("checkout/switch do SHA recebido, ou de arquivo depois de --, não avisam", () => {
      for (const remoto of ['git checkout --detach "$SHA"', "git switch --detach $SHA", "git checkout -- docker-compose.yml"]) {
        const steps = CHECKOUT_ONLY + RESOLVE + step("- name: Deploy", "  env:", "    SHA: ${{ steps.version.outputs.sha }}", `  run: ssh h 'cd /opt/app && git checkout --detach $SHA && ${remoto}'`) + HEALTH + TAG;
        expect(pinFindings(evaluate([deployYml({ steps })])), remoto).toEqual([]);
      }
    });
  });

  describe("git pull reprova onde estiver, fora de comentário", () => {
    it("no with: de uma action de ssh", () => {
      const action = step("- uses: appleboy/ssh-action@v1", "  with:", "    script: cd /opt/app && git checkout ${{ inputs.ref }} && git pull");
      expect(failKeys(evaluate([deployYml({ steps: action + HEALTH + TAG })]))).toEqual(["pull"]);
    });

    it("num script do repo que o passo remoto chama, com a cadeia na mensagem", () => {
      const omni = step("- name: Deploy", "  env:", "    REF: ${{ inputs.ref }}", '  run: ssh h "cd /opt/app && DEPLOY_REF=$REF bash scripts/deploy.sh"');
      const files = { "scripts/deploy.sh": 'git checkout "$DEPLOY_REF"\ngit -C /opt/app pull --ff-only\n' };
      const r = evaluate([deployYml({ steps: omni + HEALTH + TAG })], filesAt(files));
      expect(failKeys(r)).toEqual(["pull"]);
      expect(failText(r)).toMatch(/Deploy → scripts\/deploy\.sh/);
    });

    it("em comentário, no workflow ou no script, não", () => {
      const comentado = step("- name: Deploy", "  env:", "    REF: ${{ inputs.ref }}", "  run: |", "    # nunca git pull aqui", '    ssh h "git checkout $REF" # git pull não', "    bash scripts/x.sh");
      const files = { "scripts/x.sh": "# era git pull --ff-only\necho ok\n" };
      expect(evaluate([deployYml({ steps: comentado + HEALTH + TAG })], filesAt(files)).findings).toEqual([]);
    });
  });

  describe("github.sha no lugar do SHA da ref reprova, quando o workflow tem o input ref", () => {
    const comRef = (s: string) => evaluate([deployYml({ steps: s })]);
    // github.sha também não é fonte do SHA implantado: a comparação reprova junto.
    it("no env do health check", () => {
      const health = HEALTH.replace("${{ steps.version.outputs.sha }}", "${{ github.sha }}");
      expect(failKeys(comRef(CHECKOUT_REF + health + TAG)).sort()).toEqual(["sha", "version"]);
    });

    it("no passo da tag e no passo remoto ($GITHUB_SHA)", () => {
      const tag = TAG.replace('"$SHA"', '"${{ github.sha }}"');
      expect(failKeys(comRef(CHECKOUT_REF + HEALTH + tag))).toEqual(["sha"]);
      const remoto = step("- name: Deploy", "  env:", "    REF: ${{ inputs.ref }}", '  run: ssh h "git checkout $REF && APP_VERSION=$GITHUB_SHA docker compose up -d"');
      expect(failKeys(comRef(CHECKOUT_ONLY + remoto + HEALTH + TAG))).toEqual(["sha"]);
    });

    it("sem o input ref, não há achado sha: a falha é a do ref", () => {
      const health = HEALTH.replace("${{ steps.version.outputs.sha }}", "${{ github.sha }}");
      const r = evaluate([deployYml({ on: "on: workflow_dispatch\n", steps: CHECKOUT_REF + health + TAG })]);
      expect(failKeys(r)).toContain("ref");
      expect(failKeys(r)).not.toContain("sha");
    });
  });
});

describe("evaluateDeployContract — algum passo consulta a version_url", () => {
  it("sem consulta à version_url falha — o curl que só olha o status de outra URL", () => {
    const status = step("- name: Health", "  run: curl -fsS https://mesa.example.com/healthz");
    const r = evaluate([deployYml({ steps: CHECKOUT_REF + status + TAG })]);
    expect(failKeys(r)).toEqual(["version"]);
    expect(failText(r)).toContain(URL_);
    expect(failText(r)).toMatch(/SHA/);
    expect(failText(r)).toMatch(/deploy\.yml\.example/);
  });

  it("a URL num env: referenciado pelo run: conta (a forma do template), com ou sem / no fim", () => {
    const viaEnv = step(
      "- name: Health",
      "  env:",
      `    VERSION_URL: ${URL_}/`,
      "    SHA: ${{ steps.version.outputs.sha }}",
      '  run: curl -fsS "$VERSION_URL" | grep -q "$SHA"',
    );
    expect(evaluate([deployYml({ steps: CHECKOUT_REF + viaEnv + TAG })]).findings).toEqual([]);
  });

  it("a URL só num comentário não conta", () => {
    const comentario = step("- name: Health", "  run: |", `    # TODO: consultar ${URL_}`, "    curl -fsS https://mesa.example.com/healthz");
    expect(failKeys(evaluate([deployYml({ steps: CHECKOUT_REF + comentario + TAG })]))).toEqual(["version"]);
  });

  // A forma real do mesa-crm: o comando do ssh em várias linhas. Rodada 4:
  // o corte por linha contava como um só o comando que atravessa a linha da
  // consulta, e o tirava — justo o ssh que leva o $SHA ao smoke.sh.
  it("um script do repo chamado pelo passo, inclusive dentro do ssh de várias linhas, conta — o smoke.sh do mesa-crm", () => {
    const smoke = step(
      "- name: Smoke check",
      "  env:",
      "    SHA: ${{ steps.version.outputs.sha }}",
      "  run: |",
      '    ssh "$VPS_USER@$VPS_HOST" "',
      "      set -euo pipefail",
      "      cd /opt/mesa",
      "      bash infra/prod/smoke.sh $SHA",
      '    "',
    );
    const w = deployYml({ steps: CHECKOUT_REF + smoke + TAG });
    const comVersao = filesAt({
      "infra/prod/smoke.sh": `#!/bin/sh\nwant="$1"\ngot=$(curl -fsS ${URL_})\n[ "$got" = "$want" ] || exit 1\n`,
    });
    const r = evaluate([w], comVersao);
    expect(r.findings).toEqual([]);
    expect(r.located.find((l) => l.key === "version")?.where).toMatch(/Smoke check → infra\/prod\/smoke\.sh/);

    const soHealthz = filesAt({ "infra/prod/smoke.sh": "#!/bin/sh\ncurl -fsS http://localhost:3000/healthz\n" });
    expect(failKeys(evaluate([w], soHealthz))).toEqual(["version"]);

    // A variante com aspas simples e o SHA concatenado de fora.
    const aspasSimples = step(
      "- name: Smoke check",
      "  env:",
      "    SHA: ${{ steps.version.outputs.sha }}",
      "  run: |",
      "    ssh \"$VPS_USER@$VPS_HOST\" '",
      "      set -euo pipefail",
      "      cd /opt/mesa",
      "      bash infra/prod/smoke.sh '\"$SHA\"'",
      "    '",
    );
    expect(evaluate([deployYml({ steps: CHECKOUT_REF + aspasSimples + TAG })], comVersao).findings).toEqual([]);
  });

  it("segue um script chamado por outro script, e resolve o working-directory do passo", () => {
    const verify = step("- name: Verify", "  working-directory: infra", "  run: ./verify.sh");
    const files = filesAt({
      "infra/verify.sh": "bash scripts/check-version.sh\n",
      "scripts/check-version.sh": `curl ${URL_} | grep -q "$(git rev-parse HEAD)"\n`,
    });
    expect(evaluate([deployYml({ steps: CHECKOUT_REF + verify + TAG })], files).findings).toEqual([]);
  });

  it("caminho de script que sai do repo nunca é lido", () => {
    const seen: string[] = [];
    const verify = step("- name: Verify", "  run: bash ../fora/check.sh && bash /etc/check.sh");
    evaluate([deployYml({ steps: CHECKOUT_REF + verify + TAG })], (rel) => {
      seen.push(rel);
      return `curl ${URL_}`;
    });
    expect(seen).toEqual([]);
  });

  it("readFile que lança não derruba a avaliação", () => {
    const verify = step("- name: Verify", "  run: bash scripts/check.sh");
    const r = evaluate([deployYml({ steps: CHECKOUT_REF + verify + TAG })], () => {
      throw new Error("EACCES");
    });
    expect(failKeys(r)).toEqual(["version"]);
  });
});

// Revisão de segurança da #32: citar a URL bastava. Davam verde um curl que só
// olha o 200, um curl com || true, um echo da URL, a URL com sufixo
// (version-old) e uma version_url que é prefixo de outra rota. Agora o passo
// que cita a URL tem de referenciar uma fonte do SHA implantado, a falha da
// comparação tem de chegar ao status do passo, e a URL termina onde termina.
describe("evaluateDeployContract — a versão servida é comparada com o SHA, não só citada", () => {
  const health = (run: string, env = "    SHA: ${{ steps.version.outputs.sha }}") =>
    step("- name: Health", "  env:", env, `  run: ${run}`);
  const versionFails = (run: string, env?: string, specText: string = DECLARED) =>
    evaluateDeployContract({ specText, workflows: [deployYml({ steps: CHECKOUT_REF + health(run, env) + TAG })], readFile: noFiles });

  it("regressão: o curl que só olha o 200 reprova, apontando a fonte do SHA", () => {
    const r = versionFails(`curl -fsS "${URL_}"`);
    expect(failKeys(r)).toEqual(["version"]);
    expect(failText(r)).toMatch(/não a compara/);
    expect(failText(r)).toMatch(/steps\.<id>\.outputs/);
    expect(failText(r)).toMatch(/aiteam\/templates\/deploy\.yml\.example/);
  });

  it("regressão: curl || true e echo da URL reprovam", () => {
    expect(failKeys(versionFails(`curl -fsS "${URL_}" || true`))).toEqual(["version"]);
    expect(failKeys(versionFails(`echo "${URL_}"`))).toEqual(["version"]);
  });

  it("regressão: a comparação com a falha engolida reprova, dizendo como", () => {
    const r = versionFails(`curl -fsS "${URL_}" | grep -q "$SHA" || true`);
    expect(failKeys(r)).toEqual(["version"]);
    expect(failText(r)).toMatch(/engol/);
  });

  it("regressão: a URL termina onde termina — version-old e um prefixo de outra rota não contam", () => {
    expect(failKeys(versionFails(`curl -fsS "${URL_}-old" | grep -q "$SHA"`))).toEqual(["version"]);
    const prefixo = spec("deploy:\n  workflow: deploy.yml\n  version_url: https://mesa.example.com/api");
    expect(failKeys(versionFails('curl -fsS "https://mesa.example.com/api/healthz" | grep -q "$SHA"', undefined, prefixo))).toEqual(["version"]);
  });

  it("a URL com / no fim, com query ou entre aspas conta", () => {
    for (const u of [`"${URL_}/"`, `"${URL_}?_=1"`, `'${URL_}'`, URL_]) {
      expect(versionFails(`curl -fsS ${u} | grep -q "$SHA"`).findings, u).toEqual([]);
    }
  });

  it("fontes do SHA: steps.*.outputs, needs.*.outputs, APP_VERSION, git rev-parse, ou uma env ligada a elas", () => {
    expect(versionFails(`curl -fsS "${URL_}" | grep -q "\${{ steps.version.outputs.sha }}"`, "    X: y").findings).toEqual([]);
    expect(versionFails(`curl -fsS "${URL_}" | grep -q "$ESPERADO"`, "    ESPERADO: ${{ needs.deploy.outputs.sha }}").findings).toEqual([]);
    expect(versionFails(`curl -fsS "${URL_}" | grep -q "$APP_VERSION"`, "    X: y").findings).toEqual([]);
    expect(versionFails(`curl -fsS "${URL_}" | grep -q "$(git rev-parse HEAD)"`, "    X: y").findings).toEqual([]);
  });

  it("uma env com SHA que o passo não lê não é comparação", () => {
    expect(failKeys(versionFails(`curl -fsS "${URL_}"`, "    SHA: ${{ steps.version.outputs.sha }}"))).toEqual(["version"]);
  });

  // Re-verificação da #32: a comparação passava sem comparar. O SHA num echo
  // contava como fonte; a guarda [[ SHA ]] || exit 1, que vem antes da
  // consulta, contava como "o passo pode falhar"; a comparação só na condição
  // de um if, um script sem relação com a versão, e um if: no passo também.
  describe("regressões da re-verificação: a comparação tem de poder reprovar, depois da consulta", () => {
    const comEnv = (run: string[], extra: string[] = []) =>
      step(
        "- name: Health",
        ...extra,
        "  env:",
        `    U: ${URL_}`,
        "    SHA: ${{ steps.version.outputs.sha }}",
        "  run: |",
        ...run.map((l) => `    ${l}`),
      );
    const avaliar = (health: string, files: Record<string, string> = {}) =>
      evaluate([deployYml({ steps: CHECKOUT_REF + health + TAG })], filesAt(files));

    it('echo "Verificando $SHA" + curl só do 200 reprova: echo não é comparação', () => {
      const r = avaliar(comEnv(['echo "Verificando $SHA"', 'curl -fsS --retry 5 "$U"']));
      expect(failKeys(r)).toEqual(["version"]);
      expect(failText(r)).toMatch(/não a compara/);
    });

    it("a guarda [[ SHA ]] || exit 1 antes da consulta não faz a comparação || echo reprovar", () => {
      const r = avaliar(comEnv(['[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1', 'curl -fsS "$U" | grep -q "$SHA" || echo "diferente, seguindo"']));
      expect(failKeys(r)).toEqual(["version"]);
      expect(failText(r)).toMatch(/engol|\|\| echo/);
    });

    it("a comparação só na condição de um if, sem exit, reprova", () => {
      const r = avaliar(comEnv(['if curl -fsS "$U" | grep -q "$SHA"; then echo ok; else echo "::warning::versão antiga"; fi']));
      expect(failKeys(r)).toEqual(["version"]);
    });

    it("um script sem relação com a versão não faz a comparação || true reprovar", () => {
      const r = avaliar(comEnv(["./scripts/notify.sh", 'curl -fsS "$U" | grep -q "$SHA" || true']), { "scripts/notify.sh": "echo hi\n" });
      expect(failKeys(r)).toEqual(["version"]);
    });

    it("a guarda seguida de uma comparação que reprova passa; e o timeout + until por bash -c também", () => {
      expect(avaliar(comEnv(['[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1', 'curl -fsS "$U" | grep -q "$SHA"'])).findings).toEqual([]);
      expect(avaliar(comEnv(["timeout 600 bash -c 'until curl -fsS \"$U\" | grep -q \"$SHA\"; do sleep 5; done'"])).findings).toEqual([]);
      expect(avaliar(comEnv(['if ! curl -fsS "$U" | grep -q "$SHA"; then echo "::error::versão antiga"; exit 1; fi'])).findings).toEqual([]);
    });

    it("if: condicional no passo da comparação é aviso que o contract test barra", () => {
      const r = avaliar(comEnv(['curl -fsS "$U" | grep -q "$SHA"'], ["  if: inputs.skip_health != 'true'"]));
      expect(fails(r)).toEqual([]);
      expect(warns(r)).toEqual([expect.objectContaining({ key: "condition", message: expect.stringMatching(/skip_health/) })]);
      expect(warns(r)[0]?.message).toMatch(/aiteam\/templates\/deploy\.yml\.example/);
      expect(contractBlockers(r)).toHaveLength(1);
    });

    it("o if: do job inteiro (o confirm do template) não é condição da comparação", () => {
      const r = evaluate([deployYml({ job: "    if: ${{ github.event.inputs.confirm == 'deploy' }}\n", steps: CHECKOUT_REF + HEALTH + TAG })]);
      expect(r.findings).toEqual([]);
    });

    // Rodada 3: o corte do texto na primeira consulta perdia o estado do shell
    // de antes dela — o set +e numa linha anterior sumia, e a comparação
    // depois dele voltava a "reprovar o passo".
    // Rodada 3: qualquer exit N≠0 depois da consulta contava como "a comparação
    // reprova". Agora a falha tem de estar amarrada à comparação: um comando
    // com o SHA que não é echo nem foi engolido, ou um exit no nível de topo,
    // ou um exit cuja condição (o lado esquerdo do ||, a condição do if)
    // referencia o SHA.
    describe("a falha do passo está amarrada à comparação", () => {
      it("curl de aquecimento + comparação || echo reprova", () => {
        const r = avaliar(comEnv(['curl -fsS "$U"', 'curl -fsS "$U" | grep -q "$SHA" || echo "::warning::versão antiga"']));
        expect(failKeys(r)).toEqual(["version"]);
      });

      it("corpo=$(curl) + [ -n corpo ] || exit 1 + comparação || echo reprova", () => {
        const r = avaliar(comEnv(['corpo=$(curl -fsS "$U")', '[ -n "$corpo" ] || exit 1', 'echo "$corpo" | grep -q "$SHA" || echo "::warning::diferente"']));
        expect(failKeys(r)).toEqual(["version"]);
      });

      it("corpo=$(curl) + if [ -z corpo ]; then exit 1; fi + comparação || echo reprova", () => {
        const r = avaliar(comEnv(['corpo=$(curl -fsS "$U" || true)', 'if [ -z "$corpo" ]; then exit 1; fi', 'echo "$corpo" | grep -q "$SHA" || echo warn']));
        expect(failKeys(r)).toEqual(["version"]);
      });

      // Rodada 4: a linha só de atribuição não entrava na lista and-or, e o
      // exit 1 depois do || dela parecia um exit de topo.
      it("regressão: corpo=$(curl) || exit 1 + comparação || echo reprova", () => {
        const r = avaliar(comEnv(['corpo=$(curl -fsS "$U") || exit 1', 'echo "$corpo" | grep -q "$SHA" || echo "::warning::diferente"']));
        expect(failKeys(r)).toEqual(["version"]);
        // Com o SHA na atribuição, o exit à direita dela é da comparação.
        expect(avaliar(comEnv(['ok=$(curl -fsS "$U" | grep -c "$SHA") || exit 1', "echo ok"])).findings).toEqual([]);
      });

      // Rodada 4: o helper fail() { …; exit 1; } é a forma comum de reprovar
      // com mensagem; chamar ele à direita da comparação é propagar.
      it("o helper fail() que termina em exit 1, chamado à direita da comparação, conta; um warn() que só escreve, não", () => {
        const comFail = ['fail() { echo "::error::$1"; exit 1; }', 'v=$(curl -fsS "$U" | jq -r .version)', '[ "$v" = "$SHA" ] || fail "versão $v"'];
        expect(avaliar(comEnv(comFail)).findings).toEqual([]);
        const multilinha = ["die() {", '  echo "::error::$1"', "  exit 2", "}", 'v=$(curl -fsS "$U" | jq -r .version)', '[ "$v" = "$SHA" ] || die "versão $v"'];
        expect(avaliar(comEnv(multilinha)).findings).toEqual([]);
        const soAvisa = ['warn() { echo "::warning::$1"; }', 'v=$(curl -fsS "$U" | jq -r .version)', '[ "$v" = "$SHA" ] || warn "versão $v"'];
        expect(failKeys(avaliar(comEnv(soAvisa)))).toEqual(["version"]);
        const saiOk = ['done_() { echo fim; exit 0; }', 'v=$(curl -fsS "$U" | jq -r .version)', '[ "$v" = "$SHA" ] || done_'];
        expect(failKeys(avaliar(comEnv(saiOk)))).toEqual(["version"]);
      });

      it("a guarda [ -n $U ] || exit 1 antes da comparação || echo reprova", () => {
        const r = avaliar(comEnv(['[ -n "$U" ] || exit 1', 'curl -fsS "$U" | grep -q "$SHA" || echo "::warning::diferente"']));
        expect(failKeys(r)).toEqual(["version"]);
      });

      it("passam: o exit 1 de topo do template, o exit da condição com o SHA, e o comando com o SHA no fim", () => {
        const laco = ["for i in 1 2 3; do", '  v=$(curl -fsS "$U")', '  if [ "$v" = "$SHA" ]; then exit 0; fi', "  sleep 5", "done", "exit 1"];
        expect(avaliar(comEnv(laco)).findings).toEqual([]);
        expect(avaliar(comEnv(['if ! curl -fsS "$U" | grep -q "$SHA"; then exit 1; fi'])).findings).toEqual([]);
        expect(avaliar(comEnv(['curl -fsS "$U" | grep -q "$SHA" || exit 1', "echo ok"])).findings).toEqual([]);
        expect(avaliar(comEnv(['test "$(curl -fsS "$U")" = "$SHA"'])).findings).toEqual([]);
        expect(avaliar(comEnv(['check() { curl -fsS "$U" | grep -q "$SHA"; }', "for i in 1 2 3; do check && exit 0; sleep 5; done", "exit 1"])).findings).toEqual([]);
      });
    });

    it("regressão: set +e numa linha antes da consulta segue valendo", () => {
      const r = avaliar(comEnv(["set +e", 'curl -fsS "$U" | grep -q "$SHA"', "echo fim"]));
      expect(failKeys(r)).toEqual(["version"]);
      expect(failText(r)).toMatch(/set \+e/);
    });
  });

  // Revisão da #32, vermelho falso: a URL e o SHA no env: do passo, e o script
  // que o passo chama lendo $VERSION_URL — a forma mais natural de extrair o
  // health check para um arquivo — reprovava.
  it("regressão: env: com VERSION_URL e SHA, e o script chamado lendo $VERSION_URL, passa", () => {
    const viaScript = step(
      "- name: Health",
      "  env:",
      `    VERSION_URL: ${URL_}`,
      "    SHA: ${{ steps.version.outputs.sha }}",
      "  run: ./scripts/health.sh",
    );
    const files = filesAt({ "scripts/health.sh": 'until curl -fsS "$VERSION_URL" | grep -q "$SHA"; do sleep 5; done\n' });
    const r = evaluate([deployYml({ steps: CHECKOUT_REF + viaScript + TAG })], files);
    expect(r.findings).toEqual([]);
    expect(r.located.find((l) => l.key === "version")?.where).toMatch(/Health → scripts\/health\.sh/);
  });

  it("regressão: numa action de health check, a URL e o SHA no env: do job ou do workflow contam", () => {
    const action = step("- name: Health", "  uses: some/health-action@v1");
    const jobEnv = wf(
      "deploy.yml",
      `${DISPATCH_REF}${WRITE}jobs:\n  deploy:\n    env:\n      URL: ${URL_}\n      SHA: \${{ steps.version.outputs.sha }}\n    steps:\n${CHECKOUT_REF}${action}${TAG}`,
    );
    expect(evaluate([jobEnv]).findings).toEqual([]);
    const wfEnv = wf(
      "deploy.yml",
      `${DISPATCH_REF}${WRITE}env:\n  URL: ${URL_}\n  SHA: \${{ steps.version.outputs.sha }}\njobs:\n  deploy:\n    steps:\n${CHECKOUT_REF}${action}${TAG}`,
    );
    expect(evaluate([wfEnv]).findings).toEqual([]);
  });

  it("o laço do template, que compara dentro de if e termina em exit 1, conta como comparação que reprova", () => {
    const laco = step(
      "- name: Health",
      "  env:",
      "    SHA: ${{ steps.version.outputs.sha }}",
      "  run: |",
      "    for i in 1 2 3; do",
      `      corpo=$(curl -fsS "${URL_}" || true)`,
      '      if [ "${corpo#*$SHA}" != "$corpo" ]; then exit 0; fi',
      "      sleep 5",
      "    done",
      "    exit 1",
    );
    expect(evaluate([deployYml({ steps: CHECKOUT_REF + laco + TAG })]).findings).toEqual([]);
  });
});

describe("evaluateDeployContract — o passo que cria a tag deploy/", () => {
  it("sem tag deploy/ falha apontando o passo do template", () => {
    const r = evaluate([deployYml({ steps: CHECKOUT_REF + HEALTH })]);
    expect(failKeys(r)).toEqual(["tag"]);
    expect(failText(r)).toMatch(/deploy\//);
    expect(failText(r)).toMatch(/contents: write/);
    expect(failText(r)).toMatch(/deploy\.yml\.example/);
  });

  it("git tag sem git push não envia a tag — falha", () => {
    const local = step("- name: Tag", '  run: git tag "deploy/$(date +%s)" "$SHA"');
    expect(failKeys(evaluate([deployYml({ steps: CHECKOUT_REF + HEALTH + local })]))).toEqual(["tag"]);
  });

  it("tag com outro prefixo, ou git tag -l 'deploy/*' numa listagem ou mensagem, não contam", () => {
    const release = step("- name: Tag", '  run: git tag "release/$V" && git push origin --tags');
    expect(failKeys(evaluate([deployYml({ steps: CHECKOUT_REF + HEALTH + release })]))).toEqual(["tag"]);
    const listagem = step("- name: Tag", "  run: |", "    git tag -l 'deploy/*' --sort=-creatordate", "    git push origin main");
    expect(failKeys(evaluate([deployYml({ steps: CHECKOUT_REF + HEALTH + listagem })]))).toEqual(["tag"]);
    const eco = step("- name: Tag", "  run: |", "    echo \"rollback: git tag -l 'deploy/*'\" && git push");
    expect(failKeys(evaluate([deployYml({ steps: CHECKOUT_REF + HEALTH + eco })]))).toEqual(["tag"]);
  });

  // Sondas da revisão da #32: o git push no passo da tag tinha de existir, mas
  // não precisava enviar a tag — subir a main ou um --dry-run passavam.
  it("o git push tem de enviar a tag: push da main ou --dry-run não contam; --tags e --follow-tags contam", () => {
    const comPush = (push: string) =>
      step("- name: Tag", "  run: |", '    TAG="deploy/$(date +%s)"', '    git tag -a "$TAG" -m ok', `    ${push}`);
    for (const push of ["git push origin HEAD:main", 'git push --dry-run origin "$TAG"', 'git push -n origin "$TAG"']) {
      expect(failKeys(evaluate([deployYml({ steps: CHECKOUT_REF + HEALTH + comPush(push) })])), push).toEqual(["tag"]);
    }
    for (const push of ['git push origin "$TAG"', "git push origin --tags", "git push --follow-tags origin HEAD", 'git push origin "refs/tags/${TAG}"']) {
      expect(evaluate([deployYml({ steps: CHECKOUT_REF + HEALTH + comPush(push) })]).findings, push).toEqual([]);
    }
  });

  it("git com -c antes do tag, e a ref criada pela API (gh api …/git/refs), contam", () => {
    const comC = step(
      "- name: Tag",
      "  run: |",
      "    git -c user.name=bot -c user.email=bot@x \\",
      '      tag -a "deploy/$STAMP" -m ok "$SHA"',
      '    git push origin "deploy/$STAMP"',
    );
    expect(evaluate([deployYml({ steps: CHECKOUT_REF + HEALTH + comC })]).findings).toEqual([]);
    const api = step("- name: Tag", '  run: gh api repos/$GITHUB_REPOSITORY/git/refs -f ref="refs/tags/deploy/$STAMP" -f sha="$SHA"');
    expect(evaluate([deployYml({ steps: CHECKOUT_REF + HEALTH + api })]).findings).toEqual([]);
  });
});

describe("evaluateDeployContract — workflow reutilizável e entradas estranhas", () => {
  it("segue o workflow reutilizável local: o ref passado no with: do job chega, e os passos dele contam", () => {
    const caller = wf(
      "deploy.yml",
      `${DISPATCH_REF}${WRITE}jobs:\n  prod:\n    uses: ./.github/workflows/_deploy.yml\n    with:\n      alvo: \${{ inputs.ref }}\n`,
    );
    const called = (deploy: string) =>
      wf("_deploy.yml", `on:\n  workflow_call:\n    inputs:\n      alvo:\n        type: string\njobs:\n  d:\n    steps:\n${deploy}${HEALTH}${TAG}`);
    const r = evaluate([caller, called(CALLED_DEPLOY)]);
    expect(r.findings).toEqual([]);
    expect(r.located.find((l) => l.key === "ref")?.where).toMatch(/deploy\.yml › prod → _deploy\.yml › d › Deploy/);
    expect(r.located.find((l) => l.key === "tag")?.where).toMatch(/deploy\.yml › prod → _deploy\.yml › d › Tag/);
    // O chamado que recebe o input e o ignora não leva a ref ao deploy.
    const ignora = evaluate([caller, called(step("- name: Deploy", "  run: ssh h './deploy.sh'"))]);
    expect(failKeys(ignora)).toEqual(["ref"]);
  });

  it("workflow com forma inesperada não lança: vira os achados de sempre", () => {
    const docs = [
      null,
      "texto",
      { on: 42, jobs: [1, 2] },
      { on: { workflow_dispatch: null }, jobs: { x: null, y: { steps: "não é lista" }, z: { steps: [null, { run: 7 }] } } },
    ];
    for (const doc of docs) {
      const r = evaluate([{ file: "deploy.yml", doc }]);
      expect(failKeys(r).length, JSON.stringify(doc)).toBeGreaterThan(0);
    }
  });

  it("toda falha do workflow aponta o template", () => {
    const r = evaluate([deployYml({ on: "on: workflow_dispatch\n", steps: step("- run: echo nada") })]);
    expect(failKeys(r).sort()).toEqual(["ref", "tag", "version"]);
    for (const f of fails(r)) expect(f.message, f.key).toMatch(/aiteam\/templates\/deploy\.yml\.example/);
  });
});

// A tag marca só deploy verificado — é o que faz da lista deploy/* uma lista
// de rollback confiável. Tag criada antes do health check, ou num job que não
// espera por ele, marca também o deploy que nunca subiu.
describe("evaluateDeployContract — a tag deploy/ vem depois da consulta à version_url", () => {
  const orderFindings = (r: DeployEvaluation) => r.findings.filter((f) => f.key === "order");
  const jobs = (body: string) => wf("deploy.yml", `${DISPATCH_REF}${WRITE}jobs:\n${body}`);
  const job = (id: string, needs: string, steps: string) => `  ${id}:\n${needs ? `    needs: ${needs}\n` : ""}    steps:\n${steps}`;

  it("no mesmo job, tag abaixo do health check: sem aviso", () => {
    expect(orderFindings(evaluate([COMPLETE]))).toEqual([]);
  });

  // Revisão de segurança da #32: a ordem errada era só aviso, e a tag marcava
  // o deploy reprovado com o contrato verde. Agora reprova.
  it("no mesmo job, tag acima de toda consulta: reprova, apontando os dois passos e o template", () => {
    const r = evaluate([deployYml({ steps: CHECKOUT_REF + TAG + HEALTH })]);
    expect(failKeys(r)).toEqual(["order"]);
    const msg = orderFindings(r)[0]?.message ?? "";
    expect(msg).toMatch(/deploy\.yml › deploy › Tag/);
    expect(msg).toMatch(/deploy\.yml › deploy › Health/);
    expect(msg).toMatch(/aiteam\/templates\/deploy\.yml\.example/);
  });

  it("num job que depende do job do health check via needs, direto ou em cadeia, em string ou lista: sem aviso", () => {
    const direto = jobs(job("deploy", "", CHECKOUT_REF + HEALTH) + job("tag", "deploy", TAG));
    expect(evaluate([direto]).findings).toEqual([]);
    const cadeia = jobs(job("deploy", "", CHECKOUT_REF + HEALTH) + job("smoke", "[deploy]", step("- run: echo ok")) + job("tag", "[smoke]", TAG));
    expect(evaluate([cadeia]).findings).toEqual([]);
  });

  it("num job fora da cadeia de needs do health check, ou do qual o health check depende: reprova", () => {
    const paralelo = jobs(job("deploy", "", CHECKOUT_REF + HEALTH) + job("tag", "", TAG));
    expect(orderFindings(evaluate([paralelo])).map((f) => f.level)).toEqual(["fail"]);
    const invertido = jobs(job("tag", "", TAG) + job("deploy", "tag", CHECKOUT_REF + HEALTH));
    expect(orderFindings(evaluate([invertido])).map((f) => f.level)).toEqual(["fail"]);
  });

  it("o mesmo passo consulta a version_url e cria a tag: aviso pedindo dois passos", () => {
    const junto = step(
      "- name: Health e tag",
      "  env:",
      "    SHA: ${{ steps.version.outputs.sha }}",
      "  run: |",
      `    curl -fsS "${URL_}" | grep -q "$SHA"`,
      '    TAG="deploy/$(date +%s)"',
      '    git tag -a "$TAG" -m ok && git push origin "$TAG"',
    );
    const r = evaluate([deployYml({ steps: CHECKOUT_REF + junto })]);
    expect(orderFindings(r).map((f) => f.level)).toEqual(["warn"]);
    expect(orderFindings(r)[0]?.message).toMatch(/mesmo passo/);
  });

  it("basta uma consulta antes da tag, mesmo havendo outra depois", () => {
    const r = evaluate([deployYml({ steps: CHECKOUT_REF + HEALTH + TAG + HEALTH.replace("Health", "Health de novo") })]);
    expect(orderFindings(r)).toEqual([]);
  });

  it("sem consulta à version_url, não há ordem a conferir: só a falha da versão", () => {
    const r = evaluate([deployYml({ steps: CHECKOUT_REF + TAG })]);
    expect(failKeys(r)).toEqual(["version"]);
    expect(orderFindings(r)).toEqual([]);
  });

  it("job do chamador com needs no job que chama o reutilizável do health check: sem aviso", () => {
    const caller = wf(
      "deploy.yml",
      `${DISPATCH_REF}${WRITE}jobs:\n  prod:\n    uses: ./.github/workflows/_deploy.yml\n    with:\n      alvo: \${{ inputs.ref }}\n${job("tag", "prod", TAG)}`,
    );
    const called = wf("_deploy.yml", `on:\n  workflow_call:\njobs:\n  d:\n    steps:\n${CALLED_DEPLOY}${HEALTH}`);
    expect(evaluate([caller, called]).findings).toEqual([]);
    const semNeeds = wf(
      "deploy.yml",
      `${DISPATCH_REF}${WRITE}jobs:\n  prod:\n    uses: ./.github/workflows/_deploy.yml\n    with:\n      alvo: \${{ inputs.ref }}\n${job("tag", "", TAG)}`,
    );
    expect(orderFindings(evaluate([semNeeds, called])).map((f) => f.level)).toEqual(["fail"]);
  });

  // A tag sob always()/failure()/cancelled() roda com o health check vermelho:
  // marca como ponto de rollback o deploy que acabou de reprovar.
  describe("a condição da tag não a deixa rodar com o health check vermelho", () => {
    const comIf = (cond: string) => TAG.replace("      - name: Tag\n", `      - name: Tag\n        if: ${cond}\n`);
    for (const cond of ["always()", "${{ always() }}", "failure()", "success() || failure()", "${{ !cancelled() }}", "cancelled()"]) {
      it(`if: ${cond} no passo da tag reprova`, () => {
        const r = evaluate([deployYml({ steps: CHECKOUT_REF + HEALTH + comIf(cond) })]);
        expect(failKeys(r)).toEqual(["order"]);
        expect(failText(r)).toMatch(/deploy\.yml\.example/);
      });
    }

    it("if: always() no job da tag reprova, mesmo com needs no job do health check", () => {
      const tagJob = `  tag:\n    needs: deploy\n    if: \${{ always() }}\n    steps:\n${TAG}`;
      const r = evaluate([jobs(job("deploy", "", CHECKOUT_REF + HEALTH) + tagJob)]);
      expect(failKeys(r)).toEqual(["order"]);
      expect(failText(r)).toMatch(/always\(\)/);
    });

    it("if: success() ou uma condição comum não reprovam", () => {
      expect(evaluate([deployYml({ steps: CHECKOUT_REF + HEALTH + comIf("success()") })]).findings).toEqual([]);
      expect(evaluate([deployYml({ steps: CHECKOUT_REF + HEALTH + comIf("github.ref == 'refs/heads/main'") })]).findings).toEqual([]);
    });
  });

  // A consulta que não roda, ou cuja falha não para o job, não barra a tag.
  describe("a consulta que pode barrar a tag: roda, e a falha dela para o job", () => {
    const healthCom = (linha: string) => HEALTH.replace("      - name: Health\n", `      - name: Health\n        ${linha}\n`);
    it("continue-on-error na consulta reprova", () => {
      const r = evaluate([deployYml({ steps: CHECKOUT_REF + healthCom("continue-on-error: true") + TAG })]);
      expect(failKeys(r)).toEqual(["version"]);
      expect(failText(r)).toMatch(/continue-on-error/);
    });

    it("continue-on-error no job da consulta reprova", () => {
      const r = evaluate([deployYml({ job: "    continue-on-error: true\n", steps: CHECKOUT_REF + HEALTH + TAG })]);
      expect(failKeys(r)).toEqual(["version"]);
    });

    it("if: false na consulta, no passo ou no job (com o job da tag em if: always()), reprova", () => {
      const passo = evaluate([deployYml({ steps: CHECKOUT_REF + healthCom("if: false") + TAG })]);
      expect(failKeys(passo)).toEqual(["version"]);
      expect(failText(passo)).toMatch(/if: false/);
      const nunca = `  never:\n    if: false\n    steps:\n${CHECKOUT_REF}${HEALTH}`;
      const tagJob = `  deploy:\n    needs: never\n    if: always()\n    steps:\n${TAG}`;
      expect(failKeys(evaluate([jobs(nunca + tagJob)])).sort()).toEqual(["order", "version"]);
    });

    it("basta uma consulta válida antes da tag, mesmo havendo outra com continue-on-error", () => {
      const r = evaluate([deployYml({ steps: CHECKOUT_REF + healthCom("continue-on-error: true") + HEALTH.replace("Health", "Health 2") + TAG })]);
      expect(r.findings).toEqual([]);
    });
  });
});

// O contract test barra toda falha e os avisos que deixam o rollback quebrado
// sem o run perceber: permissions não declarado (o push da tag pode falhar) e
// a tag no mesmo passo da consulta (a ordem que o núcleo não confere). O
// opt-out e o deploy no runner continuam só avisos.
describe("contractBlockers — o que o deploy-contract.test.ts reprova", () => {
  it("falhas e os avisos de permissions e de ordem; não o opt-out nem o deploy no runner", () => {
    expect(contractBlockers(evaluate([COMPLETE]))).toEqual([]);
    const semPermissions = evaluate([deployYml({ permissions: "", steps: CHECKOUT_REF + HEALTH + TAG })]);
    expect(contractBlockers(semPermissions)).toEqual([expect.stringMatching(/contents: write/)]);
    const optOut = evaluate(null, noFiles, spec('deploy:\n  workflow: none\n  reason: "x"'));
    expect(contractBlockers(optOut)).toEqual([]);
    const runner = evaluate([deployYml({ steps: CHECKOUT_ONLY + step("- run: npm run deploy") + HEALTH + TAG })]);
    expect(warns(runner).length).toBeGreaterThan(0);
    expect(contractBlockers(runner)).toEqual([]);
    expect(contractBlockers(evaluate([deployYml({ steps: CHECKOUT_REF + TAG + HEALTH })]))).toHaveLength(1);
  });
});

// A tag deploy/ é obrigatória, então a permissão de enviá-la também: sem
// contents: write o git push da tag falha com o GITHUB_TOKEN DEPOIS de um
// deploy verde — o run fica vermelho com produção certa, e não sobra tag de
// rollback. O omni-chat declara contents: read.
describe("evaluateDeployContract — o token do job da tag pode enviá-la (contents: write)", () => {
  const STEPS = CHECKOUT_REF + HEALTH + TAG;
  const permFindings = (r: DeployEvaluation) => r.findings.filter((f) => f.key === "permissions");
  const jobPerms = (body: string) => `    permissions:\n${body}`;

  it("contents: write no workflow ou no job passa sem achado", () => {
    expect(evaluate([deployYml({ steps: STEPS })]).findings).toEqual([]);
    expect(evaluate([deployYml({ permissions: "", job: jobPerms("      contents: write\n"), steps: STEPS })]).findings).toEqual([]);
    expect(evaluate([deployYml({ permissions: "permissions: write-all\n", steps: STEPS })]).findings).toEqual([]);
  });

  it("contents: read no workflow falha — o omni-chat", () => {
    const r = evaluate([deployYml({ permissions: "permissions:\n  contents: read\n", steps: STEPS })]);
    expect(failKeys(r)).toEqual(["permissions"]);
    expect(failText(r)).toMatch(/contents: read/);
    expect(failText(r)).toMatch(/contents: write/);
    expect(failText(r)).toMatch(/deploy\.yml › deploy › Tag/);
    expect(failText(r)).toMatch(/aiteam\/templates\/deploy\.yml\.example/);
  });

  it("permissions: {}, read-all ou um mapa sem contents falham", () => {
    for (const p of ["permissions: {}\n", "permissions: read-all\n", "permissions:\n  issues: write\n"]) {
      expect(failKeys(evaluate([deployYml({ permissions: p, steps: STEPS })])), p).toEqual(["permissions"]);
    }
  });

  it("o permissions do job vale sobre o do workflow, nos dois sentidos", () => {
    const jobWrite = deployYml({ permissions: "permissions:\n  contents: read\n", job: jobPerms("      contents: write\n"), steps: STEPS });
    expect(evaluate([jobWrite]).findings).toEqual([]);
    const jobVazio = deployYml({ permissions: WRITE, job: "    permissions: {}\n", steps: STEPS });
    expect(failKeys(evaluate([jobVazio]))).toEqual(["permissions"]);
  });

  it("só o job que cria a tag importa", () => {
    const outro = wf(
      "deploy.yml",
      `${DISPATCH_REF}jobs:\n  lint:\n    permissions:\n      contents: read\n    steps:\n      - run: echo ok\n  deploy:\n    permissions:\n      contents: write\n    steps:\n${STEPS}`,
    );
    expect(evaluate([outro]).findings).toEqual([]);
  });

  it("sem permissions em lugar nenhum é aviso: o default depende do repo — e pede contents: write", () => {
    const r = evaluate([deployYml({ permissions: "", steps: STEPS })]);
    expect(fails(r)).toEqual([]);
    expect(permFindings(r)).toEqual([
      expect.objectContaining({ level: "warn", message: expect.stringMatching(/contents: write/) }),
    ]);
    expect(permFindings(r)[0]?.message).toMatch(/aiteam\/templates\/deploy\.yml\.example/);
  });

  it("sem passo de tag não há o que conferir: só a falha da tag", () => {
    const r = evaluate([deployYml({ permissions: "permissions:\n  contents: read\n", steps: CHECKOUT_REF + HEALTH })]);
    expect(failKeys(r)).toEqual(["tag"]);
  });

  // No reutilizável, o chamado só pode REBAIXAR o token do chamador.
  it("no workflow reutilizável, o chamador sem write limita o chamado; chamador sem declaração é aviso", () => {
    const called = (perms: string) =>
      wf("_deploy.yml", `on:\n  workflow_call:\n${perms}jobs:\n  d:\n    steps:\n${CALLED_DEPLOY}${HEALTH}${TAG}`);
    const caller = (perms: string) =>
      wf("deploy.yml", `${DISPATCH_REF}${perms}jobs:\n  prod:\n    uses: ./.github/workflows/_deploy.yml\n    with:\n      alvo: \${{ inputs.ref }}\n`);
    expect(failKeys(evaluate([caller("permissions:\n  contents: read\n"), called(WRITE)]))).toEqual(["permissions"]);
    const semDeclarar = evaluate([caller(""), called(WRITE)]);
    expect(fails(semDeclarar)).toEqual([]);
    expect(permFindings(semDeclarar).map((f) => f.level)).toEqual(["warn"]);
    expect(evaluate([caller(WRITE), called("")]).findings).toEqual([]);
  });
});
