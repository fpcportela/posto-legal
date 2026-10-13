// Pure secret-detection core. Consumed by scripts/scan-secrets.ts (the
// pre-commit gate) and unit-tested in secret-scanner.test.ts. The rule of the
// scanner: match secret *values*, not *mentions* — a doc that merely names a key
// must not trip, but a real key (named or bare) must.

export interface SecretFinding {
  line: number;
  rule: string;
  snippet: string;
}

// Named assignments worth catching even when the value isn't a recognizable
// provider format (e.g. an opaque LANGFUSE/AWS secret).
const NAMED_VARS = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "LANGFUSE_SECRET_KEY",
  "AWS_SECRET_ACCESS_KEY",
] as const;

const NAMED_RE = new RegExp(`\\b(${NAMED_VARS.join("|")})\\s*[:=]\\s*(\\S.*)$`);

interface RawRule {
  rule: string;
  re: RegExp;
}

// Raw key material — caught even with no variable name attached.
const RAW_RULES: RawRule[] = [
  { rule: "anthropic-api-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { rule: "openai-api-key", re: /\bsk-[A-Za-z0-9-]{20,}/ },
  { rule: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "github-token", re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { rule: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { rule: "redis-url-credentials", re: /\bredis:\/\/[^\s:@/]+:[^\s@/]+@/ },
];

const PLACEHOLDER_PREFIX_RE =
  /^(?:your[-_ ]|<|xxx|changeme|change-me|example|placeholder|todo|\.\.\.|\$\{)/i;

/**
 * A value is a placeholder (not a leak) when it is empty, an obvious template
 * token, or composed only of mask characters. Surrounding quotes are stripped
 * first so `"<your-key>"` and `<your-key>` are treated the same.
 */
export function isPlaceholder(rawValue: string): boolean {
  let v = rawValue.trim();
  v = v.replace(/^["'`]([\s\S]*)["'`]$/, "$1").trim();
  if (v === "") return true;
  // `VAR=` dentro de um code span markdown: a crase fecha logo depois do `=`,
  // então o que sobra como "valor" é a crase e a prosa em volta. Documentação
  // da regra, não segredo. Estreito de propósito — `VAR=`sk-ant-real`` começa
  // com material de chave e continua sinalizado.
  if (/^`(?:\s|$)/.test(v)) return true;
  // A value with an ellipsis is a documentation example (e.g. `AIza…`,
  // `sk-ant-...`), never a real key — match the value, not the mention.
  if (v.includes("…") || v.includes("...")) return true;
  if (PLACEHOLDER_PREFIX_RE.test(v)) return true;
  if (/^[x*.\-_·…]+$/i.test(v)) return true;
  return false;
}

/**
 * Scan a text blob (typically the added lines of a staged diff) for secrets.
 * Returns one finding per (line, rule) hit. Snippets are redacted — the secret
 * value is never echoed back, so findings are safe to print in hook output.
 */
export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];

  text.split(/\r?\n/).forEach((line, i) => {
    const lineNo = i + 1;

    const named = NAMED_RE.exec(line);
    if (named) {
      const varName = named[1] ?? "secret";
      const value = named[2] ?? "";
      if (!isPlaceholder(value)) {
        findings.push({
          line: lineNo,
          rule: varName,
          snippet: `<redacted value assigned to ${varName}>`,
        });
      }
    }

    for (const { rule, re } of RAW_RULES) {
      if (re.test(line)) {
        findings.push({ line: lineNo, rule, snippet: `<redacted ${rule} match>` });
      }
    }
  });

  return findings;
}
