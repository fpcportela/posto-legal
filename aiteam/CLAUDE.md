# CLAUDE.md - rb-ai-team (Claude Initialization Protocol)

> **Boot:** o start de sessão vive em `aiteam/BOOT.md` (engine-neutro, importado
> abaixo). O estado do projeto chega injetado pelo hook `SessionStart`
> (`aiteam/hooks/session-brief.mjs`) — não releia `.beads/active.yaml` (visão
> gerada) no start a menos que precise de um campo fora do brief. Regras globais,
> Permission Tiers e mandatos de TDD: `AGENTS.md`.

@BOOT.md

## Claude-specific (sobre o BOOT)

- **Artifacts:** use artifacts markdown para entregar planos arquiteturais grandes
  ou sumários de documentação.
- **Tool Selection:** prefira a tool built-in mais específica a um Bash genérico
  (`Read` > `cat`, `Grep` > `grep -r`, `Edit` > `sed`).
