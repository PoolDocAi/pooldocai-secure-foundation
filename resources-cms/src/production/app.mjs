import {publicNavigation,addNavigationBreadcrumbs} from '../platform/navigation.mjs';
import { membership, sessionToken, signInWithPassword, verifiedIdentity } from "./auth.mjs";
import { compatibilityRoute } from "./compat-api.mjs";
import { productionRuntime } from "./runtime.mjs";
import { PrivateStorage } from "./storage.mjs";
import { commandRoute, healthRoute, loginRoute, logoutRoute, mediaReadRoute, mediaUploadRoute, refreshRoute } from "./serverless.mjs";
import { renderPublicArticle, renderPublicHub, renderSitemap } from "./render.mjs";
import { readFileSync } from "node:fs";
import { editorialAsset } from "../editorial-assets.mjs";
import { recoveryRoutes } from "./recovery.mjs";

import {catalogSitemap,addPublicCapabilities} from '../platform/catalog.mjs';
import {platformRoutes,platformPath} from '../platform/routes.mjs';
import {SupabasePlatformAdapter} from './platform-adapter.mjs';
import {requireOrigin,requireCsrf} from './auth.mjs';
const adminHtml = readFileSync(new URL("../../public/admin.html", import.meta.url), "utf8");

const html = (value, status = 200, extra = {}) => new Response(value, { status, headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", ...extra } });

export function createProductionApp(runtime = productionRuntime()) {
  const { config, db } = runtime;
  if(config.features?.discovery)db.useVerifiedCatalog=true;
  if(config.features?.taxonomy)db.platformEnabled=true;
  if(config.ownerPublishing)db.ownerPublishing=true;
  if(config.features?.folders)db.navigationEnabled=true;
  const authConfig = { url: config.supabaseUrl, publishableKey: config.publishableKey };
  const identity = async (request) => {
    const accessToken = sessionToken(request);
    return { ...(await verifiedIdentity(accessToken, authConfig)), accessToken };
  };
  const memberRole = (user) => membership(db, user);
  const storage = new PrivateStorage({ url: config.supabaseUrl, publishableKey: config.publishableKey });
  const login = loginRoute({ origin: config.origin, signIn: (email, password) => signInWithPassword(email, password, authConfig), memberRole,
    onIdentityVerified: ({ id }) => {
      if (id === config.recoveryOwnerId) console.info('cms_owner_identity_verified', { id });
    },
  });
  const logout = logoutRoute({ origin: config.origin, authConfig });
  const refresh = refreshRoute({ origin: config.origin, authConfig, memberRole });
  const command = commandRoute({ identity, db, origin: config.origin });
  const upload = mediaUploadRoute({ identity, db, storage, origin: config.origin });
  const media = mediaReadRoute({ identity, db, storage });
  const approvedImports = config.approvedImportCatalogPath ? JSON.parse(readFileSync(config.approvedImportCatalogPath,"utf8")) : null;
  const compat = compatibilityRoute({ db, identity, memberRole, origin: config.origin, uploadRoute: upload, approvedImports, ownerPublishing: config.ownerPublishing === true });
  const health = healthRoute({ db });
  const platformAdapter=new SupabasePlatformAdapter(db);
  const platform=platformRoutes({features:config.features||{},adapter:platformAdapter,origin:config.origin,identity:async request=>{const u=await identity(request);return {...u,role:await memberRole(u)};},guardWrite:async request=>{requireOrigin(request,config.origin);requireCsrf(request);}});
  const recovery = recoveryRoutes(config);
  return async (request) => {
    const url = new URL(request.url), path = url.pathname;
    if(platformPath(path)&&!(path==='/resources/'&&!config.features?.discovery))return platform(request);
    if (path.startsWith('/api/recovery/') || path === '/admin/recovery/callback') return recovery(request);
    if (path === "/api/login") return login(request);
    if (path === "/api/logout") return logout(request);
    if (path === "/api/refresh") return refresh(request);
    if (path === "/api/cms/command") return command(request);
    if (path === "/api/health/resources") return health(request);
    if (path.startsWith("/api/")) return compat(request);
    if (path === "/admin" || path === "/admin/") {
      try {
        const user = await identity(request); await memberRole(user);
        return html(adminHtml, 200, {
          "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow",
          "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          "Referrer-Policy": "same-origin", "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        });
      } catch { return new Response(null, { status: 302, headers: { Location: "/admin/login", "Cache-Control": "no-store" } }); }
    }
    const mediaMatch = path.match(/^\/media\/([0-9a-f-]{36})$/i);
    if (mediaMatch) return media(request, mediaMatch[1]);
    const preview = path.match(/^\/preview\/([0-9a-f-]{36})$/i);
    if (preview) {
      try { const user = await identity(request); await memberRole(user); const row = await db.read(user, preview[1]); return row ? html(renderPublicArticle({ ...row, content: row.editable, renderedHtml: row.rendered_html }, { preview: true }), 200, { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" }) : new Response(null, { status: 404 }); }
      catch { return new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } }); }
    }
    const previewAsset = path.match(/^\/preview-assets\/(resource-17\/workflow\.(?:svg|png|pdf))$/);
    if (previewAsset && request.method === "GET") {
      try {
        const user = await identity(request); await memberRole(user);
        const asset = editorialAsset(previewAsset[1]);
        if (!asset) return new Response(null, { status: 404 });
        return new Response(asset.bytes, { status: 200, headers: {
          "Content-Type": asset.mime, "Content-Disposition": `${asset.mime.startsWith("application/pdf") ? "attachment" : "inline"}; filename="${asset.filename}"`,
          "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        } });
      } catch { return new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } }); }
    }
    if (path === "/resources/" || path === "/resources") return html(renderPublicHub(await db.publicIndex(), url.searchParams), 200, { "Cache-Control": url.search ? "no-store" : "no-store" });
    if (path === "/resources-sitemap.xml") return new Response(config.features?.discovery?catalogSitemap(await platformAdapter.catalog()):renderSitemap(await db.publicIndex()), { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store" } });
    const article = path.match(/^\/resources\/([a-z0-9-]+)\/$/);
    if (article) {
      if(config.features?.discovery){const catalogue=await platformAdapter.catalog();if(!catalogue.some(r=>r.slug===article[1])){const target=await db.redirect(article[1]);return target&&catalogue.some(r=>r.slug===target)?new Response(null,{status:308,headers:{Location:`/resources/${target}/`,'Cache-Control':'no-store'}}):new Response(null,{status:404,headers:{'Cache-Control':'no-store'}});}}
      const record = await db.publicArticle(article[1]);
      if (record){let internal=false;try{const u=await identity(request);internal=Boolean(await memberRole(u));}catch{}let rendered=renderPublicArticle(record);if(config.features?.folders){const catalog=await platformAdapter.catalog(),article=catalog.find(r=>r.slug===record.slug);if(article)rendered=addNavigationBreadcrumbs(rendered,publicNavigation(await platformAdapter.navigation.published(),catalog),article);}return html(addPublicCapabilities(rendered,{...config.features,analytics:config.features?.analytics&&!internal}), 200, { "Cache-Control": "no-store" });}
      const redirect = await db.redirect(article[1]);
      if (redirect) return new Response(null, { status: 308, headers: { Location: `/resources/${redirect}/`, "Cache-Control": "public, max-age=3600" } });
      return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return new Response(null, { status: 404 });
  };
}
