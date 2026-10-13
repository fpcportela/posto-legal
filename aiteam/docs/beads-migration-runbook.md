# Runbook — migrar o `.beads` do modelo antigo para o modelo por bead

> **Para quem:** um consumidor que vendoriza o `aiteam/` e ainda está no modelo antigo
> (`active.yaml` único, um espelho `.beads/<branch>.yaml` por branch, `archive/`).
> **Quando:** sob demanda, numa sessão do próprio consumidor, quando você decidir. O
> upstream não migra os seus dados: o PR do `aiteam-sync` traz só o `aiteam/` e o
> checklist.
>
> Este runbook só põe os passos em ordem. O contrato é o
> [`beads-schema.md`](beads-schema.md) §11, o comando é
> `aiteam/scripts/migrate-beads.mjs` (o cabeçalho lista as flags) e o que o sync manda
> fazer à mão está no checklist do `aiteam-sync`. Se este texto e o código discordarem,
> vale o código.

## 0. Você está no modelo antigo?

```bash
git ls-files .beads/active.yaml
```

Se lista o arquivo, o repo está em **modo legado**: siga este runbook. Se não lista,
o repo já migrou (ou nunca teve beads); vá direto à verificação (§9).

Em modo legado nada muda até o PR de dados entrar: os hooks novos só avisam, o comando
`node aiteam/scripts/beads.mjs` recusa com a dica de migração e o `pre-commit` recusa
`.beads/tasks/`. Continue registrando estado pelo `.beads/SCHEMA.md` local.

## 1. Pré-requisito: o `aiteam/` sincronizado e o doctor rodado

1. Traga o `aiteam/` **inteiro** do upstream — pelo PR do `aiteam-sync`, se houver um
   esperando, ou pelo checkout com escopo de
   [`consuming-as-upstream.md`](consuming-as-upstream.md). Você precisa de
   `aiteam/scripts/migrate-beads.mjs`, `beads.mjs`, `beads-check.mjs`,
   `beads-views.mjs` e dos hooks novos em `aiteam/githooks/`.
2. Rode `node aiteam/install.mjs` (idempotente): ele encadeia os hooks.
3. Feche o checklist do sync. O item do `.gitattributes` vale já, em modo legado (§6);
   se ainda não o fez, faça no commit da migração.
4. Rode `node aiteam/scripts/doctor.mjs`. O esperado é um **WARN** em
   `.beads no modelo por bead` ("modo legado: .beads/active.yaml ainda é rastreado").
   Um **FAIL** em `merge driver beads-yaml` quer dizer que o `.gitattributes` ainda
   mapeia o driver e o script dele não existe: resolva o §6 antes de seguir.
   Outros resultados vêm do checklist do sync, não da migração, e não a impedem: um
   **FAIL** em `SPEC.md ci:` ou em `SPEC.md deploy:` (o bloco que falta no frontmatter do
   `SPEC.md`) e um **WARN** em `merge driver beads-yaml` (o mapeamento, um comentário que
   ainda cita o driver ou o registro que sobrou no `.git/config`). Resolva-os pelo
   checklist, no seu tempo.

Os scripts são node puro: rodam sem `aiteam/node_modules`. No Windows, com centenas de
beads, ligue `git config core.longpaths true` (caminho de bead acima de 160 caracteres
gera aviso).

## 2. Levantar as branches e worktrees que mexem em `.beads/`

```bash
git fetch --all --prune
git worktree list
git branch -a --no-merged <default>
git diff --stat <default>...<branch> -- .beads/    # para cada branch da lista
```

- **Branch que mudou `.beads/` desde a base** (o `active.yaml`, o espelho dela ou o
  `archive/`): de preferência, mergeie-a na default **antes** da migração — o bead dela
  entra na migração sem trabalho extra. A que ficar aberta, porte (§5).
- **Worktree aberta numa branch antiga:** a sessão de lá segue no modelo antigo até a
  branch ser atualizada ou mergeada (§5). O comando `beads` recusa lá.
- **Mudança não commitada em `.beads/`** no checkout que vai migrar: commite-a antes (a
  migração lê `HEAD`) ou rode a migração com `--from-worktree`. Com `--from-worktree`, a
  edição pode mudar status ou acrescentar, mas não apagar nó: o commit da migração confere o
  `active.yaml` e o `archive/` do `HEAD`, e um nó que sumiu na edição é recusado (contrato §11).
- **Combine uma janela.** Enquanto o PR de dados (§7) estiver aberto, ninguém registra
  estado no modelo antigo na default. Uma mudança no `active.yaml` da default nesse
  meio-tempo faz o PR conflitar e cai no §5.

## 3. `--dry-run`, `--recover-mirrors` e `--scan-history`

Numa branch de dados, a partir da default atualizada:

```bash
git switch <default> && git pull
git switch -c chore/beads-modelo-novo
node aiteam/scripts/migrate-beads.mjs --dry-run      # ou: npm --prefix aiteam run beads:migrate -- --dry-run
```

Os arquivos levam o nome da branch atual com `/` trocado por `-`
(`.beads/tasks/<id>/chore-beads-modelo-novo.yaml`); `--as <nome>` troca esse nome. O
comando recusa, sem escrever nada, se `.beads/tasks/` já tem conteúdo, se há algo staged
em `.beads/` ou se a árvore difere de `HEAD` em `.beads/` (sem `--from-worktree`).

O relatório — o do próprio rb-ai-team, rodado com `--recover-mirrors`, no formato atual
do comando:

```
fontes: active 2 · completed 33 · espelhos 26 arquivos
únicos 41 → pastas 41 ✓  (com --recover-mirrors: 6 recuperado(s) dos espelhos)
no completed.yaml e FORA do índice antigo (#30): nenhum
no índice sem nó no completed.yaml: nenhum
só em espelhos: 6
  infra-npm-prefix-install-docs · fix-npm-prefix-install.yaml · completed · 2026-07-29
  …
```

| Linha | O que diz |
|---|---|
| `fontes` | o que foi lido de `HEAD`: `active.yaml` (vivos), `archive/completed.yaml` (a verdade do histórico) e os espelhos |
| `únicos N → pastas N ✓` | a conferência da contagem; com `✗` a migração aborta **antes** de escrever |
| `duplicatas` | o mesmo id em duas fontes: fica o `updated_at` maior, e o outro é listado |
| `FORA do índice antigo (#30)` | nó do `completed.yaml` que o índice antigo não tinha; migra assim mesmo |
| `só em espelhos` | ids que só existem no espelho de alguma branch: **ficam de fora sem `--recover-mirrors`** |
| `espelho ilegível` | YAML quebrado, fora da conta: conserte-o e rode de novo, ou porte-o depois com `--port` |

**`--recover-mirrors` — quando `só em espelhos` não é zero.** É o caso comum: no modelo
antigo o agente registrava no espelho da branch dele. Com a flag, esses ids entram (se o
mesmo id está em vários espelhos, vence o `updated_at` maior). Ordem de grandeza do
levantamento de outubro de 2026, só como exemplo — o seu `--dry-run` é o que vale:
omni-chat com 5 beads só em espelho, trabalhista com 31 e riosbraz com 27; o crm com 557
arquivados, que viram 557 pastas de beads concluídos.

**`--scan-history` — depois do commit da migração, sempre com `--dry-run` primeiro.** O
modelo antigo perdeu beads pelo caminho (o archive que pulava nós, #30; o espelho de uma
branch que um merge descartou), e eles continuam no histórico do git. O comando recusa em
modo legado, por isso vem depois (§4). Ele traz de volta, como pasta nova, cada id que não
existe em `.beads/tasks/`, **com o status da versão mais nova** — então um bead que foi
tirado do `active.yaml` de propósito volta, e um bead esquecido volta vivo. Leia a lista
antes de aplicar. No rb-ai-team ele trouxe 29 beads, 4 deles vivos (`pending` e
`in_progress` de julho): voltaram como trabalho aberto e tiveram de ser revistos um a um.
Id que já existe mas tem
versão mais nova no histórico só aparece no relatório (porte com `--port-from <commit>`
se quiser). Rodar de novo não traz nada.

A linha `versão ilegível, fora da conta: <commit> <arquivo>: <erro>` é uma versão de
`active.yaml`, espelho ou `archive/completed.yaml`, naquele commit, cujo YAML não
parseia: ela fica fora da varredura, e um bead que só existia nela não volta. Se importar,
extraia-a com `git show <commit>:<arquivo>` para um arquivo fora do repo, conserte o YAML
e porte esse arquivo com `--port`.

## 4. Migrar e commitar

```bash
node aiteam/scripts/migrate-beads.mjs --recover-mirrors > <saida.txt>   # ou sem a flag, conforme o §3
cat <saida.txt>                                                         # leia tudo, avisos incluídos
git status
```

`<saida.txt>` e o `<arquivo-da-mensagem>` abaixo são caminhos seus, fora do repo (troque
os `<…>` antes de rodar: no shell, `<` e `>` são redirecionamento).

O que o comando faz, sem commitar: escreve `.beads/tasks/<id>/<branch>.yaml` (a
definição e uma entrada com o estado), põe `phases` e `focus_note` em
`.beads/project/<branch>.yaml`, tira do índice o `archive/`, os espelhos, o `active.yaml`,
o `cost-log.json` e o `session-log.ndjson` (e apaga do disco o `archive/`, os espelhos e
o `active.yaml`), cria ou completa o `.beads/.gitignore` e regenera as visões. O custo
acumulado do `session` antigo não migra: custo agora é local (`beads-schema.md` §10), e o
orçamento vem do `SPEC.md`.

No mesmo commit, à mão:

1. **`.beads/SCHEMA.md`** vira o apontador para [`beads-schema.md`](beads-schema.md), com
   as convenções locais num apêndice. Modelo: `git show upstream/main:.beads/SCHEMA.md`.
2. **`.gitattributes`**, se ainda não o limpou (§6).

**A mensagem do commit leva o relatório:** é o registro da migração. Escreva-a no
`<arquivo-da-mensagem>` — a primeira linha (ex.:
`chore(beads): migra o .beads para o modelo por bead`), uma linha em branco e as linhas do
relatório, de `fontes:` até a lista de `só em espelhos`. Depois do relatório o comando
imprime uma linha `[beads] ⚠` por aviso da regeneração das visões (id sem palavra-chave
de mesa, resumo longo…) — dezenas, num backlog grande. Essas linhas ficam fora da
mensagem: elas também saem no **stdout**, então redirecionar só o stdout não as separa;
filtre-as com `grep -v '^\[beads\]' <saida.txt>`.

```bash
npm --prefix aiteam run validate:beads
git add .beads/SCHEMA.md .gitattributes
git commit -F <arquivo-da-mensagem>
```

Use `-F` com um arquivo, nunca o `git commit` que abre o editor (uma sessão de agente não
tem editor) nem um `-m` longo com aspas escapadas (o tier-guard já negou um assim). O
`pre-commit` já roda no modelo novo (o índice não tem mais o `active.yaml`).

Depois, o resgate do histórico, num commit separado — a mensagem leva a lista do
`--scan-history`, com o mesmo filtro das linhas `[beads]`:

```bash
node aiteam/scripts/migrate-beads.mjs --scan-history --dry-run   # leia a lista
node aiteam/scripts/migrate-beads.mjs --scan-history > <saida.txt>
git commit -F <arquivo-da-mensagem>   # ex.: chore(beads): recupera do histórico os N beads que o modelo antigo perdeu
```

## 5. Branch aberta antes da migração: portar arquivo por arquivo com `--port`

O bead de uma branch aberta antes da migração só existe no `active.yaml`, no espelho e às
vezes no `archive/` dela. **Porte antes de tirar esses arquivos do git** — o `git rm`
sozinho perde o bead. O comando principal é o `--port <rev>:<arquivo>`, um por arquivo que
sai (abaixo). A alternativa de uma vez só é o `--port-from <commit>`, que une
`active.yaml` e `archive/completed.yaml` daquele commit por id, como a migração (os
espelhos entram com `--recover-mirrors`). Os dois criam a pasta dos ids que ainda não
existem e acrescentam, no arquivo da **sua** branch, uma entrada por nó mais novo que o
estado combinado. Rode antes com `--dry-run`: a saída diz
`N criado(s), M com entrada nova, K já refletido(s)`.

**Porte por arquivo.** O `--port` aceita `<rev>:<arquivo>` (`HEAD:.beads/velha.yaml`,
`MERGE_HEAD:.beads/active.yaml`, `REBASE_HEAD:…`, `CHERRY_PICK_HEAD:…`) e lê o arquivo
**do commit**, então funciona mesmo com o arquivo já apagado do disco. É esse o comando que
a recusa do `pre-commit` manda rodar, um por arquivo que sai. Evite começar pelo
`--port-from … --recover-mirrors`: ele lê **todos** os espelhos do commit e traz também o
que só existe nos espelhos de outras branches (num consumidor real, 32 beads onde o
`--port` do espelho dela trouxe 1).

**Descartar de propósito:** não há opt-out. O único jeito é `git commit --no-verify`, que
**também pula o secret scan e o drift das personas**. Antes, rode
`npx tsx aiteam/scripts/scan-secrets.ts` e `npm --prefix aiteam run validate:agents`.

A recusa lista no máximo 10 ids ("… +N"). Um nó sem id num arquivo antigo não impede o
porte dos outros: ele sai como `⚠ … nó sem id — ficaram de fora`.

⚠️ **A alternativa `--port-from … --recover-mirrors`** une todos os espelhos que o commit
tem — os de **outras** branches incluídos. Além do excesso do parágrafo acima, quem migrou
sem `--recover-mirrors` recebe de volta por ela, como pastas novas, os ids de espelho que
deixou de fora de propósito na migração. O porte por arquivo não tem esse efeito, e o
`pre-commit` recusa tirar do índice um espelho que ele não portou.

Depois do porte, tire do índice o que sobrar do modelo antigo e apague do disco — um
`active.yaml` antigo esquecido no disco vira "visão editada à mão" no próximo hook, e o
backup `*.editado-*` bloqueia o commit seguinte:

```bash
git rm -q --cached --ignore-unmatch -- .beads/active.yaml .beads/<espelho>.yaml
git rm -r -q --cached --ignore-unmatch -- .beads/archive
rm -f .beads/active.yaml .beads/<espelho>.yaml
```

`<espelho>` (e `<sua-branch>`, nos casos b e d) é um **placeholder**: o nome do espelho da
branch antiga, que é o nome dela com `/` trocado por `-` (`feat/login` →
`.beads/feat-login.yaml`). Troque-o antes de rodar. Copiado como está, o shell lê `<` e
`>` como redirecionamento e o comando não faz o que parece. A branch pode não ter espelho
(nem `active.yaml` no índice, depois de um merge limpo): por isso o `--ignore-unmatch` —
sem ele, o `git rm` aborta inteiro com "pathspec … did not match" e não tira nada.

Escolha o caso pelo lado em que o merge acontece (d e e: rebase e cherry-pick):

**a) Levar a branch antiga para a branch migrada (merge local).** Os hooks conferem este
sentido: no commit do merge o `pre-commit` recusa criar ou modificar `active.yaml`,
espelho e `archive/`, e recusa o `git rm` sem porte, listando os ids que faltam.

```bash
git switch <default> && git pull
git merge --no-commit --no-ff <branch-antiga>
node aiteam/scripts/migrate-beads.mjs --port MERGE_HEAD:.beads/active.yaml
node aiteam/scripts/migrate-beads.mjs --port MERGE_HEAD:.beads/<espelho>.yaml
# se a branch trouxe archive/: --port MERGE_HEAD:.beads/archive/completed.yaml
# tire do índice e do disco o que sobrou (bloco acima), depois:
git commit -F <arquivo-da-mensagem>
```

De uma vez só: `--port-from MERGE_HEAD --recover-mirrors`, com o aviso acima.

**b) A sua branch ainda está no modelo antigo e recebe a default já migrada.**
`git checkout velha && git merge main`. O `active.yaml` conflita (modify/delete). Aqui o
lado que perde o bead é o **HEAD**, a sua branch. O `MERGE_HEAD` é a default e não tem
nada do modelo antigo, então `--port-from MERGE_HEAD` não serve. Porte o HEAD **antes** de
tirar os arquivos do índice:

```bash
node aiteam/scripts/migrate-beads.mjs --port HEAD:.beads/active.yaml
node aiteam/scripts/migrate-beads.mjs --port HEAD:.beads/<sua-branch>.yaml
# se a branch arquivou algo (archive/completed.yaml em conflito): --port HEAD:.beads/archive/completed.yaml
git rm -q --cached --ignore-unmatch -- .beads/active.yaml .beads/<sua-branch>.yaml   # e apague os arquivos (e o archive/, se portado)
git commit -F <arquivo-da-mensagem>
```

O `pre-commit` confere o HEAD: tirar o `active.yaml` ou o espelho sem portar é
**recusado**, com os ids que faltam e esta mesma dica. Depois do commit, o merge de volta
na default sai limpo.

- De uma vez só: `--port-from HEAD --recover-mirrors`, que traz também o que só existe nos
  espelhos de **outras** branches (o aviso acima).
- Se mantiver o `active.yaml` no índice, o repo continua em modo legado e o commit é
  recusado (a mensagem traz o mesmo porte).
- Merge limpo (a branch só tinha o espelho): o `post-merge` avisa do resíduo. O
  `git rm --cached` dele, **mesmo num commit comum**, passa pelo `pre-commit`: se o bead
  do espelho não estiver em `.beads/tasks/`, o commit é recusado com os ids e a dica
  `--port HEAD:.beads/<espelho>.yaml` (ou, de uma vez,
  `--port-from HEAD --recover-mirrors`). Porte antes de apagar. Espelho velho cujos beads
  já estão no estado apaga-se sem recusa.
- Squash: vale o mesmo; só o espelho com o nome da branch atual é conferido.
- Espelho com YAML quebrado: não o tire do índice até corrigir e portar.

**c) A branch já entrou por um merge limpo** (ela só criou o espelho dela — inclusive pelo
botão do GitHub, que não roda hook nenhum). O `post-merge` avisa alto do resíduo
rastreado, e o `validate:beads` falha com a dica "porte com `--port` … antes do
`git rm --cached`" até ele sair. Numa branch nova a partir da default:

```bash
node aiteam/scripts/migrate-beads.mjs --port HEAD:.beads/<espelho>.yaml
# tire do índice e do disco o espelho (bloco acima), depois:
git commit -F <arquivo-da-mensagem>   # e abra o PR
```

De uma vez só: `--port-from HEAD --recover-mirrors`, com o aviso acima.

**d) Rebase da branch antiga sobre a default migrada (`git rebase main`).** Dá o mesmo
conflito do merge: `active.yaml` apagado de um lado e modificado do outro, mais o espelho.
O lado "de lá" é o commit que o rebase está aplicando (`REBASE_HEAD`), não o `MERGE_HEAD`.
Porte **antes** do `git rm --cached`:

```bash
node aiteam/scripts/migrate-beads.mjs --port REBASE_HEAD:.beads/active.yaml
node aiteam/scripts/migrate-beads.mjs --port REBASE_HEAD:.beads/<sua-branch>.yaml
# se o commit arquivou algo (archive/completed.yaml em conflito): --port REBASE_HEAD:.beads/archive/completed.yaml
git rm -q --cached --ignore-unmatch -- .beads/active.yaml .beads/<sua-branch>.yaml   # e apague os arquivos (e o archive/, se portado)
git rebase --continue
```

**Atenção:** o git aplica os commits de um rebase com `-n`, então o `rebase --continue`
**não chama o `pre-commit`** e nada recusa. Se o porte for esquecido, o `post-rewrite`
avisa no fim ("o rebase deixou bead para trás") e mostra os comandos de porte: um
`--port ORIG_HEAD:<arquivo>` por arquivo, ou, de uma vez,
`--port-from ORIG_HEAD --recover-mirrors`. Porte e commite em seguida. O commit antigo fica
em `ORIG_HEAD` e no reflog por ~30 dias, e o `--scan-history` não o recupera.

**e) Cherry-pick de um commit da branch antiga na default migrada.** É o mesmo conflito e
o mesmo porte, agora com `CHERRY_PICK_HEAD`:

```bash
node aiteam/scripts/migrate-beads.mjs --port CHERRY_PICK_HEAD:.beads/active.yaml
node aiteam/scripts/migrate-beads.mjs --port CHERRY_PICK_HEAD:.beads/<espelho>.yaml
# se o commit arquivou algo (archive/completed.yaml em conflito): --port CHERRY_PICK_HEAD:.beads/archive/completed.yaml
git rm -q --cached --ignore-unmatch -- .beads/active.yaml .beads/<espelho>.yaml   # e o archive/, se portado
git cherry-pick --continue
```

O `git cherry-pick --continue` roda o `pre-commit`, que recusa o `--continue` sem o porte.
Limitação conhecida: com conflito, ele confere o modelo antigo inteiro do commit escolhido,
não só o que esse commit muda em `.beads/`. Por isso pode recusar o cherry-pick de um commit
só de código por causa de um bead que a default tirou à mão antes de migrar. Se o bead
listado não deve voltar, confirme com `git commit --no-verify` (§10).

## 6. Limpar o `.gitattributes`

Saem duas coisas, as duas do checklist do sync:

- **o bloco do driver `beads-yaml`** — o bloco inteiro, comentário incluído (três linhas de
  comentário e duas ou três `merge=beads-yaml`): o contract test reprova qualquer
  `beads-yaml` no arquivo;
- **qualquer regra `merge=union` em `.beads/`** — a mesma união silenciosa, que o contract
  test não pega — com o parágrafo de comentário colado nela.

```bash
sed -i.bak -E '/^#.*(Conflict-free merges for the Bead Board|beads-merge\.ts|merge\.beads-yaml)|merge=beads-yaml/d' .gitattributes && rm .gitattributes.bak
awk '/^[ \t]*#/ {buf = buf $0 "\n"; next} /^[ \t]*(\/|\*\*\/)?\.beads\/[^ \t]*[ \t]+(.*[ \t])?merge=union([ \t\r]|$)/ {buf = ""; next} {printf "%s", buf; buf = ""; print} END {printf "%s", buf}' .gitattributes > .gitattributes.new && mv .gitattributes.new .gitattributes
git diff -- .gitattributes
grep -nE 'beads-yaml|^[[:space:]]*(/|\*\*/)?\.beads/.*merge=union' .gitattributes   # não pode sobrar nada
npm --prefix aiteam test -- githooks-contract
```

O contract test (a última linha) roda no vitest e precisa do `aiteam/node_modules`: sem
ele, instale com `cd aiteam && npm install`, ou confie no `grep` acima. Os scripts da
migração (`migrate-beads.mjs`, `beads.mjs`, `beads-check.mjs`, `beads-views.mjs`) não
precisam: são node puro.

O `sed` e o `awk` são estreitos de propósito. Se o `grep` ainda achar `beads-yaml` num
comentário de **outra** regra, reescreva esse comentário sem citar o driver. O registro
`merge.beads-yaml` que sobra no `.git/config` fica inerte sem o mapeamento; apague-o
quando nenhuma branch ou worktree o mapear mais (o doctor diz quando):
`git config --remove-section merge.beads-yaml`.

## 7. O commit e o PR de dados

O PR de dados leva só dados: `.beads/tasks/**`, `.beads/project/<branch>.yaml`,
`.beads/.gitignore`, `.beads/SCHEMA.md`, `.gitattributes` e as remoções (`active.yaml`,
espelhos, `archive/`, `cost-log.json`). Nada de código da app, nada do `aiteam/` (o sync
é outro PR, anterior). Dois commits: a migração, com o relatório na mensagem, e o resgate
do `--scan-history`, se trouxe algo. No corpo do PR: o relatório do `--dry-run`, a lista
do `--scan-history` e as branches abertas do §2 com o caso do §5 que cada uma vai usar.

O merge pode ser pelo GitHub: são só dados, e ninguém escreveu no modelo antigo na
janela. Se a default andou e mexeu no `active.yaml` nesse meio-tempo, o PR conflita:
atualize a branch de dados com a default localmente (o `MERGE_HEAD` é a default, ainda no
modelo antigo) com o porte por arquivo do §5 a (`--port MERGE_HEAD:.beads/active.yaml`,
um por arquivo que sai).

## 8. Depois do merge

Em **cada** clone e **cada** worktree:

1. **Antes do `git pull`, `git status -- .beads` limpo.** Uma mudança não commitada no
   `active.yaml` antigo impede o pull: anote o que ela registrava, descarte-a e registre de
   novo como entrada, com o comando `beads`, depois do pull.

   **Apague ou mova o `.beads/.gitignore` não rastreado.** Em modo legado o
   `node aiteam/install.mjs` cria esse arquivo em cada clone sem pô-lo no git, e o PR de
   dados traz o mesmo caminho rastreado: com ele no disco, o `git pull` aborta com
   "untracked working tree files would be overwritten by merge". O pull traz a versão do
   PR, então pode apagar.

   ```bash
   git ls-files --others --exclude-standard -- .beads/.gitignore   # listado = não rastreado
   rm .beads/.gitignore                                            # ou mova-o para fora do repo
   ```
2. **`git switch <default> && git pull`.** O git apaga do disco o que o commit da migração
   tirou (`active.yaml`, espelhos, `archive/`, `cost-log.json`), e o `post-merge`
   regenera as visões —
   `.beads/active.yaml` e `.beads/index.yaml` passam a ser geradas e ignoradas. Sem os
   hooks naquele clone, rode `node aiteam/install.mjs`; para regenerar à mão,
   `npm --prefix aiteam run beads:views`. A worktree de um subagente isolado do Claude Code
   nasce sem as visões (o `post-checkout` não roda nela); o `beads status` funciona lá
   assim mesmo.
3. **Espelhos não rastreados.** Um espelho que o hook antigo escreveu e ninguém commitou
   continua no disco:

   ```bash
   git ls-files --others --exclude-standard -- .beads
   node aiteam/scripts/migrate-beads.mjs --port .beads/<arquivo>.yaml --dry-run
   ```

   Aqui o `--port` lê do disco, sem `<rev>:`: o arquivo não está em commit nenhum. Se o
   `--dry-run` cria ou acrescenta algo que é trabalho de verdade, rode sem a flag numa
   branch e commite; depois apague o arquivo. Se diz só "já refletido", apague-o.

   Na limpeza em massa dos resíduos rastreados (`git rm --cached` de vários espelhos de
   uma vez), um espelho de outra branch com bead que o estado não reflete é recusado pelo
   `pre-commit` até ser portado — um `--port HEAD:.beads/<espelho>.yaml` por espelho que
   sai, o comando que a recusa mostra.
4. **Branches antigas** que ainda estão abertas: o §5, quando cada uma for atualizada ou
   mergeada.
5. **Os agentes** passam a gravar com `node aiteam/scripts/beads.mjs`
   (`new`/`start`/`note`/`done`), como o `BOOT.md` e o `AGENTS.md` já mandam; o
   `.beads/SCHEMA.md` aponta para o contrato.

## 9. Verificar

```bash
npm --prefix aiteam run validate:beads
node aiteam/scripts/beads.mjs status
node aiteam/scripts/doctor.mjs
git ls-files .beads/active.yaml                   # vazio
git ls-files .beads | grep -v '^\.beads/tasks/'   # só .gitignore, SCHEMA.md, BACKLOG.md e project/
```

| Onde | O esperado |
|---|---|
| `validate:beads` | `✓ N beads válidos (M vivos)`, sem erro |
| `beads status` | a branch e o arquivo em que ela escreve; o total de beads bate com as `pastas` do relatório mais o que o `--scan-history` trouxe |
| `doctor` | `.beads no modelo por bead` sem "modo legado"; nenhum FAIL em `merge driver beads-yaml` (um WARN com o `git config --remove-section` enquanto o registro sobrar); a validação dos beads passa. Um FAIL em `SPEC.md ci:` ou `SPEC.md deploy:` e um WARN do driver vêm do checklist do sync (§1), não da migração |
| `git ls-files .beads` | fora `.beads/tasks/`, só `.beads/.gitignore`, `.beads/SCHEMA.md`, o `.beads/BACKLOG.md` se você tem um e `.beads/project/<branch>.yaml` se o `active.yaml` antigo tinha fases ou foco |

## 10. Quando algo recusa

| Mensagem | O que fazer |
|---|---|
| `untracked working tree files would be overwritten by merge: .beads/.gitignore` (no `git pull` do §8) | o `install.mjs` criou o arquivo sem rastreá-lo, em modo legado: apague-o ou mova-o para fora do repo e repita o pull, que traz a versão do PR de dados |
| `migrate recusado: há mudanças staged em .beads/` | commite ou tire do stage |
| `a árvore difere de HEAD em .beads/` | commite as mudanças ou rode com `--from-worktree` |
| `há arquivos não rastreados em .beads/tasks/` | alguém usou o protocolo novo em modo legado: mova-os para fora do repo, migre e registre de novo como entrada |
| `únicos N → pastas M ✗` | nada foi escrito: leia as duplicatas e os ids inválidos do relatório; um id que não vale como nome de pasta se corrige no `active.yaml` antigo, num commit antes da migração |
| `… é do modelo antigo (espelho ou archive/) e não se cria mais` | um merge trouxe o modelo antigo: §5 |
| `a sua branch (HEAD) está no modelo antigo e este commit tira …` ou `o HEAD ainda rastreia o modelo antigo (resíduo de um merge) e este commit tira …` | porte antes, um `--port <rev>:<arquivo>` por arquivo que sai — o comando vem na mensagem — e commite de novo (§5 b e c) |
| `o rebase deixou bead para trás` (aviso do `post-rewrite`, no fim do `git rebase`) | o `rebase --continue` não roda o `pre-commit`, então nada recusou: porte agora com `--port ORIG_HEAD:<arquivo>` (ou `--port-from ORIG_HEAD --recover-mirrors`) e commite; o commit antigo fica em `ORIG_HEAD` e no reflog por ~30 dias (§5 d) |
| `git cherry-pick --continue` recusado: `o commit do cherry-pick (CHERRY_PICK_HEAD) está no modelo antigo e traz …` | `--port CHERRY_PICK_HEAD:<arquivo>` por arquivo, `git rm --cached` do que sobrou e `--continue` de novo (§5 e) |
| quer descartar de propósito o bead do modelo antigo | não há opt-out: só `git commit --no-verify`, que pula também o secret scan e o drift das personas — antes, rode `npx tsx aiteam/scripts/scan-secrets.ts` e `npm --prefix aiteam run validate:agents` |
| `visão editada à mão` / commit bloqueado por `*.editado-*` | passe o que importa do backup para uma entrada nova e apague o backup |
| aviso de caminho acima de 160 caracteres (Windows) | `git config core.longpaths true` |
