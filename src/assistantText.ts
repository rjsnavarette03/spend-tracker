// Turns an assistant reply into paragraphs and lists for the floating chat (AssistantWidget).
// The model is asked for plain text with "- " bullets, but models still slip
// into Markdown, so the marks the chat doesn't render (bold, headings, code
// ticks, table rules) are dropped instead of shown. React escapes the text:
// nothing here is ever rendered as HTML.

export type ReplyBlock =
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,2}[.)]\s+(.*)$/;
const HEADING = /^\s*#{1,6}\s+/;
const TABLE_RULE =/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function stripMarks(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*\|(.*)\|\s*$/, (_, cells: string) =>
      cells
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
        .join(' · ')
    )
    .trim();
}

export function replyBlocks(text: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (raw.trim() === '' || TABLE_RULE.test(raw)) {
      endPara();
      continue;
    }
    const bullet = BULLET.exec(raw);
    const numbered = bullet ? null : NUMBERED.exec(raw);
    const item = bullet ?? numbered;
    if (item) {
      endPara();
      const kind = bullet ? 'ul' : 'ol';
      const last = blocks[blocks.length - 1];
      const itemText = stripMarks(item[1]);
      if (last && last.kind === kind) last.items.push(itemText);
      else blocks.push({ kind, items: [itemText] });
      continue;
    }
    const line = stripMarks(raw);
    if (!line) continue;
    if (HEADING.test(raw)) {
      // A heading stands alone, as its own short paragraph.
      endPara();
      blocks.push({ kind: 'p', text: line });
    } else {
      para.push(line);
    }
  }
  endPara();
  return blocks;
}
