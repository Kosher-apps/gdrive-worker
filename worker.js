/**
 * Google Drive direct-link service — single Cloudflare Worker.
 *
 * Routes:
 *   GET /                          Web UI (paste a Drive link)
 *   GET /api?url=<drive link|id>   JSON metadata + direct link
 *   GET /dl/<file-id>/<filename>   Streamed direct download (Range supported)
 *   GET /f/<file-id>               Simple file page with a download button
 *
 * Secrets (optional but strongly recommended):
 *   GOOGLE_API_KEY — Google Cloud API key with the Drive API enabled.
 *   Without it, metadata falls back to scraping the public file page,
 *   and folder listing is unavailable.
 *
 * No server, no database, no files are ever stored. Only public files
 * ("Anyone with the link") work.
 */

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ---------------------------------------------------------------- helpers

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatSize(bytes) {
  if (bytes == null || isNaN(bytes)) return null;
  const n = Number(bytes);
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + " " + units[i];
}

function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}

/** Extract a Drive file/folder ID from any common URL format or a bare ID. */
function extractId(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  // Bare ID: 10+ chars of the Drive alphabet (no spaces, no slashes).
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;

  let url;
  try {
    url = new URL(s.startsWith("http") ? s : "https://" + s);
  } catch {
    return null;
  }

  // /file/d/<id>/view  |  /drive/folders/<id>  |  /drive/u/0/folders/<id>
  let m =
    url.pathname.match(/\/file\/d\/([^/?#]+)/) ||
    url.pathname.match(/\/folders\/([^/?#]+)/) ||
    url.pathname.match(/\/d\/([^/?#]+)/);
  if (m) return m[1];

  // open?id=<id>  |  uc?id=<id>  |  uc?export=download&id=<id>
  const q = url.searchParams.get("id");
  if (q) return q;

  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

function errJson(message, status = 400, extra = {}) {
  return json({ ok: false, error: message, ...extra }, status);
}

// ------------------------------------------------------- Drive metadata

async function driveApiGet(id, apiKey) {
  const u =
    `${DRIVE_API}/files/${encodeURIComponent(id)}` +
    `?key=${encodeURIComponent(apiKey)}` +
    `&fields=id,name,size,mimeType,webViewLink,videoMediaMetadata`;
  const r = await fetch(u, { headers: { accept: "application/json" } });
  if (!r.ok) {
    let msg = `Drive API error ${r.status}`;
    try {
      const j = await r.json();
      if (j?.error?.message) msg = j.error.message;
    } catch { /* keep generic message */ }
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }
  const j = await r.json();
  return {
    id: j.id,
    name: j.name,
    size: j.size != null ? Number(j.size) : null,
    mimeType: j.mimeType || null,
    webViewLink: j.webViewLink || null,
    source: "api",
  };
}

async function driveApiListFolder(id, apiKey) {
  const items = [];
  let pageToken = "";
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({
      key: apiKey,
      q: `'${id}' in parents and trashed = false`,
      fields: "nextPageToken,files(id,name,size,mimeType,webViewLink)",
      orderBy: "folder,name",
      pageSize: "100",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const r = await fetch(`${DRIVE_API}/files?${params}`, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) {
      const e = new Error(`Drive API list error ${r.status}`);
      e.status = r.status;
      throw e;
    }
    const j = await r.json();
    for (const f of j.files || []) {
      items.push({
        id: f.id,
        name: f.name,
        size: f.size != null ? Number(f.size) : null,
        size_human: formatSize(f.size),
        mime: f.mimeType || null,
        ext: extOf(f.name),
        type: f.mimeType === FOLDER_MIME ? "folder" : "file",
      });
    }
    pageToken = j.nextPageToken || "";
    if (!pageToken) break;
  }
  return items;
}

/** Fallback when no API key is set: scrape the public file page. */
async function scrapeFilePage(id) {
  const r = await fetch(`https://drive.google.com/file/d/${id}/view`, {
    headers: { "user-agent": BROWSER_UA, accept: "text/html" },
  });
  const html = await r.text();

  if (/Sign in|accounts\.google\.com/i.test(html) && !/drive\.google\.com/i.test(html)) {
    const e = new Error("File is not public (or does not exist). Share it as 'Anyone with the link'.");
    e.status = 403;
    throw e;
  }

  // <title>name - Google Drive</title>
  let name = null;
  const title = html.match(/<title>(.*?)<\/title>/is);
  if (title) {
    name = title[1].replace(/\s*-\s*Google Drive\s*$/i, "").trim();
    if (!name || /^Google Drive$/i.test(name)) name = null;
  }
  if (!name) {
    const m = html.match(/"name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) name = JSON.parse(`"${m[1]}"`);
  }
  let size = null;
  const sizeM =
    html.match(/"sizeBytes"\s*:\s*"(\d+)"/) || html.match(/"size"\s*:\s*"(\d+)"/);
  if (sizeM) size = Number(sizeM[1]);
  let mime = null;
  const mimeM = html.match(/"mimeType"\s*:\s*"([^"]+)"/);
  if (mimeM) mime = mimeM[1];
  const isFolder =
    mime === FOLDER_MIME || /\/drive\/folders\//.test(html.slice(0, 2000));

  if (!name) {
    const e = new Error(
      r.status === 404
        ? "File not found."
        : "Could not read this file. It may be private — share it as 'Anyone with the link' — or set a GOOGLE_API_KEY."
    );
    e.status = r.status === 404 ? 404 : 403;
    throw e;
  }
  // The view page does not expose the size, so probe the download endpoint
  // for byte 0 — Content-Range carries the exact total.
  const probe = await probeDownloadSize(id);
  return {
    id,
    name,
    size: probe?.size ?? size,
    size_human: probe?.size_human || null,
    mimeType: probe?.mime || mime || (isFolder ? FOLDER_MIME : "application/octet-stream"),
    webViewLink: `https://drive.google.com/file/d/${id}/view`,
    source: "scrape",
  };
}

async function getMetadata(id, env) {
  if (env.GOOGLE_API_KEY) {
    try {
      return await driveApiGet(id, env.GOOGLE_API_KEY);
    } catch (e) {
      // 404/403 from the API are definitive (not found / not public).
      if (e.status === 404 || e.status === 403) {
        const err = new Error(
          e.status === 404
            ? "File not found."
            : "File is not public. Share it as 'Anyone with the link'."
        );
        err.status = e.status;
        throw err;
      }
      // Any other API failure (quota, transient) -> try the scrape fallback.
      return scrapeFilePage(id);
    }
  }
  return scrapeFilePage(id);
}

async function getFileInfo(id, env, origin) {
  const meta = await getMetadata(id, env);
  const isFolder = meta.mimeType === FOLDER_MIME;
  const info = {
    ok: true,
    type: isFolder ? "folder" : "file",
    id: meta.id,
    name: meta.name,
    size: meta.size,
    // Exact size wins when known; the "(84M)" text from the warning page
    // is only a rounded fallback for when the probe could not measure it.
    size_human: meta.size != null ? formatSize(meta.size) : (meta.size_human || null),
    mime: meta.mimeType,
    ext: extOf(meta.name),
    direct: isFolder
      ? null
      : `${origin}/dl/${meta.id}/${encodeURIComponent(meta.name)}`,
    page: `${origin}/f/${meta.id}`,
    drive: meta.webViewLink || `https://drive.google.com/file/d/${meta.id}/view`,
  };
  if (isFolder) {
    if (!env.GOOGLE_API_KEY) {
      info.items = null;
      info.note =
        "Folder listing requires a GOOGLE_API_KEY secret. Set one (see README) to list folder contents.";
    } else {
      info.items = await driveApiListFolder(id, env.GOOGLE_API_KEY);
      for (const it of info.items) {
        it.direct =
          it.type === "file"
            ? `${origin}/dl/${it.id}/${encodeURIComponent(it.name)}`
            : null;
        it.page = `${origin}/f/${it.id}`;
      }
    }
  }
  return info;
}

// ------------------------------------------------------------ downloading

function getCookies(res) {
  // getSetCookie() is available in Workers; fall back to the single header.
  if (typeof res.headers.getSetCookie === "function") {
    return res.headers.getSetCookie();
  }
  const c = res.headers.get("set-cookie");
  return c ? [c] : [];
}

/** Extract the virus-scan confirm token (and uuid + form action, when present) from Google's warning page. */
function extractConfirm(html) {
  const confirm =
    (html.match(/name=["']confirm["']\s+value=["']([^"']+)["']/i) || [])[1] ||
    (html.match(/confirm=([A-Za-z0-9_\-]+)/) || [])[1] ||
    (html.match(/"confirm"\s*:\s*"([^"]+)"/) || [])[1] ||
    null;
  const uuid =
    (html.match(/name=["']uuid["']\s+value=["']([^"']+)["']/i) || [])[1] ||
    (html.match(/[?&]uuid=([A-Za-z0-9-]+)/) || [])[1] ||
    null;
  // The warning form posts to drive.usercontent.google.com/download — the
  // confirm token only works there. A re-request to /uc just 303-redirects
  // back to usercontent *without* the token and shows the warning again.
  const action =
    (html.match(/<form[^>]*action=["']([^"']+)["']/i) || [])[1] || null;
  return { confirm, uuid, action };
}

/**
 * Best-effort exact size/mime for the no-API-key path, without downloading
 * the file: ask Google for just byte 0 and read the total from Content-Range.
 * Falls back to the human size printed on the warning page ("(84M)").
 */
async function probeDownloadSize(id) {
  try {
    const r = await fetch(
      `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`,
      { headers: { "user-agent": BROWSER_UA, accept: "*/*" } }
    );
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("text/html")) {
      const len = r.headers.get("content-length");
      if (r.body) await r.body.cancel();
      return {
        size: len ? Number(len) : null,
        mime: ct.split(";")[0].trim() || null,
        size_human: null,
      };
    }
    const html = await r.text();
    let size_human = null;
    const hm = html.match(/uc-name-size[\s\S]{0,500}?\(([\d.,]+\s*[KMGT]B?)\)/i);
    if (hm) {
      size_human = hm[1].replace(/\s+/g, "").toUpperCase();
      if (/[KMGT]$/.test(size_human)) size_human += "B";
      size_human = size_human.replace(/^(\d+(?:\.\d+)?)([KMGT]B)$/, "$1 $2");
    }
    const { confirm, uuid, action } = extractConfirm(html);
    if (!confirm) return { size: null, mime: null, size_human };
    const second = new URL(action || "https://drive.google.com/uc");
    second.searchParams.set("export", "download");
    second.searchParams.set("id", id);
    second.searchParams.set("confirm", confirm);
    if (uuid) second.searchParams.set("uuid", uuid);
    const cookies = getCookies(r)
      .map((c) => c.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
    const headers = { "user-agent": BROWSER_UA, range: "bytes=0-0" };
    if (cookies) headers.cookie = cookies;
    const r2 = await fetch(second.toString(), { headers });
    if (r2.body) await r2.body.cancel();
    const cr = r2.headers.get("content-range") || "";
    const total = /\/(\d+)\s*$/.exec(cr);
    return {
      size: total ? Number(total[1]) : null,
      mime: (r2.headers.get("content-type") || "").split(";")[0].trim() || null,
      size_human,
    };
  } catch {
    return null;
  }
}

async function handleDownload(request, env, id, filenameParam) {
  // Resolve the real filename first (also validates that the file is public).
  let meta;
  try {
    meta = await getMetadata(id, env);
  } catch (e) {
    return new Response(
      e.message || "File not found or not public.",
      { status: e.status || 404, headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }
  if (meta.mimeType === FOLDER_MIME) {
    return new Response("This is a folder, not a file. Open its page to see the files inside.", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const filename = filenameParam
    ? decodeURIComponent(filenameParam)
    : meta.name;
  const range = request.headers.get("range");

  const upstreamHeaders = {
    "user-agent": BROWSER_UA,
    accept: "*/*",
  };
  if (range) upstreamHeaders.range = range;

  const firstUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
  let upstream = await fetch(firstUrl, { headers: upstreamHeaders });

  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    // Large file: Google answered with the virus-scan warning page.
    const html = await upstream.text();
    const { confirm, uuid, action } = extractConfirm(html);
    if (!confirm) {
      return new Response(
        "Google blocked this download (virus-scan warning without a confirm token). " +
          "The file may be private, removed, or too large to confirm automatically.",
        { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }
    const cookies = getCookies(upstream)
      .map((c) => c.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
    // Re-request the warning form's own action (drive.usercontent.google.com),
    // exactly as the form does — /uc would 303 back without the token.
    const second = new URL(action || "https://drive.google.com/uc");
    second.searchParams.set("export", "download");
    second.searchParams.set("id", id);
    second.searchParams.set("confirm", confirm);
    if (uuid) second.searchParams.set("uuid", uuid);
    const secondHeaders = { ...upstreamHeaders };
    if (cookies) secondHeaders.cookie = cookies;
    upstream = await fetch(second.toString(), { headers: secondHeaders });
    const ct2 = upstream.headers.get("content-type") || "";
    if (ct2.includes("text/html")) {
      return new Response(
        "Google still returned a warning page after confirming. The file may be private or unavailable.",
        { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }
  }

  if (!upstream.ok && upstream.status !== 206) {
    return new Response(`Google returned ${upstream.status} for this file.`, {
      status: upstream.status === 404 ? 404 : 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Stream Google's response straight through — never buffered in memory.
  const headers = new Headers();
  const passthrough = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
  ];
  for (const h of passthrough) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.get("content-type") && meta.mimeType) {
    headers.set("content-type", meta.mimeType);
  }
  headers.set(
    "content-disposition",
    `attachment; filename="${filename.replace(/["\n\r]/g, "")}"; ` +
      `filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  headers.set("access-control-allow-origin", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

// ------------------------------------------------------------------ pages

const HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Drive Direct Link</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f6f7f9; color: #1a1a1a; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 16px 48px; }
  h1 { font-size: 26px; margin: 0 0 6px; }
  p.sub { color: #555; margin: 0 0 20px; }
  .card { background: #fff; border: 1px solid #e3e5e8; border-radius: 14px; padding: 18px; }
  input[type=text] { width: 100%; padding: 12px; font-size: 16px; border: 1px solid #c9cdd3; border-radius: 10px; }
  button { cursor: pointer; border: 0; border-radius: 10px; padding: 12px 18px; font-size: 16px; font-weight: 600; background: #1a73e8; color: #fff; }
  button.ghost { background: #eef1f4; color: #1a1a1a; }
  button:disabled { opacity: .55; cursor: default; }
  .row { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
  #out { margin-top: 16px; }
  .meta { line-height: 1.7; word-break: break-word; }
  .meta b { display: inline-block; min-width: 64px; color: #555; font-weight: 600; }
  .links a { display: block; word-break: break-all; margin: 6px 0; color: #1a73e8; }
  .err { color: #b3261e; }
  .muted { color: #666; font-size: 14px; }
  video { width: 100%; border-radius: 10px; margin-top: 12px; background: #000; }
  .copyrow { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  .copyrow code { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: #f0f2f5; padding: 8px 10px; border-radius: 8px; font-size: 13px; }
  .fileitem { display: flex; justify-content: space-between; gap: 10px; padding: 8px 0; border-top: 1px solid #eee; }
  .fileitem a { color: #1a73e8; text-decoration: none; }
  @media (max-width: 480px) { h1 { font-size: 22px; } }
</style>
</head>
<body>
<main>
  <h1>Drive Direct Link</h1>
  <p class="sub">Paste a public Google Drive file or folder link and get a direct download link. No sign-in, nothing is stored.</p>
  <div class="card">
    <input id="url" type="text" placeholder="https://drive.google.com/file/d/…/view" autocomplete="off" spellcheck="false">
    <div class="row">
      <button id="go">Get link</button>
      <button class="ghost" id="paste" type="button">Paste</button>
    </div>
    <div id="out"></div>
  </div>
  <p class="muted">Only files shared as “Anyone with the link” work. Large files are handled automatically (virus-scan confirmation).</p>
</main>
<script>
const $ = (id) => document.getElementById(id);
const out = $("out");

function esc(s){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
async function copyText(t, btn){
  let done = false;
  try {
    await navigator.clipboard.writeText(t);
    done = true;
  } catch {
    // Fallback for browsers where the Clipboard API is unavailable/denied.
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      done = document.execCommand("copy");
      ta.remove();
    } catch { done = false; }
  }
  if (!done) { prompt("Copy this link:", t); return; }
  const o = btn.textContent;
  btn.textContent = "Copied!";
  setTimeout(() => btn.textContent = o, 1500);
}
// One delegated listener for all Copy buttons (they are rendered dynamically).
// NOTE: do NOT use inline onclick="copyText(\"...\")" — the double quotes
// inside the attribute break the HTML and the button silently does nothing.
out.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (b) copyText(b.getAttribute("data-copy"), b);
});
function linkRow(label, href){
  return '<div class="copyrow"><code>' + esc(href) + '</code>' +
    '<button class="ghost" type="button" data-copy="' + esc(href) + '">Copy</button></div>' +
    '<div class="links"><a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(label) + ' ↗</a></div>';
}

$("paste").onclick = async () => {
  try { $("url").value = await navigator.clipboard.readText(); } catch { $("url").focus(); }
};
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") $("go").click(); });

$("go").onclick = async () => {
  const v = $("url").value.trim();
  if (!v) { out.innerHTML = '<p class="err">Paste a Drive link first.</p>'; return; }
  $("go").disabled = true;
  out.innerHTML = "<p>Loading…</p>";
  try {
    const r = await fetch("/api?url=" + encodeURIComponent(v));
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || ("HTTP " + r.status));
    let h = '<div class="meta"><div><b>Name</b> ' + esc(d.name) + '</div>' +
      '<div><b>Type</b> ' + esc(d.type) + (d.mime ? " · " + esc(d.mime) : "") + '</div>' +
      (d.size_human ? '<div><b>Size</b> ' + esc(d.size_human) + '</div>' : "") + '</div>';
    if (d.type === "folder") {
      h += '<p><a href="' + esc(d.page) + '">Open folder page ↗</a></p>';
      if (d.items && d.items.length) {
        h += "<h3>Files (" + d.items.length + ")</h3>";
        for (const it of d.items) {
          h += '<div class="fileitem"><span>' + esc(it.name) + (it.size_human ? ' <span class="muted">(' + esc(it.size_human) + ')</span>' : "") + '</span>' +
            (it.direct ? '<a href="' + esc(it.direct) + '">Download</a>' : '<a href="' + esc(it.page) + '">Open</a>') + '</div>';
        }
      } else if (d.note) {
        h += '<p class="muted">' + esc(d.note) + '</p>';
      } else {
        h += '<p class="muted">This folder is empty.</p>';
      }
    } else {
      h += linkRow("Direct download link", d.direct);
      h += linkRow("File page", d.page);
      if (d.mime && d.mime.startsWith("video/")) {
        h += '<p><b>Watch / stream:</b> open the file page, or play the direct link — it supports seeking.</p>';
        h += '<video controls preload="metadata" src="' + esc(d.direct) + '"></video>';
      }
      if (d.mime && d.mime.startsWith("audio/")) {
        h += '<audio controls preload="metadata" style="width:100%;margin-top:12px" src="' + esc(d.direct) + '"></audio>';
      }
      if (d.mime && d.mime.startsWith("image/")) {
        h += '<p><img src="' + esc(d.direct) + '" alt="" style="max-width:100%;border-radius:10px;margin-top:12px"></p>';
      }
    }
    out.innerHTML = h;
  } catch (e) {
    out.innerHTML = '<p class="err">' + esc(e.message || "Something went wrong.") + '</p>';
  } finally {
    $("go").disabled = false;
  }
};
</script>
</body>
</html>`;

function filePageHtml(info) {
  const dl = info.direct || info.page;
  const isVideo = info.mime && info.mime.startsWith("video/");
  const isAudio = info.mime && info.mime.startsWith("audio/");
  const isImage = info.mime && info.mime.startsWith("image/");
  let preview = "";
  if (isVideo) preview = `<video controls preload="metadata" src="${esc(info.direct)}" style="width:100%;border-radius:10px;background:#000"></video>`;
  else if (isAudio) preview = `<audio controls preload="metadata" src="${esc(info.direct)}" style="width:100%"></audio>`;
  else if (isImage) preview = `<img src="${esc(info.direct)}" alt="" style="max-width:100%;border-radius:10px">`;

  let itemsHtml = "";
  if (info.type === "folder") {
    if (info.items && info.items.length) {
      itemsHtml = "<h3>Files</h3>" + info.items.map((it) =>
        `<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid #eee">` +
        `<span>${esc(it.name)}${it.size_human ? ` <span style="color:#666">(${esc(it.size_human)})</span>` : ""}</span>` +
        (it.direct ? `<a href="${esc(it.direct)}">Download</a>` : `<a href="${esc(it.page)}">Open</a>`) +
        `</div>`
      ).join("");
    } else if (info.note) {
      itemsHtml = `<p style="color:#666">${esc(info.note)}</p>`;
    } else {
      itemsHtml = `<p style="color:#666">This folder is empty.</p>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(info.name)} — Drive Direct Link</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; background: #f6f7f9; color: #1a1a1a; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 16px 48px; }
  .card { background: #fff; border: 1px solid #e3e5e8; border-radius: 14px; padding: 18px; }
  h1 { font-size: 22px; word-break: break-word; margin: 0 0 8px; }
  .meta { color: #555; line-height: 1.7; }
  a.btn { display: inline-block; margin-top: 14px; background: #1a73e8; color: #fff; text-decoration: none; font-weight: 600; padding: 12px 20px; border-radius: 10px; }
  a { color: #1a73e8; }
  code { word-break: break-all; background: #f0f2f5; padding: 2px 6px; border-radius: 6px; font-size: 13px; }
  .muted { color: #666; font-size: 14px; }
</style>
</head>
<body>
<main>
  <div class="card">
    <h1>${esc(info.name)}</h1>
    <div class="meta">
      <div>Type: ${esc(info.type)}${info.mime ? " · " + esc(info.mime) : ""}</div>
      ${info.size_human ? `<div>Size: ${esc(info.size_human)}</div>` : ""}
    </div>
    ${preview}
    ${info.type === "file" ? `<a class="btn" href="${esc(dl)}">Download</a>` : ""}
    ${info.type === "file" ? `<p class="muted">Direct link: <code>${esc(info.direct)}</code></p>` : ""}
    ${itemsHtml}
    <p class="muted"><a href="/">← Back to Drive Direct Link</a> · <a href="${esc(info.drive)}" target="_blank" rel="noopener">Open in Google Drive ↗</a></p>
  </div>
</main>
</body>
</html>`;
}

// ------------------------------------------------------------------ router

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, OPTIONS",
            "access-control-allow-headers": "*",
          },
        });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        return errJson("Only GET is supported.", 405);
      }

      if (path === "/" || path === "/index.html") {
        return new Response(HOME_HTML, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (path === "/api") {
        const input = url.searchParams.get("url") || url.searchParams.get("id");
        if (!input) return errJson("Missing ?url=<drive link or file id> parameter.", 400);
        const id = extractId(input);
        if (!id) return errJson("Could not extract a file ID from that link. Paste a Google Drive link or a bare file ID.", 400);
        try {
          const info = await getFileInfo(id, env, url.origin);
          return json(info);
        } catch (e) {
          return errJson(e.message || "Could not read this file.", e.status || 500);
        }
      }

      if (path.startsWith("/dl/")) {
        const parts = path.slice(4).split("/").filter(Boolean);
        const id = parts[0] ? decodeURIComponent(parts[0]) : null;
        if (!id) return new Response("Missing file ID.", { status: 400 });
        const filename = parts[1] ? parts[1] : null; // still URL-encoded; decoded in handler
        return handleDownload(request, env, id, filename);
      }

      if (path.startsWith("/f/")) {
        const id = decodeURIComponent(path.slice(3).split("/")[0] || "");
        if (!id) return new Response("Missing file ID.", { status: 400 });
        try {
          const info = await getFileInfo(id, env, url.origin);
          return new Response(filePageHtml(info), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        } catch (e) {
          return new Response(
            `<h1>Could not open this file</h1><p>${esc(e.message || "Unknown error.")}</p><p><a href="/">← Back</a></p>`,
            { status: e.status || 500, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }
      }

      return errJson("Not found. Routes: / , /api?url=… , /dl/<id>/<filename> , /f/<id>", 404);
    } catch (e) {
      return errJson(e.message || "Internal error.", 500);
    }
  },
};
