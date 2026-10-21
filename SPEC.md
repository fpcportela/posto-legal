---
# SPEC.md frontmatter — budget_usd é lido pelo circuit-breaker; tier_defaults pelo
# tier-guard; infra_kb pelos hooks de infra; ci pelo aiteam/src/ci-contract.test.ts
# e pelo doctor; deploy pelo aiteam/src/deploy-contract.test.ts e pelo doctor.
project: "posto-legal"
version: "0.1.0"
budget_usd: 2.00          # limite por sessão (sobrepõe AI_SESSION_BUDGET_USD)
tier_defaults:
  allow_tier1: true
  allow_tier2: true
  allow_tier3: false       # exige aprovação humana explícita
infra_kb:                  # vazio: o projeto não roda em host compartilhado
  remote: ""
  url: ""
  ref: "main"
  entry: "README.md"
ci:                        # o que o CI de PR roda (aiteam/AGENTS.md §CI/CD Mandate, item 1)
  workdir: .
  test: npm test
deploy:
  workflow: none
  reason: "hoje o GitHub Pages (build legado) publica a main sozinho em fpcportela.github.io/posto-legal; o deploy.yml versionado entra na migração para a Hostinger (§7)"
last_updated: "2026-10-21"
---

# Especificação do Projeto — Posto Legal

> **AGENTES:** leiam este arquivo antes de qualquer implementação. Ele é a fonte da verdade.
> Se o contexto da conversa conflitar com o SPEC.md, vale o SPEC.md.
> O `README.md` descreve o comportamento atual do protótipo em detalhe; este arquivo diz o que construir e com quais regras.

## 1. Visão Geral

Posto Legal é um app para motoristas registrarem abastecimentos, acompanharem o consumo (km/l) de cada veículo e avaliarem postos numa rede compartilhada: cada avaliação vem de quem rodou com o combustível daquele posto. O problema que resolve é saber, antes de abastecer, se o combustível de um posto rende bem e se o atendimento é confiável. Hoje existe um protótipo web completo (arquivo único `prototipo/index.html`) com banco online no Supabase. O primeiro lançamento é para um **grupo fechado de teste** (dezenas de usuários), para validar o fluxo antes de abrir ao público.

Nas próximas semanas o trabalho segue **em paralelo**: amadurecer a versão web para esse grupo de teste e começar o app nativo em React Native (Expo), neste mesmo repositório.

## 2. Arquitetura

- **Frontend web:** `prototipo/index.html` — HTML/CSS/JS sem build, Leaflet 1.9.4 (cdnjs) com fundo do OpenStreetMap (tile.openstreetmap.org, escurecido por CSS), busca de endereço pelo Photon (OSM). O `index.html` da raiz só redireciona para `prototipo/`. Roda em modo local (localStorage) quando `SUPABASE_URL`/`SUPABASE_KEY` estão vazios.
- **Regras de negócio:** serão extraídas para um módulo JS puro (ex.: `prototipo/regras.js`) importado pelo protótipo e pelos testes — e, depois, pelo app Expo. Ver §4.
- **App nativo (a começar):** React Native com Expo, numa pasta própria deste repo (ex.: `app/`). `expo-location` + `expo-task-manager` (geofence) e `expo-notifications`.
- **Backend:** Supabase — Postgres com RLS, Supabase Auth **por telefone** (código no WhatsApp via `signInWithOtp`/`verifyOtp`; sem senha). O envio sai pelo provedor Phone do Supabase (Twilio) ou por um Send SMS Hook numa Edge Function com a Cloud API da Meta.
- **Banco:** `supabase/schema.sql` é a fonte do schema. Mudança de schema = editar esse arquivo de forma idempotente (`if not exists`, `create or replace`).
- **Mensageria:** WhatsApp Business Cloud API (Meta), modelo da categoria *Autenticação*. Hoje simulado.
- **Dados de postos:** base de revendedores da **ANP** (dados abertos), complementada pelo cadastro dos usuários.
- **Infraestrutura:** hoje GitHub Pages; no futuro, **Hostinger** (§7).
- **Testes:** Vitest sobre o módulo de regras, rodando em PR pelo GitHub Actions.

## 3. Modelo de Domínio

Tabelas do Supabase (`supabase/schema.sql`), todas com RLS:

- **profiles** — 1:1 com `auth.users`: nome, WhatsApp (11 dígitos, único — é o login), `status` (`pendente`/`confirmado`), `lgpd_em` (data do aceite), `is_admin`. Cada usuário lê/escreve só o próprio; admin lê todos.
- **postos** — nome, bandeira, cidade, UF, endereço, `lat`/`lng`, `criado_por`. Leitura pública. Posto sem coordenadas não aparece no mapa.
- **garagem** — 1 por usuário, `dados` jsonb: veículos (com combustível usual) e configuração (alertas de reputação, GPS). Privado.
- **abastecimentos** — por usuário e veículo: km, combustível, preço, total, litros, tanque cheio, posto, `km_l`, data. Privado.
- **avaliacoes** — por usuário e posto: nota, comentário, combustível, preço, modelo do carro, km/l. Leitura pública; cada usuário escreve só as próprias.
- **eventos** — telemetria de uso (tipo, tela, dados jsonb, sessão); visão `uso_por_dia` para o administrador.

Regras de domínio (invariantes — não mudar sem decisão humana):

- **Média (tanque cheio):** km/l = (km atual − km anterior) ÷ litros do abastecimento atual, só quando os **dois** abastecimentos completaram o tanque. A média é atribuída ao posto **anterior**.
- **Avaliação:** o posto é avaliado no abastecimento **seguinte** do mesmo veículo. No primeiro abastecimento de um veículo não há avaliação; a partir do segundo, a nota é obrigatória.
- **Cadastro:** obrigatório, só com nome e celular com WhatsApp (DDD + celular, 11 dígitos, um por conta), confirmado por código de 6 dígitos no WhatsApp (5 tentativas) antes de liberar abas, mapa e GPS. Não há CPF, e-mail nem senha. Trocar o WhatsApp exige nova confirmação.
- **Login:** celular + código de 6 dígitos no WhatsApp, sem senha.
- **Aviso por GPS:** parado ~30 s (web) / ~2 min (app) a até 150 m de um posto pergunta "Vai abastecer no <posto>?"; "Agora não" silencia o posto por 30 min.

## 4. Escopo

### Dentro do escopo
- [ ] **Suíte de testes:** extrair as regras puras do `prototipo/index.html` (média km/l, regra da avaliação, validação do celular/WhatsApp, cor do marcador por reputação) para um módulo JS; `package.json` na raiz com Vitest; `npm test` rodando em PR via `.github/workflows/ci.yml`.
- [ ] **Web pronto para o grupo de teste:** Supabase em uso real, administrador, eventos de uso.
- [ ] **WhatsApp real:** ligar o provedor Phone do Supabase Auth (que gera e confere o código) com envio pelo WhatsApp — Twilio ou Send SMS Hook numa Edge Function com a Cloud API da Meta. O código nunca chega ao aparelho pelo banco.
- [ ] **Base de postos da ANP:** importar revendedores (CNPJ, bandeira, endereço) para `postos`, com geocodificação quando faltar coordenada; deduplicar com os postos cadastrados por usuários.
- [ ] **App Expo:** mesmo modelo de dados e regras (reusando o módulo de regras), mapa, abastecimentos, avaliações e aviso por geofence com notificação local ("Vou abastecer" / "Agora não"). No iOS, só os ~20 postos mais próximos ficam monitorados, atualizados conforme o carro anda.
- [ ] **LGPD:** exclusão de conta pelo próprio usuário (apaga perfil, garagem, abastecimentos; avaliações anonimizadas ou apagadas — ver §7).

### Fora do escopo
- Monetização, anúncios, planos pagos e parcerias com postos — o foco agora é validar o uso.
- Preços automáticos (scraping, APIs de preço, levantamento semanal da ANP como preço do posto) — o preço vem só do que o usuário informa no abastecimento.

## 5. Contratos

Não há API própria: o cliente fala direto com o Supabase (PostgREST + Auth) sob RLS. Os contratos são:

- **Schema e políticas:** `supabase/schema.sql`. Toda tabela nova tem RLS ligado e política explícita.
- **Funções SQL expostas:** `is_admin()`, `whats_em_uso(p_whats text) → boolean`.
- **Edge Functions (a criar):** Send SMS Hook do Supabase Auth para enviar o código pela Cloud API da Meta, se essa for a opção escolhida (ver §7).
- **Módulo de regras (a criar):** funções puras, sem DOM, sem rede, sem `localStorage`, usadas pelo web, pelo app e pelos testes.

## 6. Requisitos Não-Funcionais

- **LGPD estrita:**
  - O WhatsApp **nunca** vai para `eventos`, logs, mensagens de erro ou ferramentas de terceiros.
  - Aceite LGPD registrado (`profiles.lgpd_em`) antes de qualquer dado pessoal ser gravado.
  - O usuário pode excluir a própria conta e os dados dela.
  - Coletar só o necessário: a conta tem nome e WhatsApp, sem CPF nem e-mail.
- **Custo zero no início:** só serviços com plano gratuito até validar com o grupo de teste (Supabase free, GitHub Pages/Actions, Photon, Leaflet/tiles do OSM, dados abertos da ANP e do IBGE). Qualquer serviço pago (Google Places, SMS, hospedagem paga) precisa de decisão humana antes. A Cloud API do WhatsApp cobra por conversa de autenticação: registrar a estimativa antes de ligar.
- **Segurança:**
  - Chave do Supabase no cliente é só a `anon`; a `service_role` nunca entra no repositório nem no front.
  - Segredos (Meta, service_role) ficam nos secrets do Supabase/GitHub.
  - O código de verificação é gerado e conferido pelo servidor (Supabase Auth) no modo online; o código na tela é só do modo protótipo.
- **Desempenho:** o mapa deve continuar fluido com a base da ANP carregada — buscar postos por área visível, não a base inteira.
- **Observabilidade:** eventos de uso em `eventos`, painel "Uso do app" para o administrador.

## 7. Decisões em Aberto

> Agentes **não** implementam estas áreas sem decisão humana.

- [ ] **Envio do código pelo WhatsApp no Supabase Auth:** Twilio (pago, por mensagem) ou Send SMS Hook + Cloud API da Meta (pago por conversa de autenticação). Sem um deles, o modo online não envia o código.
- [ ] **Troca de número no modo online:** hoje bloqueada; exigiria `updateUser({phone})` + confirmação do novo número.

- [ ] **Migração para a Hostinger:** qual produto (hospedagem compartilhada, VPS), como o deploy chega lá, onde fica o endpoint de versão. Quando decidido: `.github/workflows/deploy.yml` a partir de `aiteam/templates/deploy.yml.example` e bloco `deploy:` com `workflow: deploy.yml` e `version_url`.
- [ ] **GitHub Pages publica a `main` direto:** enquanto não houver deploy.yml, todo merge na `main` vai ao ar sem gate. Decidir se o Pages passa a publicar de outra branch (ex.: `gh-pages`) ou por workflow com disparo manual.
- [ ] **Avaliações ao excluir a conta:** apagar ou anonimizar (elas alimentam a nota pública do posto).
- [ ] **Estrutura do monorepo:** nome da pasta do app Expo e como o módulo de regras é compartilhado entre web e app (caminho relativo, pacote de workspace).
- [ ] **Geocodificação dos postos da ANP:** Photon/Nominatim respeitando os limites de uso, ou outra fonte gratuita.

## 8. Ferramentas de Observabilidade

- **Bead Board** do framework: `python3 aiteam/tools/bead_board/server.py` e abra http://localhost:8080/.
- **Uso do app:** visão `uso_por_dia` e cartão "Uso do app" em Minha conta (só administrador).

## 9. CI/CD

> Mandato: `aiteam/AGENTS.md` §CI/CD Mandate.

- [ ] Pipeline em PR, bloqueante, rodando `npm test` na raiz (`.github/workflows/ci.yml`, modelo `aiteam/templates/ci.yml.example`): `<a criar junto com a suíte de testes>`
- [ ] Deploy de produção só via `.github/workflows/deploy.yml` a partir da `main` — hoje `workflow: none` (GitHub Pages legado), ver §7
- [ ] Gate humano: comando de disparo do deploy registrado em `ask_patterns` (`.claude/tier-rules.json`): `<na migração para a Hostinger>`
- [ ] Secrets exclusivamente no secret store do CI/Supabase
- [ ] Preview/staging antes de produção: `<a definir>`
- [ ] Rollback documentado: hoje = reverter o commit na `main` (o Pages republica)
- [ ] Health check pós-deploy: `https://fpcportela.github.io/posto-legal/` responde 200

## 10. Change Log

| Data | Mudança | Autor |
|------|---------|-------|
| 2026-10-08 | SPEC inicial, na adoção do rb-ai-team (entrevista) | Fabio Portela Carvalho |
| 2026-10-21 | Conta só com celular/WhatsApp: sai CPF, e-mail e senha; login = celular + código no WhatsApp | Fabio Portela Carvalho |
