/* Score Reader 모바일 웹앱: 화면·저장·흐름. 인식은 reader.js (OpenCV.js) */
(function () {
  "use strict";
  const S = window.ScoreReader;
  const $ = s => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v; else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    for (const k of kids) if (k !== null && k !== undefined) e.append(k.nodeType ? k : document.createTextNode(k));
    return e;
  };
  const VERSION = "1.1.0";
  // 업데이트 기록: [버전, 날짜, [바뀐 점]]  새 버전을 처음 열면 맨 위 항목을 한 번 보여줌
  const CHANGELOG = [
    ["1.1.0", "2026-11-19", [
      "업데이트 기록 추가 (설정 맨 아래). 새 버전을 처음 열면 바뀐 점을 한 번 보여줘요",
      "PC 프로그램(1.6)에서도 같은 백업 파일을 내보내고 가져올 수 있어요 (PC → 폰, 폰 → PC)"]],
    ["1.0.0", "2026-11-18", [
      "첫 버전: 읽기 · 학습 · 상수표 · 기록(포텐셜) · 설정",
      "사진은 폰 안에서만 처리, 한 번 열면 인터넷 없이도 사용",
      "PC 프로그램의 학습 데이터를 백업 파일로 가져오기"]],
  ];
  const BOM = String.fromCharCode(0xFEFF);    // CSV 를 엑셀에서 열 때 한글이 깨지지 않게
  let R = null;           // 인식 엔진 (OpenCV 준비 후)
  let db = null;          // 모든 데이터 (IndexedDB 에 저장)

  // ---------- 저장 (IndexedDB) ----------
  const IDB = {
    open() { return new Promise((res, rej) => { const r = indexedDB.open("score-reader", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async get(k) { const d = await this.open(); return new Promise((res, rej) => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
    async set(k, v) { const d = await this.open(); return new Promise((res, rej) => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); },
  };
  const emptyDb = () => ({ glyphs: {}, labels: {}, colors: {}, anchors: {}, songs: {}, table: "", records: {}, __v: 1 });
  async function loadDb() {
    try { db = (await IDB.get("db")) || emptyDb(); } catch (e) { db = emptyDb(); toast("저장소를 열 수 없어 이번에만 쓰는 모드로 동작해요"); }
    db.__v = (db.__v || 0) + 1;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* 무시 */ }
  }
  let saveTimer = null;
  function save() { db.__v = (db.__v || 0) + 1; clearTimeout(saveTimer); saveTimer = setTimeout(() => IDB.set("db", db).catch(e => toast("저장 실패: " + e.message)), 150); }

  // ---------- 작은 UI 도우미 ----------
  let toastT = null;
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 2600); }
  function dialog(title, body, buttons) {      // buttons: [[라벨, 값, 'primary'|'danger'|'']]
    return new Promise(res => {
      const d = $("#dlg"); $("#dlgH").textContent = title; $("#dlgB").textContent = body;
      const f = $("#dlgF"); f.innerHTML = "";
      for (const [label, val, cls] of buttons) f.append(el("button", { class: cls || "", onclick: () => { d.close(); res(val); } }, label));
      d.onclose = () => res(null); d.showModal();
    });
  }
  const confirmBox = (title, body, ok = "확인", danger = false) => dialog(title, body, [["취소", false, ""], [ok, true, danger ? "danger" : "primary"]]);
  function download(name, text, type) {
    const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const fmt = n => S.comma(n);
  const recKey = (song, tag) => S.songKey(song) + "|" + tag;

  // ---------- 화면 전환 ----------
  const PAGES = { read: ["읽기", "결과 화면 스크린샷 → 점수"], learn: ["학습", "인식 → 고쳐서 등록"], table: ["상수표", "곡 · 레벨 · 상수 · 노트 수"],
    rec: ["기록", "곡 · 난이도 · 점수 · 포텐셜"], set: ["설정", "처음 한 번 · 데이터"] };
  function show(p) {
    document.querySelectorAll(".page").forEach(s => s.classList.toggle("on", s.id === "p-" + p));
    document.querySelectorAll("nav.tabbar button").forEach(b => b.classList.toggle("on", b.dataset.p === p));
    $("#title").textContent = PAGES[p][0]; $("#sub").textContent = PAGES[p][1];
    if (p === "table") renderTable(); if (p === "rec") renderRecords(); if (p === "set") renderSetup();
    window.scrollTo(0, 0);
  }
  document.querySelectorAll("nav.tabbar button").forEach(b => b.addEventListener("click", () => show(b.dataset.p)));

  // ---------- 사진 읽기 ----------
  async function decodeFile(file) {
    let bmp = null;
    try { bmp = await createImageBitmap(file, { colorSpaceConversion: "none", premultiplyAlpha: "none", imageOrientation: "from-image" }); }
    catch (e) { try { bmp = await createImageBitmap(file); } catch (e2) { bmp = null; } }
    let w, h, draw;
    if (bmp) { w = bmp.width; h = bmp.height; draw = c => c.drawImage(bmp, 0, 0); }
    else {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("사진을 열 수 없음")); i.src = URL.createObjectURL(file); });
      w = img.naturalWidth; h = img.naturalHeight; draw = c => c.drawImage(img, 0, 0);
    }
    const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = cv.getContext("2d", { willReadFrequently: true }); draw(ctx);
    const data = ctx.getImageData(0, 0, w, h); if (bmp && bmp.close) bmp.close();
    return data;
  }
  const tick = () => new Promise(r => setTimeout(r, 0));

  // ---------- 읽기 탭 ----------
  let results = [];      // {file(File), row, rec}
  function recordScore(row) {        // 더 높을 때만
    const key = recKey(row.song, row.tag), sc = parseInt(row.score, 10), old = db.records[key];
    if (old && old.score >= sc) return { kept: true, old: old.score };
    db.records[key] = { score: sc, song: row.song, tag: row.tag, at: new Date().toISOString() };
    save(); return { kept: false, old: old ? old.score : 0 };
  }
  $("#readFiles").addEventListener("change", async e => {
    const files = [...e.target.files]; e.target.value = ""; if (!files.length || !R) return;
    const bar = $("#pbar"), lab = $("#plabel"), t0 = performance.now();
    for (let i = 0; i < files.length; i++) {
      const left = i ? (performance.now() - t0) / i * (files.length - i) / 1000 : 0;
      bar.style.width = (i / files.length * 100) + "%";
      lab.textContent = `${i} / ${files.length} (${Math.floor(i * 100 / files.length)}%)` + (i ? ` · 남은 시간 약 ${Math.ceil(left)}초` : "") + ` · ${files[i].name}`;
      await tick();
      let row;
      try { const im = R.matFromImageData(await decodeFile(files[i])); row = R.recognize(im, db, files[i].name); im.delete(); }
      catch (err) { row = { file: files[i].name, check: "처리 불가: " + err.message, ok: false, error: true }; }
      const item = { file: files[i], row, rec: null };
      if (row.ok && $("#optSave").checked) item.rec = recordScore(row);
      results.unshift(item); renderResults();
    }
    bar.style.width = "100%";
    lab.textContent = `${files.length} / ${files.length} 완료 · ${((performance.now() - t0) / 1000).toFixed(1)}초 · OK ${results.filter(r => r.row.ok).length}장`;
  });
  function renderResults() {
    const box = $("#results"); box.innerHTML = "";
    $("#readActs").classList.toggle("hide", !results.length);
    for (const it of results) {
      const r = it.row, card = el("div", { class: "card res " + (r.ok ? "okc" : "") });
      if (r.error) { card.append(el("div", { class: "song" }, r.file), el("div", { class: "why" }, r.check)); box.append(card); continue; }
      card.append(el("div", { class: "song" }, r.song === "?" ? "곡을 못 찾음" : r.song), el("div", { class: "score" }, r.score ? fmt(parseInt(r.score, 10) || 0) : "?"));
      card.append(el("div", { class: "meta" }, `${r.diff || "?"} ${r.level || ""} · ${r.grade || "?"} · 상수 ${r.const || "-"}`),
        el("div", { class: "meta", style: "text-align:right" }, `P ${r.pure} · F ${r.far} · L ${r.lost}`));
      const chip = el("span", { class: "chip " + (r.ok ? "ok" : "bad") }, r.ok ? "OK" : "검수 필요");
      const why = el("div", { class: "why" }, chip, " ", r.ok ? "" : r.check.replace(/^검수필요: /, ""));
      if (it.rec) why.append(" · ", it.rec.kept ? `기존 기록 ${fmt(it.rec.old)} 유지` : (it.rec.old ? `신기록! (이전 ${fmt(it.rec.old)})` : "기록 저장됨"));
      card.append(why);
      const acts = el("div", { class: "acts" });
      if (r.cands && r.cands.length > 1) {
        acts.append(el("span", { class: "muted" }, "이 곡이 맞나요?"));
        for (const c of r.cands) acts.append(el("button", { class: "small", onclick: () => pickCand(it, c) }, `${c.song} (${c.level})`));
      }
      acts.append(el("button", { class: "small", onclick: () => openLearn(it.file) }, "고치기·학습"));
      card.append(acts); box.append(card);
    }
  }
  function pickCand(it, c) {
    const r = it.row; R.rememberCover(db, r.hash, c.song); save();
    r.song = c.song; r.const = c.const; r.tag = c.tag; r.cands = [c];
    r.issues = r.issues.filter(x => x !== "song"); r.ok = !r.issues.length;
    r.check = r.ok ? "OK / 후보에서 고름" : "검수필요: " + r.issues.join(",");
    if (r.ok && $("#optSave").checked) it.rec = recordScore(r);
    renderResults(); toast(`${c.song} 로 기억했어요 (다음부터 자켓으로 바로 골라요)`);
  }
  $("#clearRes").addEventListener("click", () => { results = []; renderResults(); $("#pbar").style.width = "0"; $("#plabel").textContent = "결과 화면 스크린샷을 고르면 바로 읽어요."; });
  const csvCell = v => { v = String(v ?? ""); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  $("#csvBtn").addEventListener("click", () => {
    const cols = ["file", "song", "diff", "level", "const", "notes", "recall", "score", "highscore", "pure", "far", "lost", "grade", "check"];
    const lines = [cols.join(",")].concat(results.slice().reverse().map(it => cols.map(c => csvCell(it.row[c])).join(",")));
    download("results.csv", BOM + lines.join("\r\n"), "text/csv");
  });

  // ---------- 학습 탭 ----------
  const FIELDS = ["song", "diff", "level", "grade", "score", "highscore", "recall", "pure", "far", "lost"];
  let learnFile = null;
  function fillSelect(sel, opts) { sel.innerHTML = ""; sel.append(el("option", { value: "" }, "")); for (const o of opts) sel.append(el("option", { value: o }, o)); }
  fillSelect($("#f-diff"), S.DIFFS); fillSelect($("#f-grade"), S.GRADES); fillSelect($("#a-diff"), S.DIFFS);
  $("#learnFile").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) openLearn(f); });
  async function openLearn(file) {
    show("learn"); learnFile = file;
    const box = $("#learnBox"); box.classList.remove("hide");
    $("#learnImg").src = URL.createObjectURL(file); $("#learnLog").classList.add("hide");
    $("#learnCheck").textContent = "읽는 중…"; await tick();
    let row;
    try { const im = R.matFromImageData(await decodeFile(file)); row = R.recognize(im, db, file.name); im.delete(); }
    catch (err) { row = { check: "처리 불가: " + err.message, issues: [] }; }
    fillLearn(row);
  }
  function fillLearn(row) {
    const issues = new Set(row.issues || []), cands = (row.cands || []).map(c => c.song);
    const dl = $("#songCands"); dl.innerHTML = ""; for (const c of cands) dl.append(el("option", { value: c }));
    for (const k of FIELDS) {
      let v = row[k] ?? "";
      if (/^\?+$/.test(String(v))) v = "";
      if (k === "song") v = cands.length === 1 ? cands[0] : "";
      $("#f-" + k).value = v;
      const bad = issues.has(k) || String(row[k] ?? "").includes("?") || (k !== "song" && !v) || (k === "song" && cands.length !== 1);
      document.querySelector(`label[data-k="${k}"]`).classList.toggle("bad", bad);
    }
    let msg = row.check || "";
    if (cands.length > 1) msg = `곡 후보 ${cands.length}개: 곡명 칸을 눌러 고르세요. | ` + msg;
    $("#learnCheck").textContent = msg;
    $("#learnCheck").style.color = row.ok ? "var(--ok)" : "var(--bad)";
    $("#toTableBtn").classList.toggle("hide", !(cands.length === 0 && /상수표에/.test(row.check || "")));
  }
  $("#learnBtn").addEventListener("click", async () => {
    if (!learnFile || !R) return;
    const v = Object.fromEntries(FIELDS.map(k => [k, $("#f-" + k).value.trim()]));
    const bad = ["score", "highscore", "level", "recall", "pure", "far", "lost"].filter(k => v[k] && !/^\d+\+?$/.test(v[k]));
    if (bad.length) { toast("숫자 칸에 '?' 같은 글자가 있어요: " + bad.join(", ")); return; }
    let log;
    try { const im = R.matFromImageData(await decodeFile(learnFile)); log = R.learn(im, db, v); im.delete(); save(); }
    catch (err) { log = ["등록 실패: " + err.message]; }
    const L = $("#learnLog"); L.textContent = log.join("\n"); L.classList.remove("hide");
    toast("등록했어요. 다시 읽어서 확인할게요");
    const im = R.matFromImageData(await decodeFile(learnFile)); const row = R.recognize(im, db, learnFile.name); im.delete();
    fillLearn(row);
  });
  $("#toTableBtn").addEventListener("click", () => {
    const n = ["pure", "far", "lost"].map(k => parseInt($("#f-" + k).value, 10));
    $("#a-song").value = $("#f-song").value; $("#a-diff").value = $("#f-diff").value; $("#a-level").value = $("#f-level").value;
    $("#a-notes").value = n.every(x => !isNaN(x)) ? n[0] + n[1] + n[2] : ""; $("#a-const").value = "";
    show("table"); document.querySelector("#addCard details").open = true; $("#a-song").focus();
  });

  // ---------- 상수표 탭 ----------
  function tableRows() {
    const out = [];
    S.splitlines(db.table || "").forEach((ln, i) => {
      const p = ln.split("\t"); if (p.length < 4) return;
      const m = /^(.*) \[(PST|PRS|FTR|ETR|BYD|INS)\]\s*$/.exec(p[2]); if (!m) return;
      const notes = S.pyInt(p[3]); if (notes === null) return;
      out.push({ i, level: p[0].trim(), const: p[1].trim(), song: m[1].trim(), tag: m[2], notes });
    });
    return out;
  }
  function myScore(song, tag) { const r = db.records[recKey(song, tag)]; return r ? r.score : 0; }
  function renderTable() {
    const rows = tableRows(), q = $("#tSearch").value.trim().toLowerCase(), qn = S.pyInt(q);
    const hit = rows.filter(r => !q || r.song.toLowerCase().includes(q) || (qn !== null && r.notes === qn));
    $("#tInfo").textContent = `${rows.length}개 채보 · 내 기록 ${Object.keys(db.records).length}곡`;
    const L = $("#tList"); L.innerHTML = "";
    for (const r of hit.slice(0, 150)) {
      const my = myScore(r.song, r.tag);
      L.append(el("div", { class: "it", onclick: () => tableRowMenu(r) },
        el("div", { class: "n" }, r.level), el("div", {}, el("div", { class: "t" }, r.song), el("div", { class: "s" }, `${S.TAG_NAME[r.tag] || r.tag} · 상수 ${r.const} · ${fmt(r.notes)}노트`)),
        el("div", { class: "v" }, my ? fmt(my) : "-")));
    }
    $("#tMore").textContent = hit.length > 150 ? `${hit.length}개 중 150개만 보여요. 검색으로 좁혀주세요.` : (rows.length ? "" : "아직 상수표가 없어요. 아래에서 표를 붙여넣거나 한 곡씩 추가하세요.");
  }
  $("#tSearch").addEventListener("input", renderTable);
  async function tableRowMenu(r) {
    const v = await dialog(`${r.song} [${r.tag}]`, `레벨 ${r.level} · 상수 ${r.const} · ${fmt(r.notes)}노트\n내 점수: ${myScore(r.song, r.tag) ? fmt(myScore(r.song, r.tag)) : "없음"}`,
      [["닫기", null, ""], ["이 줄 삭제", "del", "danger"]]);
    if (v !== "del") return;
    if (!await confirmBox("이 줄을 지울까요?", `${r.song} [${r.tag}]`, "삭제", true)) return;
    const lines = S.splitlines(db.table); lines.splice(r.i, 1); db.table = lines.join("\n"); save(); renderTable(); toast("삭제했어요");
  }
  $("#addBtn").addEventListener("click", async () => {
    const song = $("#a-song").value.trim(), tag = S.DIFF_TAG[$("#a-diff").value], lv = $("#a-level").value.trim(), c = $("#a-const").value.trim(), n = S.pyInt($("#a-notes").value);
    const err = [];
    if (!song || song.includes("\t")) err.push("곡명"); if (!tag) err.push("난이도"); if (!/^\d{1,2}\+?$/.test(lv)) err.push("레벨(예: 10, 10+)");
    if (c === "" || isNaN(Number(c))) err.push("상수(예: 10.7)"); if (n === null) err.push("노트 수");
    if (err.length) { toast("확인해 주세요: " + err.join(", ")); return; }
    const rows = tableRows();
    if (rows.some(r => r.song.toLowerCase() === song.toLowerCase() && r.tag === tag) && !await confirmBox("이미 있어요", `${song} [${tag}] 줄이 이미 있어요. 그래도 추가할까요?`, "추가")) return;
    const line = `${lv.endsWith("+") ? lv : lv + " "}\t${Number(c).toFixed(2)}\t${song} [${tag}]\t${fmt(n)}\t0`;
    db.table = (db.table ? db.table.replace(/\s+$/, "") + "\n" : "") + line; save();
    ["#a-song", "#a-level", "#a-const", "#a-notes"].forEach(s => $(s).value = "");
    $("#tSearch").value = song; renderTable(); toast("상수표에 추가했어요");
  });
  $("#tImport").addEventListener("click", async () => {
    const [rows, problems] = S.parseWideTable($("#tPaste").value);
    if (!rows.length) { toast("표에서 '곡명 [PST/PRS/FTR/ETR/BYD/INS]' 칸을 찾지 못했어요"); return; }
    const cnt = {}; rows.forEach(r => cnt[r[3]] = (cnt[r[3]] || 0) + 1);
    const old = new Set(tableRows().map(r => r.song.toLowerCase() + "|" + r.tag)), nw = new Set(rows.map(r => r[2].toLowerCase() + "|" + r[3]));
    const added = [...nw].filter(k => !old.has(k)).length, removed = [...old].filter(k => !nw.has(k)).length;
    const msg = `표에서 채보 ${rows.length}개를 찾았어요.\n${S.TAG_ORDER.filter(t => cnt[t]).map(t => `${t} ${cnt[t]}`).join("  ")}\n\n지금 상수표와 비교: 새로 생김 ${added}, 없어짐 ${removed}` +
      (problems.length ? `\n\n건너뛴 칸 ${problems.length}개:\n` + problems.slice(0, 5).join("\n") : "") + "\n\n이 내용으로 상수표를 새로 만들까요?";
    if (!await confirmBox("상수표 새로 만들기", msg, "새로 만들기")) return;
    db.table = S.formatChartRows(rows).join("\n"); save(); $("#tPaste").value = ""; renderTable(); toast(`상수표를 새로 만들었어요: ${rows.length}개 채보`);
  });

  // ---------- 기록 탭 ----------
  function potentialRows() {
    const consts = new Map(tableRows().map(r => [recKey(r.song, r.tag), r]));
    const out = [];
    for (const [k, rec] of Object.entries(db.records)) {
      const t = consts.get(k); if (!t || !(rec.score > 0)) continue;
      out.push({ song: t.song, tag: t.tag, level: t.level, const: Number(t.const), score: rec.score, p: S.potential(Number(t.const), rec.score) });
    }
    return out.sort((a, b) => b.p - a.p);
  }
  function renderRecords() {
    const rows = potentialRows(), L = $("#rList"); L.innerHTML = "";
    const noConst = Object.keys(db.records).length - rows.length;
    $("#rInfo").innerHTML = "";
    $("#rInfo").append(el("b", {}, `기록 ${rows.length}곡`), rows.length ? ` · 최고 ${rows[0].p.toFixed(3)} (${rows[0].song} [${S.TAG_NAME[rows[0].tag]}])` : "",
      noConst > 0 ? el("div", { class: "muted" }, `상수표에 없는 기록 ${noConst}곡은 포텐셜을 계산하지 못했어요`) : "");
    rows.forEach((r, i) => {
      const tier = r.p >= 12.5 ? "t1" : r.p >= 12 ? "t2" : r.p >= 11 ? "t3" : "";
      L.append(el("div", { class: "it" }, el("div", { class: "n" }, String(i + 1)),
        el("div", {}, el("div", { class: "t" }, r.song), el("div", { class: "s" }, `${S.TAG_NAME[r.tag]} ${r.level} · ${fmt(r.score)}`)),
        el("div", { class: "v " + tier }, r.p.toFixed(3))));
    });
    if (!rows.length) L.append(el("div", { class: "it" }, el("div"), el("div", { class: "s" }, "아직 기록이 없어요. 읽기 탭에서 스크린샷을 읽으면 쌓여요."), el("div")));
  }
  $("#rCsv").addEventListener("click", () => {
    const lines = ["순위,곡,난이도,레벨,상수,점수,포텐셜"].concat(potentialRows().map((r, i) => [i + 1, r.song, S.TAG_NAME[r.tag], r.level, r.const, r.score, r.p.toFixed(3)].map(csvCell).join(",")));
    download("potential.csv", BOM + lines.join("\r\n"), "text/csv");
  });
  $("#rReset").addEventListener("click", async () => {
    const n = Object.keys(db.records).length;
    if (!n) { toast("지울 기록이 없어요"); return; }
    if (!await confirmBox("⚠ 모든 기록 초기화", `정말 모든 점수 기록 ${n}곡을 지울까요?\n되돌릴 수 없어요. 필요하면 먼저 설정 → 백업 내보내기를 하세요.`, "모두 지우기", true)) return;
    db.records = {}; save(); renderRecords(); toast("모든 기록을 지웠어요");
  });

  // ---------- 설정 탭 ----------
  function renderSetup() {
    const g = db.glyphs || {}, names = { score: "점수", hs: "하이스코어", level: "레벨", recall: "MAX RECALL", stat: "PURE/FAR/LOST" };
    const need = [], parts = [];
    for (const grp of ["score", "hs", "level", "recall", "stat"]) {
      const have = new Set((g[grp] || []).map(t => t.ch)), miss = "0123456789".split("").filter(d => !have.has(d));
      parts.push(`${names[grp]} ${10 - miss.length}/10`);
      if (grp === "level") { if (miss.length === 10) need.push("레벨: 하나도 없음"); } else if (miss.length) need.push(`${names[grp]}: ${miss.join("")} 없음`);
    }
    const diffs = [...new Set((db.labels.diff || []).map(t => t.label))], grades = [...new Set((db.labels.grade || []).map(t => t.label))];
    parts.push("난이도 " + (diffs.join(", ") || "없음"), "등급 " + (grades.join(", ") || "없음"));
    if (!diffs.length) need.push("난이도 0개"); if (!grades.length) need.push("등급 0개");
    const nothing = !diffs.length && !grades.length && parts.slice(0, 5).every(p => p.endsWith(" 0/10"));
    const nTab = tableRows().length, hasA = R ? R.hasAnchors(db) : !!(db.anchors && db.anchors.hs);
    const steps = [
      [hasA, "1. 기준 글자 등록", "결과 화면 한 장에서 HIGH SCORE, MAX RECALL 글자 위치를 알려주세요.", hasA ? "등록됨" : "아직 안 함 (기준 크기와 다른 스크린샷은 이게 없으면 못 읽어요)", "스크린샷 고르기", () => pickAnchorPhoto()],
      [!need.length, "2. 글자 모양 학습", "학습 탭에서 스크린샷을 정답과 함께 등록하세요. 0~9가 골고루 나오도록 5~10장 정도.",
        nothing ? "아직 학습한 화면이 없어요." : parts.join(" · ") + (need.length ? "\n부족: " + need.join(" / ") : ""), "학습 탭으로", () => show("learn")],
      [nTab > 0, "3. 상수표 넣기", "상수표 탭에서 표를 붙여넣거나 한 곡씩 추가하세요.", nTab ? `${nTab}개 채보` : "아직 없음", "상수표 탭으로", () => show("table")]];
    const box = $("#steps"); box.innerHTML = "";
    for (const [ok, t, d, m, btn, fn] of steps)
      box.append(el("div", { class: "st" + (ok ? " done" : "") }, el("div", { class: "dot" }), el("div", {}, el("b", {}, t), el("div", { class: "muted" }, d), el("div", { class: "m", style: "white-space:pre-wrap" }, m)),
        el("button", { class: "small", onclick: fn }, btn)));
    renderChangelog();
    $("#ver").textContent = `Score Reader 모바일 ${VERSION}` + (navigator.serviceWorker && navigator.serviceWorker.controller ? " · 오프라인 사용 가능" : "");
  }

  function renderChangelog() {
    const b = $("#clogBody"); b.innerHTML = "";
    for (const [ver, date, items] of CHANGELOG) {
      b.append(el("div", { class: "clv" }, `버전 ${ver}`, el("small", {}, date)));
      const ul = el("ul", { class: "cli" }); for (const it of items) ul.append(el("li", {}, it)); b.append(ul);
    }
  }
  async function whatsNew() {        // 새 버전을 처음 열면 한 번
    let seen = null; try { seen = await IDB.get("seenVersion"); } catch (e) { return; }
    if (seen === VERSION) return;
    try { await IDB.set("seenVersion", VERSION); } catch (e) { /* 무시 */ }
    if (!seen && !Object.keys(db.records || {}).length && !(db.table || "").length) return;   // 완전히 처음 쓰는 사람에게는 생략
    const [ver, date, items] = CHANGELOG[0];
    dialog(`버전 ${ver} 업데이트`, `${date}\n\n` + items.map(i => "•  " + i).join("\n") + "\n\n전체 기록은 설정 맨 아래에 있어요.", [["확인", true, "primary"]]);
  }

  // 기준 글자: 사진 위에 상자 두 개 그리기
  const anc = { file: null, img: null, boxes: null, cur: "hs", k: 1, start: null };
  function pickAnchorPhoto() {
    const inp = el("input", { type: "file", accept: "image/*" });
    inp.addEventListener("change", async () => {
      const f = inp.files[0]; if (!f) return;
      anc.file = f; anc.img = await decodeFile(f);
      anc.boxes = R.suggestAnchorBoxes(anc.img.width, anc.img.height); setCur("hs");
      $("#anchorBox").classList.remove("hide"); $("#anchorMsg").textContent = ""; drawAnchor();
      $("#anchorBox").scrollIntoView({ behavior: "smooth" });
    });
    inp.click();
  }
  function setCur(n) { anc.cur = n; $("#segHs").classList.toggle("on", n === "hs"); $("#segRc").classList.toggle("on", n === "recall"); }
  $("#segHs").addEventListener("click", () => setCur("hs")); $("#segRc").addEventListener("click", () => setCur("recall"));
  function drawAnchor() {
    const c = $("#anchorCv"), W = anc.img.width, H = anc.img.height, cssW = c.clientWidth || 340, dpr = window.devicePixelRatio || 1;
    anc.k = cssW / W; c.width = Math.round(cssW * dpr); c.height = Math.round(H * anc.k * dpr); c.style.height = (H * anc.k) + "px";
    const x = c.getContext("2d"), tmp = Object.assign(document.createElement("canvas"), { width: W, height: H });
    tmp.getContext("2d").putImageData(anc.img, 0, 0);
    x.setTransform(1, 0, 0, 1, 0, 0); x.drawImage(tmp, 0, 0, c.width, c.height);
    const s = anc.k * dpr;
    for (const [n, col] of [["hs", "#e33"], ["recall", "#28f"]]) {
      const [x1, y1, x2, y2] = anc.boxes[n]; x.strokeStyle = col; x.lineWidth = 3 * dpr; x.strokeRect(x1 * s, y1 * s, (x2 - x1) * s, (y2 - y1) * s);
    }
  }
  const cvPoint = e => { const r = $("#anchorCv").getBoundingClientRect(); return [(e.clientX - r.left) / anc.k, (e.clientY - r.top) / anc.k]; };
  $("#anchorCv").addEventListener("pointerdown", e => { if (!anc.img) return; e.target.setPointerCapture(e.pointerId); anc.start = cvPoint(e); });
  $("#anchorCv").addEventListener("pointermove", e => {
    if (!anc.start) return; const [x, y] = cvPoint(e), [x0, y0] = anc.start;
    anc.boxes[anc.cur] = [Math.min(x0, x), Math.min(y0, y), Math.max(x0, x), Math.max(y0, y)]; drawAnchor();
  });
  $("#anchorCv").addEventListener("pointerup", () => { if (!anc.start) return; anc.start = null; if (anc.cur === "hs") setCur("recall"); });
  $("#anchorCancel").addEventListener("click", () => { $("#anchorBox").classList.add("hide"); anc.img = null; });
  $("#anchorSave").addEventListener("click", () => {
    try { const im = R.matFromImageData(anc.img); const msg = R.learnAnchors(im, db, anc.boxes); im.delete(); save(); $("#anchorBox").classList.add("hide"); renderSetup(); dialog("기준 글자", msg, [["확인", true, "primary"]]); }
    catch (err) { $("#anchorMsg").textContent = err.message; $("#anchorMsg").style.color = "var(--bad)"; }
  });
  window.addEventListener("resize", () => { if (anc.img && !$("#anchorBox").classList.contains("hide")) drawAnchor(); });

  // 백업
  function toBackup() {
    const B = S.bytesToB64, pk = t => ({ w: t.w, h: t.h, b64: B(t.data) });
    return { app: "score-reader-web", version: 1, exported: new Date().toISOString(),
      glyphs: Object.fromEntries(Object.entries(db.glyphs).map(([g, l]) => [g, l.map(t => ({ ch: t.ch, ...pk(t) }))])),
      labels: Object.fromEntries(Object.entries(db.labels).map(([k, l]) => [k, l.map(t => ({ label: t.label, ...pk(t) }))])),
      colors: db.colors, anchors: Object.fromEntries(Object.entries(db.anchors || {}).map(([n, a]) => [n, pk(a)])),
      songs: db.songs, table: db.table, records: db.records };
  }
  function fromBackup(b) {
    const B = S.b64ToBytes, un = t => ({ w: t.w, h: t.h, data: B(t.b64) }), d = emptyDb();
    for (const [g, l] of Object.entries(b.glyphs || {})) d.glyphs[g] = l.map(t => ({ ch: t.ch, ...un(t) }));
    for (const [k, l] of Object.entries(b.labels || {})) d.labels[k] = l.map(t => ({ label: t.label, ...un(t) }));
    for (const [n, a] of Object.entries(b.anchors || {})) d.anchors[n] = un(a);
    d.colors = b.colors || {}; d.songs = b.songs || {}; d.table = b.table || "";
    for (const [k, r] of Object.entries(b.records || {})) if (r && r.score > 0) d.records[k] = { score: r.score, song: r.song, tag: r.tag, at: r.at || b.exported };
    return d;
  }
  $("#bkExport").addEventListener("click", () => download(`score_reader_backup_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(toBackup()), "application/json"));
  $("#bkImport").addEventListener("change", async e => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    let b; try { b = JSON.parse(await f.text()); } catch (err) { toast("백업 파일을 읽지 못했어요"); return; }
    if (b.app !== "score-reader-web") { toast("Score Reader 백업 파일이 아니에요"); return; }
    const d = fromBackup(b), nG = Object.values(d.glyphs).reduce((a, l) => a + l.length, 0);
    const msg = `백업(${b.exported || "날짜 없음"}): 글자 모양 ${nG}개, 기준 글자 ${Object.keys(d.anchors).length}개, 자켓 ${Object.keys(d.songs).length}개, 상수표 ${S.splitlines(d.table).length}줄, 기록 ${Object.keys(d.records).length}곡\n\n지금 데이터를 이 백업으로 바꿀까요? (지금 데이터는 사라져요)`;
    if (!await confirmBox("백업 가져오기", msg, "바꾸기", true)) return;
    db = d; save(); renderSetup(); toast("백업을 가져왔어요");
  });
  $("#wipe").addEventListener("click", async () => {
    if (!await confirmBox("⚠ 모든 데이터 지우기", "학습한 글자 모양, 기준 글자, 상수표, 기록을 전부 지울까요?\n되돌릴 수 없어요.", "모두 지우기", true)) return;
    db = emptyDb(); save(); results = []; renderResults(); renderSetup(); toast("모든 데이터를 지웠어요");
  });

  // ---------- 시작 ----------
  // 이 OpenCV.js 는 cv 객체가 then 을 가진(promise 처럼 보이는) 모양이라 await cv 하면 영원히 기다림 -> 준비 신호만 기다리고 상자에 담아 돌려줌
  async function getCV() {
    if (typeof cv === "undefined") await new Promise(r => { window.__cvLoaded = r; });
    const box = await new Promise(r => {
      const ok = () => r({ m: cv });
      if (cv.calledRun) return ok();
      const prev = cv.onRuntimeInitialized;
      cv.onRuntimeInitialized = () => { if (prev) prev(); ok(); };
    });
    return box;          // cv 를 그대로 돌려주면(then 이 있어서) 또 영원히 기다림 -> 상자째로
  }
  (async () => {
    await loadDb();
    try { R = S.ScoreReaderEngine((await getCV()).m); }
    catch (e) { $("#loadMsg").textContent = "인식 엔진을 불러오지 못했어요: " + e.message; return; }
    $("#loading").remove();
    const ready = R.hasAnchors(db) && tableRows().length;
    show(ready ? "read" : "set");
    whatsNew();
    if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  })();
})();
