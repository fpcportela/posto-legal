import { describe, it, expect } from "vitest";
import { validateBeads } from "./beads-schema.js";

const VALID_DOC = `
version: "1.0"
branch: "main"
project: "demo"
last_updated: "2026-06-10T12:00:00Z"
session:
  active_spec_hash: ""
  budget_usd: 2.00
  cost_accumulated_usd: 0.10
  current_task_phase: "implement"
tasks:
  - id: "ui-login-form"
    title: "Login form"
    description: "Build the login form with validation"
    status: "in_progress"
    context_summary: "Reusing FormField."
    related_files: []
    blockers: []
    created_at: "2026-06-10T12:00:00Z"
    updated_at: "2026-06-10T12:00:00Z"
`;

describe("validateBeads", () => {
  it("accepts a fully conformant document", () => {
    const r = validateBeads(VALID_DOC);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("accepts the empty bootstrap template", () => {
    const template = `
version: "1.0"
branch: ""
project: ""
last_updated: ""
session:
  active_spec_hash: ""
  budget_usd: 2.00
  cost_accumulated_usd: 0.00
tasks: []
`;
    const r = validateBeads(template);
    expect(r.errors).toEqual([]);
  });

  // A visão gerada do modelo por bead (aiteam/docs/beads-schema.md §7.1) não
  // carrega branch nem last_updated: a branch vem do git, na hora, e a visão
  // é reescrita a cada hook. Este schema passou a ser o contrato da visão.
  it("accepts the generated v2 view, which carries no branch nor last_updated", () => {
    const view = `
version: "2"
project: ""
session:
  budget_usd: 2
  cost_accumulated_usd: 0
archive:
  count: 0
  index: ".beads/index.yaml"
tasks: []
`;
    expect(validateBeads(view).errors).toEqual([]);
  });

  it("rejects unparseable YAML", () => {
    const r = validateBeads("tasks: [unclosed");
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("rejects a task without id", () => {
    const r = validateBeads(VALID_DOC.replace('id: "ui-login-form"', 'note: "no id"'));
    expect(r.errors.some((e) => e.includes("id"))).toBe(true);
  });

  it("rejects a non-string id", () => {
    const r = validateBeads(VALID_DOC.replace('"ui-login-form"', "12345"));
    expect(r.errors.some((e) => e.includes("id"))).toBe(true);
  });

  it("rejects a status outside the enum", () => {
    const r = validateBeads(VALID_DOC.replace('"in_progress"', '"discovery"'));
    expect(r.errors.some((e) => e.includes("status"))).toBe(true);
  });

  it("rejects quoted (string) budget numbers", () => {
    const r = validateBeads(VALID_DOC.replace("budget_usd: 2.00", 'budget_usd: "2.00"'));
    expect(r.errors.some((e) => e.includes("budget_usd"))).toBe(true);
  });

  it("rejects null tasks", () => {
    const r = validateBeads(VALID_DOC.replace(/tasks:[\s\S]*$/, "tasks:\n"));
    expect(r.errors.some((e) => e.includes("tasks"))).toBe(true);
  });

  it("rejects duplicate task ids", () => {
    const dup = VALID_DOC + `
  - id: "ui-login-form"
    description: "Duplicate"
    status: "pending"
`;
    const r = validateBeads(dup);
    expect(r.errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("rejects a task with neither title nor description", () => {
    const r = validateBeads(
      VALID_DOC
        .replace(/^\s*title: "Login form"\n/m, "")
        .replace(/^\s*description: "Build the login form with validation"\n/m, "")
    );
    expect(r.errors.some((e) => e.includes("description"))).toBe(true);
  });

  it("warns when id has no desk routing keyword", () => {
    const r = validateBeads(VALID_DOC.replace(/"ui-login-form"/g, '"task-001"'));
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("routing"))).toBe(true);
  });

  it("does not warn for an explicit orch- prefix", () => {
    const r = validateBeads(VALID_DOC.replace(/"ui-login-form"/g, '"orch-sprint-setup"'));
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("routing"))).toBe(false);
  });

  it("warns on description longer than 140 chars", () => {
    const long = "x".repeat(150);
    const r = validateBeads(
      VALID_DOC.replace("Build the login form with validation", long)
    );
    expect(r.warnings.some((w) => w.includes("140"))).toBe(true);
  });

  it("warns on HTML in text fields", () => {
    const r = validateBeads(
      VALID_DOC.replace("Build the login form with validation", "Build <b>bold</b> form")
    );
    expect(r.warnings.some((w) => w.includes("HTML"))).toBe(true);
  });

  it("warns on context_summary longer than 600 chars", () => {
    const long = "s".repeat(700);
    const r = validateBeads(VALID_DOC.replace("Reusing FormField.", long));
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("context_summary exceeds"))).toBe(true);
  });

  // No modelo por bead não há mais archive: a visão só traz os beads vivos, e
  // o aviso aponta para o que de fato encolhe a visão — fechar o que acabou.
  it("warns when the view outgrows a single agent read, without the removed archive script", () => {
    const padded = VALID_DOC + "\n# " + "x".repeat(100_001) + "\n";
    const r = validateBeads(padded);
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => w.includes("100KB") && w.includes("completed"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("archive"))).toBe(false);
  });

  it("suppresses the size warning with warnOversize: false", () => {
    const padded = VALID_DOC + "\n# " + "x".repeat(100_001) + "\n";
    const r = validateBeads(padded, { warnOversize: false });
    expect(r.warnings.some((w) => w.includes("100KB"))).toBe(false);
  });

  it("accepts a valid impl_model and rejects an unknown one", () => {
    const withModel = VALID_DOC.replace(
      'status: "in_progress"',
      'status: "in_progress"\n    impl_model: "sonnet"',
    );
    expect(validateBeads(withModel).errors).toEqual([]);

    const badModel = VALID_DOC.replace(
      'status: "in_progress"',
      'status: "in_progress"\n    impl_model: "gpt"',
    );
    expect(validateBeads(badModel).errors.some((e) => e.includes("impl_model"))).toBe(true);
  });

  it("routes data/sre/ux ids without a desk-routing warning (aiteam/docs/beads-schema.md §5)", () => {
    for (const id of ["data-sync-pipeline", "sre-datadog-setup", "ux-a11y-audit"]) {
      const r = validateBeads(VALID_DOC.replace(/"ui-login-form"/g, `"${id}"`));
      expect(r.errors).toEqual([]);
      expect(r.warnings.some((w) => w.includes("routing"))).toBe(false);
    }
  });
});

const withTags = (tagsYaml: string) => `version: "1.0"
branch: "main"
project: "demo"
last_updated: "2026-07-15T00:00:00Z"
session:
  active_spec_hash: ""
  budget_usd: 2.00
  cost_accumulated_usd: 0.00
tasks:
  - id: "api-tagged"
    description: "Task com tags"
    status: "completed"
${tagsYaml}
    created_at: "2026-07-15T00:00:00Z"
    updated_at: "2026-07-15T00:00:00Z"
`;

describe("beads-schema tags field", () => {
  it("accepts a list of string tags", () => {
    const r = validateBeads(withTags("    tags: [webhook, integracoes]"));
    expect(r.errors).toEqual([]);
  });

  it("accepts a task with no tags (optional)", () => {
    const r = validateBeads(withTags("    effort: M"));
    expect(r.errors).toEqual([]);
  });

  it("rejects tags that are not a list of strings", () => {
    const r = validateBeads(withTags("    tags: 123"));
    expect(r.errors.some((e) => e.includes("tags"))).toBe(true);
  });
});

// trello / trello_scope (aiteam/docs/beads-schema.md §3.3): o card de origem do bead. O contrato
// da visão valida o formato; "ausente" é o caso normal (trabalho sem card).
describe("beads-schema trello + trello_scope", () => {
  const withCard = (fields: string) => withTags(fields);
  const ok = (fields: string) => expect(validateBeads(withCard(fields)).errors).toEqual([]);
  const bad = (fields: string, re: RegExp) => expect(validateBeads(withCard(fields)).errors.join("\n")).toMatch(re);

  it("accepts a task with no card (optional, the normal case)", () => ok("    effort: M"));
  it("accepts a single shortLink", () => ok('    trello: "97e1Chex"'));
  it("accepts a list of shortLinks (one bead absorbing several cards)", () => ok('    trello: ["0nU0fBM1", "68wGTstW"]'));
  it("accepts trello_scope: partial together with trello", () => ok('    trello: "97e1Chex"\n    trello_scope: "partial"'));

  it("rejects the full URL instead of the shortLink", () => bad('    trello: "https://trello.com/c/97e1Chex"', /trello/));
  it("rejects an empty list and a list with an empty or invalid item", () => {
    bad("    trello: []", /trello/);
    bad('    trello: ["0nU0fBM1", ""]', /trello/);
    bad('    trello: ["0nU0fBM1", "a b"]', /trello/);
  });
  it("rejects a non-text value (unquoted number, old-model object)", () => {
    bad("    trello: 12345678", /trello/);
    bad('    trello: {card: "abc"}', /trello/);
  });
  it("rejects the 24-hex card id (it is not the shortLink), alone or inside a list, but keeps other lengths", () => {
    bad('    trello: "6a04be05693b5ca07cad2001"', /trello/);
    bad('    trello: ["97e1Chex", "6a04be05693b5ca07cad2001"]', /trello/);
    expect(validateBeads(withCard('    trello: "6a04be05693b5ca07cad2001"')).errors.join("\n")).toMatch(/card id, not the shortLink/);
    ok('    trello: "abc"');
    ok('    trello: "6a04be05693b5ca07cad200g"');
  });
  it("rejects a trello_scope outside the enum", () => bad('    trello: "97e1Chex"\n    trello_scope: "full"', /trello_scope/));
  it("rejects trello_scope without trello", () => bad('    trello_scope: "partial"', /trello_scope.*trello/));
});

const withTop = (extra: string, tasksYaml ="  - id: \"api-a\"\n    description: \"A\"\n    status: \"pending\"\n    created_at: \"2026-07-15T00:00:00Z\"\n    updated_at: \"2026-07-15T00:00:00Z\"\n") => `version: "1.0"
branch: "main"
project: "demo"
last_updated: "2026-07-15T00:00:00Z"
${extra}session:
  active_spec_hash: ""
  budget_usd: 2.00
  cost_accumulated_usd: 0.00
tasks:
${tasksYaml}`;

describe("beads-schema phases + focus_note + ref warnings", () => {
  it("accepts a well-formed phases block and session.focus_note", () => {
    const doc = withTop('phases:\n  - {key: "fase-0", name: "Fase 0", subtitle: "x"}\n', '  - id: "api-a"\n    description: "A"\n    status: "pending"\n    phase: "fase-0"\n    created_at: "2026-07-15T00:00:00Z"\n    updated_at: "2026-07-15T00:00:00Z"\n')
      .replace("session:\n", "session:\n  focus_note: \"deploy gate\"\n");
    const r = validateBeads(doc);
    expect(r.errors).toEqual([]);
  });

  it("errors on a phase with a missing or duplicate key", () => {
    const dup = withTop('phases:\n  - {key: "f", name: "A"}\n  - {key: "f", name: "B"}\n');
    expect(validateBeads(dup).errors.some((e) => e.includes("phases") && e.includes("duplicate"))).toBe(true);
    const missing = withTop('phases:\n  - {name: "A"}\n');
    expect(validateBeads(missing).errors.some((e) => e.includes("phases"))).toBe(true);
  });

  it("warns when a task.phase matches no declared phase key", () => {
    const doc = withTop('phases:\n  - {key: "fase-0", name: "Fase 0"}\n', '  - id: "api-a"\n    description: "A"\n    status: "pending"\n    phase: "fase-9"\n    created_at: "2026-07-15T00:00:00Z"\n    updated_at: "2026-07-15T00:00:00Z"\n');
    expect(validateBeads(doc).warnings.some((w) => w.includes("phase") && w.includes("fase-9"))).toBe(true);
  });

  it("warns when a blocker id matches no task", () => {
    const doc = withTop("", '  - id: "api-a"\n    description: "A"\n    status: "pending"\n    blockers:\n      - "ghost-task"\n    created_at: "2026-07-15T00:00:00Z"\n    updated_at: "2026-07-15T00:00:00Z"\n');
    expect(validateBeads(doc).warnings.some((w) => w.includes("blocker") && w.includes("ghost-task"))).toBe(true);
  });

  it("warns when session.focus_note is multiline or contains HTML", () => {
    const multiline = withTop("").replace("session:\n", 'session:\n  focus_note: "line one\\nline two"\n');
    expect(validateBeads(multiline).warnings.some((w) => w.includes("focus_note") && w.includes("multiline"))).toBe(true);

    const html = withTop("").replace("session:\n", 'session:\n  focus_note: "<b>urgent</b>"\n');
    expect(validateBeads(html).warnings.some((w) => w.includes("focus_note") && w.includes("HTML"))).toBe(true);
  });
});

describe("beads-schema ROUTING_KEYWORDS — as 4 personas novas roteiam sem warning", () => {
  it.each([
    "devops-vps-setup",
    "release-v2-rollout",
    "debug-flaky-test",
    "qa-security-audit",
  ])("id %s não dispara o warning de rota", (id) => {
    const doc = withTop(
      "",
      `  - id: "${id}"\n    description: "A"\n    status: "pending"\n    created_at: "2026-07-15T00:00:00Z"\n    updated_at: "2026-07-15T00:00:00Z"\n`
    );
    expect(validateBeads(doc).warnings.some((w) => w.includes("routing keyword"))).toBe(false);
  });
});
