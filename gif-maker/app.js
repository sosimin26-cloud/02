/* GIF 메이커 — 영상 → 블로그용 GIF (여러 구간 한 번에)
 * 모든 처리는 브라우저 안에서만 이뤄지며 영상은 어디에도 업로드되지 않습니다. */
(() => {
'use strict';
const { GIFEncoder, quantize, applyPalette } = window.gifenc;

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const COLORS_STEPS = [8, 16, 32, 64, 128, 256];
const SEG_COLORS = ['#3dd6b0', '#f5b942', '#ff7eb6', '#5b8cff', '#b48cff', '#7ee0ff', '#ff9f5b', '#a3e05b'];
const STEP = 1 / 30; // 화살표 1프레임 이동 단위

const DEFAULTS = { width: 480, fps: 12, speed: 1, colorsIdx: 5, palette: 'global', repeat: '0', optimize: true, mode: 'each', limitMB: 10 };

const S = {
  file: null, url: null, base: 'gif', duration: 0, vw: 0, vh: 0,
  segs: [], sel: null, seq: 0,
  markIn: null, markOut: null,
  cropOn: false, crop: null, cropRatio: 'free',
  lock: true, outW: 480, outH: 270,
  results: [],
  busy: false, cancel: false,
  thumbs: [], estGen: 0,
};

const video = $('video');
const xv = document.createElement('video'); // 프레임 추출 전용 (화면 미리보기와 분리)
xv.muted = true; xv.preload = 'auto'; xv.playsInline = true;

/* ---------------- 공통 유틸 ---------------- */
function fmtTime(t, cs = true) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60), s = t - m * 60;
  const ss = cs ? s.toFixed(2).padStart(5, '0') : String(Math.floor(s)).padStart(2, '0');
  return `${String(m).padStart(2, '0')}:${ss}`;
}
function parseTime(str) {
  str = String(str).trim();
  if (!str) return NaN;
  const parts = str.split(':').map(Number);
  if (parts.some(isNaN)) return NaN;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
function fmtBytes(b) {
  if (b == null || !isFinite(b)) return '-';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
}
function labelFor(n) { let s = ''; n++; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
let toastTimer;
function toast(msg, ms = 2400) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms); }
function limitBytes() { return (parseFloat($('limitMB').value) || 10) * 1024 * 1024; }

/* ---------------- 설정 ---------------- */
function settings() {
  return {
    fps: +$('fps').value,
    speed: +$('speed').value,
    colors: COLORS_STEPS[+$('colors').value],
    palette: $('palette').value,
    repeat: +$('repeat').value,
    optimize: $('optimize').checked,
    mode: $('mode').value,
  };
}
function srcRect() {
  if (S.cropOn && S.crop) return { ...S.crop };
  return { x: 0, y: 0, w: S.vw, h: S.vh };
}
function syncHeightFromWidth() {
  const r = srcRect();
  if (S.lock && r.w) S.outH = Math.max(1, Math.round(S.outW * r.h / r.w));
}
function setOutW(w) {
  S.outW = clamp(Math.round(w) || 1, 1, 4000);
  syncHeightFromWidth();
  renderSizeInputs(); onSettingsChanged();
}
function renderSizeInputs() {
  $('outW').value = S.outW; $('outH').value = S.outH;
  $('lockBtn').classList.toggle('on', S.lock);
  const r = srcRect();
  document.querySelectorAll('#sizePresets button').forEach((b) => {
    const w = +b.dataset.w; b.classList.toggle('on', (w === 0 ? r.w : w) === S.outW);
  });
}
function frameCount(seg, st = settings()) {
  return Math.max(1, Math.round((seg.end - seg.start) / st.speed * st.fps));
}
function frameTimes(seg, st = settings()) {
  const n = frameCount(seg, st), step = st.speed / st.fps, out = [];
  for (let i = 0; i < n; i++) out.push(Math.min(seg.start + i * step, seg.end - 0.001));
  return out;
}

/* ---------------- 영상 열기 ---------------- */
function openFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(file.name)) { toast('영상 파일만 열 수 있어요'); return; }
  if (S.busy) { toast('GIF를 만드는 중이에요. 끝난 뒤에 열어주세요'); return; }
  if (S.url) URL.revokeObjectURL(S.url);
  S.file = file; S.url = URL.createObjectURL(file);
  S.base = file.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'gif';
  S.segs = []; S.sel = null; S.seq = 0; S.markIn = S.markOut = null; S.thumbs = [];
  S.crop = null; S.cropOn = false; $('cropOn').checked = false;
  $('fileName').textContent = file.name;
  video.src = S.url; xv.src = S.url;
  $('dropHint').hidden = true; $('videoWrap').hidden = false;
}
video.addEventListener('loadedmetadata', () => {
  S.duration = video.duration; S.vw = video.videoWidth; S.vh = video.videoHeight;
  if (!isFinite(S.duration) || !S.vw) { toast('영상 정보를 읽지 못했어요. 다른 형식으로 시도해보세요'); return; }
  S.crop = { x: 0, y: 0, w: S.vw, h: S.vh };
  S.outW = Math.min(S.vw, +$('outW').dataset.pref || DEFAULTS.width);
  syncHeightFromWidth(); renderSizeInputs();
  $('durTime').textContent = fmtTime(S.duration);
  renderSrcInfo();
  layoutTimeline(); renderSegs(); renderStatus();
  $('estimateBtn').disabled = false;
  makeThumbs();
});
video.addEventListener('error', () => toast('이 영상은 브라우저에서 재생할 수 없어요 (코덱 미지원). mp4(H.264)로 변환 후 시도해주세요', 5000));

function renderSrcInfo() {
  const f = S.file;
  $('srcInfo').innerHTML = `
    <dt>파일</dt><dd>${escapeHtml(f.name)}</dd>
    <dt>해상도</dt><dd>${S.vw} × ${S.vh}</dd>
    <dt>길이</dt><dd>${fmtTime(S.duration)}</dd>
    <dt>파일 용량</dt><dd>${fmtBytes(f.size)}</dd>`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------------- 프레임 추출 (직렬 큐) ---------------- */
let xq = Promise.resolve();
function withExtractor(fn) { const p = xq.then(fn); xq = p.catch(() => {}); return p; }
function seekX(t) {
  t = clamp(t, 0, Math.max(0, S.duration - 0.001));
  return new Promise((res) => {
    if (xv.readyState >= 2 && Math.abs(xv.currentTime - t) < 1e-4) return res();
    let done = false;
    const fin = () => { if (done) return; done = true; xv.removeEventListener('seeked', fin); clearTimeout(to); res(); };
    const to = setTimeout(fin, 4000);
    xv.addEventListener('seeked', fin);
    xv.currentTime = t;
  });
}
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
async function grab(t, w, h, rect) {
  await seekX(t);
  if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
  wctx.imageSmoothingEnabled = true; wctx.imageSmoothingQuality = 'high';
  wctx.drawImage(xv, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  return wctx.getImageData(0, 0, w, h).data;
}

/* ---------------- GIF 인코딩 ---------------- */
function concatFrames(frames) {
  const len = frames.reduce((a, f) => a + f.length, 0), out = new Uint8ClampedArray(len);
  let o = 0; for (const f of frames) { out.set(f, o); o += f.length; }
  return out;
}
function makeWriter(st, w, h, palette) {
  const gif = GIFEncoder();
  const delay = 1000 / st.fps;
  const useGlobal = st.palette === 'global';
  const opt = useGlobal && st.optimize;
  const ti = opt ? palette.length - 1 : 0;
  let prev = null, first = true;
  return {
    gif,
    add(rgba) {
      const before = gif.bytesView().length;
      if (useGlobal) {
        const idx = applyPalette(rgba, opt ? palette.slice(0, -1) : palette, 'rgb565');
        const o = { delay, dispose: opt ? 1 : -1 };
        if (first) { o.palette = palette; o.repeat = st.repeat; }
        if (opt && prev) {
          const out = new Uint8Array(idx);
          for (let i = 0; i < out.length; i++) if (idx[i] === prev[i]) out[i] = ti;
          o.transparent = true; o.transparentIndex = ti;
          gif.writeFrame(out, w, h, o);
        } else gif.writeFrame(idx, w, h, o);
        prev = idx;
      } else {
        const pal = quantize(rgba, st.colors, { format: 'rgb565' });
        const idx = applyPalette(rgba, pal, 'rgb565');
        const o = { palette: pal, delay };
        if (first) o.repeat = st.repeat;
        gif.writeFrame(idx, w, h, o);
      }
      first = false;
      return gif.bytesView().length - before;
    },
    finish() { gif.finish(); return gif.bytes(); },
  };
}
function buildPalette(sampleFrames, st) {
  const pal = quantize(concatFrames(sampleFrames), st.optimize ? st.colors - 1 : st.colors, { format: 'rgb565' });
  if (st.optimize) pal.push([255, 0, 255]); // 투명용 자리
  return pal;
}

/* 여러 구간을 GIF 하나로 (구간이 1개면 그 구간만) */
async function encodeSegments(segs, size, onFrame) {
  const st = settings(), rect = srcRect(), { w, h } = size;
  const times = segs.flatMap((s) => frameTimes(s, st));
  let palette = null;
  if (st.palette === 'global') {
    const k = Math.min(12, times.length), sample = [];
    for (let i = 0; i < k; i++) {
      if (S.cancel) throw new Error('cancel');
      sample.push(new Uint8ClampedArray(await grab(times[Math.floor(i * times.length / k)], w, h, rect)));
    }
    palette = buildPalette(sample, st);
  }
  const wr = makeWriter(st, w, h, palette);
  for (let i = 0; i < times.length; i++) {
    if (S.cancel) throw new Error('cancel');
    wr.add(await grab(times[i], w, h, rect));
    onFrame(i + 1, times.length);
  }
  return { bytes: wr.finish(), frames: times.length, w, h };
}

/* ---------------- 용량 예상 ---------------- */
async function estimateSeg(seg, st, size) {
  const rect = srcRect(), { w, h } = size;
  const n = frameCount(seg, st), step = st.speed / st.fps;
  const K = Math.min(4, n);
  const pairs = [];
  for (let i = 0; i < K; i++) {
    const t = seg.start + (seg.end - seg.start) * (i + 0.5) / K - step / 2;
    const a = new Uint8ClampedArray(await grab(clamp(t, seg.start, seg.end - 0.001), w, h, rect));
    const b = n > 1 ? new Uint8ClampedArray(await grab(clamp(t + step, seg.start, seg.end - 0.001), w, h, rect)) : null;
    pairs.push([a, b]);
  }
  const palette = st.palette === 'global' ? buildPalette(pairs.flat().filter(Boolean), st) : null;
  let full = 0, diff = 0;
  for (const [a, b] of pairs) {
    const wr = makeWriter(st, w, h, palette);
    full += wr.add(a);
    if (b) diff += wr.add(b);
  }
  full /= K; diff /= K;
  return Math.round(40 + full + (n - 1) * (n > 1 ? diff : 0));
}
let estTimer;
function onSettingsChanged() {
  S.segs.forEach((s) => (s.est = null));
  renderSegRows(); renderStatus();
  clearTimeout(estTimer);
  estTimer = setTimeout(runEstimates, 450);
}
async function runEstimates() {
  if (!S.duration || S.busy) return;
  const gen = ++S.estGen;
  const order = [...S.segs].sort((a, b) => (b.id === S.sel) - (a.id === S.sel));
  for (const seg of order) {
    if (gen !== S.estGen || S.busy) return;
    if (seg.est != null) continue;
    const st = settings(), size = { w: S.outW, h: S.outH };
    const key = JSON.stringify([seg.start, seg.end, st, size, srcRect()]);
    seg.estState = 'busy'; renderSegRows();
    try {
      const est = await withExtractor(() => (gen === S.estGen ? estimateSeg(seg, st, size) : null));
      if (gen !== S.estGen || est == null) return;
      if (key === JSON.stringify([seg.start, seg.end, settings(), { w: S.outW, h: S.outH }, srcRect()])) seg.est = est;
    } catch (e) { console.warn(e); }
    seg.estState = null;
    renderSegRows(); renderStatus();
  }
}

/* ---------------- 만들기 ---------------- */
async function build(segIds, override) {
  if (S.busy || !S.duration) return;
  const segs = segIds.map((id) => S.segs.find((s) => s.id === id)).filter(Boolean);
  if (!segs.length) { toast('체크된 구간이 없어요'); return; }
  S.busy = true; S.cancel = false; S.estGen++;
  video.pause();
  setBusyUI(true);
  const st = settings();
  const merge = !override && st.mode === 'merge' && segs.length > 1;
  const groups = override ? [segs] : merge ? [segs] : segs.map((s) => [s]);
  const total = groups.reduce((a, g) => a + g.reduce((b, s) => b + frameCount(s, st), 0), 0);
  let doneFrames = 0, made = 0;
  try {
    for (const g of groups) {
      const tag = g.map((s) => s.label).join('');
      g.forEach((s) => (s.status = 'busy')); renderSegRows();
      const size = override || { w: S.outW, h: S.outH };
      const base = doneFrames;
      const out = await withExtractor(() => encodeSegments(g, size, (i, n) => {
        doneFrames = base + i;
        $('progText').textContent = `${tag} 구간 · ${i}/${n} 프레임`;
        $('progBar').style.width = (doneFrames / total * 100).toFixed(1) + '%';
      }));
      addResult(g, out, st);
      made++;
    }
    toast(`GIF ${made}개 완성!`);
  } catch (e) {
    if (e.message === 'cancel') toast('취소했어요');
    else { console.error(e); toast('만들다가 오류가 났어요: ' + e.message, 5000); }
  } finally {
    S.segs.forEach((s) => { if (s.status === 'busy') s.status = null; });
    S.busy = false; S.cancel = false;
    setBusyUI(false); renderSegRows(); renderResults();
  }
}
function setBusyUI(b) {
  $('progressWrap').hidden = !b; $('progBar').style.width = '0%';
  $('buildAllBtn').disabled = b || !S.segs.some((s) => s.on);
  document.querySelectorAll('.settings input, .settings select, .settings button').forEach((el) => (el.disabled = b));
  showVal();
}
function addResult(segs, out, st) {
  const key = segs.map((s) => s.id).join(',');
  const tag = segs.map((s) => s.label).join('');
  const old = S.results.find((r) => r.key === key);
  if (old) { URL.revokeObjectURL(old.url); S.results.splice(S.results.indexOf(old), 1); }
  const blob = new Blob([out.bytes], { type: 'image/gif' });
  const r = { key, segIds: segs.map((s) => s.id), tag, name: `${S.base}_${tag}.gif`, blob, url: URL.createObjectURL(blob), size: blob.size, w: out.w, h: out.h, frames: out.frames, fps: st.fps };
  S.results.unshift(r);
  const over = r.size > limitBytes();
  segs.forEach((s) => (s.status = over ? 'over' : 'done'));
}

/* ---------------- 결과물 목록 & 저장 ---------------- */
function renderResults() {
  const box = $('results');
  $('saveFolderBtn').disabled = $('saveZipBtn').disabled = !S.results.length;
  if (!S.results.length) { box.innerHTML = '<div class="empty">아직 만든 GIF가 없어요.<br>구간을 정하고 <b>GIF 만들기</b>를 누르세요.</div>'; return; }
  const lim = limitBytes();
  box.innerHTML = '';
  for (const r of S.results) {
    const over = r.size > lim;
    const el = document.createElement('div'); el.className = 'res';
    el.innerHTML = `
      <img src="${r.url}" alt="${escapeHtml(r.tag)}">
      <div class="meta">
        <div class="name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</div>
        <div class="info"><span>${r.w}×${r.h} · ${r.frames}f · ${r.fps}fps</span><span class="size ${over ? 'over' : 'ok'}">${fmtBytes(r.size)}</span></div>
        ${over ? `<div class="info"><span style="color:var(--bad)">한도 ${$('limitMB').value}MB 초과</span></div>` : ''}
        <div class="acts">
          <button class="btn sm" data-act="dl">⬇ 저장</button>
          ${over ? '<button class="btn sm" data-act="fit">한도에 맞춰 줄이기</button>' : ''}
          <button class="btn sm ghost" data-act="rm" title="목록에서 지우기">✕</button>
        </div>
      </div>`;
    el.querySelector('[data-act=dl]').onclick = () => downloadBlob(r.blob, r.name);
    el.querySelector('[data-act=rm]').onclick = () => { URL.revokeObjectURL(r.url); S.results.splice(S.results.indexOf(r), 1); renderResults(); };
    const fit = el.querySelector('[data-act=fit]');
    if (fit) fit.onclick = () => fitToLimit(r);
    box.appendChild(el);
  }
}
function fitToLimit(r) {
  const ratio = Math.sqrt(limitBytes() / r.size) * 0.85;
  const w = Math.max(16, Math.floor(r.w * ratio)), h = Math.max(16, Math.round(w * r.h / r.w));
  toast(`${r.w}px → ${w}px로 줄여서 다시 만들어요`);
  build(r.segIds, { w, h });
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function saveToFolder() {
  if (!S.results.length) return;
  if (!window.showDirectoryPicker) {
    toast('이 브라우저는 폴더 저장을 지원하지 않아 하나씩 다운로드해요');
    for (const r of S.results) { downloadBlob(r.blob, r.name); await new Promise((res) => setTimeout(res, 350)); }
    return;
  }
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'gifmaker' });
    for (const r of S.results) {
      const fh = await dir.getFileHandle(r.name, { create: true });
      const ws = await fh.createWritable(); await ws.write(r.blob); await ws.close();
    }
    toast(`${S.results.length}개를 "${dir.name}" 폴더에 저장했어요`);
  } catch (e) { if (e.name !== 'AbortError') toast('폴더 저장 실패: ' + e.message, 4000); }
}
/* 무압축 ZIP (GIF는 이미 압축돼 있어서 충분) */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
async function saveZip() {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const r of S.results) {
    const data = new Uint8Array(await r.blob.arrayBuffer()), name = enc.encode(r.name), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, p) => a + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, S.results.length, true); end.setUint16(10, S.results.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  downloadBlob(new Blob([...parts, ...central, end.buffer], { type: 'application/zip' }), `${S.base}_gifs.zip`);
}

/* ---------------- 구간 ---------------- */
function addSeg(start, end) {
  if (!S.duration) return;
  start = clamp(start, 0, S.duration); end = clamp(end, 0, S.duration);
  if (end < start) [start, end] = [end, start];
  if (end - start < 0.1) end = Math.min(S.duration, start + 3);
  if (end - start < 0.1) { toast('구간이 너무 짧아요'); return; }
  const idx = S.seq++;
  const seg = { id: 'g' + Date.now() + idx, label: labelFor(idx), color: SEG_COLORS[idx % SEG_COLORS.length], start, end, on: true, est: null, status: null };
  S.segs.push(seg); S.sel = seg.id;
  S.markIn = S.markOut = null;
  renderSegs(); renderMarks(); onSettingsChanged();
  return seg;
}
function selSeg() { return S.segs.find((s) => s.id === S.sel) || null; }
function selectSeg(id, seek = true) {
  S.sel = id; const s = selSeg();
  if (s && seek && !(video.currentTime >= s.start && video.currentTime <= s.end)) seekTo(s.start);
  renderSegs(); renderStatus();
}
function removeSeg(id) {
  S.segs = S.segs.filter((s) => s.id !== id);
  if (S.sel === id) S.sel = S.segs[0]?.id || null;
  renderSegs(); renderStatus();
}
function segChanged(seg) {
  seg.est = null; seg.status = null;
  renderSegs(); renderStatus();
  clearTimeout(estTimer); estTimer = setTimeout(runEstimates, 450);
}
function renderSegs() { renderSegBlocks(); renderSegRows(); $('buildAllBtn').disabled = S.busy || !S.segs.some((s) => s.on); }
let rowsDeferred = false;
function renderSegRows() {
  const tb = $('segRows');
  const ae = document.activeElement;
  if (ae && ae.classList.contains('t') && tb.contains(ae)) { // 시간 입력 중엔 다시 그리지 않음
    if (!rowsDeferred) { rowsDeferred = true; ae.addEventListener('blur', () => { rowsDeferred = false; setTimeout(renderSegRows); }, { once: true }); }
    return;
  }
  if (!S.segs.length) { tb.innerHTML = '<tr class="empty-row"><td colspan="9">구간이 없어요. 타임라인에서 범위를 찍고 <b>＋ 구간 추가</b>.</td></tr>'; $('chkAll').checked = true; return; }
  const st = settings(), lim = limitBytes();
  tb.innerHTML = '';
  for (const s of S.segs) {
    const tr = document.createElement('tr'); if (s.id === S.sel) tr.className = 'sel';
    const est = s.estState === 'busy' && s.est == null ? '<span class="muted">계산 중…</span>'
      : s.est == null ? '<span class="muted">-</span>'
      : `<span class="est ${s.est > lim ? 'over' : s.est > lim * 0.8 ? 'near' : ''}">≈ ${fmtBytes(s.est)}</span>`;
    const status = s.status === 'busy' ? '<span class="st-busy">만드는 중</span>' : s.status === 'done' ? '<span class="st-done">✔ 완료</span>' : s.status === 'over' ? '<span class="st-over">⚠ 한도 초과</span>' : '<span class="muted">대기</span>';
    tr.innerHTML = `
      <td class="c-chk"><input type="checkbox" ${s.on ? 'checked' : ''} data-k="on"></td>
      <td><span class="lbl" style="background:${s.color}">${s.label}</span></td>
      <td><input class="t" value="${fmtTime(s.start)}" data-k="start"></td>
      <td><input class="t" value="${fmtTime(s.end)}" data-k="end"></td>
      <td>${(s.end - s.start).toFixed(2)}초</td>
      <td>${frameCount(s, st)}</td>
      <td>${est}</td>
      <td>${status}</td>
      <td class="acts">
        <button class="btn sm ghost" data-k="setIn" title="시작을 현재 위치로 ( [ )">⇤ 현재</button>
        <button class="btn sm ghost" data-k="setOut" title="끝을 현재 위치로 ( ] )">현재 ⇥</button>
        <button class="btn sm" data-k="one" title="이 구간만 GIF 만들기">GIF</button>
        <button class="btn sm ghost" data-k="del" title="삭제 (Delete)">🗑</button>
      </td>`;
    tr.addEventListener('click', (e) => { if (!e.target.closest('input,button')) selectSeg(s.id); });
    tr.querySelector('[data-k=on]').onchange = (e) => { s.on = e.target.checked; renderSegs(); renderStatus(); };
    for (const k of ['start', 'end']) {
      const inp = tr.querySelector(`[data-k=${k}]`);
      inp.onfocus = () => selectSeg(s.id, false);
      inp.onchange = () => {
        const v = parseTime(inp.value);
        if (isNaN(v)) { inp.value = fmtTime(s[k]); return; }
        if (k === 'start') s.start = clamp(v, 0, s.end - 0.1); else s.end = clamp(v, s.start + 0.1, S.duration);
        segChanged(s); seekTo(s[k]);
      };
      inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
    }
    tr.querySelector('[data-k=setIn]').onclick = () => setSegEdge(s, 'start');
    tr.querySelector('[data-k=setOut]').onclick = () => setSegEdge(s, 'end');
    tr.querySelector('[data-k=one]').onclick = () => build([s.id]);
    tr.querySelector('[data-k=del]').onclick = () => removeSeg(s.id);
    tb.appendChild(tr);
  }
  $('chkAll').checked = S.segs.every((s) => s.on);
}
function setSegEdge(s, k) {
  const t = video.currentTime;
  if (k === 'start') { if (t >= s.end - 0.1) return toast('끝점보다 앞에서 눌러주세요'); s.start = t; }
  else { if (t <= s.start + 0.1) return toast('시작점보다 뒤에서 눌러주세요'); s.end = t; }
  segChanged(s);
}

/* ---------------- 상태 패널 ---------------- */
function renderStatus() {
  const s = selSeg(), st = settings(), lim = limitBytes();
  $('selLabel').textContent = s ? s.label : '-';
  $('selLabel').style.color = s ? s.color : '';
  $('stSize').textContent = S.duration ? `${S.outW} × ${S.outH} px` : '-';
  if (!s) {
    ['stLen', 'stFrames', 'stPlay', 'stEst'].forEach((id) => ($(id).textContent = '-'));
    $('gaugeBar').style.width = '0%'; $('gaugeNote').textContent = S.duration ? '구간을 추가하면 예상 용량이 보여요' : '';
    return;
  }
  const n = frameCount(s, st);
  $('stLen').textContent = `${fmtTime(s.start)} → ${fmtTime(s.end)} (${(s.end - s.start).toFixed(2)}초)`;
  $('stFrames').textContent = `${n}장 · ${st.fps}fps`;
  $('stPlay').textContent = `${(n / st.fps).toFixed(2)}초` + (st.speed !== 1 ? ` (${st.speed}배속)` : '');
  const res = S.results.find((r) => r.key === s.id);
  let note = '';
  if (s.est != null) {
    const p = s.est / lim;
    $('stEst').textContent = '≈ ' + fmtBytes(s.est);
    $('gaugeBar').style.width = Math.min(100, p * 100).toFixed(1) + '%';
    $('gaugeBar').style.background = p > 1 ? 'var(--bad)' : p > 0.8 ? 'var(--warn)' : 'var(--accent)';
    note = p > 1 ? `한도 ${$('limitMB').value}MB 초과 예상 — 크기·fps·색상 수·길이를 줄여보세요` : `한도 ${$('limitMB').value}MB 중 ${(p * 100).toFixed(0)}%`;
  } else {
    $('stEst').textContent = s.estState === 'busy' ? '계산 중…' : '-';
    $('gaugeBar').style.width = '0%';
  }
  if (res) note += ` · 실제 만든 파일 ${fmtBytes(res.size)}`;
  const on = S.segs.filter((x) => x.on);
  if (on.length > 1) {
    const sum = on.reduce((a, x) => a + (x.est || 0), 0), all = on.every((x) => x.est != null);
    note += ` · 체크된 ${on.length}개 합계 ${all ? '≈ ' + fmtBytes(sum) : '계산 중'}`;
  }
  $('gaugeNote').textContent = note;
}

/* ---------------- 타임라인 ---------------- */
const tlScroll = $('tlScroll'), tlInner = $('tlInner'), ruler = $('ruler'), thumbsCv = $('thumbs'), segTrack = $('segTrack');
let tlW = 0;
const pps = () => (S.duration ? tlW / S.duration : 1);
const xToT = (x) => clamp(x / pps(), 0, S.duration);
function layoutTimeline() {
  const z = +$('zoom').value;
  tlW = Math.min(32000, Math.floor(tlScroll.clientWidth * z));
  tlInner.style.width = tlW + 'px';
  drawRuler(); drawThumbs(); renderSegBlocks(); renderMarks(); renderPlayhead();
}
function canvasSize(cv, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 32000 / Math.max(1, tlW));
  cv.width = Math.floor(tlW * dpr); cv.height = Math.floor(h * dpr);
  cv.style.width = tlW + 'px'; cv.style.height = h + 'px';
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); return c;
}
function drawRuler() {
  const c = canvasSize(ruler, 22);
  c.fillStyle = '#17191d'; c.fillRect(0, 0, tlW, 22);
  if (!S.duration) return;
  const p = pps(), steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * p >= 80) || 600, minor = step / 5;
  c.strokeStyle = '#3a3e46'; c.fillStyle = '#8b909b'; c.font = '10px ui-monospace, monospace'; c.textBaseline = 'top';
  c.beginPath();
  for (let i = 0; i * minor <= S.duration + 1e-6; i++) {
    const t = i * minor, x = Math.round(t * p) + 0.5, major = i % 5 === 0;
    c.moveTo(x, major ? 10 : 16); c.lineTo(x, 22);
    if (major) c.fillText(step < 1 ? t.toFixed(1) + 's' : fmtTime(t, false), x + 3, 2);
  }
  c.stroke();
}
async function makeThumbs() {
  const url = S.url, n = Math.min(60, Math.max(8, Math.ceil(S.duration)));
  const th = 48, tw = Math.round(th * S.vw / S.vh);
  S.thumbs = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) * S.duration / n;
    const bmp = await withExtractor(async () => {
      if (url !== S.url) return null;
      await seekX(t);
      const cv = document.createElement('canvas'); cv.width = tw; cv.height = th;
      cv.getContext('2d').drawImage(xv, 0, 0, tw, th); return cv;
    });
    if (!bmp || url !== S.url) return;
    S.thumbs.push({ t, cv: bmp });
    if (i % 6 === 5 || i === n - 1) drawThumbs();
  }
}
function drawThumbs() {
  const c = canvasSize(thumbsCv, 48);
  c.fillStyle = '#0b0c0e'; c.fillRect(0, 0, tlW, 48);
  if (!S.thumbs.length || !S.vh) return;
  const tw = Math.round(48 * S.vw / S.vh);
  for (let x = 0; x < tlW; x += tw) {
    const t = (x + tw / 2) / pps();
    let best = S.thumbs[0];
    for (const th of S.thumbs) if (Math.abs(th.t - t) < Math.abs(best.t - t)) best = th;
    c.drawImage(best.cv, x, 0, tw, 48);
  }
  c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(0, 0, tlW, 48);
}
function renderSegBlocks() {
  segTrack.querySelectorAll('.seg').forEach((e) => e.remove());
  if (!S.duration) return;
  const p = pps();
  for (const s of S.segs) {
    const d = document.createElement('div');
    d.className = 'seg' + (s.id === S.sel ? ' sel' : '') + (s.on ? '' : ' off');
    d.style.left = s.start * p + 'px'; d.style.width = Math.max(4, (s.end - s.start) * p) + 'px';
    d.style.background = s.color; d.dataset.id = s.id;
    d.innerHTML = `<i class="eh l" data-edge="start"></i>${s.label}<i class="eh r" data-edge="end"></i>`;
    segTrack.appendChild(d);
  }
}
function renderMarks() {
  const mr = $('markRange'), info = $('markInfo');
  if (S.markIn == null && S.markOut == null) { mr.hidden = true; info.textContent = '시작 I · 끝 O 로 범위를 찍고 Enter로 구간 추가 (Alt+드래그로 바로 그리기)'; return; }
  const a = S.markIn ?? 0, b = S.markOut ?? Math.min(S.duration, a + 3);
  mr.hidden = false;
  mr.style.left = Math.min(a, b) * pps() + 'px'; mr.style.width = Math.abs(b - a) * pps() + 'px';
  info.textContent = `표시 범위: ${S.markIn != null ? fmtTime(S.markIn) : '처음'} → ${S.markOut != null ? fmtTime(S.markOut) : '(시작+3초)'} — Enter로 구간 추가`;
}
function renderPlayhead() {
  const t = video.currentTime || 0;
  $('playhead').style.left = t * pps() + 'px';
  $('curTime').textContent = fmtTime(t);
}
function seekTo(t) {
  if (!S.duration) return;
  video.currentTime = clamp(t, 0, S.duration);
  renderPlayhead();
}
function ensureVisible() {
  const x = (video.currentTime || 0) * pps();
  if (x < tlScroll.scrollLeft || x > tlScroll.scrollLeft + tlScroll.clientWidth - 20) tlScroll.scrollLeft = x - tlScroll.clientWidth / 3;
}

/* 타임라인 마우스 조작 */
tlInner.addEventListener('pointerdown', (e) => {
  if (!S.duration || e.button !== 0) return;
  const rect = tlInner.getBoundingClientRect();
  const tAt = (ev) => xToT(ev.clientX - rect.left);
  const segEl = e.target.closest('.seg');
  let move;
  if (segEl && !S.busy) {
    const s = S.segs.find((x) => x.id === segEl.dataset.id);
    const edge = e.target.dataset.edge;
    selectSeg(s.id, false);
    const t0 = tAt(e), s0 = s.start, e0 = s.end;
    let changed = false;
    move = (ev) => {
      const dt = tAt(ev) - t0; changed = true;
      if (edge === 'start') { s.start = clamp(s0 + dt, 0, s.end - 0.1); seekTo(s.start); }
      else if (edge === 'end') { s.end = clamp(e0 + dt, s.start + 0.1, S.duration); seekTo(s.end); }
      else { const len = e0 - s0; s.start = clamp(s0 + dt, 0, S.duration - len); s.end = s.start + len; seekTo(s.start); }
      renderSegBlocks(); renderSegRows(); renderStatus();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (changed) segChanged(s); else seekTo(t0); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  } else if (e.altKey && e.target.closest('#segTrack') && !S.busy) {
    const t0 = tAt(e);
    S.markIn = t0; S.markOut = t0; renderMarks();
    move = (ev) => { S.markOut = tAt(ev); renderMarks(); };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (Math.abs(S.markOut - S.markIn) >= 0.1) addSeg(S.markIn, S.markOut); else { S.markIn = S.markOut = null; renderMarks(); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  } else {
    video.pause(); seekTo(tAt(e));
    move = (ev) => seekTo(tAt(ev));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  e.preventDefault();
});

/* ---------------- 재생 ---------------- */
function togglePlay() {
  if (!S.duration) return;
  if (video.paused) {
    const s = selSeg();
    if ($('loopSeg').checked && s && (video.currentTime < s.start || video.currentTime >= s.end - 0.05)) video.currentTime = s.start;
    video.play();
  } else video.pause();
}
video.addEventListener('play', () => ($('playBtn').textContent = '❚❚'));
video.addEventListener('pause', () => ($('playBtn').textContent = '▶'));
video.addEventListener('seeked', renderPlayhead);
(function tick() {
  if (!video.paused) {
    const s = selSeg();
    if ($('loopSeg').checked && s && video.currentTime >= s.end) video.currentTime = s.start;
    renderPlayhead(); ensureVisible();
  }
  requestAnimationFrame(tick);
})();
function step(d) { video.pause(); seekTo((video.currentTime || 0) + d); ensureVisible(); }
function toEdge(end) {
  const s = selSeg(), t = video.currentTime;
  if (s) seekTo(end ? (t < s.end - 0.01 ? s.end : S.duration) : (t > s.start + 0.01 ? s.start : 0));
  else seekTo(end ? S.duration : 0);
  ensureVisible();
}
function markIn() { if (!S.duration) return; S.markIn = video.currentTime; if (S.markOut != null && S.markOut <= S.markIn) S.markOut = null; renderMarks(); }
function markOut() { if (!S.duration) return; S.markOut = video.currentTime; if (S.markIn != null && S.markIn >= S.markOut) S.markIn = null; renderMarks(); }
function addFromMarks() {
  if (!S.duration) return;
  const a = S.markIn ?? (S.markOut != null ? Math.max(0, S.markOut - 3) : video.currentTime);
  const b = S.markOut ?? Math.min(S.duration, a + 3);
  addSeg(a, b);
}

/* ---------------- 크롭 ---------------- */
const cropBox = $('cropBox');
function renderCrop() {
  cropBox.hidden = !S.cropOn || !S.vw;
  if (cropBox.hidden) return;
  const k = video.clientWidth / S.vw, c = S.crop;
  Object.assign(cropBox.style, { left: c.x * k + 'px', top: c.y * k + 'px', width: c.w * k + 'px', height: c.h * k + 'px' });
  $('cropLabel').textContent = `${Math.round(c.w)}×${Math.round(c.h)}`;
}
function applyCropRatio() {
  const r = S.cropRatio === 'free' ? null : +S.cropRatio;
  if (!r || !S.crop) return;
  const c = S.crop, cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  let w = c.w, h = w / r;
  if (h > S.vh) { h = S.vh; w = h * r; }
  if (w > S.vw) { w = S.vw; h = w / r; }
  S.crop = { w, h, x: clamp(cx - w / 2, 0, S.vw - w), y: clamp(cy - h / 2, 0, S.vh - h) };
}
function cropChanged() {
  S.crop = { x: Math.round(S.crop.x), y: Math.round(S.crop.y), w: Math.max(8, Math.round(S.crop.w)), h: Math.max(8, Math.round(S.crop.h)) };
  if (S.outW > S.crop.w && S.cropOn) S.outW = S.crop.w;
  syncHeightFromWidth(); renderSizeInputs(); renderCrop(); onSettingsChanged();
}
cropBox.addEventListener('pointerdown', (e) => {
  if (S.busy) return;
  const h = e.target.dataset.h, k = video.clientWidth / S.vw, c0 = { ...S.crop }, x0 = e.clientX, y0 = e.clientY;
  const r = S.cropRatio === 'free' ? null : +S.cropRatio;
  const move = (ev) => {
    const dx = (ev.clientX - x0) / k, dy = (ev.clientY - y0) / k;
    let { x, y, w, h: hh } = c0;
    if (!h) { x = clamp(c0.x + dx, 0, S.vw - w); y = clamp(c0.y + dy, 0, S.vh - hh); }
    else {
      const right = c0.x + c0.w, bottom = c0.y + c0.h;
      if (h.includes('w')) { x = clamp(c0.x + dx, 0, right - 16); w = right - x; } else w = clamp(c0.w + dx, 16, S.vw - c0.x);
      if (h.includes('n')) { y = clamp(c0.y + dy, 0, bottom - 16); hh = bottom - y; } else hh = clamp(c0.h + dy, 16, S.vh - c0.y);
      if (r) {
        hh = w / r;
        if (h.includes('n')) y = bottom - hh;
        if (y < 0 || y + hh > S.vh) { hh = h.includes('n') ? bottom : S.vh - c0.y; w = hh * r; if (h.includes('w')) x = right - w; if (h.includes('n')) y = bottom - hh; }
      }
    }
    S.crop = { x, y, w, h: hh }; renderCrop();
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); cropChanged(); };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  e.preventDefault(); e.stopPropagation();
});
new ResizeObserver(() => { renderCrop(); layoutTimeline(); }).observe(video);
new ResizeObserver(() => layoutTimeline()).observe(tlScroll);

/* ---------------- 이벤트 연결 ---------------- */
$('fileInput').onchange = (e) => { openFile(e.target.files[0]); e.target.value = ''; };
const stage = $('stage');
['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.add('dragover'); }));
['dragleave', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || !e.relatedTarget) stage.classList.remove('dragover'); }));
window.addEventListener('drop', (e) => openFile(e.dataTransfer.files[0]));

$('playBtn').onclick = togglePlay;
$('stepBackBtn').onclick = () => step(-STEP);
$('stepFwdBtn').onclick = () => step(STEP);
$('toStartBtn').onclick = () => toEdge(false);
$('toEndBtn').onclick = () => toEdge(true);
$('markInBtn').onclick = markIn;
$('markOutBtn').onclick = markOut;
$('addSegBtn').onclick = addFromMarks;
$('buildAllBtn').onclick = () => build(S.segs.filter((s) => s.on).map((s) => s.id));
$('cancelBtn').onclick = () => (S.cancel = true);
$('saveFolderBtn').onclick = saveToFolder;
$('saveZipBtn').onclick = saveZip;
$('estimateBtn').onclick = onSettingsChanged;
$('chkAll').onchange = (e) => { S.segs.forEach((s) => (s.on = e.target.checked)); renderSegs(); renderStatus(); };
$('zoom').oninput = () => { const c = (tlScroll.scrollLeft + tlScroll.clientWidth / 2) / tlW; layoutTimeline(); tlScroll.scrollLeft = c * tlW - tlScroll.clientWidth / 2; };
$('helpBtn').onclick = () => ($('helpModal').hidden = false);
$('helpClose').onclick = () => ($('helpModal').hidden = true);
$('helpModal').onclick = (e) => { if (e.target.id === 'helpModal') e.target.hidden = true; };

$('outW').onchange = () => setOutW(+$('outW').value);
$('outH').onchange = () => {
  const h = clamp(Math.round(+$('outH').value) || 1, 1, 4000), r = srcRect();
  if (S.lock && r.h) S.outW = Math.max(1, Math.round(h * r.w / r.h));
  S.outH = h; renderSizeInputs(); onSettingsChanged();
};
$('lockBtn').onclick = () => { S.lock = !S.lock; if (S.lock) syncHeightFromWidth(); renderSizeInputs(); onSettingsChanged(); };
$('sizePresets').onclick = (e) => {
  const b = e.target.closest('button'); if (!b || !S.duration) return;
  const w = +b.dataset.w; if (!S.lock) S.lock = true;
  setOutW(w === 0 ? srcRect().w : w);
};
$('cropOn').onchange = (e) => {
  S.cropOn = e.target.checked;
  if (S.cropOn && S.crop && S.crop.w === S.vw && S.crop.h === S.vh) { S.crop = { x: S.vw * 0.1, y: S.vh * 0.1, w: S.vw * 0.8, h: S.vh * 0.8 }; applyCropRatio(); }
  cropChanged();
};
$('cropRatio').onchange = (e) => { S.cropRatio = e.target.value; if (!S.cropOn) { S.cropOn = true; $('cropOn').checked = true; } applyCropRatio(); cropChanged(); };
$('cropReset').onclick = () => { if (!S.vw) return; S.crop = { x: 0, y: 0, w: S.vw, h: S.vh }; applyCropRatio(); cropChanged(); };

const showVal = () => {
  $('fpsVal').textContent = $('fps').value;
  $('speedVal').textContent = (+$('speed').value).toFixed(2).replace(/0$/, '') + '×';
  $('colorsVal').textContent = COLORS_STEPS[+$('colors').value];
  $('optimize').disabled = $('palette').value !== 'global' || S.busy;
};
['fps', 'speed', 'colors'].forEach((id) => { $(id).oninput = () => { showVal(); renderSegRows(); renderStatus(); }; $(id).onchange = () => { showVal(); onSettingsChanged(); saveSettings(); }; });
['palette', 'repeat', 'optimize', 'mode'].forEach((id) => ($(id).onchange = () => { showVal(); onSettingsChanged(); saveSettings(); }));
$('limitMB').onchange = () => { renderSegRows(); renderStatus(); renderResults(); saveSettings(); };
$('resetSettings').onclick = () => { applySettings(DEFAULTS); if (S.duration) setOutW(Math.min(S.vw, DEFAULTS.width)); saveSettings(); };

function saveSettings() {
  try {
    localStorage.setItem('gifmaker.settings', JSON.stringify({
      width: S.outW, fps: +$('fps').value, speed: +$('speed').value, colorsIdx: +$('colors').value, palette: $('palette').value,
      repeat: $('repeat').value, optimize: $('optimize').checked, mode: $('mode').value, limitMB: +$('limitMB').value,
    }));
  } catch (e) { /* 저장 불가 환경이면 무시 */ }
}
function applySettings(o) {
  $('fps').value = o.fps; $('speed').value = o.speed; $('colors').value = o.colorsIdx; $('palette').value = o.palette;
  $('repeat').value = o.repeat; $('optimize').checked = o.optimize; $('mode').value = o.mode; $('limitMB').value = o.limitMB;
  $('outW').dataset.pref = o.width;
  showVal(); onSettingsChanged();
}
try { const saved = JSON.parse(localStorage.getItem('gifmaker.settings') || 'null'); applySettings({ ...DEFAULTS, ...(saved || {}) }); }
catch (e) { applySettings(DEFAULTS); }
$('outW').addEventListener('change', saveSettings);

/* 단축키 */
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('helpModal').hidden = true; document.activeElement?.blur(); return; }
  const tag = e.target.tagName;
  if ((tag === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range') || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); $('fileInput').click(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); $('buildAllBtn').click(); return; }
  if (!S.duration || e.ctrlKey || e.metaKey) return;
  const s = selSeg();
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); step(e.shiftKey ? -1 : -STEP); break;
    case 'ArrowRight': e.preventDefault(); step(e.shiftKey ? 1 : STEP); break;
    case 'i': case 'I': markIn(); break;
    case 'o': case 'O': markOut(); break;
    case 'Enter': e.preventDefault(); addFromMarks(); break;
    case '[': if (s) setSegEdge(s, 'start'); break;
    case ']': if (s) setSegEdge(s, 'end'); break;
    case 'Delete': case 'Backspace': if (s && !S.busy) removeSeg(s.id); break;
    case 'Tab': if (S.segs.length) { e.preventDefault(); const i = S.segs.findIndex((x) => x.id === S.sel); selectSeg(S.segs[(i + (e.shiftKey ? -1 : 1) + S.segs.length) % S.segs.length].id); } break;
    case 'l': case 'L': $('loopSeg').checked = !$('loopSeg').checked; break;
    case 'Home': e.preventDefault(); toEdge(false); break;
    case 'End': e.preventDefault(); toEdge(true); break;
  }
});

renderSegs(); renderStatus(); renderResults(); layoutTimeline();
})();
