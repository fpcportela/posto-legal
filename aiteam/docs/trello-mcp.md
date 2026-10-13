# MCP do Trello (`trello-tools`)

> rb-ai-team#28 e #50. O servidor MCP que a skill [`/trello-review`](trello-review-adoption.md) usa
> deixou de ser uma cópia por projeto: ele vem com o `aiteam/`, a partir da união das quatro cópias que
> os consumidores tinham (mesa-crm, omni-chat, robo-pb-raspagem, vigacapital.com.br).

## O que é

Um servidor MCP por stdio, **do projeto** (sobe no repo, enxerga o `.env` da raiz do repo):
`aiteam/mcp/trello-server.ts`, com o código em `aiteam/mcp/trello/`. O `node aiteam/install.mjs` o
registra no `.mcp.json` e no `.cursor/mcp.json` como `trello-tools`:

```json
"trello-tools": { "command": "npx", "args": ["tsx", "aiteam/mcp/trello-server.ts"] }
```

O install **nunca sobrescreve** um `trello-tools` que o consumidor já registrou (o `mergeMcpServers` só
acrescenta o que falta): quem aponta para a cópia local dele continua apontando, até trocar (abaixo).

## As ferramentas

| Ferramenta | Tier | O que faz |
|---|---|---|
| `trello_list_boards` | 1 | os quadros abertos do usuário |
| `trello_list_lists` | 1 | as listas de um quadro |
| `trello_sync_list` | 1 | os cards de uma lista, com checklists, etiquetas e os prints (uploads) baixados para o cache |
| `trello_get_card` | 1 | um card, com os prints baixados |
| `trello_list_comments` | 1 | os comentários de um card, do mais novo ao mais antigo |
| `trello_comment_card` | 2 | comenta num card |
| `trello_move_card` | 2 | move um card de lista |
| `trello_create_card` | 2 | cria um card; `labels?` (nomes, sem diferenciar maiúsculas e acentos, ou ids) é resolvido **antes** de criar |
| `trello_add_label` | 2 | rotula um card que já existe; idempotente (pula a etiqueta que o card já tem, porque o Trello responde 400 ao repetir) |

Leitura é Tier 1, mutação é Tier 2, e **nenhuma é Tier 3** (o teste do `registry` o garante). Mutar o
quadro do time não tem desfazer pela API: o comentário não se apaga e a movida errada é conserto à mão, por
isso a skill pede a aprovação do texto antes de postar.

### Etiquetas (rb-ai-team#50)

O quadro costuma ser compartilhado por mais de um projeto, e a etiqueta é o que separa o card de cada um.
`trello_create_card` com `labels` resolve os nomes no quadro da lista (`GET /lists/{id}?fields=idBoard` e
`GET /boards/{id}/labels`) e manda os ids como `idLabels` no mesmo `POST /cards`:

- nome **desconhecido** falha listando as etiquetas do quadro e **não cria nada** — card sem a etiqueta
  pedida é exatamente o defeito;
- nome **ambíguo** (duas etiquetas com o mesmo nome) falha pedindo o id;
- sem `labels`, nada muda: um único `POST /cards`, sem consultar o quadro.

## Credenciais

`TRELLO_API_KEY` e `TRELLO_TOKEN` no `.env` **da raiz do repo** (a do git, não o diretório em que o
servidor subiu; as variáveis de ambiente ganham do arquivo). O servidor lê só as linhas `TRELLO_*` — o
resto do `.env` (banco, tokens de deploy, chaves de API) nunca entra no processo dele — e **uma vez, ao
subir**: depois de trocar a credencial, recarregue o agente. Chave em `https://trello.com/power-ups/admin`
(Power-Up, aba API Key); token com `scope=read,write` em `https://trello.com/1/authorize`.

**Sem credencial o servidor sobe** (um projeto que não usa o Trello também o recebe pelo install) e só a
chamada falha, com uma mensagem que diz o que pôr onde. Nenhuma mensagem de erro, log ou resposta carrega
a chave nem o token: a mensagem de um erro de rede, que pode citar a URL com a query, é reescrita sem eles.

## O que a rede e o disco enxergam

O modelo de segurança em uma lista — cada item tem teste com fetch falso, e **nenhum teste usa rede real**:

- **Rede só para o Trello.** A API é `https://api.trello.com/1`, sempre (a URL nunca é montada a partir de
  dado do card), com redirect manual.
- **A credencial OAuth do download só vai para o `api.trello.com`, e só para o endpoint de download de
  anexo** (`/1/cards/<id>/attachments/<id>/download/<arquivo>`): o card não consegue apontar uma requisição
  autenticada para outro endpoint da API (um `/1/members/me`, um token). O nome do arquivo (último
  segmento) só aceita caracteres não reservados ou percent-encoding que **não** seja de `/`, `\` nem `.`
  (`%2F`, `%5C`, `%2E`, em qualquer caixa, são recusados: um parser ou servidor que decodifica antes de rotear
  leria `../` e sairia do endpoint, e isso é diferença entre parsers), e o alvo credenciado não leva query
  nem fragmento. A URL de um anexo vem do card, e
  quem tem acesso ao quadro escolhe esse valor. Por isso: só `https`, sem credencial embutida nem porta; o
  `trello.com/1/…` de um upload é reescrito para o `api.trello.com`; o armazenamento do Trello
  (`trello-attachments.s3.amazonaws.com`, `*.trellousercontent.com`) é baixado **sem** credencial; qualquer
  outro host é recusado antes de a requisição existir. **Anexo que é link externo** (`isUpload` diferente de
  `true`) não é baixado — nem sem credencial, para o computador do dev não fazer requisição para onde o
  card mandar — e sai em `errors` do resultado. Um redirect é conferido de novo a cada salto (no máximo 3),
  e o header não acompanha o salto para o armazenamento.
- **Escrita só no cache.** O destino dos prints **não é entrada do modelo** (as ferramentas não têm
  `cacheRoot`; o que o modelo mandar o `zod` descarta). Lista, card e nome do anexo viram só o nome-base (os nomes reservados do Windows —
  `CON`, `NUL`, `COM1`… — ganham um `_` na frente), e o caminho final é conferido com `path.relative` contra a
  pasta do cache. **Link simbólico ou junction dentro do cache não é seguido**: cada nível da pasta é criado
  um a um com `lstat`, e o `realpath` do destino é conferido de novo.
- **O tipo do arquivo é o do conteúdo.** Só é gravado o que, pelos primeiros bytes, é png, jpeg, gif, webp,
  bmp, tiff ou heic — mesmo com `mimeType` e nome de imagem; a extensão gravada é a do conteúdo. SVG fica de
  fora (XML que carrega script). Teto de 25 MB por anexo — o download é lido em stream e **cortado** no teto, com ou sem
  `Content-Length` (um que mente não ajuda) —, 20 MB declarados por resposta JSON, e por
  `trello_sync_list` 200 downloads e 250 MB no total (o que passar do teto segue no manifesto sem print, e
  `errors` manda usar o `trello_get_card`).
- **Texto do card é dado.** Título, descrição e comentários voltam para o modelo como resultado de
  ferramenta: são conteúdo a mostrar, nunca instrução (a regra está no `PROCEDURE.md` do `/trello-review`).
  As URLs de imagem escritas na descrição (`extractDescImageUrls`) não são baixadas por nada.

## O cache dos prints

`<raiz do repo>/.trello-cache/<lista>/<card>/NN-<nome>.<ext>`. **Fora do git:** são telas internas do
produto e dados de cliente do time, e o histórico do git não esquece. O `install.mjs` acrescenta
`.trello-cache/` ao `.gitignore` da raiz (sem duplicar quando já está ignorada de outro jeito). Para
limpar, apague a pasta: a próxima `trello_sync_list` baixa de novo.

## Trocar a cópia local pelo MCP do framework (consumidor)

Quem tem o MCP em `.mcp/trello/` (mesa-crm, robo, vigacapital) troca quando for conveniente; o omni-chat,
que já o tinha em `aiteam/mcp/` e apontava para o mesmo caminho, só recebe os arquivos novos no sync.

1. Traga o `aiteam/` com este commit (o sync) e rode `node aiteam/install.mjs`.
2. No `.mcp.json`, o `args` do `trello-tools` passa de `["tsx", ".mcp/trello-server.ts"]` para
   `["tsx", "aiteam/mcp/trello-server.ts"]`. O resto do registro pode ficar. O install **não** faz isso por
   você, de propósito.
3. Antes de apagar a cópia, `git diff --no-index .mcp/trello aiteam/mcp/trello` mostra o que ela tem que o
   framework não tem. Esperado: o mesa-crm não tem nada a mais (é a base); as demais não têm as etiquetas.
4. Recarregue o agente (`/mcp`) e confira o servidor de pé e as nove ferramentas.
5. Apague a cópia: `git rm -r .mcp/trello .mcp/trello-server.ts` (e o que mais de `.mcp/` for só dela).
6. `git ls-files .trello-cache`: se listar algo (o robo versionava a pasta), `git rm -r --cached
   .trello-cache` — o install já pôs a regra no `.gitignore`.

O checklist do PR de sync avisa os dois pontos (o `trello-tools` que aponta para fora do `aiteam/`, e a
cópia em `.mcp/`) enquanto eles existirem; quem nunca teve o MCP não recebe nenhum item.

**A cópia local tem os defeitos que o framework corrige** (por isso a troca vale mais que o
conforto): o download de anexo manda a credencial OAuth para o host que o card escolher; o `cacheRoot` é
entrada do modelo e o nome do arquivo vem do Trello (escrita fora do cache); o `.env` da raiz inteiro vai
para o processo do servidor. Estão nas quatro cópias.

## Limites conhecidos

- A API do Trello recebe os parâmetros na query (é o jeito documentado de autenticar), então um comentário
  de milhares de caracteres vai na URL — o teto de 16 KB do texto cabe, mas não há como arquivar card nem
  apagar comentário. Se isso doer, o próximo passo é uma ferramenta nova (`trello_archive_card`).
- O download do anexo `trello.com/1/…` pelo `api.trello.com` segue a API documentada do Trello; não foi
  conferido contra o Trello de verdade (os testes nunca usam rede). Se um upload deixar de baixar, o
  `errors` do resultado diz o motivo.

## Testes

`npm --prefix aiteam test -- mcp/trello` (e `mcp/trello-server.test.ts`, que sobe o servidor num
subprocesso e fala MCP por stdio). Todos com fetch falso: nenhum toca a rede, e o do servidor roda sem
credencial de propósito.
