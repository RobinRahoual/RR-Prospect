/** Retire le préfixe technique d'Electron des erreurs IPC. */
export const errMsg = (e: unknown): string =>
  String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

const ALLOWED = new Set(["P", "BR", "A", "STRONG", "B", "EM", "I", "UL", "OL", "LI"]);
const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META"]);

/** Le HTML vient d'un LLM : on ne garde qu'une liste blanche de balises et le seul attribut href (http/mailto). */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove();
        continue;
      }
      const el = child as HTMLElement;
      if (DROP.has(el.tagName)) {
        el.remove();
        continue;
      }
      walk(el);
      if (!ALLOWED.has(el.tagName)) {
        el.replaceWith(...Array.from(el.childNodes));
        continue;
      }
      for (const a of Array.from(el.attributes)) {
        const okHref = el.tagName === "A" && a.name === "href" && /^(https?:|mailto:)/i.test(a.value.trim());
        if (!okHref) el.removeAttribute(a.name);
      }
      if (el.tagName === "A") {
        el.setAttribute("rel", "noopener noreferrer");
        el.setAttribute("target", "_blank");
      }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export const htmlToText = (html: string): string => {
  const d = new DOMParser().parseFromString(html.replace(/<\/p>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n"), "text/html");
  return (d.body.textContent ?? "").trim();
};
