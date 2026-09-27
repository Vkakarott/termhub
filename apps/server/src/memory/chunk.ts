/**
 * A chunk of a markdown document, indexed and titled with its location.
 */
export interface Chunk {
  index: number;
  title: string;
  text: string;
}

/**
 * Split markdown into chunks by headings (h1-h3), packing paragraphs up to max length.
 * Code fences (```) are respected: heading-looking lines inside them are ignored.
 * Empty sections are dropped. Indexes are consecutive across the file.
 */
export function chunkMarkdown(path: string, md: string, max = 1200): Chunk[] {
  const lines = md.split('\n');
  const chunks: Chunk[] = [];
  let index = 0;

  let currentHeading: string | null = null;
  let currentText: string[] = [];
  let inCodeFence = false;
  let currentSectionText = '';

  const headingRegex = /^#{1,3}\s+(.+)$/;

  const flushCurrentSection = () => {
    if (currentSectionText.trim()) {
      // Split by blank lines (paragraphs), but preserve blank lines inside code fences
      const lines = currentSectionText.split('\n');
      let fenceActive = false;
      const paragraphs: string[] = [];
      let currentPara = '';

      for (const line of lines) {
        if (line.trim().startsWith('```')) {
          fenceActive = !fenceActive;
          currentPara += (currentPara ? '\n' : '') + line;
        } else if (!fenceActive && line.trim() === '') {
          // Blank line outside fence: end paragraph
          if (currentPara.trim()) {
            paragraphs.push(currentPara.trim());
            currentPara = '';
          }
        } else {
          // Regular line or blank line inside fence
          currentPara += (currentPara ? '\n' : '') + line;
        }
      }
      if (currentPara.trim()) {
        paragraphs.push(currentPara.trim());
      }

      if (paragraphs.length > 0) {
        // Pack paragraphs
        let currentChunk = '';
        for (const para of paragraphs) {
          if (!currentChunk) {
            // First paragraph or starting new chunk
            if (para.length <= max) {
              currentChunk = para;
            } else {
              // Paragraph is too long, hard-cut it
              let remaining = para;
              while (remaining.length > 0) {
                const title = currentHeading ? `${path} › ${currentHeading}` : path;
                chunks.push({
                  index: index++,
                  title,
                  text: remaining.slice(0, max),
                });
                remaining = remaining.slice(max);
              }
              currentChunk = '';
            }
          } else if (currentChunk.length + 1 + para.length <= max) {
            // Add to current chunk
            currentChunk += '\n' + para;
          } else {
            // Start new chunk
            const title = currentHeading ? `${path} › ${currentHeading}` : path;
            chunks.push({
              index: index++,
              title,
              text: currentChunk,
            });
            if (para.length <= max) {
              currentChunk = para;
            } else {
              // Paragraph is too long, hard-cut it
              let remaining = para;
              while (remaining.length > 0) {
                chunks.push({
                  index: index++,
                  title,
                  text: remaining.slice(0, max),
                });
                remaining = remaining.slice(max);
              }
              currentChunk = '';
            }
          }
        }
        // Flush remaining chunk
        if (currentChunk) {
          const title = currentHeading ? `${path} › ${currentHeading}` : path;
          chunks.push({
            index: index++,
            title,
            text: currentChunk,
          });
        }
      }
    }
    currentSectionText = '';
  };

  for (const line of lines) {
    // Toggle code fence state
    if (line.trim().startsWith('```')) {
      inCodeFence = !inCodeFence;
      currentSectionText += line + '\n';
      continue;
    }

    // Check for heading (only outside code fence)
    if (!inCodeFence) {
      const match = line.match(headingRegex);
      if (match) {
        // Start new section
        flushCurrentSection();
        currentHeading = match[1]!;
        continue;
      }
    }

    // Add line to current section
    currentSectionText += line + '\n';
  }

  // Flush last section
  flushCurrentSection();

  return chunks;
}
