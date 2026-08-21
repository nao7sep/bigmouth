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
 * - Headings (ATX # and setext ===)
 * - List items (unordered and ordered)
 * - Table rows (|...|)
 * - Horizontal rules (---, ***, ___)
 * - Blockquotes (>)
 * - Standalone images (![...](...))
 * - Link reference definitions ([id]: url)
 * - Inline HTML blocks (<...)
 * - Blank lines
 *
 * Returns an array of paragraph strings (each is one or more
 * consecutive prose lines joined together).
 */
export function extractParagraphs(text: string): string[] {
  const lines = text.split("\n");
  const paragraphs: string[] = [];
  // The fence that opened the current code block, or null outside one. The
  // marker itself matters, not just the fact of being inside.
  let openFence: string | null = null;
  let currentParagraph: string[] = [];

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      paragraphs.push(currentParagraph.join(" "));
      currentParagraph = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    // split("\n") leaves the carriage return on CRLF input. Fence grammar is
    // line-ending agnostic, so remove that terminator before structural checks.
    const structuralLine = line.endsWith("\r") ? line.slice(0, -1) : line;

    // A fence closes only on a run of the SAME character, at least as long as
    // the one that opened it (CommonMark). Toggling on either marker meant a
    // `~~~` inside a ``` block ended it, and everything after was counted as
    // prose - a code sample containing the other marker is ordinary in a post
    // about Markdown.
    const openingFence = /^ {0,3}(`{3,}|~{3,})/.exec(structuralLine);
    if (openFence === null && openingFence) {
      const marker = openingFence[1];
      // Backtick info strings cannot themselves contain a backtick.
      const rest = structuralLine.slice(openingFence[0].length);
      if (marker[0] !== "`" || !rest.includes("`")) {
        openFence = marker;
        flushParagraph();
        continue;
      }
    } else if (openFence !== null) {
      const closingFence = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(structuralLine);
      if (
        closingFence &&
        closingFence[1][0] === openFence[0] &&
        closingFence[1].length >= openFence.length
      ) {
        openFence = null;
        flushParagraph();
        continue;
      }
      // A shorter or different fence inside a block is just code.
    }
    if (openFence !== null) continue;

    // Skip non-prose lines
    if (
      trimmed === "" ||
      /^#{1,6}\s/.test(trimmed) ||         // ATX headings
      /^[-*+]\s/.test(trimmed) ||           // unordered list items
      /^\d+[.)]\s/.test(trimmed) ||         // ordered list items
      /^\|.*\|$/.test(trimmed) ||           // table rows
      /^[-*_]{3,}$/.test(trimmed) ||        // horizontal rules (---, ***, ___)
      /^=+$/.test(trimmed) ||               // setext heading underlines (one `=` is enough)
      /^>/.test(trimmed) ||                 // blockquotes
      /^!\[.*\]\(.*\)$/.test(trimmed) ||   // standalone images
      /^\[.*\]:\s/.test(trimmed) ||         // link reference definitions
      /^</.test(trimmed)                    // inline HTML blocks
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
