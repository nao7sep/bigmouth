import twitter from "twitter-text";

/**
 * Counts Unicode grapheme clusters using the built-in Intl.Segmenter.
 */
export function graphemeCount(text: string): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const _ of segmenter.segment(text)) {
    count++;
  }
  return count;
}

/**
 * Returns the X (Twitter) weighted character count.
 */
export function xWeightedCount(text: string): number {
  return twitter.parseTweet(text).weightedLength;
}

/**
 * Extracts prose paragraphs from markdown text, excluding:
 * - Fenced code blocks (``` or ~~~)
 * - Lines that are list items (- * + or 1.)
 * - Lines that are table rows (|...|)
 * - Lines that are headings (#)
 * - Blank lines
 *
 * Returns an array of paragraph strings (each is one or more
 * consecutive prose lines joined together).
 */
export function extractParagraphs(text: string): string[] {
  const lines = text.split("\n");
  const paragraphs: string[] = [];
  let inCodeBlock = false;
  let currentParagraph: string[] = [];

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      paragraphs.push(currentParagraph.join(" "));
      currentParagraph = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Toggle code blocks
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      flushParagraph();
      continue;
    }
    if (inCodeBlock) continue;

    // Skip non-prose lines
    if (
      trimmed === "" ||
      /^#{1,6}\s/.test(trimmed) || // headings
      /^[-*+]\s/.test(trimmed) || // unordered list items
      /^\d+[.)]\s/.test(trimmed) || // ordered list items
      /^\|.*\|$/.test(trimmed) || // table rows
      /^---+$/.test(trimmed) || // horizontal rules / table separators
      /^>/.test(trimmed) // blockquotes
    ) {
      flushParagraph();
      continue;
    }

    currentParagraph.push(trimmed);
  }

  flushParagraph();
  return paragraphs;
}

export interface ContentCounts {
  graphemes: number;
  xWeighted: number;
  paragraphs: number;
  avgParagraphLength: number;
  longestParagraphLength: number;
}

export function computeCounts(text: string): ContentCounts {
  const paras = extractParagraphs(text);
  const paraLengths = paras.map((p) => graphemeCount(p));

  return {
    graphemes: graphemeCount(text),
    xWeighted: xWeightedCount(text),
    paragraphs: paras.length,
    avgParagraphLength:
      paraLengths.length > 0
        ? Math.round(
            paraLengths.reduce((a, b) => a + b, 0) / paraLengths.length
          )
        : 0,
    longestParagraphLength:
      paraLengths.length > 0 ? Math.max(...paraLengths) : 0,
  };
}
