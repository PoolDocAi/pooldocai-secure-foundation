const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const main = $("#main"),
  dialog = $("#dialog");
let me,
  content = [],
  taxonomy = [],
  page = "dashboard",
  current = null,
  dirty = false,
  saveTimer,
  saving = null,
  editGeneration = 0;
const isOwner = () => me?.role === "owner",
  canWrite = () => ["owner", "editor"].includes(me?.role),
  canReview = () => ["owner", "reviewer"].includes(me?.role);
async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(me?.csrf ? { "X-CSRF-Token": me.csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const d = await r.json();
  if (r.status === 401) {
    location.href = "/admin/login";
    throw Error("Session expired");
  }
  if (!r.ok) throw Error(d.error || "Request failed");
  return d;
}
function toast(text, error = false) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  t.classList.toggle("error", error);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 7000);
}
function modal(html, setup) {
  $("#dialog-content").innerHTML = html;
  dialog.showModal();
  setup?.();
}
$(".dialog-close").onclick = () => dialog.close();
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});
function badge(s) {
  return `<span class="status ${esc(s)}">${esc(s.replaceAll("_", " "))}</span>`;
}
const title = (heading, desc, actions = "") =>
  `<div class="page-title"><div><p class="eyebrow">RESOURCES STUDIO</p><h1>${heading}</h1><p>${desc}</p></div><div class="actions">${actions}</div></div>`;
const cat = (id) => taxonomy.find((t) => t.id === id)?.name || "Uncategorized";
const date = (s) =>
  s
    ? new Date(s).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
const opt = (rows, value) =>
  rows
    .map(
      (r) =>
        `<option value="${esc(r.id)}" ${r.id === value ? "selected" : ""}>${esc(r.name)}</option>`,
    )
    .join("");
function refresh() {
  return Promise.all([api("/api/content"), api("/api/taxonomy")]).then(
    ([c, t]) => {
      content = c;
      taxonomy = t;
    },
  );
}
const mobileMenu = $("#mobile-menu"),
  sidebar = $("#cms-sidebar"),
  backdrop = $("#nav-backdrop"), workspace = $(".workspace"), navClose = $("#nav-close"),
  mobileViewport = window.matchMedia("(max-width: 700px)");
function closeMobileNavigation(restoreFocus = false) {
  const wasOpen = sidebar.classList.contains("nav-open");
  sidebar.classList.remove("nav-open");
  document.body.classList.remove("nav-is-open");
  backdrop.hidden = true;
  mobileMenu.setAttribute("aria-expanded", "false");
  mobileMenu.setAttribute("aria-label", "Open navigation");
  workspace.inert = false;
  $(".skip").inert = false;
  sidebar.inert = mobileViewport.matches;
  sidebar.removeAttribute("role");
  sidebar.removeAttribute("aria-modal");
  if (restoreFocus && wasOpen) mobileMenu.focus();
}
function openMobileNavigation() {
  if (!mobileViewport.matches) return;
  sidebar.inert = false;
  workspace.inert = true;
  $(".skip").inert = true;
  sidebar.setAttribute("role", "dialog");
  sidebar.setAttribute("aria-modal", "true");
  sidebar.classList.add("nav-open");
  document.body.classList.add("nav-is-open");
  backdrop.hidden = false;
  mobileMenu.setAttribute("aria-expanded", "true");
  mobileMenu.setAttribute("aria-label", "Close navigation");
  sidebar.querySelector("[data-page].active")?.focus();
}
mobileMenu.onclick = () => sidebar.classList.contains("nav-open") ? closeMobileNavigation(true) : openMobileNavigation();
backdrop.onclick = () => closeMobileNavigation(true);
navClose.onclick = () => closeMobileNavigation(true);
document.addEventListener("keydown", (event) => {
  if (!sidebar.classList.contains("nav-open")) return;
  if (event.key === "Escape") { event.preventDefault(); closeMobileNavigation(true); }
  if (event.key !== "Tab") return;
  const nodes = [...sidebar.querySelectorAll('a, button:not([disabled])')].filter(el => el.getClientRects().length);
  if (!nodes.length) return;
  const first = nodes[0], last = nodes[nodes.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
mobileViewport.addEventListener("change", () => closeMobileNavigation());
closeMobileNavigation();
const cmsPages = new Set(["dashboard", "library", "taxonomy", "media", "seo", "knowledge", "settings"]);
let historyPosition = 0, undoingHistory = false;
history.replaceState({ cmsPage: page, cmsPosition: historyPosition }, "", location.href);
let navigationQueue = Promise.resolve();
function navigate(next, options = {}) {
  const pending = navigationQueue.then(() => changePage(next, options));
  navigationQueue = pending.catch(() => {});
  return pending;
}
async function changePage(next, { fromHistory = false, position = historyPosition } = {}) {
  if (!cmsPages.has(next)) next = "dashboard";
  if (dirty && !confirm("You have unsaved changes. Leave this editor?")) {
    if (fromHistory && position !== historyPosition) {
      undoingHistory = true;
      history.go(historyPosition - position);
    }
    return;
  }
  clearTimeout(saveTimer);
  if (saving) await saving;
  dirty = false;
  page = next;
  if (!fromHistory && location.hash !== `#${next}`) history.pushState({ cmsPage: next, cmsPosition: ++historyPosition }, "", `#${next}`);
  else if (fromHistory) historyPosition = position;
  closeMobileNavigation();
  current = null;
  dirty = false;
  $$("[data-page]").forEach((b) => {
    b.classList.toggle("active", b.dataset.page === page);
    if (b.dataset.page === page) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  await refresh();
  if (page === "dashboard") await dashboard();
  if (page === "library") library();
  if (page === "taxonomy") taxonomies();
  if (page === "media") await mediaLibrary();
  if (page === "seo") seoManager();
  if (page === "knowledge") knowledgeList();
  if (page === "settings") await settings();
  if (page === "folders") await window.CMSNavigation.load();
  if (page === "analytics") await window.CMSPlatform.analytics();
  main.focus();
}
$$("[data-page]").forEach(
  (b) =>
    (b.onclick = () =>
      navigate(b.dataset.page).catch((e) => toast(e.message, true))),
);
window.addEventListener("popstate", (event) => {
  if (undoingHistory) { undoingHistory = false; return; }
  const requested = location.hash.slice(1);
  navigate(cmsPages.has(requested) ? requested : "dashboard", { fromHistory: true, position: event.state?.cmsPosition ?? historyPosition }).catch(e => toast(e.message, true));
});
$("#logout").onclick = async () => {
  if (dirty && !confirm("Unsaved changes will be lost. Sign out?")) return;
  try {
    clearTimeout(saveTimer);
    if (saving) await saving;
    await api("/api/logout", { method: "POST", body: {} });
    dirty = false;
    location.href = "/admin/login";
  } catch (error) { toast(error.message, true); }
};
$("#mobile-logout").onclick = () => $("#logout").click();
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
function auditActorLabel(event) {
  if (event.email) return event.email;
  // Identity is historical evidence; do not infer the actor's current role.
  if (event.actor_id) return "Recorded user";
  if (event.action === "scheduled_publish") return "Scheduler";
  return "Unattributed event";
}
async function dashboard() {
  const d = await api("/api/dashboard");
  main.innerHTML =
    title(
      "A little knowledge. A lot of clarity.",
      "Your editorial workspace, at a glance.",
      canWrite()
        ? '<button class="primary" id="new">＋ New article</button>'
        : "",
    ) +
    `<div class="hero-note"><div><p class="eyebrow">THOUGHTFULLY PUBLISHED</p><h2>Help people take the right next step.</h2><p>Build a useful resource library. Every draft stays private until you choose to publish it.</p></div><button id="browse">Open content library →</button></div><div class="stats">${[
      ["published", "Published resources"],
      ["draft", "Drafts in progress"],
      ["scheduled", "Scheduled"],
      ["review", "Awaiting review"],
      ["archived", "Archived resources"],
    ]
      .map(
        ([key, label]) =>
          `<button class="stat" data-filter="${key}"><span><i class="dot"></i>${label}</span><strong>${d.counts[key]}</strong><span>View resources →</span></button>`,
      )
      .join(
        "",
      )}</div><div class="panels"><section class="panel"><div class="panel-heading"><h2>Recent changes</h2><span class="muted">Live audit trail</span></div><div class="activity">${
      d.recent.length
        ? d.recent
            .slice(0, 8)
            .map(
              (a) =>
                `<div class="activity-item"><span class="activity-icon">↗</span><div><strong>${esc(a.action.replaceAll("_", " "))}</strong><small>${esc(content.find((c) => c.id === a.resource_id)?.data.title || "Workspace activity")}<br>${esc(date(a.created_at))} · ${esc(auditActorLabel(a))}</small></div></div>`,
            )
            .join("")
        : '<p class="muted">Your first change will appear here.</p>'
    }</div></section><section class="panel"><div class="panel-heading"><h2>Editorial attention</h2><span class="badge">${d.warnings.length} checks</span></div>${
      d.warnings.length
        ? d.warnings
            .slice(0, 6)
            .map(
              (w) =>
                `<button class="warning" data-edit="${w.id}">${esc(w.title)}: ${esc(w.message)}</button>`,
            )
            .join("")
        : '<p class="muted">Your articles have the essentials covered.</p>'
    }<hr><h3>Separate approvals, clearer trust.</h3><p class="muted">Publishing is editorial permission. Diagnostic knowledge requires its own evidence review.</p><button id="review-knowledge">Open knowledge review →</button></section></div>`;
  $("#new")?.addEventListener("click", newArticle);
  $("#browse").onclick = () => navigate("library");
  $("#review-knowledge").onclick = () => navigate("knowledge");
  $$("[data-filter]").forEach(
    (b) =>
      (b.onclick = async () => {
        await navigate("library");
        $("#status-filter").value = b.dataset.filter;
        drawTable();
      }),
  );
  bindEdits();
}
function bindEdits() {
  $$("[data-edit]").forEach(
    (b) =>
      (b.onclick = () =>
        openEditor(b.dataset.edit).catch((e) => toast(e.message, true))),
  );
}
function library() {
  main.innerHTML =
    title(
      "Content library",
      "A home for every idea, draft, and published guide.",
      canWrite()
        ? '<button id="import">Import draft</button><button class="primary" id="new">＋ New article</button>'
        : "",
    ) +
    `<section class="panel"><div class="filters"><input id="search" aria-label="Search articles" placeholder="Search titles, summaries, or slugs…"><select id="category-filter" aria-label="Filter by category"><option value="">All categories</option>${opt(taxonomy.filter((t) => t.kind === "category"))}</select><select id="tag-filter" aria-label="Filter by topic"><option value="">All topics</option>${opt(taxonomy.filter((t) => t.kind === "tag"))}</select><select id="status-filter" aria-label="Filter by status"><option value="">All statuses</option>${["draft", "review", "approved", "scheduled", "published", "archived", "deleted"].map((s) => `<option>${s}</option>`).join("")}</select><select id="sort" aria-label="Sort articles"><option value="updated">Recently updated</option><option value="title">Title A–Z</option><option value="oldest">Oldest first</option></select></div><div class="panel-heading"><p class="muted" id="result-count"></p>${isOwner() ? '<button class="danger" id="bulk-archive" disabled>Archive selected</button>' : ""}</div><div id="article-table"></div></section>`;
  $("#new")?.addEventListener("click", newArticle);
  $("#import")?.addEventListener("click", importDraft);
  $$(".filters input,.filters select").forEach((e) => (e.oninput = drawTable));
  drawTable();
}
function drawTable() {
  let rows = content.filter(
    (r) =>
      (!$("#search").value ||
        `${r.data.title} ${r.data.summary} ${r.data.slug}`
          .toLowerCase()
          .includes($("#search").value.toLowerCase())) &&
      (!$("#category-filter").value ||
        r.data.categoryId === $("#category-filter").value) &&
      (!$("#tag-filter").value ||
        r.data.tagIds.includes($("#tag-filter").value)) &&
      (!$("#status-filter").value || r.status === $("#status-filter").value),
  );
  if ($("#sort").value === "title")
    rows.sort((a, b) => a.data.title.localeCompare(b.data.title));
  if ($("#sort").value === "oldest") rows.reverse();
  $("#result-count").textContent =
    `${rows.length} resource${rows.length === 1 ? "" : "s"}`;
  $("#article-table").innerHTML = rows.length
    ? `<div class="table-wrap"><table class="library"><thead><tr><th>Resource</th><th>Status</th><th>Category</th><th>Updated</th><th>Actions</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="title-cell">${isOwner() && !["archived", "deleted"].includes(r.status) ? `<label class="check-label"><input type="checkbox" data-select-row="${r.id}" aria-label="Select ${esc(r.data.title)}"> Select</label>` : ""}<strong>${esc(r.data.title)}</strong><small>/resources/${esc(r.data.slug)}/</small>${r.data.tagIds.map((id) => `<span class="badge">${esc(cat(id))}</span>`).join("")}</td><td>${badge(r.status)}<small>Knowledge: ${esc(r.knowledge.status)}</small>${r.published && r.status !== "published" ? "<small>Earlier version is live</small>" : ""}</td><td>${esc(cat(r.data.categoryId))}</td><td>${esc(date(r.updated_at))}</td><td><div class="row-actions"><button data-edit="${r.id}">${canWrite() ? "Edit" : "View"}</button><button data-preview="${r.id}">Preview</button>${canWrite() ? `<button data-row-action="duplicate" data-id="${r.id}">Duplicate</button>` : ""}${isOwner() ? (["archived", "deleted"].includes(r.status) ? `<button data-row-action="restore" data-id="${r.id}">Restore</button>${r.status === "archived" ? `<button class="danger" data-row-action="delete" data-id="${r.id}">Move to trash</button>` : ""}` : `<button data-row-action="archive" data-id="${r.id}">Archive</button>`) : ""}</div></td></tr>`).join("")}</tbody></table></div>`
    : '<div class="empty">No resources match these filters.</div>';
  $$("[data-select-row]").forEach(
    (c) =>
      (c.onchange = () =>
        ($("#bulk-archive").disabled = !$$("[data-select-row]:checked")
          .length)),
  );
  $("#bulk-archive")?.addEventListener("click", async () => {
    const selected = $$("[data-select-row]:checked").map((c) =>
      content.find((r) => r.id === c.dataset.selectRow),
    );
    if (
      !selected.length ||
      !confirm(
        `Archive ${selected.length} selected resources and revoke their public and knowledge access?`,
      )
    )
      return;
    try {
      await api("/api/bulk/archive", {
        method: "POST",
        body: {
          items: selected.map((r) => ({ id: r.id, version: r.version })),
        },
      });
      await refresh();
      drawTable();
      toast("Selected resources archived");
    } catch (e) {
      toast(e.message, true);
    }
  });
  bindEdits();
  $$("[data-preview]").forEach(
    (b) => (b.onclick = () => preview(b.dataset.preview)),
  );
  $$("[data-row-action]").forEach(
    (b) =>
      (b.onclick = async () => {
        const r = content.find((c) => c.id === b.dataset.id),
          action = b.dataset.rowAction;
        if (
          ["archive", "delete"].includes(action) &&
          !confirm(
            `${action === "archive" ? "Archive this resource and withdraw public and knowledge access?" : "Move this archived resource to recoverable trash?"}`,
          )
        )
          return;
        try {
          await api(`/api/content/${r.id}/${action}`, {
            method: "POST",
            body: { version: r.version },
          });
          await refresh();
          drawTable();
          toast("Resource " + action + " completed");
        } catch (e) {
          toast(e.message, true);
        }
      }),
  );
}
function newArticle() {
  modal(
    `<h2>Start a new resource</h2><form id="new-form"><label>Article title<input name="title" required maxlength="180" autofocus></label><label>URL slug<input name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*"><small>Lowercase words with hyphens. Categories never change this URL.</small></label><label>Primary category<select name="categoryId">${opt(taxonomy.filter((t) => t.kind === "category" && !t.archived))}</select></label><button class="primary">Create private draft</button></form>`,
    () => {
      $("#new-form [name=title]").oninput = (e) =>
        ($("#new-form [name=slug]").value = e.target.value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, ""));
      $("#new-form").onsubmit = async (e) => {
        e.preventDefault();
        try {
          const defaults = await api("/api/settings");
          const r = await api("/api/content", {
            method: "POST",
            body: {
              ...Object.fromEntries(new FormData(e.target)),
              body: "",
              audience: defaults.defaultAudience,
            },
          });
          dialog.close();
          await refresh();
          await openEditor(r.id);
          toast("Private draft created");
        } catch (e) {
          toast(e.message, true);
        }
      };
    },
  );
}
function importDraft() {
  modal(
    `<h2>Import a resource</h2><p>Uploads create private, unapproved drafts. Automated screening does not verify facts or authorize publication. Maximum 1 MB; PDFs are disabled. DOCX imports paragraph text; check layout and citations against the original.</p><button type="button" id="approved-library">Choose from approved collection</button><label>Article file<input type="file" id="import-file" accept=".docx,.md,.txt,.json"></label><label>Category for DOCX, MD or TXT<select id="import-category">${opt(taxonomy.filter(t=>t.kind==='category'&&!t.archived))}</select></label><label>Or paste approved article JSON<textarea id="import-json" rows="8" placeholder='{"format":"pooldocai-resource-v1","article":{…}}'></textarea></label><button class="primary" id="import-submit">Validate and create draft</button>`,
    () => {
      $("#approved-library").onclick = () => approvedLibrary().catch(e=>toast(e.message,true));
      $("#import-submit").onclick = async () => {
        const button = $('#import-submit');
        button.disabled = true;
        try {
          const file = $('#import-file').files[0];
          let result;
          if (file) {
            if (file.size > 1024*1024) throw new Error('Article file must be 1 MB or smaller');
            const bytes = new Uint8Array(await file.arrayBuffer());
            let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
            result = await api('/api/article-upload',{method:'POST',body:{name:file.name,base64:btoa(binary),categoryId:$('#import-category').value}});
          } else result = {article:await api('/api/import',{method:'POST',body:JSON.parse($('#import-json').value)})};
          const r = result.article;
          dialog.close();
          await refresh();
          await openEditor(r.id);
          toast("Imported as an unapproved draft");
          if (result.review) showAutomatedReview(result.review,result.source,result.notices);
        } catch (e) {
          toast(e.message, true);
        } finally { button.disabled = false; }
      };
    },
  );
}
async function openEditor(id) {
  if (dirty && !confirm("Leave unsaved changes?")) return;
  clearTimeout(saveTimer);
  if (saving) await saving;
  current = await api("/api/content/" + id);
  page = "editor";
  dirty = false;
  const d = current.data;
  main.innerHTML =
    title(
      "Make knowledge useful.",
      `Revision ${current.version} · ${current.published ? "A published version is live" : "Private working copy"}`,
      `<button id="back">← Library</button><button id="preview">Preview</button>`,
    ) +
    `<div class="save-bar">${badge(current.status)}<span id="save-status">All changes saved</span><span class="badge">Knowledge: ${esc(current.knowledge.status)}</span></div><div class="editor-layout"><section class="panel"><label>Article title<input id="title" class="editor-title" maxlength="180" value="${esc(d.title)}"></label><label>Summary<textarea id="summary" maxlength="500">${esc(d.summary)}</textarea></label><label for="body">Article content</label><div class="toolbar" role="toolbar" aria-label="Rich text formatting">${[
      ["formatBlock", "h2", "Heading 2"],
      ["formatBlock", "h3", "Heading 3"],
      ["formatBlock", "p", "Paragraph"],
      ["bold", "", "Bold"],
      ["italic", "", "Italic"],
      ["insertUnorderedList", "", "Bullets"],
      ["insertOrderedList", "", "Numbered"],
    ]
      .map(
        ([c, v, l]) =>
          `<button type="button" data-command="${c}" data-value="${v}">${l}</button>`,
      )
      .join(
        "",
      )}<button type="button" id="add-link">Link</button><button type="button" id="add-internal">Resource link</button><button type="button" id="add-image">Image</button><button type="button" id="add-download">Download</button><button type="button" id="add-table">Table</button><button type="button" id="add-callout">Callout</button><button type="button" id="add-warning">Safety warning</button></div><div id="body" class="rich-editor" contenteditable="${canWrite()}" role="textbox" aria-label="Article content" aria-multiline="true">${d.body}</div><details><summary>Sources & citations</summary><div><label>Source references<textarea id="sources" rows="5">${esc(d.sources.map((s) => `${s.label} | ${s.url}`).join("\n"))}</textarea><small>One source per line: Source title | https://original-source-url. Use Link in the toolbar for inline citations.</small></label></div></details></section><aside><section class="panel"><h2>Organization</h2><label>Primary category<select id="categoryId">${opt(
      taxonomy.filter((t) => t.kind === "category" && !t.archived),
      d.categoryId,
    )}</select></label><label>Topic tags<select id="tagIds" multiple size="6">${taxonomy
      .filter((t) => t.kind === "tag" && !t.archived)
      .map(
        (t) =>
          `<option value="${t.id}" ${d.tagIds.includes(t.id) ? "selected" : ""}>${esc(t.name)}</option>`,
      )
      .join(
        "",
      )}</select><small>Select any relevant topics.</small></label><label>Audience<select id="audience">${["homeowners", "professionals", "both"].map((v) => `<option ${v === d.audience ? "selected" : ""}>${v}</option>`).join("")}</select></label><label>Editorial collection<select id="collection"><option value="">None</option><option ${d.collection ? "selected" : ""}>PoolDocAI Progress Report</option></select></label><label class="check-label"><input id="featured" type="checkbox" ${d.featured ? "checked" : ""}> Featured resource</label><label>Author<input id="author" value="${esc(d.author)}"></label><label>Related resources<select id="relatedIds" multiple size="3">${content
      .filter((c) => c.id !== id && c.published)
      .map(
        (c) =>
          `<option value="${c.id}" ${d.relatedIds.includes(c.id) ? "selected" : ""}>${esc(c.data.title)}</option>`,
      )
      .join(
        "",
      )}</select></label></section><section class="panel"><h2>Equipment context</h2><label>Manufacturer (if applicable)<input id="manufacturer" value="${esc(d.manufacturer)}"></label><label>Model (if applicable)<input id="model" value="${esc(d.model)}"></label><label>Equipment category<input id="equipmentCategory" value="${esc(d.equipmentCategory)}" placeholder="Pump, filter, heater…"></label></section><section class="panel"><h2>Search & social</h2><label>URL slug<input id="slug" value="${esc(d.slug)}"><small>Published URL changes require separate authorization. Keep existing article URLs unchanged.</small></label><label>SEO title<input id="seo-title" value="${esc(d.seo.title)}" maxlength="180"></label><label>Meta description<small>If missing, screening can propose an extract from your article, but nothing is inserted or saved unless you approve it. Verify factual accuracy before publication.</small><textarea id="seo-description" maxlength="500">${esc(d.seo.description)}</textarea></label><label>Canonical URL<input id="seo-canonical" type="url" value="${esc(d.seo.canonical)}"></label><label>Open Graph title<input id="seo-ogTitle" value="${esc(d.seo.ogTitle)}"></label><label>Open Graph description<textarea id="seo-ogDescription">${esc(d.seo.ogDescription)}</textarea></label><label>Social image<input id="seo-image" value="${esc(d.seo.image)}" placeholder="/media/…"></label><button type="button" id="pick-social">Choose social image</button><label>Social image alt text<input id="seo-imageAlt" value="${esc(d.seo.imageAlt)}"></label><label>Featured image<input id="featuredImage" value="${esc(d.featuredImage)}" placeholder="/media/…"></label><button type="button" id="pick-featured">Choose featured image</button><label>Featured image alt text<input id="featuredImageAlt" value="${esc(d.featuredImageAlt)}"></label><label>Original publication date<input id="publishedAt" type="date" value="${esc(d.publishedAt?.slice(0, 10) || "")}"><small>Leave blank for first publication. Revision dates are recorded automatically.</small></label><label class="check-label"><input id="seo-noindex" type="checkbox" ${d.seo.noindex ? "checked" : ""}> Exclude from search indexing</label><div id="editor-warnings">${current.warnings.map((w) => `<p class="warning">${esc(w)}</p>`).join("")}</div></section></aside></div><section class="panel"><h2>Editorial workflow</h2><p class="muted">Save Draft stores your manual edits. Screening approvals, editorial review, and publication remain separate steps.</p><div class="actions">${canWrite() && !['scheduled','archived','deleted'].includes(current.status) ? '<button id="save" class="primary">Save Draft</button>' : ""}${canWrite() ? '<button data-action="review">Submit for Editorial Review</button>' : ""}${canReview() ? '<button data-action="approve">Approve for Publication</button>' : ""}${isOwner() ? `<button class="primary" data-action="publish">Publish</button><button data-action="unpublish">Unpublish</button><button id="schedule">Schedule publication</button>${current.status === "scheduled" ? '<button data-action="cancel-schedule">Cancel schedule</button>' : ""}` : ""}<button id="revisions">View Revision History</button></div><hr><h3>Diagnostic knowledge</h3><p class="muted">${esc(current.knowledge.classification?.replaceAll("_", " "))}<br>${esc(current.knowledge.verification_status || "Unverified")} ${current.knowledge.reviewed_at ? " · " + esc(date(current.knowledge.reviewed_at)) : ""}</p><div class="actions">${canWrite() ? '<button data-action="knowledge-submit">Submit for Knowledge Review</button>' : ""}${canReview() ? '<button id="knowledge-approve">Approve for Knowledge Base</button><button class="danger" data-action="knowledge-revoke">Revoke Knowledge Approval</button>' : ""}</div></section>`;
  $("#back").onclick = () => navigate("library");
  $("#save")?.addEventListener("click", () => {
    if (!dirty) return toast("No unsaved edits to save.");
    if (!confirm("Save your edits as a new private draft revision? Nothing will be published.")) return;
    save().then(() => toast("Approved edits saved as a private draft")).catch(e => toast(e.message, true));
  });
  $("#preview").onclick = () => {
    if (dirty) return toast("Unsaved changes: click Save Draft to approve those edits before previewing the saved revision.", true);
    preview(id);
  };
  $("#revisions").onclick = showRevisions;
  const reviewButton = document.createElement('button');
  reviewButton.id = 'automated-review';
  reviewButton.textContent = 'Screen saved draft — no changes';
  reviewButton.title = 'Read-only suggestions; you choose and approve any proposed corrections.';
  $('#revisions').before(reviewButton);
  const reviewHelp = document.createElement('p');
  reviewHelp.className = 'muted';
  reviewHelp.textContent = 'Read-only scan. Review highlighted passages, approve each desired correction, then save only approved changes. Unapproved changes stay untouched.';
  reviewButton.after(reviewHelp);
  reviewButton.onclick = async () => {
    reviewButton.disabled = true;
    try {
      if (dirty) throw Error('Save Draft explicitly first, or discard unsaved edits, before screening the saved revision.');
      const report = await api('/api/content/'+current.id+'/automated-review',{method:'POST',body:{version:current.version}});
      showAutomatedReview(report);
    } catch (error) { toast(error.message,true); }
    finally { reviewButton.disabled = false; }
  };
  $("#schedule")?.addEventListener("click", schedule);
  $("#knowledge-approve")?.addEventListener("click", knowledgeApprove);
  $$("[data-action]").forEach(
    (b) => (b.onclick = () => editorAction(b.dataset.action)),
  );
  if (
    !canWrite() ||
    ["scheduled", "archived", "deleted"].includes(current.status)
  ) {
    $$(
      ".editor-layout input,.editor-layout select,.editor-layout textarea,.toolbar button",
    ).forEach((e) => (e.disabled = true));
    $("#body").contentEditable = "false";
  }
  $$(
    ".editor-layout input,.editor-layout select,.editor-layout textarea,#body",
  ).forEach((e) => e.addEventListener("input", markDirty));
  $$("[data-command]").forEach((b) => {
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => {
      document.execCommand(b.dataset.command, false, b.dataset.value);
      markDirty();
    };
  });
  $("#body").addEventListener("paste", (e) => {
    e.preventDefault();
    document.execCommand(
      "insertText",
      false,
      e.clipboardData.getData("text/plain"),
    );
    markDirty();
  });
  let selection = null;
  function remember() {
    const s = getSelection();
    selection = s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
  }
  function insert(html) {
    $("#body").focus();
    if (selection) {
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(selection);
    }
    document.execCommand("insertHTML", false, html);
    markDirty();
  }
  $("#add-link").onmousedown = remember;
  $("#add-link").onclick = () =>
    modal(
      '<h2>Add a citation or link</h2><label>Link label<input id="link-label" required></label><label>HTTPS URL<input id="link-url" type="url" required></label><button class="primary" id="link-insert">Insert link</button>',
      () =>
        ($("#link-insert").onclick = () => {
          const href = $("#link-url").value;
          if (!/^https:\/\//.test(href)) return toast("Use an HTTPS URL", true);
          const label = $("#link-label").value;
          dialog.close();
          insert(`<a href="${esc(href)}">${esc(label || href)}</a>`);
        }),
    );
  $("#add-internal").onmousedown = remember;
  $("#add-internal").onclick = () =>
    modal(
      `<h2>Link to a published resource</h2><label>Resource<select id="internal-resource">${content
        .filter((c) => c.published)
        .map((c) => `<option value="${c.id}">${esc(c.data.title)}</option>`)
        .join(
          "",
        )}</select></label><button class="primary" id="internal-insert">Insert resource link</button>`,
      () =>
        ($("#internal-insert").onclick = () => {
          const r = content.find((c) => c.id === $("#internal-resource").value);
          if (!r) return;
          dialog.close();
          insert(
            `<a href="/resources/${esc(r.slug)}/">${esc(r.data.title)}</a>`,
          );
        }),
    );
  for (const [button, type] of [
    ["#add-image", "image"],
    ["#add-download", "download"],
  ]) {
    $(button).onmousedown = remember;
    $(button).onclick = () =>
      pickMedia(type, (m) => {
        if (type === "image")
          insert(
            `<figure><img src="/media/${m.id}" alt="${esc(m.alt)}"><figcaption>${esc(m.alt)}</figcaption></figure><p><br></p>`,
          );
        else
          insert(`<p><a href="/media/${m.id}">Download ${esc(m.name)}</a></p>`);
      });
  }
  $("#pick-social").onclick = () =>
    pickMedia("image", (m) => {
      $("#seo-image").value = "/media/" + m.id;
      $("#seo-imageAlt").value=m.alt;
      markDirty();
    });
  $("#pick-featured").onclick = () =>
    pickMedia("image", (m) => {
      $("#featuredImage").value = "/media/" + m.id;
      $("#featuredImageAlt").value = m.alt;
      markDirty();
    });
  $("#add-table").onclick = () => {
    remember();
    insert(
      '<table><caption>Table title</caption><thead><tr><th scope="col">Item</th><th scope="col">Notes</th></tr></thead><tbody><tr><td>Item</td><td>Notes</td></tr><tr><td>Item</td><td>Notes</td></tr></tbody></table><p><br></p>',
    );
  };
  $("#add-callout").onclick = () => {
    remember();
    insert(
      '<aside class="callout"><p><strong>Good to know.</strong> Add helpful context here.</p></aside><p><br></p>',
    );
  };
  $("#add-warning").onclick = () => {
    remember();
    insert(
      '<aside class="safety-callout"><p><strong>Safety warning.</strong> Describe the hazard and safe stopping point.</p></aside><p><br></p>',
    );
  };
  main.focus();
}
function reviewPassage(f) {
  const passage=String(f.excerpt||f.evidence||''), target=String(f.highlight||'');
  const at=target?passage.toLowerCase().indexOf(target.toLowerCase()):-1;
  if(at<0)return '<blockquote>'+esc(passage)+'</blockquote>';
  return '<blockquote>'+esc(passage.slice(0,at))+'<mark>'+esc(passage.slice(at,at+target.length))+'</mark>'+esc(passage.slice(at+target.length))+'</blockquote>';
}
function showAutomatedReview(report, source, notices = []) {
  const title=current?.id===report.articleId ? current.data.title : report.title || 'Unknown article';
  const proposalCards=(report.proposals||[]).map(p=>'<section class="panel"><button type="button" data-proposal="'+esc(p.id)+'" aria-pressed="false">Approve this change</button><p class="muted" data-approval-state="'+esc(p.id)+'">Unapproved — this passage stays unchanged.</p><p><strong>Field:</strong> '+esc(p.field)+'</p><p><strong>Why:</strong> '+esc(p.why)+'</p><p><strong>Current:</strong> <mark>'+esc(p.before)+'</mark></p>'+(p.context?'<p><strong>Exact passage:</strong></p>'+reviewPassage({excerpt:p.context,highlight:p.before}):'')+(
    p.kind==='verified-unit'
      ? '<label>Replacement unit (choose only after checking the source)<select data-unit="'+esc(p.id)+'"><option value="">Choose verified unit</option><option value="ppm">ppm</option><option value="mg/L">mg/L</option></select></label><label class="check-label"><input type="checkbox" data-source-verified="'+esc(p.id)+'"> I verified this exact reading against its original source.</label>'
      : '<p><strong>Proposed:</strong> '+esc(p.after)+'</p>'
  )+'</section>').join('');
  modal('<h2>Automated article review</h2><p><strong>Article:</strong> '+esc(title)+'</p><p><strong>Article ID:</strong> <code>'+esc(report.articleId)+'</code> · Saved version '+esc(report.version)+'</p><p>Checksum: <code>'+esc(report.checksum)+'</code></p><p role="status"><strong>Read-only screening: no draft edits or corrections were saved.</strong></p><p>Only selected changes you explicitly approve will be written as a new private draft revision. Other findings require your own source check and manual editing. Nothing here authorizes publication or diagnostic knowledge.</p>'+(
    source?'<p>Uploaded '+esc(source.type)+' · SHA-256: <code>'+esc(source.sha256)+'</code></p>':''
  )+notices.map(n=>'<p>'+esc(n)+'</p>').join('')+'<h3>Findings: exact passages and reasons</h3>'+(
    report.findings.map(f=>'<section class="panel"><h4>'+esc(f.area)+' · '+esc(f.severity)+'</h4><p><strong>Where:</strong> '+esc(f.field||'article')+'</p><p><strong>Passage needing review:</strong></p>'+reviewPassage(f)+'<p><strong>Why review this:</strong> '+esc(f.why||f.suggestion)+'</p><p><strong>Suggested next step:</strong> '+esc(f.suggestion)+'</p></section>').join('')||'<p>No rule triggered. Human technical and source verification is still necessary.</p>'
  )+'<h3>Proposed changes requiring your approval</h3>'+(
    proposalCards||'<p>No precise, safe edit can be proposed for these findings. Check highlighted passages and make manual edits in the editor.</p>'
  )+(proposalCards?'<button id="apply-review" class="primary">Apply ONLY approved changes &amp; save private draft</button>':'')+
  '<button id="return-to-editor">Return to editor without changes</button> <button id="download-article-review">Download report</button>',()=>{
    $('#return-to-editor').onclick=()=>{dialog.close();$('#body')?.focus();};
    $('#download-article-review').onclick=()=>{
      const blob=new Blob([JSON.stringify({...report,...(source?{uploadSource:source,notices}:{})},null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download='article-review-'+report.articleId+'-v'+report.version+'.json';
      a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    if(!proposalCards)return;
    document.querySelectorAll('[data-proposal]').forEach(button=>{
      button.onclick=()=>{
        const approved=button.getAttribute('aria-pressed')!=='true';
        button.setAttribute('aria-pressed',String(approved));
        button.textContent=approved?'Approved — undo':'Approve this change';
        button.classList.toggle('primary',approved);
        const state=document.querySelector('[data-approval-state="'+button.dataset.proposal+'"]');
        if(state)state.textContent=approved?'Approved for this batch. Nothing saved until final confirmation.':'Unapproved — this passage stays unchanged.';
      };
    });
    $('#apply-review').onclick=async()=>{
      const selected=[...document.querySelectorAll('[data-proposal][aria-pressed="true"]')],approvals=[];
      if(!selected.length)return toast('Choose at least one proposal; nothing has been changed.',true);
      if(dirty)return toast('Unsaved edits exist. Save or discard them first.',true);
      for(const el of selected){
        const id=el.dataset.proposal,p=report.proposals.find(x=>x.id===id);
        if(!p) return toast('Review proposal is no longer available.',true);
        if(p.kind==='verified-unit'){
          const verifiedUnit=document.querySelector('[data-unit="'+id+'"]').value;
          const sourceVerified=document.querySelector('[data-source-verified="'+id+'"]').checked;
          if(!verifiedUnit||!sourceVerified)return toast('Verify the original reading and select a replacement unit for each technical change.',true);
          approvals.push({id,verifiedUnit,sourceVerified});
        } else approvals.push({id});
      }
      const differences=approvals.map(a=>{
        const p=report.proposals.find(x=>x.id===a.id);
        const target=p.kind==='verified-unit'?p.before.match(/^\d+(?:\.\d+)?/)[0]+' '+a.verifiedUnit:p.after;
        return p.field+':\nBEFORE: '+p.before+'\nAFTER: '+target;
      }).join('\n\n');
      if(!confirm('Approve and SAVE the following exact changes as ONE new private draft revision?\n\n'+differences+'\n\nNo publication or knowledge approval.'))return;
      const button=$('#apply-review');button.disabled=true;
      try{
        const result=await api('/api/content/'+report.articleId+'/apply-review',{method:'POST',body:{version:report.version,checksum:report.checksum,approvals}});
        dialog.close();
        await openEditor(result.article.id);
        toast('Your '+result.applied.length+' approved change(s) were saved as a private draft.');
      } catch(e){toast(e.message,true);}
      finally{button.disabled=false;}
    };
  });
}

function collect() {
  const d = { ...current.data };
  for (const id of [
    "title",
    "summary",
    "slug",
    "categoryId",
    "audience",
    "collection",
    "author",
    "featuredImage",
    "featuredImageAlt",
    "manufacturer",
    "model",
    "equipmentCategory",
  ])
    d[id] = $("#" + id).value;
  d.body = $("#body").innerHTML;
  d.sources = document.querySelector("textarea#sources")
    .value.split(/\r?\n/)
    .map((line, index) => ({ text: line.trim(), number: index + 1 }))
    .filter(({ text }) => text)
    .map(({ text, number }) => {
      const separator = text.indexOf("|");
      if (separator < 1) {
        throw new Error(`Source line ${number}: use Source name | https://source-url`);
      }
      const label = text.slice(0, separator).trim();
      const url = text.slice(separator + 1).trim();
      if (!label || label.length > 300 || !/^https:\/\/[^\s<>"'\\\\]+$/i.test(url) || url.length > 2048) {
        throw new Error(`Source line ${number}: enter a name and a valid HTTPS URL`);
      }
      return { label, url };
    });
  d.tagIds = [...$("#tagIds").selectedOptions].map((o) => o.value);
  if($("#primaryTopicId"))d.discovery=Object.fromEntries(["primaryTopicId","guideTypeId","audienceTagId"].map(k=>[k,$("#"+k).value||null]));
  d.relatedIds = [...$("#relatedIds").selectedOptions].map((o) => o.value);
  d.featured = $("#featured").checked;
  d.publishedAt = $("#publishedAt").value || null;
  d.seo = {};
  for (const k of [
    "title",
    "description",
    "canonical",
    "ogTitle",
    "ogDescription",
    "image",
    "imageAlt",
  ])
    d.seo[k] = $("#seo-" + k).value;
  d.seo.noindex = $("#seo-noindex").checked;
  delete d.legacyHtml;
  return d;
}
function markDirty() {
  dirty = true;
  editGeneration++;
  $("#save-status").textContent = "Unsaved changes";
  clearTimeout(saveTimer); // No automatic save: explicit user approval is required.
}
async function save() {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!dirty) return current;
  const generation = editGeneration,
    payload = collect();
  $("#save-status").textContent = "Saving…";
  saving = api("/api/content/" + current.id, {
    method: "PUT",
    body: { ...payload, version: current.version },
  })
    .then((r) => {
      current = r;
      if (generation === editGeneration && !payload.seo.description && r.data.seo.description)
        $('#seo-description').value = r.data.seo.description;
      if (generation === editGeneration) dirty = false;
      $("#save-status").textContent = dirty
        ? "New changes waiting to save"
        : "All changes saved · " + new Date().toLocaleTimeString();
      $("#editor-warnings").innerHTML = r.warnings
        .map((w) => `<p class="warning">${esc(w)}</p>`)
        .join("");
      return r;
    })
    .catch((e) => {
      $("#save-status").textContent =
        "Save failed — your changes are still here";
      throw e;
    })
    .finally(() => (saving = null));
  await saving;
  return current; // Edits made during the request remain unsaved until another explicit Save Draft click.
}
async function editorAction(action) {
  try {
    if(dirty) throw Error("Save Draft explicitly before changing editorial workflow.");
    if(action === "publish" && me?.ownerPublishing) return await requestOwnerPublication();
    if (
      ["publish", "unpublish", "knowledge-revoke"].includes(action) &&
      !confirm(
        action === "publish"
          ? "Publish this approved revision publicly?"
          : action === "unpublish"
            ? "Remove the public page? Knowledge access will also be revoked."
            : "Revoke diagnostic knowledge eligibility immediately?",
      )
    )
      return;
    current = await api(`/api/content/${current.id}/${action}`, {
      method: "POST",
      body: { version: current.version },
    });
    await openEditor(current.id);
    toast(action.replaceAll("-", " ") + " completed");
  } catch (e) {
    toast(e.message, true);
  }
}
function preview(id) {
  modal(
    `<h2>Private preview</h2><div class="actions"><button id="desktop-preview">Desktop</button><button id="mobile-preview">Mobile · 320px</button><a class="button" href="/preview/${id}" target="_blank" rel="noopener">Open full preview ↗</a></div><p class="muted">Only authenticated editorial users can view this draft.</p><iframe class="preview-frame" id="preview-frame" title="Private article preview" src="/preview/${id}"></iframe>`,
    () => {
      $("#desktop-preview").onclick = () =>
        $("#preview-frame").classList.remove("mobile");
      $("#mobile-preview").onclick = () =>
        $("#preview-frame").classList.add("mobile");
    },
  );
}
async function showRevisions() {
  try {
    if(dirty) throw Error("Save Draft explicitly before opening revision history.");
    const rows = await api(`/api/content/${current.id}/revisions`);
    modal(
      `<h2>Revision history</h2><p>Restoring creates a new draft revision. It does not publish or restore knowledge eligibility.</p>${rows.map((r) => `<div class="revision-item"><div><strong>Revision ${r.version}</strong> · ${esc(r.reason)}<br><small>${esc(date(r.created_at))} · ${esc(r.data.title)}</small></div>${canWrite() ? `<button data-restore-revision="${r.id}">Restore Version</button>` : ""}</div>`).join("")}`,
      () => {
        $$("[data-restore-revision]").forEach(
          (b) =>
            (b.onclick = async () => {
              if (!confirm("Restore this version as a working draft?")) return;
              try {
                const r = await api(`/api/content/${current.id}/rollback`, {
                  method: "POST",
                  body: {
                    version: current.version,
                    revisionId: b.dataset.restoreRevision,
                  },
                });
                dialog.close();
                await openEditor(r.id);
                toast(
                  "Revision restored as draft; knowledge approval remains revoked",
                );
              } catch (e) {
                toast(e.message, true);
              }
            }),
        );
      },
    );
  } catch (e) {
    toast(e.message, true);
  }
}
function schedule() {
  modal(
    '<h2>Schedule approved publication</h2><p>Choose a future time in your device’s timezone. The stored time uses UTC.</p><label>Publication date and time<input id="schedule-time" type="datetime-local" required></label><button id="schedule-confirm" class="primary">Schedule publication</button>',
    () =>
      ($("#schedule-confirm").onclick = async () => {
        try {
          if(dirty) throw Error("Save Draft explicitly before scheduling publication.");
          await api(`/api/content/${current.id}/schedule`, {
            method: "POST",
            body: {
              version: current.version,
              scheduledAt: new Date($("#schedule-time").value).toISOString(),
            },
          });
          dialog.close();
          await openEditor(current.id);
          toast("Publication scheduled");
        } catch (e) {
          toast(e.message, true);
        }
      }),
  );
}
function knowledgeApprove() {
  const d = current.data;
  modal(
    `<h2>Approve for diagnostic knowledge</h2><p>Publication is not technical verification. This approval applies only to revision ${current.version}. Editing or withdrawing the article revokes eligibility.</p><label>Knowledge classification<select id="k-class">${["general_education", "homeowner_safe_observation", "manufacturer_supported_diagnostic", "technician_reviewed_diagnostic", "verified_repair_procedure", "unverified_hypothesis"].map((c) => `<option value="${c}">${esc(c.replaceAll("_", " "))}</option>`).join("")}</select></label><label>Supporting source<select id="k-source">${d.sources.map((s) => `<option value="${esc(s.url)}">${esc(s.label)} — ${esc(s.url)}</option>`).join("")}</select></label><label>Evidence type<select id="k-type"><option value="authority">Recognized safety / technical authority</option><option value="manufacturer">Original manufacturer documentation</option></select></label><label>Evidence excerpt<textarea id="k-excerpt" placeholder="Specific passage or section supporting this classification" required></textarea></label><label>Technician verification record (source URL, for actionable guidance)<select id="k-tech"><option value="">Not applicable to background education</option>${d.sources.map((s) => `<option value="${esc(s.url)}">${esc(s.label)}</option>`).join("")}</select></label><label>Verification method<textarea id="k-method" placeholder="Who verified the procedure, against which equipment and manual revision?"></textarea></label><label class="check-label"><input type="checkbox" id="k-human"> I personally verified the technical guidance and recorded the evidence.</label><label>Section IDs (optional, comma separated)<input id="k-sections"><small>Leave empty to approve the whole article. Section IDs are in the knowledge export contract.</small></label><button class="primary" id="k-confirm">Approve this revision for Knowledge Base</button>`,
    () =>
      ($("#k-confirm").onclick = async () => {
        try {
          if(dirty) throw Error("Save Draft explicitly before reviewing knowledge eligibility.");
          const evidence = [
            {
              url: $("#k-source").value,
              type: $("#k-type").value,
              excerpt: $("#k-excerpt").value,
            },
          ];
          if ($("#k-tech").value)
            evidence.push({
              url: $("#k-tech").value,
              type: "technician_verification",
              excerpt: $("#k-method").value,
            });
          await api(`/api/content/${current.id}/knowledge-approve`, {
            method: "POST",
            body: {
              version: current.version,
              classification: $("#k-class").value,
              evidence,
              humanVerified: $("#k-human").checked,
              verificationMethod: $("#k-method").value,
              sectionIds: $("#k-sections")
                .value.split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            },
          });
          dialog.close();
          await openEditor(current.id);
          toast(
            "Knowledge eligibility approved. Indexing remains disconnected.",
          );
        } catch (e) {
          toast(e.message, true);
        }
      }),
  );
}
function taxonomies() {
  main.innerHTML =
    title(
      "Organize with intention.",
      "Categories and topics help people find the right guide. Article URLs stay stable.",
    ) +
    `<div class="notice">Merging updates assignments and revokes affected knowledge approvals. Reassign resources before archiving a category or topic. These actions never create empty public landing pages.</div><div class="two-columns">${[
      "category",
      "tag",
    ]
      .map(
        (kind) =>
          `<section class="panel"><div class="panel-heading"><h2>${kind === "category" ? "Primary categories" : "Topic tags"}</h2>${isOwner() ? `<button data-new-tax="${kind}">＋ Add</button>` : ""}</div>${taxonomy
            .filter((t) => t.kind === kind)
            .map(
              (t) =>
                `<div class="taxonomy-item"><strong>${esc(t.name)} ${t.archived ? badge("archived") : ""}</strong>${isOwner() ? `<button data-tax="${t.id}" data-tax-action="rename">Rename</button><button data-tax="${t.id}" data-tax-action="up" aria-label="Move ${esc(t.name)} up">↑</button><button data-tax="${t.id}" data-tax-action="down" aria-label="Move ${esc(t.name)} down">↓</button><button data-tax="${t.id}" data-tax-action="merge">Merge</button><button data-tax="${t.id}" data-tax-action="archive">${t.archived ? "Restore" : "Archive"}</button>` : ""}</div>`,
            )
            .join("")}</section>`,
      )
      .join("")}</div>`;
  $$("[data-new-tax]").forEach(
    (b) =>
      (b.onclick = () =>
        modal(
          `<h2>Add ${b.dataset.newTax}</h2><label>Name<input id="tax-name" maxlength="100"></label><button class="primary" id="tax-create">Create</button>`,
          () =>
            ($("#tax-create").onclick = async () => {
              try {
                await api("/api/taxonomy", {
                  method: "POST",
                  body: { kind: b.dataset.newTax, name: $("#tax-name").value },
                });
                dialog.close();
                await navigate("taxonomy");
              } catch (e) {
                toast(e.message, true);
              }
            }),
        )),
  );
  $$("[data-tax]").forEach(
    (b) =>
      (b.onclick = async () => {
        const t = taxonomy.find((t) => t.id === b.dataset.tax),
          action = b.dataset.taxAction;
        const update = async (body) => {
          await api("/api/taxonomy/" + t.id, { method: "PUT", body });
          await navigate("taxonomy");
        };
        try {
          if (action === "archive") {
            if (!confirm(`${t.archived ? "Restore" : "Archive"} ${t.name}?`))
              return;
            await update({ archived: !t.archived });
          }
          if (action === "up" || action === "down") {
            const same = taxonomy.filter((x) => x.kind === t.kind),
              i = same.findIndex((x) => x.id === t.id),
              other = same[i + (action === "up" ? -1 : 1)];
            if (other) {
              await api("/api/taxonomy/" + other.id, {
                method: "PUT",
                body: { position: t.position },
              });
              await update({ position: other.position });
            }
          }
          if (action === "rename")
            modal(
              `<h2>Rename ${esc(t.kind)}</h2><label>Name<input id="tax-rename" value="${esc(t.name)}"></label><button class="primary" id="tax-save">Save name</button>`,
              () =>
                ($("#tax-save").onclick = async () => {
                  try {
                    await update({ name: $("#tax-rename").value });
                    dialog.close();
                  } catch (e) {
                    toast(e.message, true);
                  }
                }),
            );
          if (action === "merge")
            modal(
              `<h2>Merge ${esc(t.name)}</h2><p>All assignments will move to the target. The source will be archived. Article URLs remain unchanged.</p><label>Merge into<select id="tax-target">${opt(taxonomy.filter((x) => x.kind === t.kind && x.id !== t.id && !x.archived))}</select></label><button class="danger" id="tax-merge">Merge assignments</button>`,
              () =>
                ($("#tax-merge").onclick = async () => {
                  if (
                    !confirm(
                      "Merge all assignments and revoke affected knowledge approvals?",
                    )
                  )
                    return;
                  try {
                    await update({ mergeInto: $("#tax-target").value });
                    dialog.close();
                  } catch (e) {
                    toast(e.message, true);
                  }
                }),
            );
        } catch (e) {
          toast(e.message, true);
        }
      }),
  );
}
async function upload(file, alt = "") {
  if (!file) throw Error("Choose a file");
  if (file.size > 3 * 1024 * 1024) throw Error("Image exceeds 3 MB");
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw Error("Only JPEG, PNG and WebP images are enabled");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return api("/api/media", {
    method: "POST",
    body: { name: file.name, mime: file.type, alt, base64: btoa(binary) },
  });
}
async function mediaLibrary() {
  const media = await api("/api/media");
  main.innerHTML =
    title(
      "A useful media library.",
      "Authentic media only. Rights, attribution and technical relevance must be verified before public use. New imagery remains pending review. PDF/document uploads and cloud Storage remain gated.",
    ) +
    `<section class="panel">${canWrite() ? '<form id="upload-form"><div class="two-columns"><label>Upload image<input id="upload-file" type="file" accept="image/jpeg,image/png,image/webp" required><small>Maximum 3 MB. Images are decoded and re-encoded to metadata-free WebP. PDF and documents are disabled.</small></label><label>Alternative text<input id="upload-alt" maxlength="300" placeholder="Describe the image for someone who cannot see it"></label></div><button class="primary">Upload securely</button></form><hr>' : ""}<div class="media-grid">${media.map((m) => `<article class="media-card">${m.mime.startsWith("image/") ? `<img src="/media/${m.id}" alt="${esc(m.alt)}">` : "<p>▤ Download</p>"}<h3>${esc(m.name)}</h3><p class="muted">${Math.ceil(m.size / 1024)} KB · ${esc(m.mime)}</p><label>Alt text<input data-alt="${m.id}" value="${esc(m.alt)}"></label><button data-media-save="${m.id}">Save metadata</button><a class="button" href="/media/${m.id}" target="_blank" rel="noopener">View</a><button data-media-rights="${m.id}" data-checksum="${esc(m.checksum)}">Image rights & relevance</button><button class="danger" data-media-archive="${m.id}">Archive image</button><button data-copy="/media/${m.id}">Copy URL</button></article>`).join("") || '<p class="muted">Upload your first image.</p>'}</div></section>`;
  $("#upload-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = e.target.querySelector("button");
    b.disabled = true;
    try {
      await upload($("#upload-file").files[0], $("#upload-alt").value);
      await mediaLibrary();
      toast("File validated and saved");
    } catch (e) {
      toast(e.message, true);
    } finally {
      b.disabled = false;
    }
  });
  $$("[data-media-save]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await api("/api/media/" + b.dataset.mediaSave, {
            method: "PUT",
            body: { alt: $(`[data-alt="${b.dataset.mediaSave}"]`).value },
          });
          toast("Media metadata saved");
        } catch (e) {
          toast(e.message, true);
        }
      }),
  );
  $$("[data-copy]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy);
          toast("Media URL copied");
        } catch {
          toast("URL: " + b.dataset.copy);
        }
      }),
  );
}
async function approvedLibrary(){
 const rows=await api('/api/approved-resources');
 modal(`<h2>Approved editorial collection</h2><p>Choose one resource. Importing preserves its source history and creates a protected draft; it does not authorize publication.</p><label>Resource<select id="approved-choice">${rows.map((r,i)=>`<option value="${i}">${esc(r.resourceId)} · ${esc(r.title)}${r.assetStatus!=='not-required'?' · Assets pending':''}</option>`).join('')}</select></label><button class="primary" id="approved-import-one">Import selected draft</button>`,()=>{
  $('#approved-import-one').onclick=async()=>{const button=$('#approved-import-one');button.disabled=true;try{const r=rows[Number($('#approved-choice').value)];const imported=await api('/api/approved-resources',{method:'POST',body:{sourceIdentity:r.sourceIdentity,sourceChecksum:r.sourceChecksum}});dialog.close();await refresh();await openEditor(imported.id);toast('Approved source imported as a protected draft');}catch(e){toast(e.message,true);button.disabled=false;}};
 });
}
async function verifyPublishedDelivery(slug, title) {
  // This checks the real same-origin website route. An acknowledged database
  // release is NOT sufficient evidence that Vercel serves the published URL.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug || ""))) {
    return { ok: false, reason: "Invalid public resource slug" };
  }
  const path = `/resources/${slug}/`;
  try {
    const response = await fetch(path, {
      method: "GET", cache: "no-store", credentials: "same-origin", redirect: "manual",
    });
    if (response.status !== 200) return { ok: false, reason: `HTTP ${response.status}`, path };
    if (!/^text\/html(?:;|$)/i.test(response.headers.get("content-type") || "")) {
      return { ok: false, reason: "Expected HTML response", path };
    }
    const html = await response.text();
    // Prevent a generic page or a stale static fallback from being called verified.
    // Exact immutable-revision checks remain on the server/database release gate.
    const canonical = `https://pooldocai.com/resources/${slug}/`;
    const htmlTitle = String(title || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    if (!html.includes(canonical) || (title && !html.includes(htmlTitle) && !html.includes(title))) {
      return { ok: false, reason: "Unexpected resource page or canonical URL", path };
    }
    return { ok: true, path };
  } catch {
    return { ok: false, reason: "Website request failed", path };
  }
}
async function requestOwnerPublication(){
  const info=await api(`/api/content/${current.id}/release`);
  const blocked=info.blocks?.length||!info.enabled||info.state!=='approved';
  const commandId=crypto.randomUUID();
  modal(`<h2>Authorize this revision</h2><p>This is a separate release decision for revision ${esc(info.revisionId)}.</p><p><strong>Destination: ${esc(info.destination)}</strong> · /resources/${esc(current.data.slug)}/</p><p>Content checksum: <code>${esc(info.checksum)}</code></p>${(info.blocks||[]).map(b=>`<p class="warning">${esc(b.reason)}</p>`).join('')}${info.state!=='approved'?'<p class="warning">Complete editorial review and approval first.</p>':''}${info.holdReason?`<p class="warning">${esc(info.holdReason)}</p><label class="check-label"><input id="release-hold" type="checkbox"> I reviewed this source and explicitly authorize release of this revision. Mandatory asset blocks remain enforced.</label>`:''}<label class="check-label"><input id="release-confirm" type="checkbox"> Publish exactly this revision to ${esc(info.destination)}. This grants no diagnostic knowledge eligibility.</label><button class="primary" id="release-submit" ${blocked?'disabled':''}>Authorize revision and publish</button>`,()=>{
    $('#release-submit').onclick=async()=>{
      if(!$('#release-confirm').checked||($('#release-hold')&&!$('#release-hold').checked))return toast('Confirm this revision and its editorial hold before publishing',true);
      const button=$('#release-submit');button.disabled=true;
      try{
        const published=await api(`/api/content/${current.id}/publish`,{method:'POST',body:{commandId,version:info.version,revisionId:info.revisionId,checksum:info.checksum,destination:info.destination,confirm:true,holdChecksum:info.holdChecksum}});
        dialog.close();
        const delivery=await verifyPublishedDelivery(published.data?.slug, published.data?.title);
        await openEditor(published.id);
        if(delivery.ok) toast(`Authorized revision published; website URL verified: ${delivery.path}`);
        else toast(`Database published, but website reachability FAILED (${delivery.reason}). Check ${delivery.path||'the public route'} before announcing publication.`,true);
      }catch(e){toast(e.message,true);button.disabled=false;}
    };
  });
}
async function pickMedia(type, choose) {
  try {
    const media = (await api("/api/media")).filter((m) =>
      type === "image"
        ? m.mime.startsWith("image/")
        : !m.mime.startsWith("image/"),
    );
    modal(
      `<h2>Choose ${type === "image" ? "an image" : "a download"}</h2><p>Upload files in the Media library first. Images require alt text before publication.</p><div class="media-grid">${media.map((m) => `<button data-choose-media="${m.id}">${m.mime.startsWith("image/") ? `<img src="/media/${m.id}" width="80" alt="${esc(m.alt)}">` : ""}${esc(m.name)}</button>`).join("") || "<p>No matching files yet.</p>"}</div>`,
      () =>
        $$("[data-choose-media]").forEach(
          (b) =>
            (b.onclick = () => {
              dialog.close();
              choose(media.find((m) => m.id === b.dataset.chooseMedia));
            }),
        ),
    );
  } catch (e) {
    toast(e.message, true);
  }
}
function seoManager() {
  main.innerHTML =
    title(
      "Make every resource discoverable.",
      "Metadata checks for your editorial library. External source reachability is not automatically fetched.",
    ) +
    content
      .filter((r) => r.status !== "deleted")
      .map(
        (r) =>
          `<section class="panel"><div class="panel-heading"><h2>${esc(r.data.title)}</h2><button data-edit="${r.id}">Edit SEO</button></div><p class="muted">/resources/${esc(r.data.slug)}/ · ${r.data.seo.noindex ? "Excluded from indexing" : "Indexable when published"}</p>${r.warnings.map((w) => `<p class="warning">${esc(w)}</p>`).join("") || "<p>✓ Essential metadata is present.</p>"}</section>`,
      )
      .join("");
  bindEdits();
}
function knowledgeList() {
  main.innerHTML =
    title(
      "Useful information. Earned trust.",
      "Public publication does not approve content for diagnostic retrieval.",
      isOwner()
        ? '<a class="button" href="/api/knowledge/export" target="_blank" rel="noopener">Export approved knowledge</a>'
        : "",
    ) +
    `<div class="notice">Diagnostic indexing is disconnected. Exports contain only explicitly approved current revisions. Edits, archive, deletion, and revocation immediately exclude material from new exports.</div>` +
    content
      .filter((r) => r.status !== "deleted")
      .map(
        (r) =>
          `<section class="panel"><div class="panel-heading"><h2>${esc(r.data.title)}</h2><button data-edit="${r.id}">Review evidence</button></div>${badge(r.status)} ${badge(r.knowledge.status)}<p class="muted">${esc(r.knowledge.classification?.replaceAll("_", " "))} · Revision ${r.version}</p>${r.knowledge.reviewed_at ? `<p>Reviewed ${esc(date(r.knowledge.reviewed_at))} by ${esc(r.knowledge.reviewer_id)}<br>Approved revision ${esc(r.knowledge.revision_id)}</p>` : ""}<p>${r.data.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join(" · ")}</p></section>`,
      )
      .join("");
  bindEdits();
}
async function settings() {
  const s = await api("/api/settings");
  main.innerHTML =
    title(
      "Workspace settings",
      "Editorial defaults and a clear path to future integration.",
    ) +
    `<div class="two-columns"><section class="panel"><h2>Publication defaults</h2><form id="settings-form"><label>Default audience<select name="defaultAudience">${["homeowners", "professionals", "both"].map((v) => `<option ${v === s.defaultAudience ? "selected" : ""}>${v}</option>`).join("")}</select></label><p>Sources and metadata are required for publication. New imports always enter as drafts.</p><label>Future authentication issuer (documentation only)<input name="integrationIssuer" value="${esc(s.integrationIssuer)}" placeholder="Not connected"></label><p class="muted">IndexNow is disabled. No autonomous publication or embedding calls are enabled.</p>${isOwner() ? '<button class="primary">Save settings</button>' : ""}</form></section><section class="panel"><h2>Backup & export</h2><p>Download the complete editorial export, including revisions, redirects, knowledge approvals, and audit events. Media bytes require a separate server backup.</p>${isOwner() ? '<a class="button" href="/api/export">Download editorial backup</a>' : ""}<h2>Editorial permissions</h2>${Object.entries(
      s.permissions,
    )
      .map(
        ([role, perms]) =>
          `<p><strong>${esc(role)}</strong><br><span class="muted">${esc(perms.join(", "))}</span></p>`,
      )
      .join(
        "",
      )}<p class="notice">Only the initial owner is provisioned. Future role assignments require a reviewed authentication integration; the browser cannot grant roles.</p></section></div>`;
  $("#settings-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/settings", {
        method: "PUT",
        body: Object.fromEntries(new FormData(e.target)),
      });
      toast("Settings saved");
    } catch (e) {
      toast(e.message, true);
    }
  };
}
api("/api/me")
  .then((u) => {
    me = u;
    $("#identity").textContent = `${u.email} · ${u.role}`;
    const initial = location.hash.slice(1);
    return navigate(cmsPages.has(initial) ? initial : "dashboard", { fromHistory: true });
  })
  .catch((e) => toast(e.message, true));

main.addEventListener('click',async event=>{const button=event.target.closest('[data-media-archive]');if(!button)return;if(!confirm('Archive this image? Images referenced by a published revision cannot be archived.'))return;button.disabled=true;try{await api('/api/media/'+button.dataset.mediaArchive,{method:'DELETE'});await mediaLibrary();toast('Image archived');}catch(error){toast(error.message,true);button.disabled=false;}});

main.addEventListener('click',event=>{const button=event.target.closest('[data-media-rights]');if(button)imageRights(button).catch(error=>toast(error.message,true));});
async function imageRights(button){
 const id=button.dataset.mediaRights,rows=await api('/api/media/'+id+'/rights'),r=rows[0]||{},image=button.closest('article')?.querySelector('img');
 const d=r.details||r,version=r.version||0;
 const field=(key,label,type='text',fallback='')=>`<label>${label}<input name="${key}" type="${type}" value="${esc(d[key]??fallback)}" required></label>`;
 modal(`<h2>Image rights & relevance</h2><p>Status: ${esc(r.status||'pending review')}. Synthetic photographs are prohibited. Approval covers this exact image checksum.</p><form id="rights-form"><label>Authenticity<select name="authenticity"><option value="authentic-photograph">Authentic photograph</option><option value="official-diagram">Official diagram</option><option value="brand-graphic">Brand graphic</option></select></label><label>Source<select name="sourceType">${['pooldocai-original','manufacturer','licensed-professional','licensed-library','permitted-contributor','brand-graphic'].map(v=>`<option ${d.sourceType===v?'selected':''}>${v}</option>`).join('')}</select></label>${field('sourceUrl','Source URL','url')}${field('attribution','Required attribution')}${field('license','License / permitted usage')}${field('permissionReference','Permission record reference')}${field('copyright','Copyright owner')}${field('alt','Descriptive alternative text','text',image?.alt||'')}${field('width','Pixel width (verify against original)','number',image?.naturalWidth||'')}${field('height','Pixel height (verify against original)','number',image?.naturalHeight||'')}<label>Permission expiry (optional)<input name="expiresAt" type="datetime-local" value="${esc(d.expiresAt?.slice(0,16)||'')}"></label><p>Checksum: <code>${esc(button.dataset.checksum)}</code></p>${canWrite()?'<button class="primary" type="submit">Save pending review</button>':''}</form>${isOwner()&&r.status==='pending'?'<label class="check-label"><input id="rights-verified" type="checkbox"> I verified authenticity, usage rights, attribution, accessibility and technical relevance against the original image.</label><button id="rights-approve">Approve this image version</button>':''}${isOwner()&&r.status==='approved'?'<button class="danger" id="rights-revoke">Revoke image approval</button>':''}`,()=>{
  $('#rights-form [name=authenticity]').value=d.authenticity||'authentic-photograph';
  $('#rights-form').onsubmit=async event=>{event.preventDefault();try{const values=Object.fromEntries(new FormData(event.target));values.width=Number(values.width);values.height=Number(values.height);values.checksum=button.dataset.checksum;if(!values.expiresAt)delete values.expiresAt;else values.expiresAt=new Date(values.expiresAt).toISOString();await api('/api/media/'+id+'/rights',{method:'POST',body:{commandId:crypto.randomUUID(),version,action:'submit',details:values}});dialog.close();toast('Image saved as pending rights review');}catch(error){toast(error.message,true);}};
  $('#rights-approve')?.addEventListener('click',async()=>{if(!$('#rights-verified').checked)return toast('Complete the explicit human review first',true);try{await api('/api/media/'+id+'/rights',{method:'POST',body:{commandId:crypto.randomUUID(),version,action:'approve',details:{humanVerified:true}}});dialog.close();toast('Exact image version approved');}catch(error){toast(error.message,true);}});
  $('#rights-revoke')?.addEventListener('click',async()=>{const reason=prompt('Why is this image approval being withdrawn?');if(!reason?.trim())return;try{await api('/api/media/'+id+'/rights',{method:'POST',body:{commandId:crypto.randomUUID(),version,action:'revoke',details:{reason}}});dialog.close();toast('Image eligibility revoked');}catch(error){toast(error.message,true);}});
 });
}
