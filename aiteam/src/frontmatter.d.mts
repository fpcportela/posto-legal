// Declaração de tipos para frontmatter.mjs, na convenção src/*.d.mts (ver
// tier-core.d.mts), para os .ts compilarem sob `tsc --noEmit` sem `allowJs`.

/** O frontmatter do início do texto, sem as cercas `---`, com as quebras (CRLF, CR) normalizadas para LF e um BOM inicial descartado; null quando não há. */
export function extractFrontmatter(text: string | null | undefined): string | null;
