/// Minimal markdown renderer for release notes and the what's-new card.
/// Handles exactly the subset our changelog uses — ## headings, - lists,
/// **bold**, `code` — and escapes everything first, so a hostile note
/// body degrades to text instead of markup. Deliberately not a full
/// markdown dependency: the input is our own release prose.
export function renderMdLite(src: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const line of src.split(/\r?\n/)) {
    const heading = line.match(/^#{2,4}\s+(.*)$/);
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (heading) {
      closeList();
      out.push(`<h4>${inline(heading[1])}</h4>`);
    } else if (item) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(item[1])}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join("");
}
