# Adoção do `/trello-review` pelo consumidor

> rb-ai-team#28. A skill de intake do quadro Trello deixou de ser uma cópia por projeto: o
> **procedimento** vem com o `aiteam/` e o projeto guarda só a **configuração**. Este runbook é o
> passo a passo, por consumidor e sob demanda — o framework não orquestra nada nos consumidores, e
> cada um troca a cópia quando for conveniente. O mecanismo de sync em si está em
> [`consuming-as-upstream.md`](consuming-as-upstream.md).

## O que mudou

| Antes | Agora |
|---|---|
| `.claude/skills/trello-review/SKILL.md` com o procedimento inteiro (5 a 8 KB, uma versão por repo) | `aiteam/skills/trello-review/PROCEDURE.md` (o procedimento, sincronizado) + um `.claude/skills/trello-review/SKILL.md` **fino** (frontmatter, ids, etiqueta, idioma, o comando do reconcile) |
| o `trello:` documentado só no `.beads/SCHEMA.md` do Mesa, sem validação | `trello` e `trello_scope` no contrato do framework ([`beads-schema.md`](beads-schema.md) §3.5), com o formato validado |
| `scripts/beads-trello-reconcile.mjs` por projeto (mesa-crm, robo), lendo `active.yaml` e `archive/` | `aiteam/scripts/beads-trello-reconcile.mjs`, lendo `.beads/tasks/` |

A forma é a dos personas: **a skill vira o gatilho, o framework vira o conteúdo.** Só `aiteam/` desce
no sync, e o Claude Code só descobre skill em `.claude/skills/<nome>/SKILL.md` — por isso são dois
arquivos. O que é invariante sincroniza; o que é do projeto não é sobrescrito.

## Antes de começar

1. **O repo está no modelo por bead** (`.beads/tasks/`). O reconcile recusa (exit 2) um repo cujo
   `.beads/active.yaml` ainda é rastreado: migre antes ([`beads-schema.md`](beads-schema.md) §11).
2. **O `aiteam/` já tem este commit** (o sync, ou `git checkout upstream/main -- aiteam/`).
3. **O MCP `trello-tools` agora vem do framework** (`aiteam/mcp/trello-server.ts`;
   [`trello-mcp.md`](trello-mcp.md)), e o install o registra no `.mcp.json` — sem nunca sobrescrever o
   `trello-tools` que você já registrou. A troca da cópia local é o passo 5. O procedimento exige o MCP
   conectado, com `TRELLO_API_KEY` e `TRELLO_TOKEN` no `.env` da raiz.

## 1. Trocar a cópia da skill pelo `SKILL.md` fino

Vale para quem já tem `.claude/skills/trello-review/SKILL.md` (mesa-crm, omni-chat,
vigacapital.com.br, robo-pb-raspagem) e para quem vai instalar a skill agora.

1. Guarde os valores da cópia antiga — `git show HEAD:.claude/skills/trello-review/SKILL.md`: a tabela
   "Pinned targets" (quadro, fila de intake, lista de tarefa estacionada, de "em andamento" e de
   "finalizado"), o nome do backlog que o comentário cita, os marcadores de escopo do título e o
   `name=` da URL de autorização do token.
2. Copie o template **por cima**:

   ```bash
   mkdir -p .claude/skills/trello-review
   cp aiteam/templates/trello-review-SKILL.md.example .claude/skills/trello-review/SKILL.md
   ```

3. Preencha todo `<PLACEHOLDER>` e apague o comentário do topo. As chaves são as da §0 do
   `PROCEDURE.md`; o que o projeto tinha de específico e a tabela não cobre (uma lista que o time
   renomeou, um destino que outra fila também usa, a observação de quadro compartilhado) vai em
   **Local notes**.
4. **Não cole o procedimento no `SKILL.md`.** Foi a cópia que divergiu em quatro repos: o passo de ler
   os comentários de todo card nasceu no omni-chat e levou semanas para chegar ao Mesa.
5. Se o projeto tem o stub de outra engine (`.agent/skills/trello-review/SKILL.md`, para o
   Antigravity), ele continua apontando para o `.claude/skills/...` canônico: não muda.
6. Num projeto que **nunca teve** a skill, antes de instalar confirme se o repo tem fila no quadro:
   sem lista de intake não há o que revisar, e o reconcile exige `--queue` ou `--label`.

## 2. Trocar o reconcile local (quem tem `scripts/beads-trello-reconcile.mjs`)

O script local (mesa-crm, robo) é substituído pelo `aiteam/scripts/beads-trello-reconcile.mjs`, que lê
`.beads/tasks/` e não depende de `scripts/lib/beads-historico.mjs`. O que o script local fixava no
código vira parâmetro:

| No script local | No do framework |
|---|---|
| a constante com o id do quadro | `--board <id>` (obrigatório; sem padrão) |
| a lista de intake (`DEFAULT_QUEUE`) | `--queue <idDaLista>` |
| o filtro por etiqueta (`/mesa/i`) | `--label <regex>` |
| o regex do catálogo (`CATALOGO`) | `--ignore <regex>` — só tira card de "aberto sem bead" |
| o regex das listas de pronto | `--done-lists <regex>` (o padrão é `finalizado\|done\|conclu`) |

`--queue` e `--label` **estreitam**: com os dois, vale o card que está na fila **e** tem a etiqueta;
um dos dois é obrigatório. O comando completo fica na linha **Reconcile command** do `SKILL.md`.

Depois, apague `scripts/beads-trello-reconcile.mjs`, o script de `package.json` que o chamava
(`check:beads-trello` no Mesa) e o que só ele usava (`scripts/lib/beads-historico.mjs` e o teste dele,
conferindo antes se outro script o importa). O relatório tem a mesma forma, com um acréscimo: bead
**inválida** fica fora da conferência e é listada, em vez de sumir calada.

## 3. O campo `trello` dos beads que já o têm

O Mesa e o robo já gravam `trello` (um shortLink, ou uma lista). Agora o formato é validado:

- `migrate-beads.mjs --dry-run` acusa o valor malformado apontando o nó (a URL inteira em vez do
  shortLink, lista vazia ou com item vazio, o objeto `{card: …}` de um formato antigo, um shortLink só de
  dígitos sem aspas) e **não escreve nada**. Corrija no `active.yaml`/`archive/` e rode de novo.
- Num repo **já migrado**, o arquivo do bead só cresce ([`beads-schema.md`](beads-schema.md) §3.4): um erro de formato no
  topo de um arquivo commitado não se corrige acrescentando uma entrada, e o `beads` recusa escrever num
  bead inválido. É uma propriedade do contrato inteiro (vale para `impl_model`, `tags`…), não só do
  `trello` — por isso o ponto certo de pegar o erro é a migração, antes do commit.
- A convenção de escrita, daqui para frente, é pelo comando: `beads new <id> … --trello <shortLink>`
  (várias: separadas por vírgula) e `--trello-scope partial`. O Mesa pode tirar o §2.1 `trello` do
  `.beads/SCHEMA.md` dele: o contrato mora em `aiteam/docs/beads-schema.md` §3.5.

## 4. Conferir

```bash
node aiteam/scripts/beads-trello-reconcile.mjs --help        # o uso
node aiteam/scripts/beads-trello-reconcile.mjs --board <id> --queue <idDaLista>   # só lê: nada é movido nem comentado
npm --prefix aiteam run validate:beads                       # o formato de trello/trello_scope
```

E uma rodada de `/trello-review` com o card de menor risco: a skill abre o `SKILL.md` fino, que manda
ler o `PROCEDURE.md`. Se o agente começa pelo procedimento inteiro e pelas suas tabelas, a troca valeu.

## 5. Trocar o MCP do Trello (quem o tem em `.mcp/`)

O servidor `trello-tools` que mesa-crm, robo e vigacapital têm em `.mcp/` é a mesma base que o framework
passou a trazer — com as etiquetas (`trello_create_card` com `labels`, `trello_add_label`) e com o
download de anexo corrigido: **as quatro cópias mandam a credencial OAuth para qualquer host que o card
escolha e deixam o modelo escolher onde gravar o print**. A troca é: o `args` do `trello-tools` no
`.mcp.json` passa para `["tsx", "aiteam/mcp/trello-server.ts"]` (o install não faz isso por você), recarregar
o agente, e apagar `.mcp/trello*`. O passo a passo, com a conferência e o `.trello-cache/` (que o robo
versionava), está em [`trello-mcp.md`](trello-mcp.md). O omni-chat, que já apontava para
`aiteam/mcp/trello-server.ts`, só recebe os arquivos no sync.

A etiqueta do projeto, que a skill agora aplica, é a linha **Label** do `SKILL.md` fino (o nome exato da
etiqueta no quadro): o procedimento a põe em todo card que ele cria e nos cards da fila que chegam sem ela.

## O que o sync avisa

O checklist do PR de sync (`tools/aiteam-sync/manifest.json`) tem quatro itens para quem ainda tem a cópia
antiga, detectados pelo conteúdo do arquivo local — quem nunca teve a skill nem o MCP não recebe nenhum:

- `.claude/skills/trello-review/SKILL.md`, quando ele ainda carrega o procedimento (o laço por card);
- `scripts/beads-trello-reconcile.mjs`, quando o script local ainda existe;
- `.mcp.json`, quando o `trello-tools` aponta para fora do `aiteam/` (a cópia local);
- `.mcp/trello-server.ts` e `.mcp/trello/`, quando a cópia local do MCP ainda está em disco.

O sync nunca toca esses arquivos: o item só diz que a troca deste runbook está pendente.

**Os itens disparam também num repo ainda legado — e a troca da skill e do reconcile só vale depois de
migrar para o modelo por bead** ([`beads-schema.md`](beads-schema.md) §11). Num repo legado o `beads new` do
procedimento novo recusa e o reconcile do framework sai com 2: a cópia local é a que funciona até lá, e
o item diz o mesmo no `reason` e no `hint`. A troca do MCP (passo 5) não depende da migração.
