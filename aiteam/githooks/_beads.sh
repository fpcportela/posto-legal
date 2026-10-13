# aiteam/githooks/_beads.sh — funções do .beads para os hooks git. É carregado
# com `.` (source) pelos hooks; não é um hook e o git nunca o chama sozinho.
#
# Contrato: aiteam/docs/beads-schema.md — §7.3 (quando as visões são
# regeneradas), §8 (dono por branch no pre-commit) e §11 (modo legado).
#
# A regra de dono é bash puro: vale mesmo sem node. O node (beads-views.mjs,
# beads-check.mjs) só usa node:* e o js-yaml vendorizado — roda numa worktree
# sem aiteam/node_modules. Nada aqui escreve no .git/config: ele é
# compartilhado pelo checkout principal e por todas as worktrees.

BEADS_HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# No Git for Windows, `pwd -W` dá "C:/…", um caminho que o node.exe entende mesmo com
# MSYS_NO_PATHCONV=1 (sem a conversão automática de "/c/…" nos argumentos). No
# Linux e no macOS o `pwd` do bash não tem -W: cai no `pwd` comum.
BEADS_AITEAM="$(cd "$BEADS_HOOKS_DIR/.." && { pwd -W 2>/dev/null || pwd; })"
# O git já roda os hooks na raiz da árvore; o cd só garante isso para quem
# chama o hook à mão (o encadeamento do install.mjs, por exemplo).
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || true

# Branch atual. `symbolic-ref` funciona até em branch sem commit; em HEAD
# destacado no meio de um rebase, a branch vem do head-name do rebase. Sem
# --short: com uma tag de mesmo nome, ele devolveria "heads/<branch>".
beads_branch() {
  local b gd f
  b=$(git symbolic-ref -q HEAD 2>/dev/null)
  b="${b#refs/heads/}"
  if [ -n "$b" ]; then printf '%s' "$b"; return 0; fi
  gd=$(git rev-parse --git-dir 2>/dev/null) || return 1
  for f in "$gd/rebase-merge/head-name" "$gd/rebase-apply/head-name"; do
    if [ -f "$f" ]; then
      b=$(sed 's#^refs/heads/##' "$f" | tr -d '\r\n')
      if [ -n "$b" ]; then printf '%s' "$b"; return 0; fi
    fi
  done
  return 1
}

# Nome do arquivo de branch: `/` vira `-`.
beads_sanitize() {
  printf '%s' "${1//\//-}"
}

# A branch pode escrever beads? Charset [A-Za-z0-9._/-] e um nome de arquivo
# que comece por letra ou número.
beads_branch_ok() {
  local f
  [[ "$1" =~ ^[A-Za-z0-9._/-]+$ ]] || return 1
  [[ "$1" != *..* ]] || return 1
  f=$(beads_sanitize "$1")
  [[ "$f" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && [[ "$f" != *. ]]
}

# Modo legado (§11): o HEAD tem o .beads/active.yaml do modelo antigo (não a
# visão gerada) E o índice ainda o tem. A decisão vem do HEAD, nunca só do
# índice: um agente que cria .beads/tasks/ num consumidor legado não desliga o
# modo, e um repo migrado não volta a ele forçando um active.yaml no stage. O
# commit da migração tira o arquivo do índice — por isso sai do legado.
# (ls-tree/ls-files com o caminho em argumento separado: o "HEAD:<caminho>"
# seria convertido pelo bash do Git for Windows.)
beads_legacy() {
  beads_head_legacy && [ -n "$(git ls-files -- .beads/active.yaml 2>/dev/null)" ]
}

# O HEAD tem o .beads/active.yaml do modelo antigo (não a visão gerada)? É a
# metade de beads_legacy que não olha o índice: num merge, diz de que lado está o
# modelo antigo (o HEAD, a sua branch, ou só o MERGE_HEAD).
beads_head_legacy() {
  local entry sha first
  entry=$(git ls-tree HEAD -- .beads/active.yaml 2>/dev/null)
  [ -n "$entry" ] || return 1
  sha=$(printf '%s' "$entry" | awk '{print $3}')
  first=$(git cat-file blob "$sha" 2>/dev/null | head -n 1)
  case "$first" in
    "# GERADO por aiteam/scripts/beads-views.mjs"*) return 1 ;;
  esac
  return 0
}

# Em modo legado o modelo novo ainda não vale: nada entra em .beads/tasks/ nem
# em .beads/project/ até a migração.
beads_legacy_pre_commit() {
  local status path bad=0
  while IFS= read -r -d '' status && IFS= read -r -d '' path; do
    [ "${status:0:1}" = "D" ] && continue
    case "$path" in
      .beads/tasks/*|.beads/project/*)
        echo "[beads] ✗ $path: modo legado — o .beads/active.yaml antigo ainda manda. Registre nele, ou migre antes: node aiteam/scripts/migrate-beads.mjs --dry-run (rode migrate-beads)." >&2
        bad=1
        ;;
    esac
  done < <(git diff --cached --name-status --no-renames -z -- .beads)
  # Num merge (ou squash) em modo legado, o modelo novo só pode ter vindo do outro
  # lado: a default já migrada entrando na branch antiga. A saída não é "registre
  # no active.yaml" — é portar o que é desta branch e tirar o modelo antigo.
  if [ "$bad" = 1 ] && beads_merge_in_progress; then
    echo "[beads]   Este commit é um merge (ou squash) que traz o modelo novo — a branch padrão já migrada — para uma branch ainda no modelo antigo." >&2
    echo "[beads]   O que é da sua branch está só no active.yaml e no espelho: porte antes, um arquivo por vez (lê do commit, vale com ele já apagado) — node aiteam/scripts/migrate-beads.mjs --port HEAD:.beads/active.yaml ; node aiteam/scripts/migrate-beads.mjs --port HEAD:.beads/<sua-branch>.yaml" >&2
    echo "[beads]   ou, de uma vez: node aiteam/scripts/migrate-beads.mjs --port-from HEAD --recover-mirrors (traz também o que só existe nos espelhos de outras branches)" >&2
    echo "[beads]   e só depois tire o modelo antigo do índice: git rm -q --cached -- .beads/active.yaml .beads/<sua-branch>.yaml (e apague os arquivos). Sem o porte, o bead some do estado." >&2
  fi
  [ "$bad" = 0 ]
}

beads_legacy_notice() {
  echo "[beads] modo legado: .beads/active.yaml ainda é rastreado pelo git — os hooks não mexem no backlog." >&2
  echo "[beads] Migre com: node aiteam/scripts/migrate-beads.mjs --dry-run (aiteam/docs/beads-schema.md §11)" >&2
}

# O node a usar; BEADS_NODE é a costura dos testes. Vazio se não houver.
beads_node() {
  local n="${BEADS_NODE:-node}"
  command -v "$n" >/dev/null 2>&1 && printf '%s' "$n"
}

beads_loud() {
  local l
  echo "[beads] ⚠⚠ ===================================================================" >&2
  for l in "$@"; do echo "[beads] ⚠⚠ $l" >&2; done
  echo "[beads] ⚠⚠ ===================================================================" >&2
}

beads_in_rebase() {
  local gd
  gd=$(git rev-parse --git-dir 2>/dev/null) || return 1
  [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ]
}

# Regenera as visões (args vão para o beads-views.mjs, ex.: --quiet). Nunca
# derruba o hook: visão velha é incômodo, hook quebrado é pior.
beads_regenerate() {
  local node
  [ -d .beads ] || return 0
  node=$(beads_node)
  if [ -z "$node" ]; then
    beads_loud "node não encontrado: .beads/active.yaml e .beads/index.yaml NÃO foram regenerados." \
      "Instale o node (>= 18) e rode: node aiteam/scripts/beads-views.mjs"
    return 0
  fi
  "$node" "$BEADS_AITEAM/scripts/beads-views.mjs" "$@" || true
}

# Depois de um rebase (post-rewrite): o bead que a branch antiga tinha no active.yaml
# ou no espelho (ORIG_HEAD) e que o `git rm --cached` do conflito levou embora sem
# porte. Só avisa — o commit já foi feito —, mas alto e com o comando (§11).
beads_rewrite_check() {
  local node
  node=$(beads_node)
  [ -n "$node" ] || return 0
  if ! "$node" "$BEADS_AITEAM/scripts/beads-check.mjs" --rewrite; then
    beads_loud "o rebase deixou bead para trás (acima): porte AGORA com o comando indicado e commite." \
      "O commit antigo continua em ORIG_HEAD (git reflog); sem referência, o git o coleta em cerca de 30 dias."
  fi
  return 0
}

# Classe de um caminho staged sob .beads/ (contrato §8). Ecoa: task|project|
# stray|view|backup|local|archive|mirror|free.
beads_classify() {
  local p="$1"
  if [[ "$p" =~ ^\.beads/tasks/[^/]+/[^/]+\.yaml$ ]]; then echo task; return; fi
  case "$p" in .beads/tasks|.beads/tasks/*) echo stray; return ;; esac
  if [[ "$p" =~ ^\.beads/project/[^/]+\.yaml$ ]]; then echo project; return; fi
  case "$p" in .beads/project|.beads/project/*) echo stray; return ;; esac
  case "$p" in
    .beads/active.yaml|.beads/index.yaml) echo view; return ;;
    .beads/archive/*) echo archive; return ;;
    .beads/session.local.json|.beads/cost-log.json|.beads/session-log.ndjson) echo local; return ;;
  esac
  local base="${p#.beads/}"
  if [[ "$base" != */* ]]; then
    case "$base" in
      *.editado-*) echo backup; return ;;
      *.tmp-*|*.corrupt-*) echo local; return ;;
      *.yaml) echo mirror; return ;;
    esac
  fi
  echo free
}

# Commit de merge ou de squash local? Só isso isenta — e só da regra de DONO.
# O MERGE_HEAD tem de ser um commit de verdade e diferente do HEAD (um
# MERGE_HEAD forjado não isenta). O SQUASH_MSG não tem como ser conferido,
# por isso a isenção é só do dono: o resto da §8 vale igual.
beads_merge_in_progress() {
  local gd mh head
  gd=$(git rev-parse --git-dir 2>/dev/null) || return 1
  if [ -f "$gd/MERGE_HEAD" ]; then
    mh=$(git rev-parse -q --verify "MERGE_HEAD^{commit}" 2>/dev/null) || return 1
    head=$(git rev-parse -q --verify HEAD 2>/dev/null)
    [ -n "$mh" ] && [ "$mh" != "$head" ]
    return
  fi
  [ -f "$gd/SQUASH_MSG" ]
}

# Rebase ou cherry-pick parado num conflito (ou em `--continue`)? Têm um commit
# "de lá" como o MERGE_HEAD tem (REBASE_HEAD, CHERRY_PICK_HEAD), mas o HEAD não é
# um commit de merge: depois do `git rm --cached` do modelo antigo o diff pode nem
# ter .beads, e o hook voltaria cedo sem conferir o bead que sumiria (§11).
beads_pick_in_progress() {
  local gd
  gd=$(git rev-parse --git-dir 2>/dev/null) || return 1
  [ -f "$gd/CHERRY_PICK_HEAD" ] && return 0
  [ -f "$gd/REBASE_HEAD" ] && { [ -d "$gd/rebase-merge" ] || [ -d "$gd/rebase-apply" ]; }
}

# Merge de uma branch aberta antes da migração (§11): o active.yaml, o
# espelho e o archive/ dela não entram, e o bead que eles trazem não pode
# sumir no `git rm` — porta-se primeiro. O arquivo antigo está na árvore
# durante o merge, por isso o --port <arquivo> funciona.
beads_port_refusal() {
  # O HEAD é o lado do modelo antigo: a sua branch, aberta antes da migração, é que
  # recebeu a default já migrada (e ainda mexeu no arquivo antigo no meio do merge).
  # O porte é do HEAD; o do MERGE_HEAD só vale se a branch mergeada também é antiga.
  if beads_head_legacy; then
    echo "[beads] ✗ $1 é do modelo antigo, e a sua branch (HEAD) é que ainda o usa — o merge da default já migrada não o aceita de volta no git." >&2
    echo "[beads]   Porte primeiro o que a sua branch tem, arquivo a arquivo (lê do commit): node aiteam/scripts/migrate-beads.mjs --port HEAD:$1" >&2
    echo "[beads]   ou, de uma vez: --port-from HEAD --recover-mirrors (traz também os espelhos de outras branches); se a branch mergeada também é antiga: --port-from MERGE_HEAD" >&2
    echo "[beads]   e só depois tire-o do merge: git rm -q --cached -- $1 (e apague o arquivo)." >&2
    return 0
  fi
  echo "[beads] ✗ $1 é do modelo antigo e veio no merge de uma branch aberta antes da migração — não entra no git." >&2
  # O espelho de uma branch pode ter bead que o active.yaml não tem: o
  # --recover-mirrors o traz junto no --port-from.
  if [ "$(beads_classify "$1")" = mirror ]; then
    echo "[beads]   Porte primeiro o que ele traz: node aiteam/scripts/migrate-beads.mjs --port $1 (ou --port-from MERGE_HEAD --recover-mirrors, tudo de uma vez)" >&2
  else
    echo "[beads]   Porte primeiro o que ele traz: node aiteam/scripts/migrate-beads.mjs --port $1 (ou --port-from MERGE_HEAD, tudo de uma vez)" >&2
  fi
  echo "[beads]   e só depois tire-o do merge: git rm -q --cached -- $1 (e apague o arquivo)." >&2
}

# A §8 do contrato, sobre o que está staged. Imprime cada recusa e devolve 1
# se houver alguma. Em merge e squash, só a regra de dono fica isenta.
beads_pre_commit() {
  local gd branch file="" bad=0 touched=0 removed=0 merging=0 picking=0 status path kind id own tail
  gd=$(git rev-parse --git-dir 2>/dev/null) || return 0

  local backups
  backups=$(ls -1 .beads/*.editado-* 2>/dev/null)
  if [ -n "$backups" ]; then
    echo "[beads] ✗ há visão editada à mão guardada como backup:" >&2
    printf '%s\n' "$backups" | sed 's/^/[beads]     /' >&2
    echo "[beads]   Passe o que importa para .beads/tasks/<id>/<sua-branch>.yaml como entrada nova e apague o backup." >&2
    return 1
  fi

  beads_merge_in_progress && merging=1
  beads_pick_in_progress && picking=1

  branch=$(beads_branch)
  if [ -n "$branch" ] && beads_branch_ok "$branch"; then file=$(beads_sanitize "$branch"); fi

  while IFS= read -r -d '' status && IFS= read -r -d '' path; do
    kind=$(beads_classify "$path")
    status="${status:0:1}"
    case "$kind" in
      task|project)
        if [ "$status" = "D" ]; then
          echo "[beads] ✗ $path: apagar arquivo de bead é recusado — o histórico não se apaga (acrescente uma entrada com o status certo)." >&2
          bad=1; continue
        fi
        touched=1
        # Merge e squash trazem, por definição, arquivos de outras branches.
        [ "$merging" = 1 ] && continue
        if [ -z "$branch" ]; then
          echo "[beads] ✗ $path: HEAD destacado — crie uma branch antes de registrar beads (git switch -c <nome>)." >&2
          bad=1; continue
        fi
        if [ -z "$file" ]; then
          echo "[beads] ✗ $path: a branch \"$branch\" tem caractere fora de [A-Za-z0-9._/-] e não pode escrever beads." >&2
          bad=1; continue
        fi
        tail="${path##*/}"; own="${tail%.yaml}"
        if [ "$own" != "$file" ]; then
          if [ "$kind" = "task" ]; then
            id="${path#.beads/tasks/}"; id="${id%%/*}"
            echo "[beads] ✗ $path é da branch \"$own\"; você está em \"$branch\". Acrescente uma entrada em .beads/tasks/$id/$file.yaml." >&2
          else
            echo "[beads] ✗ $path é da branch \"$own\"; você está em \"$branch\". Escreva em .beads/project/$file.yaml." >&2
          fi
          bad=1
        fi
        ;;
      stray)
        [ "$status" = "D" ] && continue
        echo "[beads] ✗ $path: só <branch>.yaml vive em .beads/tasks/<id>/ e em .beads/project/." >&2
        bad=1
        ;;
      view|backup|local)
        # Apagar o .beads/active.yaml do índice é o que a migração faz — ou um git rm
        # --cached à mão num repo legado, que perde tudo: o node confere (§11).
        if [ "$status" = "D" ]; then
          [ "$path" = ".beads/active.yaml" ] && removed=1
          continue
        fi
        if [ "$merging" = 1 ] && [ "$path" = ".beads/active.yaml" ]; then
          beads_port_refusal "$path"; bad=1; continue
        fi
        echo "[beads] ✗ $path fica fora do git (visão gerada ou estado local) — registre em .beads/tasks/<id>/${file:-<sua-branch>}.yaml." >&2
        bad=1
        ;;
      mirror|archive)
        # Apagar o resíduo do modelo antigo é limpeza permitida — desde que o bead
        # dele esteja em .beads/tasks/ (§11): quem confere é o node, abaixo.
        if [ "$status" = "D" ]; then removed=1; continue; fi
        if [ "$merging" = 1 ]; then
          beads_port_refusal "$path"; bad=1; continue
        fi
        echo "[beads] ✗ $path é do modelo antigo (espelho ou archive/) e não se cria mais — registre em .beads/tasks/<id>/${file:-<sua-branch>}.yaml." >&2
        bad=1
        ;;
    esac
  done < <(git diff --cached --name-status --no-renames -z -- .beads)

  [ "$bad" = 0 ] || return 1
  # Num merge, ficar com "o nosso lado" não deixa nada staged em .beads/ — e
  # ainda assim pode perder as entradas do outro. O node confere mesmo assim, e
  # também o commit que só apaga resíduo do modelo antigo (espelho, archive/) e o
  # --continue de um rebase ou cherry-pick (o commit "de lá" é o REBASE_HEAD ou o
  # CHERRY_PICK_HEAD).
  [ "$touched" = 1 ] || [ "$merging" = 1 ] || [ "$removed" = 1 ] || [ "$picking" = 1 ] || return 0

  # Colisão de nomes (feat/x × feat-x): heads locais e remotos. O remoto vem sem
  # o nome do remote (refs/remotes/origin/feat/x → feat/x) e sem origin/HEAD.
  local other
  while IFS= read -r other; do
    [ -n "$other" ] && [ "$other" != "HEAD" ] || continue
    if [ "$other" != "$branch" ] && [ "$(beads_sanitize "$other")" = "$file" ]; then
      echo "[beads] ⚠ as branches \"$branch\" e \"$other\" viram o mesmo arquivo $file.yaml — renomeie uma delas." >&2
    fi
  done < <(
    {
      git for-each-ref --format='%(refname:lstrip=2)' refs/heads 2>/dev/null
      git for-each-ref --format='%(refname:lstrip=3)' refs/remotes 2>/dev/null
    } | sort -u
  )

  local node
  node=$(beads_node)
  if [ -z "$node" ]; then
    beads_loud "node não encontrado: formato, acréscimo só no fim e combinação dos beads staged NÃO foram validados." \
      "A regra de dono por branch (em bash) foi aplicada. Instale o node (>= 18)."
    return 0
  fi
  if [ "$merging" = 1 ]; then
    "$node" "$BEADS_AITEAM/scripts/beads-check.mjs" --staged --branch "$branch" --merge
  else
    "$node" "$BEADS_AITEAM/scripts/beads-check.mjs" --staged --branch "$branch"
  fi
}
