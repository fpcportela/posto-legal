# **SETUP & ARCHITECTURE: Agent-First Web Platform Development**

Este documento estabelece as diretrizes de arquitetura, segurança, orquestração e orçamentação para o desenvolvimento de plataformas web utilizando inteligência artificial autônoma. Qualquer agente de IA operando neste repositório deve ler e aderir estritamente a estas regras antes de iniciar o ciclo de desenvolvimento.

## **1\. Filosofia de Desenvolvimento e Paradigma**

A integração de modelos avançados de linguagem no ciclo de vida de desenvolvimento de software transitou da engenharia de prompts exploratória para uma metodologia arquitetural disciplinada conhecida como Spec-Driven Development (SDD).

* A especificação deixa de ser um artefato passivo de documentação e passa a ser um contrato executável que governa o comportamento, a arquitetura e a saída dos agentes autônomos.  
* O foco principal do humano passa da digitação da sintaxe para a supervisão rigorosa das implementações geradas pela IA, orquestração de prompts e arquitetura de sistemas de alto nível.

## **2\. Estrutura de Diretórios e Infraestrutura Base**

Para garantir que o ambiente de desenvolvimento seja reproduzível e isolado, utilizamos a arquitetura de **DevContainers**. O isolamento em contêineres é mandatório, pois a execução de código arbitrário por agentes introduz vetores de ataque massivos que invalidam as premissas tradicionais de segurança de aplicações.

A estrutura do repositório base (Boilerplate) deve seguir este padrão:

* aiteam/.devcontainer/: Contém a infraestrutura de isolamento (Node.js, dependências CLI globais).  
* aiteam/mcp/: Configurações do Model Context Protocol para conexões externas (Hostinger, AWS, GCP).  
* CLAUDE.md: Arquivo markdown lido pelo agente no início de cada sessão para definir padrões de código, decisões de arquitetura e bibliotecas preferidas.  
* SPEC.md: A fonte da verdade para o escopo do projeto, evitando o desvio arquitetural e a degradação de contexto.

## **3\. Arquitetura de Memória e Mitigação de Contexto**

Um dos desafios mais destrutivos na engenharia de software autônoma é a degradação do contexto do agente (Context Rot). À medida que a janela de contexto se enche de conversas tangenciais e experimentos falhos, o agente perde o foco nos requisitos originais.

* Estudos empíricos indicam que a perda severa de precisão começa quando um agente atinge aproximadamente 70% da capacidade total de sua janela de contexto.  
* **Memória Apoiada pelo Git:** Para resolver a amnésia associada à troca de ramificações (branches), a memória do agente deve ser persistente e estruturada, substituindo texto não estruturado por gráficos de tarefas armazenados diretamente no repositório de software (ex: diretório .beads/).

## **4\. Integração de Ferramentas e Model Context Protocol (MCP)**

Agentes necessitam de acesso programático e seguro a dados dinâmicos e capacidades de execução.

* O Model Context Protocol (MCP) opera como uma conexão baseada em API aberta e padronizada que permite que os agentes interajam com bancos de dados externos, software corporativo e interfaces de linha de comando em tempo real.  
* **Design de Schemas:** As ferramentas (Tools) do MCP devem usar bibliotecas de validação rigorosas (como JSON Schema ou Zod) para tipagem estrita de parâmetros. Isso previne chamadas inválidas e alucinações de argumentos.

## **5\. Governança, Segurança e Tiers de Permissão**

A autonomia absoluta sem checagens não é segura. O objetivo é a "autonomia controlada", operando dentro de limites rigidamente definidos.

### **5.1. Tiers de Permissão e Human-in-the-Loop (HITL)**

* **Tier 1 (Livre):** Tarefas locais sem mutação irreversível.  
* **Tier 2 (Moderado):** Alterações de estado reversíveis (commits, testes locais).  
* **Tier 3 (Crítico):** Ações irreversíveis exigem o padrão HITL de needsApproval. Isso significa aplicar blocos de execução no lado do servidor que exigem autorização humana antes de uma execução sensível (ex: deploys no MCP da Hostinger/AWS ou exclusão de recursos).

### **5.2. Sandboxing Comportamental**

* Contêineres tradicionais do Docker são inadequados, pois não restringem o que o agente efetivamente faz com o acesso à rede concedido. O padrão da indústria evoluiu para o sandboxing comportamental via eBPF (Extended Berkeley Packet Filter), operando no nível do kernel do Linux para restringir acesso específico a APIs e saídas de rede.

## **6\. Observabilidade e Circuitos Financeiros (Circuit Breakers)**

Sistemas de IA não falham retornando erros 500; eles falham gastando.

* Para mitigar o risco financeiro catastrófico, disjuntores financeiros (Circuit Breakers) devem operar diretamente na camada de orquestração arquitetural.  
* Se o custo total de uma sessão exceder um limite rígido predeterminado, o disjuntor aciona uma "PARADA RÍGIDA" (Hard Stop) imediata, bloqueando a requisição e matando o processo do agente.

---

## **8\. To-Do List — Pendências de Implementação**

> Status: `[ ]` pendente · `[x]` concluído · `[~]` em progresso

### **8.1. Memória `.beads/` (PRIORIDADE CRÍTICA)**
- [x] **Definir schema YAML** do nó de tarefa (`id`, `title`, `status`, `context_summary`, `related_files[]`, `blockers[]`)
- [x] **Criar arquivo** `.beads/active.yaml` (template vazio para o boilerplate)
- [x] **Criar arquivo** `.beads/cost-log.json` (registro persistente de custo por sessão)
- [x] **Escrever git hook** `post-checkout` que troca `.beads/active.yaml` automaticamente ao mudar de branch
- [ ] **Documentar protocolo de conflito** — estratégia append-only com timestamp para evitar merge conflicts em cenários multi-agente

### **8.2. Circuit Breaker Financeiro**
- [x] **Implementar** `aiteam/src/circuit-breaker.ts` — wrapper em torno do Anthropic SDK
- [x] **Definir ponto de interceptação** — response `usage` object do SDK interceptado em `messages.create`
- [x] **Definir comportamento do Hard Stop** — lança `CircuitOpenError`, grava `circuit_open: true` em `.beads/active.yaml`
- [x] **Configurar threshold via env var** `AI_SESSION_BUDGET_USD` + override no frontmatter do `SPEC.md`
- [ ] **Integrar com Redis** (sessão em memória) — atualmente usa `.beads/cost-log.json` como store único

### **8.3. Sandboxing — Fallback para Windows/WSL2**
- [x] **Documentar limitação do eBPF no WSL2** — eBPF escopo para Linux/CI apenas (Blueprint seção 5.2)
- [x] **Implementar baseline de rede** — `--cap-drop ALL` + `--security-opt no-new-privileges` no `devcontainer.json`
- [x] **Adicionar perfil seccomp** ao `devcontainer.json` como `runArgs` — `aiteam/.devcontainer/seccomp.json` (deny de syscalls de manipulação de kernel/escape; próximo passo: allowlist estilo Docker-default validada em build)
- [x] **Bloquear commit de chaves de API** — pre-commit hook em `aiteam/githooks/pre-commit` detecta literais da variável `ANTHROPIC_API_KEY` seguida de atribuição em arquivos staged

### **8.4. MCP — Catálogo de Ferramentas Inicial**
- [x] **Criar** `aiteam/mcp/tools/` com 5 ferramentas mínimas com schema Zod:
  - `git_commit` (Tier 2) ✅
  - `run_tests` (Tier 1) ✅
  - `deploy_preview` (Tier 2) ✅
  - `deploy_production` (Tier 3 — needsApproval) ✅
  - `db_migrate` (Tier 3 — needsApproval) ✅
- [x] **Definir anotação de tier** em cada tool definition (`export const TIER`)
- [x] **Adicionar `dryRun?: boolean`** em todas as ferramentas Tier 2+

### **8.5. Camada de Avaliação (Evals)**
- [x] **Criar diretório** `aiteam/evals/` com 2 exemplos de eval YAML (`input`, `expected_behavior`, `pass_criteria`)
- [x] **Criar helper** `aiteam/src/eval-suite.ts` — wrapper Vitest com `registerEvals()` (multi-dir) + CLI runner
- [x] **Parear prompts com evals** — `aiteam/prompts/plan.eval.yaml`, `aiteam/prompts/implement.eval.yaml`, `aiteam/prompts/review.eval.yaml`
- [x] **Adicionar job de CI** — `.github/workflows/eval.yml` (validate + typecheck + test + AI evals com cost guard $0.50)

### **8.6. Observabilidade**
- [x] **Adicionar Langfuse** ao `aiteam/docker-compose.yml` (atrás de `--profile observability`)
- [ ] **Configurar log estruturado** em `.beads/session-log.ndjson` (JSON lines, git-trackable)
- [ ] **Definir métricas mínimas**: tokens/sessão, custo/sessão, tool calls/sessão, circuit break events

### **8.7. Modo de Migração para Projetos Legados**
- [x] **Definir protocolo de onboarding** — scripts de drop-in documentados em aiteam/package.json scripts
- [x] **Criar script** `aiteam/scripts/generate-spec.ts` — LLM call one-shot (Haiku) que analisa estrutura do codebase e gera draft do `SPEC.md`
- [x] **Criar script** `aiteam/scripts/bootstrap-beads.ts` — inicializa `.beads/<branch>.yaml` a partir do git log, agrupando commits por escopo em task nodes
- [ ] **Documentar tratamento de conflitos** entre `CLAUDE.md` novo e regras de lint/CI já existentes

### **8.8. Estrutura do Repositório Template**
- [x] **Criar `SPEC.md` template** com frontmatter YAML (`budget_usd`, `model`, `tier_defaults`)
- [x] **`CLAUDE.md` existente** com padrões TypeScript pré-preenchidos
- [x] **Criar `AGENTS.md`** provider-agnostic com referência ao sistema de personas + skills
- [x] **Criar `aiteam/prompts/`** com 3 prompts iniciais: `plan.md`, `implement.md`, `review.md` + paired evals
- [x] **Genericizar personas** — `frontend-expert.md` e `backend-architect.md` agora se adaptam ao stack do `SPEC.md`
- [x] **Adicionar `aiteam/.env.example`** + `aiteam/vitest.config.ts` + setup instructions no README
- [ ] **Publicar como GitHub Template Repository** (passo manual via `gh repo edit --template`)

### **8.9. Decisões Arquiteturais em Aberto**
- [x] **Decidido**: Ambos — `CLAUDE.md`/`GEMINI.md` para ferramenta-específico + `AGENTS.md` provider-agnostic
- [x] **Decidido**: Langfuse self-hosted via Docker Compose como padrão (privacidade)
- [x] **Decidido**: threshold padrão `$2.00/sessão` — validar com projeto WIP antes de publicar
- [ ] **Decidir**: MCP server único por projeto vs. servidor global com config por projeto?

---

## **7\. Referências e Detalhamento das Citações Utilizadas**

*(Nota para a IA leitora: as práticas acima foram sintetizadas a partir de pesquisas avançadas em arquiteturas agentizadas para 2026\. Abaixo está o detalhamento das bases empíricas que sustentam este documento).*

* \- Spec-Driven Development (SDD): Detalha a transição da engenharia de prompts (onde o LLM fica confuso em contextos longos) para o SDD. O detalhe fundamental é que a especificação (SPEC.md) previne o "context rot" (apodrecimento do contexto), forçando a IA a sempre ter uma "fonte da verdade" documentada antes de escrever uma linha de código.  
* \- A Evolução do Desenvolvedor: Descreve a transição profissional e de mentalidade de "implementadores" (digitadores de sintaxe) para "orquestradores" de lógica de negócios.  
* \- Gestão de Estado e Memória Apoiada por Git: Baseado na evidência de que a precisão do agente despenca após 70% de uso do contexto. A recomendação detalhada é atrelar a "memória do agente" ao Git (como o projeto .beads/), garantindo que quando o desenvolvedor mudar de branch, a memória do agente também mude automaticamente.  
* \- Model Context Protocol (MCP) e Tool Schemas: Define o padrão de integração para evitar que a IA alucine comandos complexos. O detalhe crucial é o uso de bibliotecas como Zod/JSON Schema para que a ferramenta falhe graciosamente e ensine a IA a corrigir o erro de digitação de parâmetros.  
* \- Human-in-the-Loop (HITL) e needsApproval: Fundamenta os níveis de segurança e os "Tiers" de permissão do ambiente. O conceito detalha que a IA pode automatizar o raciocínio, mas para ações como Deploy em produção (Hostinger/AWS), a orquestração precisa suspender a execução (needsApproval) até o humano clicar/digitar "Sim".  
* \- Segurança e eBPF Sandboxing: Detalha os riscos de execução remota de código e o "Confused Deputy Problem". O ponto central é que instâncias comuns do Docker não são seguras o suficiente contra agentes que instalam dependências maliciosas via NPM, exigindo soluções de kernel como eBPF para travar saídas de rede não autorizadas.  
* \- Circuit Breakers Financeiros: Detalha a solução para o problema crônico de agentes autônomos ficarem presos em loops infinitos. A arquitetura exige um middleware (como Redis) que conte os tokens de cada sessão e corte o acesso da API automaticamente caso a IA entre num loop de tentativas falhas de consertar um código.  
* \- CLAUDE.md: Descreve o padrão de documentação específica da ferramenta Claude Code para injetar metadados estáticos (como uso obrigatório de TypeScript e padrões de lint) globalmente em todos os prompts locais do repositório.