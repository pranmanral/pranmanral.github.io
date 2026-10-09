// PDF Editor — runs fully in the browser (mupdf WASM).
//  P1 upload+validate+render · P2 click-to-edit overlays · P3/P4 apply + Save/download.
import * as mupdf from "./vendor/mupdf.js";

const $ = id => document.getElementById(id);
const drop = $("drop"), fileInput = $("file"), errorEl = $("error");
const uploader = $("uploader"), viewer = $("viewer"), loading = $("loading");
const metaEl = $("meta"), resetBtn = $("reset"), editsEl = $("edits"), saveBtn = $("save");

const RENDER_SCALE = 2;
const FAM2BASE14 = { "serif": "Times-Roman", "sans-serif": "Helvetica", "monospace": "Courier" };

let doc = null;                 // display document (render + overlay)
let origBytes = null;           // pristine bytes — each Save re-applies from here (idempotent)
let origName = "document.pdf";
const pending = new Map();      // key -> { page, x,y,w,h, oldText, newText, size, family, font }

function showError(m){ errorEl.textContent = m; errorEl.hidden = false; }
function clearError(){ errorEl.hidden = true; errorEl.textContent = ""; }
function escPdf(s){ return s.replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)"); }

function looksLikePdf(buf){
  const b = new Uint8Array(buf.slice(0, 1024));
  for (let i = 0; i + 5 <= b.length; i++)
    if (b[i]===0x25&&b[i+1]===0x50&&b[i+2]===0x44&&b[i+3]===0x46&&b[i+4]===0x2D) return true; // %PDF-
  return false;
}

async function handleFile(file){
  clearError();
  if (!file) return;
  const buf = await file.arrayBuffer();
  if (!looksLikePdf(buf)){ showError("That's not a PDF — try again."); fileInput.value = ""; return; }
  origBytes = new Uint8Array(buf.slice(0));           // keep a pristine copy
  origName = file.name || "document.pdf";
  try { doc = mupdf.Document.openDocument(new Uint8Array(buf), "application/pdf"); }
  catch (e){ console.error(e); showError("Couldn't open this PDF — it may be corrupted or password-protected."); return; }
  pending.clear(); updateCounter();
  await renderDocument(origName);
}

async function renderDocument(name){
  uploader.hidden = true; viewer.hidden = false; viewer.innerHTML = ""; loading.hidden = false;
  const n = doc.countPages();
  metaEl.textContent = `${name} — ${n} page${n===1?"":"s"}`;
  metaEl.hidden = false; resetBtn.hidden = false; saveBtn.hidden = false;
  await new Promise(r => requestAnimationFrame(r));

  for (let i = 0; i < n; i++){
    const page = doc.loadPage(i);
    const pix = page.toPixmap(mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE), mupdf.ColorSpace.DeviceRGB, false);
    const w = pix.getWidth()/RENDER_SCALE, h = pix.getHeight()/RENDER_SCALE;
    const url = URL.createObjectURL(new Blob([pix.asPNG()], { type: "image/png" }));

    const wrap = document.createElement("div");
    wrap.className = "page-wrap"; wrap.style.width = w+"px"; wrap.style.height = h+"px";
    const img = new Image(); img.className = "page"; img.src = url; img.alt = `page ${i+1}`;
    img.onload = () => URL.revokeObjectURL(url); wrap.appendChild(img);

    const overlay = document.createElement("div"); overlay.className = "overlay";
    const stext = JSON.parse(page.toStructuredText("preserve-whitespace").asJSON());
    for (const block of stext.blocks || [])
      for (const line of block.lines || []){
        const bb = line.bbox; if (!bb) continue;
        const text = (line.text != null ? line.text : (line.spans||[]).map(s=>s.text).join("")).replace(/\s+$/,"");
        if (!text.trim() || bb.w < 2 || bb.h < 2) continue;
        const font = line.font || {};
        const box = document.createElement("div"); box.className = "linebox";
        box.style.left=bb.x+"px"; box.style.top=bb.y+"px"; box.style.width=bb.w+"px"; box.style.height=bb.h+"px";
        box.dataset.key = `${i}|${Math.round(bb.x)}|${Math.round(bb.y)}`;
        box.dataset.page=i; box.dataset.x=bb.x; box.dataset.y=bb.y; box.dataset.w=bb.w; box.dataset.h=bb.h;
        box.dataset.text=text; box.dataset.size=font.size||bb.h*0.8; box.dataset.family=font.family||"serif"; box.dataset.font=font.name||"";
        box.title = "Click to edit";
        box.addEventListener("click", () => editLine(box));
        overlay.appendChild(box);
      }
    wrap.appendChild(overlay); viewer.appendChild(wrap);
    pix.destroy?.(); page.destroy?.();
  }
  loading.hidden = true;
}

function editLine(box){
  if (box.querySelector("input")) return;
  const d = box.dataset;
  const input = document.createElement("input"); input.type = "text";
  input.value = box.classList.contains("edited") ? box.textContent : d.text;
  input.style.fontSize = d.size+"px"; input.style.fontFamily = d.family||"serif";
  box.textContent = ""; box.classList.add("active"); box.appendChild(input);
  input.focus(); input.select();
  let settled = false;
  const finish = commit => {
    if (settled) return; settled = true;
    const nv = input.value; box.classList.remove("active"); input.remove();
    if (commit && nv !== d.text && nv.trim() !== ""){
      box.textContent = nv; box.style.fontSize = d.size+"px"; box.style.fontFamily = d.family||"serif";
      box.classList.add("edited");
      pending.set(d.key, { page:+d.page, x:+d.x, y:+d.y, w:+d.w, h:+d.h,
        oldText:d.text, newText:nv, size:+d.size, family:d.family, font:d.font });
    } else {
      box.textContent=""; box.style.fontSize=""; box.style.fontFamily=""; box.classList.remove("edited");
      pending.delete(d.key);
    }
    updateCounter();
  };
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", e => {
    if (e.key==="Enter"){ e.preventDefault(); finish(true); } else if (e.key==="Escape"){ finish(false); }
  });
}

function updateCounter(){
  const n = pending.size;
  editsEl.textContent = n ? `${n} pending edit${n===1?"":"s"}` : "";
  editsEl.hidden = n===0;
  saveBtn.disabled = n===0;
  saveBtn.textContent = n ? `Save PDF (${n})` : "Save PDF";
}

// ── apply pending edits to a fresh copy of the original, then download ──
function fontResourceName(pageObj, baseFontName){
  if (!baseFontName) return null;
  const res = pageObj.get("Resources"); if (!res) return null;
  const fonts = res.get("Font"); if (!fonts || !fonts.forEach) return null;
  let found = null;
  fonts.forEach((v, k) => {
    const bf = v.get?.("BaseFont");
    const name = bf?.asName ? bf.asName() : (bf?.toString?.() || "");
    if (name.replace(/^\//,"") === baseFontName.replace(/^\//,""))
      found = (k.asName ? k.asName() : k.toString()).replace(/^\//,"");
  });
  return found;
}
function ensureFallbackFont(workDoc, pageObj, family){
  const res = pageObj.get("Resources");
  let fonts = res.get("Font");
  const name = "FEdit";
  if (!fonts || !fonts.get){ fonts = workDoc.newDictionary(); res.put("Font", fonts); }
  if (!fonts.get(name) || fonts.get(name).isNull?.()){
    const f = workDoc.addSimpleFont(new mupdf.Font(FAM2BASE14[family] || "Times-Roman"));
    fonts.put(name, f);
  }
  return name;
}

async function applyAndSave(){
  if (pending.size === 0 || !origBytes) return;
  saveBtn.disabled = true; const label = saveBtn.textContent; saveBtn.textContent = "Saving…";
  try {
    const work = mupdf.PDFDocument.openDocument(origBytes, "application/pdf");  // fresh copy → idempotent
    const byPage = new Map();
    for (const e of pending.values()){ (byPage.get(e.page) || byPage.set(e.page, []).get(e.page)).push(e); }

    for (const [pi, edits] of byPage){
      const page = work.loadPage(pi);
      const [,,, ph] = [0,0,0, page.getBounds()[3]];
      const pageH = page.getBounds()[3];
      const pobj = page.getObject();

      for (const e of edits){            // 1) erase originals
        const an = page.createAnnotation("Redact");
        an.setRect([e.x, e.y, e.x + e.w, e.y + e.h]);
      }
      page.applyRedactions(false);

      let ops = "";                       // 2) draw replacements (reuse embedded font; fallback base-14)
      for (const e of edits){
        let resName = fontResourceName(pobj, e.font) || ensureFallbackFont(work, pobj, e.family);
        const pdfY = pageH - (e.y + e.h * 0.8);
        ops += `\nq BT /${resName} ${e.size} Tf 0 0 0 rg ${e.x.toFixed(2)} ${pdfY.toFixed(2)} Td (${escPdf(e.newText)}) Tj ET Q\n`;
      }
      const c = pobj.get("Contents");
      const opBytes = new TextEncoder().encode(ops);
      if (c.isArray && c.isArray()) {
        c.push(work.addStream(opBytes, {}));
      } else {
        const oldBytes = c.readStream().asUint8Array();
        const merged = new Uint8Array(oldBytes.length + opBytes.length);
        merged.set(oldBytes, 0); merged.set(opBytes, oldBytes.length);
        pobj.put("Contents", work.addStream(merged, {}));
      }
      page.destroy?.();
    }

    const out = work.saveToBuffer("compress").asUint8Array();
    const url = URL.createObjectURL(new Blob([out], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url; a.download = origName.replace(/\.pdf$/i, "") + "-edited.pdf";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    work.destroy?.();
  } catch (e){
    console.error(e); showError("Something went wrong while saving — see console.");
  } finally {
    saveBtn.textContent = label; saveBtn.disabled = pending.size === 0;
  }
}

function reset(){
  doc?.destroy?.(); doc = null; origBytes = null; pending.clear();
  viewer.hidden = true; viewer.innerHTML = "";
  metaEl.hidden = true; resetBtn.hidden = true; editsEl.hidden = true; saveBtn.hidden = true;
  uploader.hidden = false; clearError(); fileInput.value = "";
}

// ── events ──
fileInput.addEventListener("change", e => handleFile(e.target.files[0]));
resetBtn.addEventListener("click", reset);
saveBtn.addEventListener("click", applyAndSave);
["dragenter","dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("dragover"); }));
["dragleave","drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("dragover"); }));
drop.addEventListener("drop", e => { const f = e.dataTransfer?.files?.[0]; if (f) handleFile(f); });
