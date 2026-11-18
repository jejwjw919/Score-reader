/* Score Reader 인식 엔진 (OpenCV.js) — PC 프로그램 score_reader.py 를 그대로 옮긴 것.
 * 게임 이미지는 들어 있지 않고, 글자 모양·기준 글자·상수표는 모두 사용자가 등록한 데이터(db)를 쓴다.
 *
 *   const R = ScoreReaderEngine(cv);
 *   const im = R.matFromImageData(imageData);          // BGR Mat
 *   const row = R.recognize(im, db, "파일이름.png");     // { song, diff, level, score, ..., check, ok }
 */
(function (root) {
  "use strict";

  const REF_W = 2316, REF_H = 1596, STD_W = 2420, STD_H = 1668;
  const EXPECTED_RATIO = STD_W / STD_H, RATIO_TOL = 0.02;
  const ROIS = {
    level: [72, 530, 122, 586], plus: [118, 515, 168, 565], diff: [170, 512, 400, 558], diamond: [40, 500, 165, 620],
    recall: [400, 560, 600, 610], cover: [55, 632, 735, 1310], title: [300, 285, 1560, 385], score: [900, 660, 1420, 770],
    highscore: [1105, 795, 1360, 850], grade: [1030, 880, 1290, 1010], pure: [1160, 1082, 1295, 1143],
    far: [1160, 1150, 1295, 1214], lost: [1160, 1216, 1295, 1280],
  };
  // 숫자 칸: [극성, 임계값, 글자 모양 묶음]  (순서도 PC와 같게)
  const DIGITS = [["score", "light", 190, "score"], ["highscore", "light", 170, "hs"], ["level", "light", 235, "level"],
    ["recall", "dark", 110, "recall"], ["pure", "light", 235, "stat"], ["far", "light", 235, "stat"], ["lost", "light", 235, "stat"]];
  const FIELD_GROUP = Object.fromEntries(DIGITS.map(d => [d[0], d[3]]));
  const MIN_H_RATIO = { pure: 0.8, far: 0.8, lost: 0.8 };
  const MIN_SIM = 0.70, MAX_PER_CHAR = 3, MAX_DIGIT_VARIANTS = 10, DUP_SIM = 0.95;
  const EDGE_DROP = new Set(["recall", "pure", "far", "lost"]);
  const DIFF_TEXT_MIN = 0.60, DIFF_COLOR_MAX = 0.30, COVER_MAX_DIST = 30;
  const ANCHORS = { hs: [872, 835, 235, 53], recall: [179, 590, 223, 42] };
  const ANCHOR_REF = { hs: [911.14, 849.0, 157.92, 24.0, "light"], recall: [197.98, 594.0, 193.64, 30.0, "dark"] };
  const ANCHOR_BOX_STD = { hs: [895, 841, 1085, 881], recall: [177, 587, 420, 631] };
  const ANCHOR_LABEL = { hs: "HIGH SCORE", recall: "MAX RECALL" };
  const LEFT_REGION = [0, 480, 840, 1420];
  const ANCHOR_MIN = 0.60, SHIFT_MAX = 60;
  const PLUS_REGION = [40, 495, 190, 625];
  const DIFF_TAG = { PAST: "PST", PRESENT: "PRS", FUTURE: "FTR", ETERNAL: "ETR", BEYOND: "BYD", INS: "INS" };
  const TAG_NAME = Object.fromEntries(Object.entries(DIFF_TAG).map(([k, v]) => [v, k]));
  const TAG_ORDER = ["PST", "PRS", "FTR", "ETR", "BYD", "INS"];
  const DIFFS = Object.keys(DIFF_TAG), GRADES = ["EX+", "EX", "AA", "A", "B", "C", "D"];

  // ---------- 파이썬과 똑같이 동작하게 하는 작은 함수들 ----------
  const pyRound = x => { const f = Math.floor(x), d = x - f; return d === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(x); };
  const pyInt = s => { const t = String(s).replace(/,/g, "").trim(); return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : null; };
  const isFloat = s => { const t = String(s).trim(); return t !== "" && !isNaN(Number(t)); };
  const LINE_SEP = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85" + String.fromCharCode(0x2028, 0x2029) + "]");   // 파이썬 splitlines 와 같은 줄바꿈들
  const splitlines = text => { const a = String(text).split(LINE_SEP); if (a.length && a[a.length - 1] === "") a.pop(); return a; };
  const songKey = name => String(name).trim().split(/\s+/).join(" ").toLowerCase();
  const signed = v => (v >= 0 ? "+" : "") + v;
  const comma = n => Number(n).toLocaleString("en-US");
  const b64ToBytes = b => { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const bytesToB64 = u => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };

  function ScoreReaderEngine(cv) {
    // ---------- Mat 도우미 ----------
    const gray = m => { const g = new cv.Mat(); cv.cvtColor(m, g, cv.COLOR_BGR2GRAY); return g; };
    const resizeF = (m, f, interp) => { const d = new cv.Mat(); cv.resize(m, d, new cv.Size(0, 0), f, f, interp); return d; };
    const resizeTo = (m, w, h, interp) => { const d = new cv.Mat(); cv.resize(m, d, new cv.Size(w, h), 0, 0, interp); return d; };
    const sub = (m, x1, y1, x2, y2) => {     // 파이썬 m[y1:y2, x1:x2] (범위 밖은 잘라냄), 빈 영역이면 null
      x1 = Math.max(0, Math.min(m.cols, x1)); x2 = Math.max(0, Math.min(m.cols, x2));
      y1 = Math.max(0, Math.min(m.rows, y1)); y2 = Math.max(0, Math.min(m.rows, y2));
      if (x2 <= x1 || y2 <= y1) return null;
      return m.roi(new cv.Rect(x1, y1, x2 - x1, y2 - y1));
    };
    const matFromBytes = (w, h, bytes) => { const m = new cv.Mat(h, w, cv.CV_8UC1); m.data.set(bytes); return m; };
    const bytesOf = m => { const c = m.isContinuous() ? m : m.clone(); const u = new Uint8Array(c.data); if (c !== m) c.delete(); return u; };
    function withMats(fn) { const T = []; const k = m => (m && T.push(m), m); try { return fn(k); } finally { for (const m of T) m.delete(); } }

    function matFromImageData(imageData) {
      const rgba = cv.matFromImageData(imageData), bgr = new cv.Mat();
      cv.cvtColor(rgba, bgr, cv.COLOR_RGBA2BGR); rgba.delete(); return bgr;
    }

    function crop(im, name, region) {
      const [x1, y1, x2, y2] = region || ROIS[name], h = im.rows, w = im.cols;
      return im.roi(new cv.Rect(Math.floor(x1 / REF_W * w), Math.floor(y1 / REF_H * h),
        Math.floor(x2 / REF_W * w) - Math.floor(x1 / REF_W * w), Math.floor(y2 / REF_H * h) - Math.floor(y1 / REF_H * h)));
    }

    function bestMatch(g, t) {
      if (g.rows < t.rows || g.cols < t.cols) return [-1, { x: 0, y: 0 }];
      const r = new cv.Mat(); cv.matchTemplate(g, t, r, cv.TM_CCOEFF_NORMED);
      const mm = cv.minMaxLoc(r); r.delete(); return [mm.maxVal, mm.maxLoc];
    }

    function components(bin) {      // 연결 성분: [{x,y,w,h,area,cx,cy}], 0번(배경)은 뺌
      const lab = new cv.Mat(), st = new cv.Mat(), cen = new cv.Mat();
      const n = cv.connectedComponentsWithStats(bin, lab, st, cen, 8, cv.CV_32S);
      const s = st.data32S, c = cen.data64F, out = [];
      for (let i = 1; i < n; i++) out.push({ x: s[i * 5], y: s[i * 5 + 1], w: s[i * 5 + 2], h: s[i * 5 + 3], area: s[i * 5 + 4], cx: c[i * 2], cy: c[i * 2 + 1] });
      lab.delete(); st.delete(); cen.delete(); return out;
    }

    function warp(im, f, dx, dy) {
      const M = cv.matFromArray(2, 3, cv.CV_32F, [f, 0, -dx, 0, f, -dy]), out = new cv.Mat();
      cv.warpAffine(im, out, M, new cv.Size(STD_W, STD_H), f < 1 ? cv.INTER_AREA : cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
      M.delete(); return out;
    }

    function pasteLeft(out, left) {
      const [x1, y1, x2, y2] = LEFT_REGION, r = new cv.Rect(x1, y1, x2 - x1, y2 - y1);
      const a = left.roi(r), b = out.roi(r); a.copyTo(b); a.delete(); b.delete();
    }

    // ---------- 기준 글자(사용자 등록) ----------
    const cache = { key: null, anchors: {}, glyphs: {}, labels: {}, charts: null, chartsText: null };
    function prep(db) {                 // db 가 바뀌면(버전 증가) 캐시를 새로 만듦
      const key = db.__v || 0;
      if (cache.key === key && cache.db === db) return;
      for (const n in cache.anchors) cache.anchors[n].delete();
      cache.key = key; cache.db = db; cache.anchors = {}; cache.glyphs = {}; cache.labels = {};
      for (const n of ["hs", "recall"]) { const a = db.anchors && db.anchors[n]; if (a) cache.anchors[n] = matFromBytes(a.w, a.h, a.data); }
      for (const g in (db.glyphs || {})) cache.glyphs[g] = db.glyphs[g].map(t => [t.ch, t.data, Math.hypot(...t.data)]);
      for (const k in (db.labels || {})) cache.labels[k] = db.labels[k].map(t => [t.label, t.data, stats(t.data)]);
    }
    const hasAnchors = db => !!(db.anchors && db.anchors.hs && db.anchors.recall);
    const anchor = (db, n) => { prep(db); return [ANCHORS[n][0], ANCHORS[n][1], cache.anchors[n]]; };

    function findScale(g, db) {
      const [, , tpl] = anchor(db, "hs");
      return withMats(k => {
        const q = 4, small = k(resizeF(g, 1 / q, cv.INTER_AREA)), tSmall = k(resizeF(tpl, 1 / q, cv.INTER_AREA));
        let best = [-1, 1.0, { x: 0, y: 0 }];
        for (let f = 0.30; f <= 3.5; f *= 1.03) {
          const img = resizeF(small, f, f < 1 ? cv.INTER_AREA : cv.INTER_LINEAR);
          const [sc, loc] = bestMatch(img, tSmall); img.delete();
          if (sc > best[0]) best = [sc, f, loc];
        }
        const [, f0, loc0] = best, th = tpl.rows, tw = tpl.cols;
        const cx = loc0.x * q / f0, cy = loc0.y * q / f0, m = 40 / f0;
        const x1 = Math.trunc(Math.max(0, cx - m)), y1 = Math.trunc(Math.max(0, cy - m));
        const x2 = Math.trunc(Math.min(g.cols, cx + (tw + 2 * 40) / f0)), y2 = Math.trunc(Math.min(g.rows, cy + (th + 2 * 40) / f0));
        const win = k(sub(g, x1, y1, x2, y2));
        best = [-1, f0, { x: 0, y: 0 }];
        if (win) {
          const start = f0 * 0.95, stop = f0 * 1.05, step = f0 * 0.0025, delta = (start + step) - start;
          const n = Math.ceil((stop - start) / step);
          for (let i = 0; i < n; i++) {
            const f = start + i * delta, img = resizeF(win, f, f < 1 ? cv.INTER_AREA : cv.INTER_CUBIC);
            const [sc, loc] = bestMatch(img, tpl); img.delete();
            if (sc > best[0]) best = [sc, f, loc];
          }
        }
        const [sc, f, loc] = best;
        return [sc, f, [x1 * f + loc.x, y1 * f + loc.y]];
      });
    }

    function align(im, db) {
      return withMats(k => {
        const g = k(gray(im));
        const [sc, f, [px, py]] = findScale(g, db);
        if (sc < ANCHOR_MIN) return [null, `HIGH SCORE 글자를 찾지 못함(일치도 ${sc.toFixed(2)})`];
        const [hx, hy] = anchor(db, "hs");
        const out = warp(im, f, px - hx, py - hy);
        const [rx, ry, rtpl] = anchor(db, "recall");
        const big = k(resizeF(g, f, f < 1 ? cv.INTER_AREA : cv.INTER_CUBIC));
        const [rsc, l] = bestMatch(big, rtpl);
        if (rsc < ANCHOR_MIN) { out.delete(); return [null, `MAX RECALL 글자를 찾지 못함(일치도 ${rsc.toFixed(2)}): 카메라 사진이거나 결과 화면이 아님`]; }
        const left = k(warp(im, f, l.x - rx, l.y - ry));
        pasteLeft(out, left);
        return [out, `크기 맞춤 적용(배율 x${f.toFixed(3)}, 일치도 ${sc.toFixed(2)}/${rsc.toFixed(2)})`];
      });
    }

    /** 원본 BGR Mat -> 기준 화면(2420x1668)으로 맞춘 새 Mat. 반환 {im, note}. 실패하면 Error. */
    function load(src, db) {
      const h = src.rows, w = src.cols;
      const sameRatio = Math.abs(w / h - EXPECTED_RATIO) <= RATIO_TOL;
      if (!hasAnchors(db)) {
        if (sameRatio) return { im: resizeTo(src, STD_W, STD_H, cv.INTER_CUBIC), note: "기준 글자 미등록: 크기만 맞춤(설정에서 등록 권장)" };
        throw new Error(`기준 글자를 아직 등록하지 않아 이 크기(${w}x${h})의 화면을 맞출 수 없음 (설정에서 등록하세요)`);
      }
      let std = null;
      if (sameRatio) {
        std = (w === STD_W && h === STD_H) ? src.clone() : resizeTo(src, STD_W, STD_H, cv.INTER_CUBIC);
        const off = {};
        withMats(k => {
          const g = k(gray(std));
          for (const name of ["hs", "recall"]) {
            const [ax, ay, tpl] = anchor(db, name), th = tpl.rows, tw = tpl.cols;
            const x1 = Math.max(0, ax - SHIFT_MAX), y1 = Math.max(0, ay - SHIFT_MAX);
            const r = k(sub(g, x1, y1, ax + tw + SHIFT_MAX, ay + th + SHIFT_MAX));
            if (!r) continue;
            const [sc, l] = bestMatch(r, tpl);
            if (sc >= ANCHOR_MIN) off[name] = [x1 + l.x - ax, y1 + l.y - ay];
          }
        });
        if (off.hs) {
          const c = off.hs, l = off.recall || c;
          if (Math.max(...[...c, ...l].map(Math.abs)) <= 2) return { im: std, note: "" };
          const out = warp(std, 1.0, c[0], c[1]);
          if (l[0] !== c[0] || l[1] !== c[1]) { const left = warp(std, 1.0, l[0], l[1]); pasteLeft(out, left); left.delete(); }
          std.delete();
          return { im: out, note: `위치 보정(가운데 ${signed(c[0])},${signed(c[1])}px / 왼쪽 ${signed(l[0])},${signed(l[1])}px)` };
        }
      }
      const [out, note] = align(src, db);
      if (out) { if (std) std.delete(); return { im: out, note }; }
      if (std) return { im: std, note: "" };
      throw new Error(`결과 화면으로 맞출 수 없음(${w}x${h}): ${note}`);
    }

    // ---------- 글자 읽기 ----------
    function plusMark(im) {
      return withMats(k => {
        const c = k(crop(im, null, PLUS_REGION)), g = k(gray(c)), b = k(new cv.Mat());
        cv.threshold(g, b, 215, 255, cv.THRESH_BINARY);
        const H = g.rows, W = g.cols;
        const inner = components(b).filter(o => o.x > 0 && o.y > 0 && o.x + o.w < W && o.y + o.h < H);
        const digits = inner.filter(o => o.h >= 0.30 * H && o.w <= 0.45 * W);
        if (!digits.length) return false;
        const xr = Math.max(...digits.map(o => o.x + o.w)), yt = Math.min(...digits.map(o => o.y)), hd = Math.max(...digits.map(o => o.h));
        for (const o of inner) {
          if (digits.includes(o)) continue;
          if (!(0.18 * hd <= o.h && o.h <= 0.7 * hd && 0.18 * hd <= o.w && o.w <= 0.75 * hd && 0.6 <= o.w / o.h && o.w / o.h <= 1.6)) continue;
          if (!(xr - 0.15 * hd <= o.x && o.x <= xr + 0.6 * hd) || o.y + o.h / 2 > yt + 0.5 * hd) continue;
          const fill = o.area / (o.w * o.h);
          if (0.25 <= fill && fill <= 0.75) return true;
        }
        return false;
      });
    }

    function digitRun(boxes) {
      const hs = boxes.map(b => b[3]).sort((a, b) => a - b), ys = boxes.map(b => b[1] + b[3]).sort((a, b) => a - b);
      const hMed = hs[hs.length >> 1], botMed = ys[ys.length >> 1];
      const row = boxes.filter(b => Math.abs(b[3] - hMed) <= 0.2 * hMed && Math.abs(b[1] + b[3] - botMed) <= 0.2 * hMed);
      if (!row.length) return boxes;
      const runs = []; let cur = [row[0]];
      for (const b of row.slice(1)) {
        const p = cur[cur.length - 1];
        if (b[0] - (p[0] + p[2]) > 0.8 * hMed) { runs.push(cur); cur = [b]; } else cur.push(b);
      }
      runs.push(cur);
      return runs[runs.length - 1];
    }

    const cmpTuple = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

    function segment(img, polarity, thr, minRatio, edgeDrop) {     // 반환 {mask(Mat), boxes:[[x,y,w,h]]}
      const g = gray(img), mask = new cv.Mat();
      if (polarity === "light") cv.threshold(g, mask, thr, 255, cv.THRESH_BINARY);      // g > thr
      else cv.threshold(g, mask, thr - 1, 255, cv.THRESH_BINARY_INV);                   // g < thr
      g.delete();
      const W = mask.cols;
      let boxes = components(mask).filter(o => o.area > 30 && !(edgeDrop && (o.x <= 0 || o.x + o.w >= W))).map(o => [o.x, o.y, o.w, o.h]);
      if (!boxes.length) return { mask, boxes: [] };
      const maxH = Math.max(...boxes.map(b => b[3]));
      boxes = boxes.filter(b => b[3] >= minRatio * maxH).sort(cmpTuple);
      if (edgeDrop && boxes.length) boxes = digitRun(boxes);
      return { mask, boxes };
    }

    function normGlyph(mask, box) {
      const [x, y, w, h] = box, nw = Math.max(1, Math.min(48, pyRound(w * 48 / h)));
      return withMats(k => {
        const g = k(mask.roi(new cv.Rect(x, y, w, h))), r = k(resizeTo(g, nw, 48, cv.INTER_AREA));
        const out = new Uint8Array(48 * 48), x0 = (48 - nw) >> 1, d = bytesOf(r);
        for (let yy = 0; yy < 48; yy++) out.set(d.subarray(yy * nw, yy * nw + nw), yy * 48 + x0);
        return out;
      });
    }

    function similarity(a, b, nb) {
      let dot = 0, na = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; }
      return dot / (Math.sqrt(na) * (nb === undefined ? Math.hypot(...b) : nb) + 1e-9);
    }

    function stats(d) { let s = 0; for (let i = 0; i < d.length; i++) s += d[i]; const m = s / d.length; let v = 0; for (let i = 0; i < d.length; i++) v += (d[i] - m) ** 2; return [m, Math.sqrt(v)]; }
    function ccoeffNormed(a, sa, b, sb) {   // 같은 크기 두 이미지의 TM_CCOEFF_NORMED
      let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - sa[0]) * (b[i] - sb[0]);
      return sa[1] && sb[1] ? s / (sa[1] * sb[1]) : 0;
    }

    function fixed(img) { return withMats(k => bytesOf(k(resizeTo(k(gray(img)), 160, 48, cv.INTER_AREA)))); }

    function readDigits(im, field, db) {
      prep(db);
      const [, pol, thr, group] = DIGITS.find(d => d[0] === field);
      const c = crop(im, field), { mask, boxes } = segment(c, pol, thr, MIN_H_RATIO[field] || 0.6, EDGE_DROP.has(field));
      c.delete();
      const tpls = cache.glyphs[group] || [];
      let text = "", low = false;
      for (const box of boxes) {
        const g = normGlyph(mask, box); let best = "?", s = MIN_SIM;
        for (const [ch, t, nt] of tpls) { const v = similarity(g, t, nt); if (v > s) { best = ch; s = v; } }
        low = low || best === "?"; text += best;
      }
      mask.delete();
      return [text, low];
    }

    function bestLabel(img, kind, db) {
      prep(db);
      const q = fixed(img), sq = stats(q); let best = null, score = -1;
      for (const [label, t, st] of (cache.labels[kind] || [])) { const s = ccoeffNormed(q, sq, t, st); if (s > score) { best = label; score = s; } }
      return [best, score];
    }

    function diamondSig(im) {
      return withMats(k => {
        const c = k(crop(im, "diamond")), hsv = k(new cv.Mat()); cv.cvtColor(c, hsv, cv.COLOR_BGR2HSV);
        const d = bytesOf(hsv); let n = 0, cs = 0, sn = 0, ss = 0, vs = 0;
        for (let i = 0; i < d.length; i += 3) {
          if (d[i + 1] > 90 && d[i + 2] > 60) { const a = d[i] * Math.PI / 90; cs += Math.cos(a); sn += Math.sin(a); ss += d[i + 1]; vs += d[i + 2]; n++; }
        }
        if (n < 50) return null;
        return [cs / n, sn / n, ss / n / 255, vs / n / 255];
      });
    }

    function bestColorLabel(im, db) {
      const sig = diamondSig(im); if (!sig) return [null, 9.0];
      let best = null, dist = 9.0;
      for (const [label, sigs] of Object.entries(db.colors || {})) for (const t of sigs) {
        const d = Math.hypot(...sig.map((v, i) => v - t[i])); if (d < dist) { best = label; dist = d; }
      }
      return [best, dist];
    }

    function dhash(img) {
      return withMats(k => {
        const d = bytesOf(k(resizeTo(k(gray(img)), 17, 16, cv.INTER_AREA))); let s = "";
        for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) s += d[y * 17 + x + 1] > d[y * 17 + x] ? "1" : "0";
        return s;
      });
    }
    const hamming = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

    // ---------- 상수표 ----------
    function chartTable(db) {
      if (cache.chartsText === db.table && cache.charts) return cache.charts;
      const charts = new Map();
      for (const ln of splitlines(db.table || "")) {
        const p = ln.split("\t"); if (p.length < 4) continue;
        const m = /^(.*) \[(PST|PRS|FTR|ETR|BYD|INS)\]\s*$/.exec(p[2]); if (!m) continue;
        const notes = pyInt(p[3]); if (notes === null) continue;
        const key = m[2] + "|" + notes;
        if (!charts.has(key)) charts.set(key, []);
        charts.get(key).push({ song: m[1].trim(), level: p[0].trim(), const: p[1].trim(), tag: m[2], notes, score: (p[4] || "").trim() });
      }
      cache.charts = charts; cache.chartsText = db.table;
      return charts;
    }
    function chartRows(db) { const out = []; for (const v of chartTable(db).values()) out.push(...v); return out; }

    function totalNotes(row) {
      const a = pyInt(row.pure), b = pyInt(row.far), c = pyInt(row.lost);
      return a === null || b === null || c === null ? null : a + b + c;
    }

    function findSong(row, db, coverName) {
      const charts = chartTable(db);
      if (!charts.size) return [[], "상수표가 비어 있음 (상수표 탭에서 넣어주세요)"];
      const tag = DIFF_TAG[row.diff || ""], total = totalNotes(row);
      if (total === null) return [[], "PURE/FAR/LOST를 읽지 못해 총 노트 수를 모름"];
      if (!tag) return [[], "난이도를 몰라 상수표에서 찾을 수 없음"];
      let cands = charts.get(tag + "|" + total) || [];
      if (!cands.length) return [[], `상수표에 ${tag} ${total}노트 곡이 없음(노트 수 인식 오류 가능)`];
      if (row.level && !row.level.includes("?")) {
        const same = cands.filter(c => c.level === row.level);
        if (!same.length) return [[], `상수표에 ${tag} ${total}노트·레벨 ${row.level} 곡이 없음(같은 노트 수: ${cands.map(c => `${c.song}(레벨 ${c.level})`).join(", ")})`];
        cands = same;
      }
      if (cands.length > 1 && coverName) { const same = cands.filter(c => c.song === coverName); if (same.length) cands = same; }
      return [cands, ""];
    }

    /** 한 장 인식 (PC의 cmd_read 한 장 분량). src = 원본 BGR Mat */
    function recognize(src, db, file) {
      let L;
      try { L = load(src, db); } catch (e) { return { file, check: "처리 불가: " + e.message, ok: false, error: true }; }
      const im = L.im;
      try {
        const row = { file }, issues = [], notes = [];
        for (const [field] of DIGITS) { const [t, low] = readDigits(im, field, db); row[field] = t; if (low || !t) issues.push(field); }
        if (row.level && plusMark(im)) row.level += "+";
        const dc = crop(im, "diff"); let [d, s1] = bestLabel(dc, "diff", db); dc.delete();
        row.diff = d;
        if (d === null || s1 < DIFF_TEXT_MIN) {
          const guess = d ? `글자 ${d} ${s1.toFixed(2)}` : "등록된 글자 템플릿 없음";
          const [cl, cd] = bestColorLabel(im, db);
          if (cl !== null && cd <= DIFF_COLOR_MAX) { row.diff = cl; notes.push("난이도는 마름모 색상으로 판정"); }
          else { issues.push("diff"); notes.push(`diff 진단: ${guess}, 색상 ${cl || "등록 없음"} 거리 ${cd.toFixed(2)}`); row.diff = d || ""; }
        }
        const gc = crop(im, "grade"); const [g, s2] = bestLabel(gc, "grade", db); gc.delete();
        row.grade = g; if (g === null || s2 < 0.6) issues.push("grade");
        const cc = crop(im, "cover"); row.hash = dhash(cc); cc.delete();
        let near = null, nd = 1e9;
        for (const [hk, name] of Object.entries(db.songs || {})) { const dd = hamming(row.hash, hk); if (dd < nd) { nd = dd; near = name; } }
        const [cands, why] = findSong(row, db, near !== null && nd <= COVER_MAX_DIST ? near : null);
        row.notes = totalNotes(row) || "";
        row.cands = cands;
        if (cands.length === 1) { row.song = cands[0].song; row.const = cands[0].const; row.tag = cands[0].tag; }
        else if (cands.length) { row.song = cands.map(c => c.song).join(" / "); row.const = cands.map(c => c.const).join(" / "); issues.push("song"); notes.push(`상수표 후보 ${cands.length}곡`); }
        else { row.song = "?"; row.const = ""; issues.push("song"); notes.push(why); }
        const sc = row.score || "";
        if (!(sc.length === 8 && /^\d+$/.test(sc) && parseInt(sc, 10) <= 10100000)) issues.push("score형식");
        const uniq = [...new Set(issues)];
        row.issues = uniq; row.ok = !uniq.length;
        row.check = row.ok ? "OK" : "검수필요: " + uniq.join(",");
        if (L.note) notes.push(L.note);
        if (notes.length) row.check += " / " + notes.join("; ");
        return row;
      } finally { im.delete(); }
    }

    // ---------- 학습 ----------
    /** 정답 값으로 글자 모양 등을 등록 (PC의 cmd_learn). values = {score, highscore, level, recall, pure, far, lost, diff, grade, song} */
    function learn(src, db, values) {
      const { im } = load(src, db), log = [];
      try {
        db.glyphs = db.glyphs || {}; db.labels = db.labels || {}; db.colors = db.colors || {}; db.songs = db.songs || {};
        for (const [field, pol, thr, group] of DIGITS) {
          let val = values[field]; if (val === undefined || val === null || val === "") continue;
          val = String(val); if (field === "level") val = val.replace(/\++$/, "");
          const c = crop(im, field), { mask, boxes } = segment(c, pol, thr, MIN_H_RATIO[field] || 0.6, EDGE_DROP.has(field)); c.delete();
          if (boxes.length !== val.length) { log.push(`[건너뜀] ${field}: 글자 ${boxes.length}개 분리됨, 정답은 ${val.length}자 (${val})`); mask.delete(); continue; }
          const list = db.glyphs[group] = db.glyphs[group] || []; let saved = 0;
          for (let i = 0; i < val.length; i++) {
            const ch = val[i], g = normGlyph(mask, boxes[i]), same = list.filter(t => t.ch === ch);
            if (same.length >= MAX_DIGIT_VARIANTS) continue;
            if (same.some(t => similarity(g, t.data) >= DUP_SIM)) continue;
            list.push({ ch, w: 48, h: 48, data: g }); saved++;
          }
          mask.delete();
          log.push(`[등록] ${field}: 새 글자 모양 ${saved}개 저장 (${group})`);
        }
        for (const kind of ["diff", "grade"]) {
          const val = values[kind]; if (!val) continue;
          const list = db.labels[kind] = db.labels[kind] || [];
          if (list.filter(t => t.label === val).length < MAX_PER_CHAR) { const c = crop(im, kind); list.push({ label: val, w: 160, h: 48, data: fixed(c) }); c.delete(); }
          if (kind === "diff") {
            const sig = diamondSig(im);
            if (sig && (db.colors[val] || []).length < MAX_PER_CHAR) (db.colors[val] = db.colors[val] || []).push(sig);
          }
          log.push(`[등록] ${kind}: ${val}`);
        }
        if (values.song) { const c = crop(im, "cover"); db.songs[dhash(c)] = values.song; c.delete(); log.push(`[등록] 곡 자켓: ${values.song}`); }
        db.__v = (db.__v || 0) + 1;
        return log;
      } finally { im.delete(); }
    }

    /** 후보 중 하나를 골랐을 때: 자켓만 기억 */
    function rememberCover(db, hash, song) { db.songs = db.songs || {}; db.songs[hash] = song; db.__v = (db.__v || 0) + 1; }

    // ---------- 기준 글자 등록 ----------
    function suggestAnchorBoxes(w, h) {
      const s = h / STD_H, ox = (w - STD_W * s) / 2, out = {};
      for (const [n, [x1, y1, x2, y2]] of Object.entries(ANCHOR_BOX_STD)) out[n] = [Math.trunc(ox + x1 * s), Math.trunc(y1 * s), Math.trunc(ox + x2 * s), Math.trunc(y2 * s)];
      return out;
    }

    function textMeasure(g, box, polarity) {
      const [x1, y1, x2, y2] = box.map(v => Math.trunc(v));
      const c = sub(g, Math.max(0, x1), Math.max(0, y1), x2, y2); if (!c) return null;
      return withMats(k => {
        k(c); const m = k(new cv.Mat());
        cv.threshold(c, m, 0, 255, (polarity === "light" ? cv.THRESH_BINARY : cv.THRESH_BINARY_INV) | cv.THRESH_OTSU);
        let idx = components(m).filter(o => o.area > 6);
        if (!idx.length) return null;
        const hmax = Math.max(...idx.map(o => o.h));
        idx = idx.filter(o => o.h >= 0.6 * hmax && o.h < 0.95 * c.rows);
        if (idx.length < 4) return null;
        const l = idx.reduce((a, b) => (b.cx < a.cx ? b : a)), r = idx.reduce((a, b) => (b.cx > a.cx ? b : a));
        const top = Math.min(...idx.map(o => o.y)), bot = Math.max(...idx.map(o => o.y + o.h));
        return [Math.max(0, x1) + l.cx, Math.max(0, y1) + top, r.cx - l.cx, bot - top];
      });
    }

    /** 사용자가 그린 상자(이미지 좌표 {hs:[x1,y1,x2,y2], recall:[...]})로 기준 글자 등록 */
    function learnAnchors(src, db, boxes) {
      const g = gray(src), m = {};
      try {
        for (const n of ["hs", "recall"]) {
          m[n] = textMeasure(g, boxes[n], ANCHOR_REF[n][4]);
          if (!m[n]) throw new Error(`${ANCHOR_LABEL[n]} 글자를 상자 안에서 찾지 못함. 그 글자만 감싸도록 상자를 다시 그려주세요.`);
        }
      } finally { g.delete(); }
      const dxImg = m.hs[0] - m.recall[0], dyImg = m.hs[1] - m.recall[1];
      if (dxImg <= 0 || dyImg <= 0) throw new Error("두 상자의 위치가 뒤바뀐 것 같아요. HIGH SCORE는 가운데, MAX RECALL은 왼쪽 위에 있어요.");
      const f = (ANCHOR_REF.hs[0] - ANCHOR_REF.recall[0]) / dxImg, fv = (ANCHOR_REF.hs[1] - ANCHOR_REF.recall[1]) / dyImg;
      if (Math.abs(fv / f - 1) > 0.04) throw new Error("두 글자의 위치 관계가 결과 화면과 맞지 않아요. 상자가 각각 HIGH SCORE, MAX RECALL 글자를 감싸는지 확인해주세요.");
      for (const n of ["hs", "recall"]) {
        const ratio = m[n][2] * f / ANCHOR_REF[n][2];
        if (!(0.9 <= ratio && ratio <= 1.1)) throw new Error(`${ANCHOR_LABEL[n]} 상자 안에 다른 글자가 섞였거나 글자가 잘린 것 같아요. 그 글자만 감싸주세요.`);
      }
      const anchors = {};
      for (const n of ["hs", "recall"]) {
        const [x, y, bw, bh] = ANCHORS[n], [rx, ry] = ANCHOR_REF[n];
        withMats(k => {
          const wv = k(warp(src, f, m[n][0] * f - rx, m[n][1] * f - ry)), gg = k(gray(wv)), r = k(gg.roi(new cv.Rect(x, y, bw, bh)));
          anchors[n] = { w: bw, h: bh, data: bytesOf(r) };
        });
      }
      const old = db.anchors;
      db.anchors = anchors; db.__v = (db.__v || 0) + 1;
      try { const L = load(src, db); L.im.delete(); return `기준 글자 등록 완료 (배율 x${f.toFixed(3)}) / 확인: ${L.note || "위치 그대로"}`; }
      catch (e) { db.anchors = old; db.__v++; throw new Error("등록한 기준 글자로 다시 읽어보니 실패했어요: " + e.message); }
    }

    return {
      matFromImageData, recognize, learn, learnAnchors, suggestAnchorBoxes, rememberCover, load, crop,
      chartTable, chartRows, findSong, hasAnchors, totalNotes,
    };
  }

  // ---------- cv 없이 쓰는 것들 (상수표·포텐셜) ----------
  function scoreValue(text) { const v = pyInt(text); if (v === null) return 0; return v > 0 && v < 100000 ? 10000000 + v : v; }
  function potential(c, score) {
    let p;
    if (score >= 10000000) p = c + 2.0 + 0.2;
    else if (score >= 9800000) p = c + 1.0 + (score - 9800000) / 200000 + 0.2;
    else p = c + (score - 9500000) / 300000 + 0.2;
    return Math.max(0, p);
  }
  const CELL = /^(.*\S)\s*\[(PST|PRS|FTR|ETR|BYD|INS)\]$/;
  function parseWideTable(text) {
    const rows = [], problems = [], seen = new Set();
    splitlines(text).forEach((ln, li0) => {
      const li = li0 + 1, cells = ln.split("\t");
      cells.forEach((c, i) => {
        const m = CELL.exec(c.trim()); if (!m || i < 2 || i + 1 >= cells.length) return;
        const name = m[1].trim(), tag = m[2], lv = cells[i - 2].trim(), cst = cells[i - 1].trim(), notes = pyInt(cells[i + 1]);
        if (notes === null || !isFloat(cst)) { problems.push(`${li}번째 줄 '${name} [${tag}]': 노트 수/상수를 읽지 못함`); return; }
        if (!/^\d{1,2}\+?$/.test(lv)) { problems.push(`${li}번째 줄 '${name} [${tag}]': 레벨 '${lv}' 이상함`); return; }
        const key = name.toLowerCase() + "|" + tag;
        if (seen.has(key)) { problems.push(`${li}번째 줄 '${name} [${tag}]': 중복이라 건너뜀`); return; }
        seen.add(key);
        const score = i + 2 < cells.length && cells[i + 2].trim() ? cells[i + 2].trim() : "0";
        rows.push([lv, cst, name, tag, notes, score]);
      });
    });
    const lvval = lv => parseInt(lv, 10) + (lv.endsWith("+") ? 0.5 : 0);
    rows.sort((a, b) => (TAG_ORDER.indexOf(a[3]) - TAG_ORDER.indexOf(b[3])) || (lvval(a[0]) - lvval(b[0])));
    return [rows, problems];
  }
  function formatChartRows(rows) {
    return rows.map(([lv, c, name, tag, notes, score]) => `${lv.endsWith("+") ? lv : lv + " "}\t${c}\t${name} [${tag}]\t${comma(notes)}\t${score}`);
  }

  const api = { ScoreReaderEngine, scoreValue, potential, parseWideTable, formatChartRows, songKey, splitlines, b64ToBytes, bytesToB64,
    DIFF_TAG, TAG_NAME, TAG_ORDER, DIFFS, GRADES, FIELD_GROUP, STD_W, STD_H, pyInt, comma };
  root.ScoreReader = api;
})(typeof self !== "undefined" ? self : this);
