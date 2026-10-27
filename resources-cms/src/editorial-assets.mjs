import { readFileSync } from "node:fs";

const ASSETS = Object.freeze({
  "resource-17/workflow.svg": {
    file: new URL("../attachments/pending/Resource_17_Diagnostic_Workflow.svg", import.meta.url),
    mime: "image/svg+xml; charset=utf-8",
    filename: "Resource_17_Diagnostic_Workflow.svg",
  },
  "resource-17/workflow.png": {
    file: new URL("../attachments/pending/Resource_17_Diagnostic_Workflow.png", import.meta.url),
    mime: "image/png",
    filename: "Resource_17_Diagnostic_Workflow.png",
  },
  "resource-17/workflow.pdf": {
    file: new URL("../attachments/pending/Resource_17_Diagnostic_Workflow.pdf", import.meta.url),
    mime: "application/pdf",
    filename: "Resource_17_Diagnostic_Workflow.pdf",
  },
});

export function editorialAsset(key) {
  const asset = ASSETS[key];
  if (!asset) return null;
  return { ...asset, bytes: readFileSync(asset.file) };
}

export function editorialPreviewFigure(slug, preview) {
  if (!preview || slug !== "pool-diagnostic-workflow") return "";
  const alt = "Ten-stage pool equipment diagnostic workflow, from capturing the reported problem through follow-up, with safety screening and documentation continuing throughout.";
  return `<figure class="workflow-figure"><div class="workflow-diagram-scroll" tabindex="0" role="region" aria-label="Scrollable diagnostic workflow diagram"><img src="/preview-assets/resource-17/workflow.svg" width="1120" height="700" alt="${alt}"></div><figcaption>${alt} <a href="/preview-assets/resource-17/workflow.png">Review PNG alternative</a> · <a href="/preview-assets/resource-17/workflow.pdf">Review PDF alternative</a>. These files are private editorial-review assets and are not publication-ready.</figcaption></figure>`;
}

export function injectEditorialPreviewAsset(body, slug, preview) {
  const figure = editorialPreviewFigure(slug, preview);
  if (!figure) return body;
  const marker = /(<h2[^>]*>\s*Step 1:)/i;
  return marker.test(body) ? body.replace(marker, `${figure}$1`) : `${figure}${body}`;
}
