# POSTO LEGAL

App para motoristas registrarem abastecimentos, acompanharem a média de km/l e avaliarem postos numa rede compartilhada.

## Protótipo (navegador)

- Arquivo: `prototipo/index.html`
- Publicado em: https://claude.ai/artifact/W2fjPF3TGaFpwnze3xso7s

O protótipo tem todo o fluxo. O mapa e o GPS funcionam no navegador (melhor abrindo o arquivo direto, já que a página publicada bloqueia a localização e as imagens do mapa).

### Mapa (aba Mapa)
- Mapa Leaflet com fundo CARTO/OpenStreetMap. Cada posto com localização vira um marcador com a nota (★) e o preço do combustível escolhido.
- Veículo e combustível no topo: o combustível começa pelo "combustível usual" do veículo e pode ser trocado. Opção "só postos com preço deste combustível".
- Cor do marcador segue os limites de "Alertas de reputação" da Garagem: verde (ótimo), amarelo (regular ou poucas avaliações), vermelho (péssimo), cinza (sem nota).
- Tocar no posto abre um painel com nota, preço do combustível do veículo, rendimento relatado com esse combustível, resumo de elogios e reclamações, e os botões "Abastecer aqui" e "Todas as avaliações".
- No cadastro de posto, o campo **Endereço** busca enquanto você digita (Photon, base do OpenStreetMap, gratuito e sem chave; prioriza a cidade escolhida e a sua posição). Escolher uma sugestão preenche endereço, cidade, UF e localização; se for um posto (⛽), também nome e bandeira. Para produção com muitos usuários, trocar por Google Places ou um servidor Photon próprio.
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

### Regra da avaliação
O posto é avaliado (estrelas + comentário) sempre no abastecimento **seguinte** do mesmo veículo, depois de rodar com o combustível dele. No primeiro abastecimento de um veículo não há avaliação. A nota é obrigatória a partir do segundo.

## Próxima etapa: app de celular

- React Native (Expo), para Android e iPhone.
- Localização em segundo plano com geofence: avisa quando o carro fica parado alguns minutos dentro do raio de um posto, por notificação local com ações "Vou abastecer" / "Agora não" (mesma regra do protótipo, com tempo parado de uns 2 min). Bibliotecas: `expo-location` + `expo-task-manager` (geofencing) e `expo-notifications`. No iOS o limite é de 20 regiões monitoradas, então o app registra só os postos mais próximos e atualiza a lista conforme o carro anda.
- Mapa e lista de postos: Google Places API ou base de revendedores da ANP.
- Backend: Supabase (Postgres + login + regras de acesso), com o mesmo modelo de dados acima.
- Notificação ao chegar: nota do posto e resumo de elogios e reclamações.
