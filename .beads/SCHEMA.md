# .beads — contrato

> **O formato e o protocolo do `.beads` estão em [`aiteam/docs/beads-schema.md`](../aiteam/docs/beads-schema.md).**
> Escreva em `.beads/tasks/<id>/<sua-branch>.yaml` — um arquivo por bead e por branch, só acrescentando no fim.
> **Nunca escreva nas visões** `.beads/active.yaml` e `.beads/index.yaml`: são geradas, ficam fora do git e o
> próximo hook descarta a edição (com backup e aviso). Valide com `npm --prefix aiteam run validate:beads`.
> O jeito recomendado de escrever é o comando `node aiteam/scripts/beads.mjs` (`new`, `start`, `stage`, `note`,
> `block`, `done`; `status` mostra também as outras branches, marcadas como não mergeadas).

## Convenções locais deste repo (opcional)

- `.beads/BACKLOG.md` guarda a spec técnica de cada bead pendente, pelo id. O bead fica com a linha curta
  (`title`, `description`); a spec longa mora lá.
