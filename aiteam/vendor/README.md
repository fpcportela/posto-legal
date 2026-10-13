# aiteam/vendor

Dependências copiadas para dentro do framework, para rodar sem `aiteam/node_modules`.

| Arquivo | Origem | Licença |
|---|---|---|
| `js-yaml.mjs` | `js-yaml` 4.2.0, `dist/js-yaml.mjs` (ESM autocontido, sem import), sem a linha `//# sourceMappingURL=` | MIT — `js-yaml.LICENSE` |

**Por que existe.** Os gates do `.beads` (hooks git, `beads-views`, `beads-check`,
`migrate-beads`, o brief do `SessionStart` e o `beads-guard`) precisam de um parser
YAML e rodam em node puro: worktree recém-criada, clone novo, máquina sem `npm install`.
Sem a cópia, esses gates seriam pulados em silêncio justamente onde mais importam.

**Como atualizar.** Atualize o pacote em `aiteam/package.json` e copie o build ESM,
tirando só a linha do source map (o `.map` não vem junto, e o vite reclamaria a cada import):

```bash
grep -v '^//# sourceMappingURL=' aiteam/node_modules/js-yaml/dist/js-yaml.mjs > aiteam/vendor/js-yaml.mjs
cp aiteam/node_modules/js-yaml/LICENSE aiteam/vendor/js-yaml.LICENSE
```

`aiteam/src/vendor-js-yaml.test.ts` falha enquanto a cópia divergir do pacote instalado.
Não edite `js-yaml.mjs` à mão.
