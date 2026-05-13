export function extractBracketedJson(
  text: string,
  openChar: "[" | "{",
  closeChar: "]" | "}"
): string | null {
  const start = text.indexOf(openChar);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === openChar) {
      depth += 1;
      continue;
    }
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

export function parseJsonCandidates(text: string): unknown[] {
  const trimmed = text.trim();
  const candidates = new Set<string>();
  if (trimmed) candidates.add(trimmed);

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
    const inner = match[1]?.trim();
    if (inner) candidates.add(inner);
  }

  const objectSnippet = extractBracketedJson(trimmed, "{", "}");
  if (objectSnippet) candidates.add(objectSnippet);

  const arraySnippet = extractBracketedJson(trimmed, "[", "]");
  if (arraySnippet) candidates.add(arraySnippet);

  const parsed: unknown[] = [];
  for (const candidate of candidates) {
    try {
      parsed.push(JSON.parse(candidate));
    } catch {
      // Ignore invalid candidates and continue searching.
    }
  }

  return parsed;
}
