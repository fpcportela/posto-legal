# POSTO LEGAL

App para motoristas registrarem abastecimentos, acompanharem a média de km/l e avaliarem postos numa rede compartilhada.

## Protótipo (navegador)

- Arquivos: `prototipo/index.html` e `prototipo/regras.js` (as regras de negócio, carregadas pelo `index.html`; os dois vão juntos para onde o protótipo for publicado — no artifact do claude.ai, o `regras.js` entra como arquivo de apoio).
- Publicado em: https://claude.ai/artifact/W2fjPF3TGaFpwnze3xso7s

O protótipo tem todo o fluxo. O mapa e o GPS funcionam no navegador (melhor abrindo o arquivo direto, já que a página publicada bloqueia a localização e as imagens do mapa).

### Mapa (aba Mapa)
- Mapa Leaflet com fundo do OpenStreetMap (tiles padrão escurecidos por filtro CSS; o CARTO passou a exigir chave em 2026). Cada posto com localização vira um marcador com a nota (★) e o preço do combustível escolhido.
- O fundo é escolhido em `MAPA_FUNDO`, no script do `index.html`: `"osm"` (padrão, só para testes — a política de uso do OpenStreetMap não aceita o tráfego de um app) ou `"stadia"` (Stadia Maps, fundo escuro pronto; crie a conta grátis e cadastre lá o domínio do site).
- O Leaflet só é baixado quando o mapa é aberto (ou com o navegador ocioso, depois que o app abriu). Os marcadores são reaproveitados entre um desenho e outro: mover o mapa só cria os que entraram na área visível e remove os que saíram.
- Veículo e combustível no topo: o combustível começa pelo "combustível usual" do veículo e pode ser trocado. Opção "só postos com preço deste combustível".
- Cor do marcador segue os limites de "Alertas de reputação" da Garagem: verde (ótimo), amarelo (regular ou poucas avaliações), vermelho (péssimo), cinza (sem nota).
- Tocar no posto abre um painel com nota, preço do combustível do veículo, rendimento relatado com esse combustível, resumo de elogios e reclamações, e os botões "Abastecer aqui" e "Todas as avaliações".
- No cadastro de posto, o campo **Endereço** busca enquanto você digita (Photon, base do OpenStreetMap, gratuito e sem chave; prioriza a cidade escolhida e a sua posição). Escolher uma sugestão preenche endereço, cidade, UF e localização; se for um posto (⛽), também nome e bandeira. Para produção com muitos usuários, trocar por Google Places ou um servidor Photon próprio.
- **Renomear** (no painel do posto e em "Todas as avaliações"): cada usuário pode dar ao posto o nome que quiser (o nome fantasia da fachada, até 60 caracteres). Esse nome é só dele: fica na garagem do usuário (`garagem.apelidos[postoId]`) e não muda nada para os outros, que continuam vendo a razão social. O app mostra o nome escolhido e, abaixo, "Razão social: …". Deixar em branco volta para a razão social.
- **Suspeita de fraude**: no abastecimento, o botão "Suspeita de fraude" abre uma janela com o tipo (bomba marcou litros a mais, combustível adulterado, cobrança diferente da bomba, preço diferente do anunciado, outro) e a descrição (10 a 500 caracteres). A suspeita é registrada no posto atual ao salvar o abastecimento. Posto com suspeita mostra o selo "⚠ N suspeitas" (lista, ranking, painel do posto, tela de abastecer, aviso do GPS) e uma bolinha vermelha no marcador do mapa; tocar no selo abre todos os relatos (primeiro nome e data, "não verificados"). Tabela `suspeitas` no Supabase: todos leem, cada um grava/apaga o seu, o administrador apaga abusos.
- Tocar num ponto vazio permite cadastrar um posto com aquela localização. O formulário de novo posto também tem "Usar minha localização". Postos sem `lat`/`lng` não aparecem no mapa.

### Aviso de chegada por GPS
- Ligado na aba Mapa ("Perguntar se vou abastecer…"), fica salvo em `garagem.config.gps`.
- Quando o aparelho fica 30 s parado (velocidade até 3 m/s) a até 150 m de um posto, abre a pergunta "Vai abastecer no <posto>?" com nota, preço do combustível do veículo e um elogio e uma reclamação de destaque. "Sim" abre o abastecimento com posto, veículo e combustível preenchidos; "Agora não" silencia aquele posto por 30 min.
- No protótipo só funciona com a página aberta. Para testar parado, use "Simular chegada" no painel do posto.

### Dados
- `postos/<id>`: posto (nome, bandeira, cidade, uf, endereço, lat, lng). Público. A cidade é escolhida de uma lista dos 5.571 municípios do IBGE embutida no arquivo (busca sem acento; escolher a cidade preenche o estado). Postos antigos podem ter "Cidade / UF" juntos no campo `cidade`.
- `avaliacoes/<usuario>`: `{itens:[...]}` com nota, comentário, combustível, preço, modelo do carro e km/l. Leitura pública, cada usuário escreve só o próprio documento.
- `data/users/<usuario>/garagem`: veículos e configuração dos alertas. Privado.
- `data/users/<usuario>/ab-*`: abastecimentos (km, litros, total, média). Privado.

- `cadastros/<usuario>`: nome, CPF, e-mail, WhatsApp, status (`pendente`/`confirmado`), data do aceite LGPD. Cada usuário lê e escreve só o próprio; o dono do app lê todos (tabela "Usuários cadastrados" na Garagem).

### Cadastro e confirmação
O cadastro é obrigatório: o app só libera as abas, o mapa e o aviso por GPS depois que a conta é confirmada. Depois disso, o botão com o primeiro nome no topo abre **Minha conta** (dados com CPF mascarado, "Alterar dados", totais de veículos, abastecimentos e avaliações e, no modo local, "Sair da conta" com confirmação). CPF validado pelos dígitos verificadores; WhatsApp exige DDD + celular (11 dígitos). Código de 6 dígitos, 5 tentativas, reenviar e corrigir número. Trocar o WhatsApp exige nova confirmação.

### Login (modo local)
- Entrar com **CPF ou e-mail + senha** e, em seguida, o **código de 6 dígitos no WhatsApp** (dois passos em todo login).
- Senha: mínimo de 8 caracteres com letras e números. 5 senhas erradas bloqueiam a conta por 5 minutos.
- **Esqueci minha senha**: CPF ou e-mail → código no WhatsApp → nova senha → entra.
- Minha conta tem **Alterar senha** (pede a senha atual) e **Sair da conta**.
- Cada conta do aparelho tem seus próprios veículos e abastecimentos (`posto-legal-v1-u-<id>`). Postos e avaliações são compartilhados entre as contas, simulando a rede. Contas em `posto-legal-v1-contas`, sessão em `posto-legal-v1-sessao`.
- A senha é guardada só como hash (SHA-256 com sal, 3.000 rodadas). Isso é só para o protótipo: no app real, quem cuida da senha é o servidor (Supabase Auth), e o código do WhatsApp é gerado e conferido lá.
- Os dados da versão sem login (veículos e abastecimentos de quem já tinha saído) passam para a primeira conta criada no aparelho.

**No protótipo o envio pelo WhatsApp é simulado** (o código aparece na tela). No app real:
- Backend (ex.: Supabase Edge Function) gera o código, guarda só o hash com validade de 10 min e envia pela **WhatsApp Business Cloud API (Meta)** com um modelo de mensagem da categoria *Autenticação* (precisa de conta Business verificada e número próprio).
- O código nunca vai para o aparelho do usuário pelo banco; a verificação acontece no servidor.
- CPF único por conta (índice único no banco) e limite de envios por número/IP.

### Regra da média
É o método do tanque cheio: km/l = (km atual − km anterior) ÷ litros do abastecimento atual. Só vale quando o tanque foi completado nos dois abastecimentos. A média é atribuída ao posto **anterior**, porque foi o combustível dele que rodou esses km.

No Histórico e nos "Últimos abastecimentos" do Painel, tocar num abastecimento abre a edição (data, km, combustível, valor do litro, litros, total, tanque cheio). Data e km precisam ficar entre o abastecimento anterior e o seguinte do mesmo veículo; ao salvar, a média deste e a do seguinte são recalculadas, assim como o km/l e o preço enviados à rede.

### Regra da avaliação
O posto é avaliado (estrelas + comentário) sempre no abastecimento **seguinte** do mesmo veículo, depois de rodar com o combustível dele. No primeiro abastecimento de um veículo não há avaliação. A nota é obrigatória a partir do segundo.

## Instalar no celular (PWA)

- Publicado no GitHub Pages, o protótipo pode ser instalado como app: no Android (Chrome), menu ⋮ → "Instalar app"; no iPhone (Safari), Compartilhar → "Adicionar à Tela de Início". Abre em tela cheia, com ícone próprio.
- Arquivos: `prototipo/manifest.webmanifest`, `prototipo/sw.js` (service worker), `prototipo/icone.svg` e `prototipo/icones/`.
- O service worker busca sempre a versão publicada e, sem internet, abre com a última cópia guardada. Supabase, mapa e fontes não passam por ele. Ao mudar a lista de arquivos guardados, troque `VERSAO` no `sw.js`.
- Limite: o aviso por GPS só funciona com o app aberto (no app Expo ele funcionará em segundo plano).

## Regras e testes

- As regras de negócio ficam em `prototipo/regras.js`, sem tela, rede nem armazenamento: média pelo tanque cheio, avaliação no abastecimento seguinte, nota em meias estrelas, CPF, WhatsApp, senha, cor do marcador, estatística do posto, distância e a montagem da rede a partir do banco. No navegador elas ficam em `window.Regras`; no Node (testes e, depois, o app Expo), vêm por `require`.
- Testes: `npm install` e depois `npm test` (Vitest, em `testes/`). O GitHub Actions roda os testes em todo PR e push na `main` (`.github/workflows/ci.yml`).

## Desempenho

- A nota, os preços e o rendimento de cada posto vêm de um índice das avaliações agrupadas por posto, refeito só quando os dados mudam. Por isso `S.pub`, `S.mine` e `S.susp` nunca são alterados no lugar: cada mudança troca o objeto inteiro.
- Cada aba é desenhada só quando está à vista; as outras são desenhadas ao serem abertas.
- A busca de postos espera 200 ms depois da última tecla. O aviso por GPS olha só os postos a até 2 km (lista refeita a cada 500 m andados).

## Próxima etapa: app de celular

- React Native (Expo), para Android e iPhone.
- Localização em segundo plano com geofence: avisa quando o carro fica parado alguns minutos dentro do raio de um posto, por notificação local com ações "Vou abastecer" / "Agora não" (mesma regra do protótipo, com tempo parado de uns 2 min). Bibliotecas: `expo-location` + `expo-task-manager` (geofencing) e `expo-notifications`. No iOS o limite é de 20 regiões monitoradas, então o app registra só os postos mais próximos e atualiza a lista conforme o carro anda.
- Mapa e lista de postos: Google Places API ou base de revendedores da ANP.
- Backend: Supabase (Postgres + login + regras de acesso), com o mesmo modelo de dados acima.
- Notificação ao chegar: nota do posto e resumo de elogios e reclamações.

## Banco online (Supabase)

Com `SUPABASE_URL` e `SUPABASE_KEY` preenchidos no topo do script de `prototipo/index.html`, o app passa a usar o banco online; vazios, roda no modo local.

- Script do banco: `supabase/schema.sql` (tabelas `profiles`, `postos`, `garagem`, `abastecimentos`, `avaliacoes`, `suspeitas`, `eventos`, `apagados`, `uso_diario` e a visão `uso_por_dia`, com regras de acesso RLS). Pode ser rodado de novo a qualquer momento; depois de atualizar o protótipo, rode-o de novo no SQL Editor.
- Sincronização: a rede (postos, avaliações, suspeitas) vem inteira no login e, depois, a cada minuto, só o que mudou (`atualizado_em`, preenchido por gatilho, e a tabela `apagados`, que guarda só o id do que foi apagado). A tela só é redesenhada quando algo mudou. Num banco sem essa parte do script, o app continua baixando tudo, como antes.
- Todas as leituras de tabela vêm em páginas de 1.000 linhas (o limite por pedido do Supabase); antes, o que passasse disso sumia sem aviso.
- O cartão "Uso do app" usa a função `uso_resumo(dias)`, calculada no banco (só para administradores).
- Manutenção diária (`manutencao()`, agendada pelo pg_cron às 3h15): eventos com mais de 90 dias viram uma linha por dia e tipo em `uso_diario` e saem de `eventos`; registros de `apagados` com mais de 30 dias saem também. Sem a extensão pg_cron, rode `select public.manutencao();` de vez em quando.
- Login pelo Supabase Auth (e-mail + senha; o CPF é convertido no e-mail da conta pela função `email_do_login`). Depois da senha continua o código do WhatsApp (ainda simulado).
- "Esqueci minha senha" no modo online manda um **link por e-mail** (o código do WhatsApp para recuperar senha precisa de servidor próprio).
- Eventos de uso gravados em `eventos`: abriu o app, telas, cadastro, login/saída, posto cadastrado, abastecimento, mapa, GPS, busca de endereço.
- Administrador: `update public.profiles set is_admin = true where email = '...';` no SQL Editor. O administrador vê em Minha conta o cartão "Uso do app" e, na Garagem, a tabela de usuários.
- Configuração do Auth: desligar "Confirm email" (Authentication → Sign In / Providers → Email) e colocar o endereço do app em Authentication → URL Configuration (Site URL e Redirect URLs).
