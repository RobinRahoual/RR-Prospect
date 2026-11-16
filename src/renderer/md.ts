import { sanitizeHtml } from "./util";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s: string) =>
  esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');

/** Sous-ensemble Markdown (gras, italique, listes, liens, paragraphes) → HTML assaini. */
export function mdToHtml(src: string): string {
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    const li = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      const kind = li[1] ? "ol" : "ul";
      if (list !== kind) {
        close();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline(li[2]!)}</li>`);
    } else {
      close();
      if (line.trim()) out.push(`<p>${inline(line.replace(/^#{1,6}\s+/, ""))}</p>`);
    }
  }
  close();
  return sanitizeHtml(out.join(""));
}
