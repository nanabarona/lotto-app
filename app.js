"use strict";
/*
 * 복권 수첩 — 비공개 저장소(lotto-auto)의 기록을 GitHub API 로 읽어서 보여주는 폰 앱.
 * 이 파일에는 개인 데이터가 없다. 저장소 이름과 토큰은 폰에서 입력하고 폰에만 저장된다
 * (PIN 을 정하면 토큰을 PIN 으로 암호화해서 저장).
 *
 * 주소 뒤에 ?demo 를 붙이면 예시 데이터로 보는 데모 모드 (다른 사람에게 보여주기용).
 */

const STORE_KEY = "lotto-app";
const WEEKDAYS = "일월화수목금토";
const params = new URLSearchParams(location.search);
const MODE = params.has("demo") ? "demo" : params.has("local") ? "local" : "live";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const won = (n) => `${Math.round(n || 0).toLocaleString("ko-KR")}원`;
const shortWon = (n) => {
  const a = Math.abs(n);
  if (a >= 1e8) return `${+(n / 1e8).toFixed(1)}억`;
  if (a >= 1e4) return `${+(n / 1e4).toFixed(1)}만`;
  return `${n.toLocaleString("ko-KR")}`;
};

const store = {
  get() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch { return {}; } },
  set(patch) { try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...store.get(), ...patch })); } catch { /* 저장 불가 환경 */ } },
  clear() { try { localStorage.removeItem(STORE_KEY); } catch { /* */ } },
};

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(String(v).length === 10 ? `${v}T00:00` : v);
  return isNaN(d) ? null : d;
}
function fmtWhen(v, withTime = true) {
  const d = toDate(v);
  if (!d) return "";
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}(${WEEKDAYS[d.getDay()]})`;
  return withTime ? `${md} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : md;
}
function ago(v) {
  const d = toDate(v);
  if (!d) return "";
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (m < 60 * 24) return `${Math.round(m / 60)}시간 전`;
  return `${Math.round(m / 1440)}일 전`;
}

let toastTimer;
function toast(msg) {
  let el = $(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.append(el); }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ───────────── 토큰 암호화 (PIN) ───────────── */
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function pinKey(pin, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 250000, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function sealToken(token, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await pinKey(pin, salt), enc.encode(token));
  return { salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}
async function openToken(sealed, pin) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, await pinKey(pin, unb64(sealed.salt)), unb64(sealed.ct));
  return new TextDecoder().decode(pt);
}

/* ───────────── 데이터 원천: GitHub API / 로컬 / 데모 ───────────── */
class ApiError extends Error {
  constructor(status, body) { super(`HTTP ${status}`); this.status = status; this.body = body; }
}
function apiMessage(e, forRun = false) {
  if (!(e instanceof ApiError)) return "네트워크에 연결할 수 없어요. 잠시 후 다시 시도하세요.";
  if (e.status === 401) return "토큰이 올바르지 않거나 만료됐어요. 설정에서 다시 연결하세요.";
  if (e.status === 403) return forRun ? "토큰에 'Actions: 읽기/쓰기' 권한이 없어요." : "토큰 권한이 부족해요 (Contents 읽기 필요).";
  if (e.status === 404) return "저장소를 찾을 수 없어요. 저장소 이름과 토큰의 저장소 선택을 확인하세요.";
  return `GitHub 응답 오류 (${e.status})`;
}

const source = {
  repo: "", token: "",
  async gh(path, opts = {}) {
    const res = await fetch(`https://api.github.com/repos/${this.repo}${path}`, {
      ...opts, cache: "no-store",
      headers: { Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
    });
    if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ""));
    return res;
  },
  async text(path) {
    if (MODE === "local") {
      const r = await fetch(`../${path}`, { cache: "no-store" });
      if (!r.ok) throw new ApiError(r.status, "");
      return r.text();
    }
    const r = await this.gh(`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=main`,
      { headers: { Accept: "application/vnd.github.raw+json" } });
    return r.text();
  },
  async json(path, fallback) {
    try { return JSON.parse(await this.text(path)); } catch (e) { if (e.status === 404) return fallback; throw e; }
  },
  async logFiles() {
    if (MODE === "local") {
      const html = await (await fetch("../logs/", { cache: "no-store" })).text();
      return [...html.matchAll(/href="([^"]+\.log)"/g)].map((m) => decodeURIComponent(m[1])).sort().reverse();
    }
    try {
      const r = await this.gh("/contents/logs?ref=main", { headers: { Accept: "application/vnd.github+json" } });
      return (await r.json()).map((f) => f.name).filter((n) => n.endsWith(".log")).sort().reverse();
    } catch (e) { if (e.status === 404) return []; throw e; }
  },
  async runs() {
    if (MODE === "local") return [];
    const r = await this.gh("/actions/workflows/weekly.yml/runs?per_page=8", { headers: { Accept: "application/vnd.github+json" } });
    return (await r.json()).workflow_runs || [];
  },
  async dispatch(dryRun) {
    await this.gh("/actions/workflows/weekly.yml/dispatches", {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { dry_run: dryRun ? "true" : "false" } }),
    });
  },
  async check() { await this.gh("", { headers: { Accept: "application/vnd.github+json" } }); },
};

/* ───────────── 상태 ───────────── */
const S = {
  tab: "home",
  data: null,          // { app, ledger, purchases, balances, notifications, logFiles }
  runs: [], runsError: "",
  loading: false, loadedAt: null,
  hist: { view: "ledger", game: "all", limit: 60 },
  stats: { period: "all" },
  logs: { file: "", text: "", filter: "all", q: "" },
  polling: null,
};

async function loadAll() {
  if (S.loading) return;
  S.loading = true;
  $("#btn-refresh").classList.add("spin");
  try {
    if (MODE === "demo") {
      S.data = demoData();
      S.runs = S.data.runs;
      // 공개 당첨 데이터로만 만든 가설 검증 결과 스냅숏 (개인 데이터 아님)
      try { S.data.research = await (await fetch("demo-research.json")).json(); } catch { S.data.research = null; }
    } else {
      const [app, ledger, purchases, balances, notifications, logFiles, research] = await Promise.all([
        source.json("data/app.json", null),
        source.json("data/ledger.json", []),
        source.json("data/purchases.json", []),
        source.json("data/balance.json", []),
        source.json("data/notifications.json", []),
        source.logFiles(),
        source.json("data/research.json", null),
      ]);
      S.data = { app, ledger, purchases, balances, notifications, logFiles, research };
      try { S.runs = await source.runs(); S.runsError = ""; } catch (e) { S.runs = []; S.runsError = apiMessage(e, true); }
    }
    S.loadedAt = new Date();
    if (!S.logs.file) S.logs.file = S.data.logFiles[0] || "";
    S.logs.text = "";
  } catch (e) {
    toast(apiMessage(e));
    if (e instanceof ApiError && (e.status === 401 || e.status === 404)) { showSetup(apiMessage(e)); return; }
  } finally {
    S.loading = false;
    $("#btn-refresh").classList.remove("spin");
  }
  render();
}

/* ───────────── 렌더링 공통 ───────────── */
function render() {
  if (!S.data) return;
  $("#sync").innerHTML = `${esc(S.data.app ? `기록 ${fmtWhen(S.data.app.generated_at)}` : "기록 없음")}<br>${esc(S.loadedAt ? `받아옴 ${ago(S.loadedAt)}` : "")}`;
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === S.tab)));
  const unread = unreadCount();
  $("#badge").hidden = unread === 0;
  $("#badge").textContent = unread > 9 ? "9+" : String(unread);
  const view = $("#view");
  ({ home: renderHome, alerts: renderAlerts, history: renderHistory, stats: renderStats, logs: renderLogs }[S.tab])(view);
}

function setTab(tab) {
  S.tab = tab;
  store.set({ tab });
  if (tab === "alerts") S.seenBefore = undefined;  // 열 때마다 '새 알림' 표시 기준을 다시 잡는다
  render();
  window.scrollTo({ top: 0 });
}

const ICONS = {
  done: '<path d="M5 12l5 5 9-10"/>',
  charge: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 15h2"/>',
  pending: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  gave_up: '<path d="M6 6l12 12M18 6L6 18"/>',
  blocked: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
};

function ballColor(n) {
  if (n <= 10) return "var(--ball-y)";
  if (n <= 20) return "var(--ball-b)";
  if (n <= 30) return "var(--ball-r)";
  if (n <= 40) return "var(--ball-g)";
  return "var(--ball-l)";
}
const balls = (nums) => `<div class="balls">${nums.map((n) => `<span class="ball" style="--ball:${ballColor(n)}">${n}</span>`).join("")}</div>`;
const digits = (num) => `<div class="balls">${[...String(num)].map((d) => `<span class="digit">${esc(d)}</span>`).join("")}</div>`;

function rankPill(rank, prize) {
  if (!rank) return '<span class="pill mute">낙첨</span>';
  if (rank === "추첨 전") return '<span class="pill warn">추첨 전</span>';
  return `<span class="pill good">${esc(rank)}${prize ? ` · ${won(prize)}` : ""}</span>`;
}

/* ───────────── 홈 ───────────── */
function renderHome(view) {
  const { app, purchases, balances } = S.data;
  const st = app?.status;
  const bal = app?.balance || balances.at(-1);
  let html = "";

  if (st) {
    const canCharge = st.kind === "charge" || st.kind === "gave_up";
    html += `
    <section class="card status" data-kind="${esc(st.kind)}">
      <div class="eyebrow">이번 주 · 로또 ${esc(st.week)}회</div>
      <div class="status-head">
        <span class="status-icon"><svg viewBox="0 0 24 24">${ICONS[st.kind] || ICONS.pending}</svg></span>
        <span class="status-title">${esc(st.headline)}</span>
      </div>
      ${st.details?.length ? `<ul>${st.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
      <div class="actions">
        ${canCharge ? `<a class="btn primary grow" href="${esc(st.charge_url)}" target="_blank" rel="noopener">충전하기${st.shortfall ? ` (${won(st.shortfall.amount)})` : ""}</a>` : ""}
        <button class="btn ${canCharge ? "" : "primary"} grow" data-run="real">지금 구매 시도</button>
        <button class="btn grow" data-run="dry">모의 실행</button>
      </div>
      <div class="hint" style="margin-top:10px">${st.checked_at ? `마지막 확인 ${esc(fmtWhen(st.checked_at))} · ` : ""}이미 샀으면 '지금 구매 시도'를 눌러도 다시 사지 않아요.</div>
    </section>`;
  } else {
    html += `<section class="card"><h2>이번 주 상태</h2><p class="empty">아직 자동 실행 기록이 없어요. 첫 자동 실행(월요일 07:17) 뒤에 표시돼요.</p></section>`;
  }

  html += `<div class="tiles">
    <div class="tile"><div class="k">예치금</div><div class="v num">${bal ? won(bal.balance) : "–"}</div><div class="s">${bal ? `${esc(fmtWhen(bal.at))} 기준` : "기록 없음"}</div></div>
    <div class="tile"><div class="k">다음 자동 실행</div><div class="v" style="font-size:17px;margin-top:6px">${esc(st?.next_try_text || "월 07:17")}</div><div class="s">월 2시간마다 · 화~금 하루 4번</div></div>
  </div>`;

  const lastLotto = [...purchases].reverse().find((p) => p.game === "lotto645");
  const lastPension = [...purchases].reverse().find((p) => p.game === "pension720");
  html += `<section class="card"><h2>최근 자동 구매 번호</h2>`;
  if (!lastLotto && !lastPension) html += `<p class="empty">아직 이 프로그램으로 산 번호가 없어요.</p>`;
  if (lastLotto) html += purchaseBlock(lastLotto);
  if (lastPension) html += purchaseBlock(lastPension);
  html += `</section>`;

  html += `<section class="card"><h2>실행 기록 <small>GitHub Actions</small></h2>`;
  if (S.runsError) html += `<p class="empty">${esc(S.runsError)}</p>`;
  else if (!S.runs.length) html += `<p class="empty">실행 기록이 없어요.</p>`;
  else {
    html += `<div class="list">${S.runs.map((r) => {
      const ev = r.event === "schedule" ? "자동 실행" : "직접 실행";
      const pill = r.status !== "completed" ? '<span class="pill warn">진행 중</span>'
        : r.conclusion === "success" ? '<span class="pill good">완료</span>'
        : r.conclusion === "cancelled" ? '<span class="pill mute">취소</span>' : '<span class="pill bad">실패</span>';
      const link = r.html_url ? `<a href="${esc(r.html_url)}" target="_blank" rel="noopener">${esc(ev)} #${esc(r.run_number)}</a>` : `${esc(ev)} #${esc(r.run_number)}`;
      return `<div class="row"><div><div class="t">${link}</div><div class="d">${esc(fmtWhen(r.created_at))}</div></div>${pill}</div>`;
    }).join("")}</div>`;
  }
  html += `</section>`;
  view.innerHTML = html;

  view.querySelectorAll("[data-run]").forEach((b) => b.addEventListener("click", () => runWorkflow(b.dataset.run === "dry")));
}

function purchaseBlock(p) {
  const name = p.game === "lotto645" ? "로또 6/45" : "연금복권 720+";
  let body = "";
  if (p.game === "lotto645") {
    body = p.tickets.map((t, i) => `<div class="ticket"><span class="slot">${esc(t.slot)}</span>${t.numbers?.length ? balls(t.numbers) : '<span class="muted">자동번호</span>'}${
      p.result ? rankPill(p.result[i] === "낙첨" ? null : p.result[i]) : '<span class="pill warn">추첨 전</span>'}</div>`).join("");
  } else {
    const byNumber = {};
    p.tickets.forEach((t, i) => { (byNumber[t.number] ||= []).push({ g: t.group, r: p.result?.[i] }); });
    body = Object.entries(byNumber).map(([num, list]) => {
      const groups = list.map((x) => x.g).sort();
      const where = groups.join(",") === "1,2,3,4,5" ? "1~5조" : groups.map((g) => `${g}조`).join(" ");
      const best = list.find((x) => x.r && x.r !== "낙첨")?.r;
      return `<div class="ticket wide"><div class="balls"><span class="jo">${esc(where)}</span>${digits(num)}</div>${
        p.result ? rankPill(best || null) : '<span class="pill warn">추첨 전</span>'}</div>`;
    }).join("");
  }
  return `<div style="margin-top:6px"><div class="eyebrow">${esc(name)} · ${esc(p.round)}회 · ${esc(fmtWhen(p.bought_at, false))}</div>${body}</div>`;
}

async function runWorkflow(dry) {
  const msg = dry ? "결제 직전까지만 확인하는 모의 실행을 시작할까요?"
    : "지금 구매를 시도할까요?\n이번 주에 이미 샀으면 아무것도 사지 않고, 예치금이 부족하면 충전 요청 알림만 와요.";
  if (!confirm(msg)) return;
  if (MODE !== "live") { toast("데모에서는 실제로 실행되지 않아요."); return; }
  try {
    await source.dispatch(dry);
    toast("실행을 요청했어요. 2~3분 뒤 결과가 반영돼요.");
    pollRuns();
  } catch (e) { toast(apiMessage(e, true)); }
}

function pollRuns() {
  clearInterval(S.polling);
  let tries = 0;
  S.polling = setInterval(async () => {
    tries += 1;
    try { S.runs = await source.runs(); } catch { /* 다음 번에 */ }
    const busy = S.runs.some((r) => r.status !== "completed");
    if (S.tab === "home") render();
    if ((!busy && tries > 2) || tries > 24) {
      clearInterval(S.polling);
      loadAll();
    }
  }, 15000);
}

/* ───────────── 알림 ───────────── */
function unreadCount() {
  const seen = store.get().seen || "";
  return (S.data?.notifications || []).filter((n) => n.at > seen).length;
}
function markSeen() {
  const list = S.data?.notifications || [];
  if (list.length) store.set({ seen: list.at(-1).at });
}
function renderAlerts(view) {
  const list = [...(S.data.notifications || [])].reverse();
  if (S.seenBefore === undefined) {
    S.seenBefore = store.get().seen || "";
    markSeen();
    $("#badge").hidden = true;
  }
  const seen = S.seenBefore;
  let html = `<section class="card"><h2>알림 기록 <small>휴대폰으로 보낸 알림 전체</small></h2>`;
  if (!list.length) html += `<p class="empty">아직 보낸 알림이 없어요.</p>`;
  html += list.slice(0, 150).map((n) => {
    const important = n.priority >= 4;
    return `<article class="notice">
      <div class="h">${n.at > seen ? '<span class="dot" aria-label="새 알림"></span>' : ""}<b>${esc(n.title)}</b>${important ? '<span class="pill warn">중요</span>' : ""}<span class="when">${esc(fmtWhen(n.at))}</span></div>
      <p>${esc(n.message)}</p>
      ${n.buttons?.length ? `<div class="links">${n.buttons.map(([label, url]) => `<a class="btn" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`).join("")}</div>` : ""}
    </article>`;
  }).join("");
  html += `</section>`;
  view.innerHTML = html;
}

/* ───────────── 내역 ───────────── */
function ledgerRank(e) {
  if (e.result === "미추첨") return "추첨 전";
  if (!(e.prize > 0) && e.result !== "당첨") return null;
  return e.rank ? `${e.rank}등` : "당첨";
}
function gameKey(e) { return /연금/.test(e.game) ? "pension" : "lotto"; }

/** 연금복권 '모든조' 구매는 계정 내역에 조별로 5줄이 찍히므로, 같은 날·회차·번호는 한 줄로 합친다. */
function groupLedger(entries) {
  const out = [], index = {};
  entries.forEach((e) => {
    const m = /^(\d):(\d{6})$/.exec(e.info || "");
    const key = m ? `${e.date}|${e.game}|${e.round}|${m[2]}` : `${e.key}`;
    const g = index[key];
    if (!g) {
      index[key] = { ...e, groups: m ? [m[1]] : [], number: m ? m[2] : "" };
      out.push(index[key]);
    } else {
      g.qty += e.qty;
      g.prize = (g.prize || 0) + (e.prize || 0);
      g.groups.push(m[1]);
      if (e.rank && (!g.rank || e.rank < g.rank)) g.rank = e.rank;
      if (e.result === "당첨") g.result = "당첨";
    }
  });
  return out;
}

function renderHistory(view) {
  const h = S.hist;
  let html = `<div class="chips" role="group" aria-label="보기">
      <button class="chip" data-view="ledger" aria-pressed="${h.view === "ledger"}">계정 구매내역</button>
      <button class="chip" data-view="mine" aria-pressed="${h.view === "mine"}">자동 구매 번호</button>
    </div>`;

  if (h.view === "ledger") {
    const all = groupLedger([...S.data.ledger].filter((e) => h.game === "all" || gameKey(e) === h.game)).reverse();
    html += `<section class="card">
      <div class="chips" role="group" aria-label="복권 종류" style="margin-bottom:6px">
        ${[["all", "전체"], ["lotto", "로또"], ["pension", "연금복권"]].map(([k, l]) => `<button class="chip" data-game="${k}" aria-pressed="${h.game === k}">${l}</button>`).join("")}
      </div>`;
    if (!all.length) html += `<p class="empty">내역이 없어요.</p>`;
    let month = "";
    const monthly = {};
    all.forEach((e) => { const m = e.date.slice(0, 7); (monthly[m] ||= [0, 0]); monthly[m][0] += e.qty * 1000; monthly[m][1] += e.prize || 0; });
    h.rows = all;
    all.slice(0, h.limit).forEach((e, i) => {
      const m = e.date.slice(0, 7);
      if (m !== month) {
        month = m;
        html += `<div class="month-head"><span>${esc(m.replace("-", "년 "))}월</span><span class="num">구매 ${won(monthly[m][0])} · 당첨 ${won(monthly[m][1])}</span></div>`;
      }
      const gs = [...e.groups].sort();
      const num = e.number ? ` · ${gs.join(",") === "1,2,3,4,5" ? "1~5조" : gs.map((g) => `${g}조`).join(" ")} ${e.number}` : "";
      html += `<div class="row tap" data-i="${i}" role="button" tabindex="0" aria-label="${esc(e.game)} ${esc(e.round)}회 상세 보기"><div><div class="t">${esc(e.game)} ${e.round ? `${esc(e.round)}회` : ""}</div><div class="d">${esc(fmtWhen(e.date, false))} · ${esc(e.qty)}매${esc(num)}</div></div>${rankPill(ledgerRank(e), e.prize)}</div>`;
    });
    if (all.length > h.limit) html += `<div class="actions"><button class="btn grow" id="more">더 보기 (${all.length - h.limit}건 남음)</button></div>`;
    html += `</section>`;
  } else {
    const mine = [...S.data.purchases].reverse();
    h.mine = mine;
    html += `<section class="card"><h2>이 프로그램이 산 번호 <small>눌러서 당첨번호와 비교</small></h2>`;
    html += mine.length ? mine.map((p, i) => `<div class="tap-block" data-p="${i}" role="button" tabindex="0">${purchaseBlock(p)}</div>`)
      .join('<hr style="border:0;border-top:1px solid var(--line);margin:12px 0">') : `<p class="empty">아직 없어요.</p>`;
    html += `</section>`;
  }
  view.innerHTML = html;
  const open = (el, detail) => {
    el.addEventListener("click", () => openDetail(detail()));
    el.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openDetail(detail()); } });
  };
  view.querySelectorAll("[data-i]").forEach((el) => open(el, () => detailFromLedger(h.rows[+el.dataset.i])));
  view.querySelectorAll("[data-p]").forEach((el) => open(el, () => detailFromPurchase(h.mine[+el.dataset.p])));
  view.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => { h.view = b.dataset.view; render(); }));
  view.querySelectorAll("[data-game]").forEach((b) => b.addEventListener("click", () => { h.game = b.dataset.game; h.limit = 60; render(); }));
  $("#more")?.addEventListener("click", () => { h.limit += 60; render(); });
}

/* ───────────── 상세 (번호 · 당첨번호 비교) ───────────── */
async function loadDraws() {
  if (S.draws) return S.draws;
  const toMap = (list) => Object.fromEntries((list || []).map((d) => [d.round, d]));
  if (MODE === "demo") S.draws = S.data.draws;
  else {
    const [lotto, pension] = await Promise.all([
      source.json("data/lotto645_history.json", []), source.json("data/pension720_history.json", []),
    ]);
    S.draws = { lotto: toMap(lotto), pension: toMap(pension) };
  }
  return S.draws;
}

function pensionTickets(list) {  // [{group, number}] → [{groups:[...], number}]
  const by = {};
  list.forEach((t) => { (by[t.number] ||= []).push(String(t.group)); });
  return Object.entries(by).map(([number, groups]) => ({ number, groups: groups.sort() }));
}

function detailFromLedger(e) {
  const pension = gameKey(e) === "pension";
  let games = e.games || [];
  if (!pension && !games.length) {  // 이 프로그램으로 산 회차면 기록해 둔 번호로
    const p = S.data.purchases.find((x) => x.game === "lotto645" && x.round === e.round && x.tickets.some((t) => t.numbers?.length));
    if (p) games = p.tickets;
  }
  const research = S.data.purchases.find((x) => x.game === (pension ? "pension720" : "lotto645") && x.round === e.round)?.research;
  return {
    pension, game: e.game, round: e.round, date: e.date, qty: e.qty, prize: e.prize || 0, result: e.result, rank: e.rank,
    games, tickets: pension && e.number ? [{ number: e.number, groups: [...e.groups].sort() }] : [], research,
  };
}

function detailFromPurchase(p) {
  const pension = p.game === "pension720";
  const rows = groupLedger(S.data.ledger.filter((e) => gameKey(e) === (pension ? "pension" : "lotto") && e.round === p.round));
  const prize = rows.reduce((s, e) => s + (e.prize || 0), 0);
  const result = !rows.length ? (p.result ? "" : "미추첨") : rows.some((e) => e.result === "미추첨") ? "미추첨" : prize > 0 ? "당첨" : "낙첨";
  return {
    pension, game: pension ? "연금복권720+" : "로또6/45", round: p.round, date: (p.bought_at || "").slice(0, 10),
    qty: p.tickets.length, prize, result, rank: rows.find((e) => e.rank)?.rank,
    games: pension ? [] : p.tickets, tickets: pension ? pensionTickets(p.tickets) : [], research: p.research,
  };
}

function lottoRankOf(nums, draw) {
  const hit = nums.filter((n) => draw.numbers.includes(n)).length;
  if (hit === 6) return "1등";
  if (hit === 5 && nums.includes(draw.bonus)) return "2등";
  return { 5: "3등", 4: "4등", 3: "5등" }[hit] || null;
}
function pensionRankOf(group, number, draw) {
  if (number === draw.number) return String(group) === String(draw.group) ? "1등" : "2등";
  if (number === draw.bonus) return "보너스";
  for (let k = 5; k >= 1; k--) if (number.slice(-k) === draw.number.slice(-k)) return `${8 - k}등`;
  return null;
}
function tailMatch(number, target) {
  let k = 0;
  while (k < 6 && number[5 - k] === target[5 - k]) k++;
  return k;
}

async function openDetail(d) {
  let draws;
  try { draws = await loadDraws(); } catch (e) { toast(apiMessage(e)); return; }
  const draw = d.pension ? draws.pension[d.round] : draws.lotto[d.round];
  const status = d.result === "미추첨" || !draw ? '<span class="pill warn">추첨 전</span>'
    : d.prize > 0 ? `<span class="pill good">${d.rank ? `${esc(d.rank)}등 · ` : ""}${won(d.prize)}</span>` : '<span class="pill mute">낙첨</span>';

  let body = `<dl class="facts">
      <div><dt>구입일</dt><dd>${esc(fmtWhen(d.date, false))}</dd></div>
      <div><dt>추첨일</dt><dd>${draw ? esc(fmtWhen(draw.date, false)) : "추첨 전"}</dd></div>
      <div><dt>구매</dt><dd>${esc(d.qty)}${d.pension ? "매" : "게임"} · ${won(d.qty * 1000)}</dd></div>
      <div><dt>당첨금</dt><dd>${draw ? won(d.prize) : "–"}</dd></div>
    </dl>`;

  if (!d.pension) {
    if (draw) {
      body += `<div><div class="sec-title">${esc(d.round)}회 당첨번호</div><div class="win-row">${balls(draw.numbers)}<span class="plus">+</span>${balls([draw.bonus])}</div></div>`;
    }
    body += `<div><div class="sec-title">내 번호</div>`;
    if (!d.games.length) body += `<p class="empty">번호 정보를 아직 받지 못했어요. 다음 자동 실행(또는 홈의 '모의 실행') 때 받아와요.</p>`;
    d.games.forEach((g) => {
      const nums = g.numbers || [];
      const rank = draw && nums.length ? lottoRankOf(nums, draw) : null;
      const ballsHtml = nums.length ? `<div class="balls">${nums.map((n) => {
        const cls = !draw ? "" : draw.numbers.includes(n) ? "" : n === draw.bonus && rank === "2등" ? " bonus-hit" : " miss";
        return `<span class="ball${cls}" style="--ball:${ballColor(n)}">${n}</span>`;
      }).join("")}</div>` : '<span class="muted">자동번호 (번호 확인 전)</span>';
      const hits = draw && nums.length ? nums.filter((n) => draw.numbers.includes(n)).length : null;
      body += `<div class="line"><span class="slot">${esc(g.slot)}<span class="mode">${esc(g.mode || "")}</span></span>${ballsHtml}${
        !draw ? '<span class="pill warn">추첨 전</span>' : rank ? `<span class="pill good">${esc(rank)}</span>` : `<span class="pill mute">${hits}개</span>`}</div>`;
    });
    body += `</div>`;
  } else {
    if (draw) {
      body += `<div><div class="sec-title">${esc(d.round)}회 당첨번호</div><div class="win-row"><span class="jo">${esc(draw.group)}조</span>${digits(draw.number)}</div>
        <div class="hint" style="margin-top:6px">보너스 ${esc(draw.bonus)} (조 상관없이 6자리 일치)</div></div>`;
    }
    body += `<div><div class="sec-title">내 번호</div>`;
    if (!d.tickets.length) body += `<p class="empty">번호 정보가 없어요.</p>`;
    d.tickets.forEach((t) => {
      const where = t.groups.join(",") === "1,2,3,4,5" ? "1~5조" : t.groups.map((g) => `${g}조`).join(" ");
      const k = draw ? tailMatch(t.number, draw.number) : 0;
      const best = draw ? t.groups.map((g) => pensionRankOf(g, t.number, draw)).filter(Boolean).sort()[0] : null;
      const digitHtml = `<div class="balls">${[...t.number].map((c, i) => `<span class="digit${draw && i >= 6 - k ? " hit" : ""}">${esc(c)}</span>`).join("")}</div>`;
      body += `<div class="line" style="grid-template-columns:1fr auto"><div class="balls" style="flex-wrap:nowrap"><span class="jo">${esc(where)}</span>${digitHtml}</div>${
        !draw ? '<span class="pill warn">추첨 전</span>' : best ? `<span class="pill good">${esc(best)}</span>` : '<span class="pill mute">낙첨</span>'}</div>`;
    });
    if (draw) body += `<p class="hint" style="margin:6px 0 0">연금복권은 끝자리부터 맞은 개수로 등수가 정해져요 (1자리 7등 … 5자리 3등, 6자리+조 1등).</p>`;
    body += `</div>`;
  }
  if (d.research) body += researchHtml(d.research, d.pension);

  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(d.game)} ${esc(d.round)}회 상세">
    <div class="sheet-head"><h3>${esc(d.game)} ${esc(d.round)}회</h3>${status}</div>
    ${body}
    <button class="btn primary grow" data-close>닫기</button>
  </div>`;
  document.body.append(bg);
  const close = () => { bg.remove(); document.removeEventListener("keydown", onKey); window.removeEventListener("popstate", close); };
  const onKey = (ev) => { if (ev.key === "Escape") { history.back(); } };
  bg.addEventListener("click", (ev) => { if (ev.target === bg || ev.target.hasAttribute("data-close")) history.back(); });
  document.addEventListener("keydown", onKey);
  history.pushState({ sheet: 1 }, "");  // 폰 '뒤로' 버튼으로 닫히게
  window.addEventListener("popstate", close);
}

function researchHtml(r, pension) {
  if (!r) return "";
  let html = `<div><div class="sec-title">번호를 이렇게 고른 이유</div><p class="hint" style="margin:0 0 6px">${esc(r.summary || "")}</p>`;
  if (!pension && r.tickets?.length) {
    html += `<div class="table-wrap"><table><thead><tr><th>게임</th><th class="r">인기도</th><th class="r">1등 시 예상 몫</th></tr></thead><tbody>
      ${r.tickets.map((t) => `<tr><td>${esc(t.slot)}</td><td class="r">${t.popularity.toFixed(2)}배</td><td class="r">${t.first_prize_multiplier.toFixed(2)}배</td></tr>`).join("")}
      </tbody></table></div><p class="hint" style="margin:6px 0 0">인기도 1.00 = 평균 조합. 낮을수록 남들이 덜 고른 조합이라 1~3등이 되면 나눠 갖는 사람이 적어요. 당첨 확률 자체는 모든 조합이 같아요.</p>`;
  }
  return html + `</div>`;
}

function researchCards() {
  const R = S.data.research;
  if (!R) return `<section class="card"><h2>번호 선택 연구</h2><p class="empty">아직 분석 결과가 없어요. 다음 자동 실행(또는 홈의 '모의 실행') 뒤에 표시돼요.</p></section>`;
  let html = "";
  const M = R.model;
  if (M) {
    html += `<section class="card"><h2>이번 주 번호 선택 <small>${esc(fmtWhen(M.fitted_at))} 분석</small></h2>
      <p style="margin:0 0 10px;color:var(--ink-2)">${esc(M.summary)}</p>
      <div class="tiles">
        <div class="tile"><div class="k">겹치지 않은 숫자</div><div class="v num">${esc(M.distinct_numbers)}개</div><div class="s">5게임 기준 · 많을수록 이번 주 당첨 기회 ↑</div></div>
        <div class="tile"><div class="k">인기도 모델 검증</div><div class="v num">${Math.round((1 - M.validation.low_vs_high) * 100)}%</div><div class="s">비인기로 본 조합의 실제 공동 당첨자 감소 (최근 ${esc(M.validation.holdout_draws)}회)</div></div>
      </div>
      <div class="sec-title" style="margin-top:12px">사람들이 많이 고르는 번호 (피함)</div>
      <div class="balls">${M.popular_numbers.map(([n]) => `<span class="ball" style="--ball:${ballColor(n)}">${n}</span>`).join("")}</div>
      <div class="sec-title" style="margin-top:10px">사람들이 덜 고르는 번호</div>
      <div class="balls">${M.unpopular_numbers.map(([n]) => `<span class="ball" style="--ball:${ballColor(n)}">${n}</span>`).join("")}</div>
    </section>`;
  }
  const block = (title, part) => {
    const P = R[part];
    if (!P) return "";
    const adopted = P.adopted.length;
    return `<section class="card"><h2>${title} <small>${adopted ? `${adopted}개 채택` : "채택된 가설 없음"} · ${esc(fmtWhen(R.generated_at))}</small></h2>
      <p class="hint" style="margin:0 0 8px">${part === "lotto" ? `매 회차 '그 회차 이전 데이터만' 보고 골랐을 때 실제로 더 맞았는지 ${esc(P.backtest_draws)}회로 검증했어요.` : "연금복권 이력 전체로 검증했어요."} 효과가 확인된 가설만 번호 선택에 자동 반영돼요.</p>
      <div class="list">${P.tests.map((t) => `<details class="row" style="display:block">
        <summary style="display:flex;justify-content:space-between;gap:10px;cursor:pointer;list-style:none">
          <span class="t">${esc(t.name)}</span>
          <span class="pill ${t.verdict === "채택" ? "good" : t.verdict === "기각" ? "mute" : "warn"}">${esc(t.verdict)}</span>
        </summary>
        <div class="d" style="margin-top:6px">가설: ${esc(t.claim)}</div>
        <div class="d">방법: ${esc(t.method)}</div>
        <div class="d" style="color:var(--ink-2)">결과: ${esc(t.result)}</div>
        <div class="d" style="color:var(--ink-2)">${esc(t.why)}</div>
      </details>`).join("")}</div>
    </section>`;
  };
  html += block("로또 당첨 가설 검증", "lotto") + block("연금복권 당첨 가설 검증", "pension");
  return html;
}

/* ───────────── 분석 ───────────── */
function periodFilter(entries) {
  const p = S.stats.period;
  if (p === "all") return entries;
  const now = new Date();
  const from = p === "year" ? `${now.getFullYear()}-01-01`
    : new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1).toISOString().slice(0, 10);
  return entries.filter((e) => e.date >= from);
}

function renderStats(view) {
  const entries = periodFilter([...S.data.ledger].sort((a, b) => a.date.localeCompare(b.date)));
  const drawn = entries.filter((e) => e.result !== "미추첨");
  const spend = entries.reduce((s, e) => s + e.qty * 1000, 0);
  const prize = entries.reduce((s, e) => s + (e.prize || 0), 0);
  const drawnSpend = drawn.reduce((s, e) => s + e.qty * 1000, 0);
  const roi = drawnSpend ? prize / drawnSpend : 0;
  const net = prize - spend;

  const games = {};
  entries.forEach((e) => {
    const g = (games[e.game] ||= { spend: 0, prize: 0, drawnSpend: 0, orders: 0, wins: 0, best: 0 });
    g.spend += e.qty * 1000; g.prize += e.prize || 0; g.best = Math.max(g.best, e.prize || 0);
    if (e.result !== "미추첨") { g.drawnSpend += e.qty * 1000; g.orders += 1; if ((e.prize || 0) > 0) g.wins += 1; }
  });
  const ranks = {};
  entries.filter((e) => (e.prize || 0) > 0).forEach((e) => {
    const k = `${e.game}|${e.rank || 0}`;
    (ranks[k] ||= { game: e.game, rank: e.rank, n: 0, sum: 0 });
    ranks[k].n += 1; ranks[k].sum += e.prize;
  });

  let html = researchCards() + `<div class="eyebrow" style="margin-top:6px">내 구매 수익률</div><div class="chips" role="group" aria-label="기간">
    ${[["all", "전체 기간"], ["12m", "최근 12개월"], ["year", "올해"]].map(([k, l]) => `<button class="chip" data-period="${k}" aria-pressed="${S.stats.period === k}">${l}</button>`).join("")}
  </div>`;

  if (!entries.length) { view.innerHTML = html + `<section class="card"><p class="empty">이 기간의 내역이 없어요.</p></section>`; bindPeriod(view); return; }

  html += `<div class="tiles">
    <div class="tile"><div class="k">총 구매</div><div class="v num">${won(spend)}</div><div class="s">${entries.reduce((s, e) => s + e.qty, 0).toLocaleString()}매</div></div>
    <div class="tile"><div class="k">총 당첨금</div><div class="v num">${won(prize)}</div><div class="s">최고 ${won(Math.max(0, ...Object.values(games).map((g) => g.best)))}</div></div>
    <div class="tile"><div class="k">회수율</div><div class="v num">${(roi * 100).toFixed(1)}%</div><div class="s">추첨 끝난 구매 기준</div></div>
    <div class="tile"><div class="k">손익</div><div class="v num ${net >= 0 ? "up" : "down"}">${net >= 0 ? "+" : "−"}${won(Math.abs(net))}</div><div class="s">당첨금 − 구매액</div></div>
  </div>`;

  html += `<section class="card"><h2>복권별</h2><div class="table-wrap"><table>
    <thead><tr><th>복권</th><th class="r">구매</th><th class="r">당첨금</th><th class="r">회수율</th><th class="r">당첨 비율</th></tr></thead><tbody>
    ${Object.entries(games).map(([name, g]) => `<tr><td>${esc(name)}</td><td class="r">${shortWon(g.spend)}</td><td class="r">${shortWon(g.prize)}</td>
      <td class="r">${g.drawnSpend ? ((g.prize / g.drawnSpend) * 100).toFixed(1) : "–"}%</td><td class="r">${g.orders ? ((g.wins / g.orders) * 100).toFixed(0) : "–"}%</td></tr>`).join("")}
    </tbody></table></div><p class="hint" style="margin:8px 0 0">당첨 비율 = 당첨된 구매 건 / 추첨 끝난 구매 건 (로또는 5게임 묶음이 1건)</p></section>`;

  html += `<section class="card"><h2>누적 구매액과 당첨금</h2>
    <div class="legend"><span><i style="background:var(--series-1)"></i>누적 구매액</span><span><i style="background:var(--series-2)"></i>누적 당첨금</span></div>
    <div class="chart" id="chart-cum"></div></section>`;
  html += `<section class="card"><h2>월별 구매·당첨</h2>
    <div class="legend"><span><i class="sq" style="background:var(--series-1)"></i>구매액</span><span><i class="sq" style="background:var(--series-2)"></i>당첨금</span></div>
    <div class="chart" id="chart-month"></div></section>`;

  const rankRows = Object.values(ranks).sort((a, b) => a.game.localeCompare(b.game) || (a.rank || 9) - (b.rank || 9));
  html += `<section class="card"><h2>등수별 당첨</h2>${rankRows.length ? `<div class="table-wrap"><table>
    <thead><tr><th>복권</th><th>등수</th><th class="r">횟수</th><th class="r">당첨금</th></tr></thead><tbody>
    ${rankRows.map((r) => `<tr><td>${esc(r.game)}</td><td>${r.rank ? `${esc(r.rank)}등` : "당첨"}</td><td class="r">${r.n}</td><td class="r">${won(r.sum)}</td></tr>`).join("")}
    </tbody></table></div>` : `<p class="empty">이 기간에는 당첨이 없어요.</p>`}</section>`;

  view.innerHTML = html;
  bindPeriod(view);

  // 누적 (구입일 기준, 날짜별)
  const days = [];
  let cs = 0, cp = 0;
  entries.forEach((e) => {
    cs += e.qty * 1000; cp += e.prize || 0;
    if (days.length && days.at(-1).date === e.date) { days.at(-1).a = cs; days.at(-1).b = cp; }
    else days.push({ date: e.date, a: cs, b: cp });
  });
  lineChart($("#chart-cum"), days, [
    { key: "a", label: "누적 구매액", color: "var(--series-1)" },
    { key: "b", label: "누적 당첨금", color: "var(--series-2)" },
  ]);

  const months = {};
  entries.forEach((e) => { const m = e.date.slice(0, 7); (months[m] ||= { m, a: 0, b: 0 }); months[m].a += e.qty * 1000; months[m].b += e.prize || 0; });
  barChart($("#chart-month"), Object.values(months).slice(-12), [
    { key: "a", label: "구매액", color: "var(--series-1)" },
    { key: "b", label: "당첨금", color: "var(--series-2)" },
  ]);
}
function bindPeriod(view) {
  view.querySelectorAll("[data-period]").forEach((b) => b.addEventListener("click", () => { S.stats.period = b.dataset.period; render(); }));
}

/* ── 차트: 한 개의 y축, 얇은 선, 옅은 격자, 가로선 크로스헤어 + 툴팁 ── */
function niceMax(v) {
  if (v <= 0) return 1000;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}
const svgNS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(svgNS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  parent?.append(el);
  return el;
}
function chartFrame(el, yMax) {
  el.innerHTML = "";
  const W = Math.max(280, el.clientWidth || 320), H = 200;
  const m = { l: 44, r: 12, t: 10, b: 24 };
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, el);
  const y = (v) => m.t + (H - m.t - m.b) * (1 - v / yMax);
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i;
    svgEl("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: i === 0 ? "var(--line)" : "var(--grid)", "stroke-width": 1 }, svg);
    svgEl("text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end" }, svg).textContent = shortWon(v);
  }
  const tip = document.createElement("div");
  tip.className = "tip"; tip.hidden = true; el.append(tip);
  return { svg, W, H, m, y, tip };
}
function lineChart(el, rows, series) {
  if (!el || rows.length < 2) { if (el) el.innerHTML = '<p class="empty">데이터가 2일 이상 쌓이면 그려져요.</p>'; return; }
  const yMax = niceMax(Math.max(...rows.map((r) => Math.max(...series.map((s) => r[s.key])))));
  const { svg, W, H, m, y, tip } = chartFrame(el, yMax);
  const t0 = toDate(rows[0].date).getTime(), t1 = toDate(rows.at(-1).date).getTime();
  const x = (d) => m.l + (W - m.l - m.r) * ((toDate(d).getTime() - t0) / Math.max(1, t1 - t0));
  [rows[0], rows[Math.floor(rows.length / 2)], rows.at(-1)].forEach((r, i) => {
    svgEl("text", { x: x(r.date), y: H - 6, "text-anchor": ["start", "middle", "end"][i] }, svg).textContent = r.date.slice(2, 7).replace("-", ".");
  });
  series.forEach((s) => {
    const d = rows.map((r, i) => `${i ? "L" : "M"}${x(r.date).toFixed(1)},${y(r[s.key]).toFixed(1)}`).join("");
    svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    const last = rows.at(-1);
    svgEl("circle", { cx: x(last.date), cy: y(last[s.key]), r: 4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2 }, svg);
  });
  const cross = svgEl("line", { y1: m.t, y2: H - m.b, stroke: "var(--muted)", "stroke-width": 1, "stroke-dasharray": "3 3", visibility: "hidden" }, svg);
  const dots = series.map((s) => svgEl("circle", { r: 4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }, svg));
  const hit = svgEl("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" }, svg);
  const show = (evt) => {
    const box = svg.getBoundingClientRect();
    const px = ((evt.clientX - box.left) / box.width) * W;
    let best = rows[0];
    rows.forEach((r) => { if (Math.abs(x(r.date) - px) < Math.abs(x(best.date) - px)) best = r; });
    const cx = x(best.date);
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
    series.forEach((s, i) => { dots[i].setAttribute("cx", cx); dots[i].setAttribute("cy", y(best[s.key])); dots[i].setAttribute("visibility", "visible"); });
    tip.innerHTML = `<b>${esc(best.date)}</b><br>${series.map((s) => `${esc(s.label)} ${won(best[s.key])}`).join("<br>")}`;
    tip.hidden = false;
    tip.style.left = `${Math.min(Math.max((cx / W) * box.width, 70), box.width - 70)}px`;
    tip.style.top = `${(y(Math.max(...series.map((s) => best[s.key]))) / H) * box.height - 8}px`;
  };
  const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); };
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", hide);
}
function barChart(el, rows, series) {
  if (!el || !rows.length) return;
  const yMax = niceMax(Math.max(...rows.map((r) => Math.max(...series.map((s) => r[s.key])))));
  const { svg, W, H, m, y, tip } = chartFrame(el, yMax);
  const band = (W - m.l - m.r) / rows.length;
  const gap = 2, inner = Math.min(18, (band * 0.7 - gap) / series.length);
  rows.forEach((r, i) => {
    const x0 = m.l + band * i + (band - (inner * series.length + gap)) / 2;
    series.forEach((s, j) => {
      const v = r[s.key], top = y(v), base = y(0), bx = x0 + j * (inner + gap);
      if (v > 0) {
        const rr = Math.min(4, inner / 2, base - top);
        const d = `M${bx},${base}V${top + rr}Q${bx},${top} ${bx + rr},${top}H${bx + inner - rr}Q${bx + inner},${top} ${bx + inner},${top + rr}V${base}Z`;
        svgEl("path", { d, fill: s.color }, svg);
      }
    });
    if (rows.length <= 6 || i % 2 === rows.length % 2 || i === rows.length - 1) {
      svgEl("text", { x: m.l + band * i + band / 2, y: H - 6, "text-anchor": "middle" }, svg).textContent = `${+r.m.slice(5)}월`;
    }
    const hit = svgEl("rect", { x: m.l + band * i, y: m.t, width: band, height: H - m.t - m.b, fill: "transparent" }, svg);
    const show = () => {
      const box = svg.getBoundingClientRect();
      tip.innerHTML = `<b>${esc(r.m.replace("-", "년 "))}월</b><br>${series.map((s) => `${esc(s.label)} ${won(r[s.key])}`).join("<br>")}`;
      tip.hidden = false;
      tip.style.left = `${Math.min(Math.max(((m.l + band * i + band / 2) / W) * box.width, 70), box.width - 70)}px`;
      tip.style.top = `${(y(Math.max(...series.map((s) => r[s.key]))) / H) * box.height - 8}px`;
    };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", () => { tip.hidden = true; });
  });
}

/* ───────────── 로그 ───────────── */
async function renderLogs(view) {
  const L = S.logs;
  const files = S.data.logFiles || [];
  view.innerHTML = `<section class="card">
    <h2>실행 로그</h2>
    <div class="log-tools">
      <input type="search" id="log-q" placeholder="검색 (예: 구매 완료, 예치금)" value="${esc(L.q)}" aria-label="로그 검색">
      <select id="log-file" aria-label="월 선택">${files.map((f) => `<option value="${esc(f)}" ${f === L.file ? "selected" : ""}>${esc(f.replace(".log", ""))}</option>`).join("") || "<option>없음</option>"}</select>
    </div>
    <div class="chips" style="margin-bottom:10px" role="group" aria-label="로그 종류">
      ${[["all", "전체"], ["issue", "오류·경고"], ["notify", "알림"], ["buy", "구매"]].map(([k, l]) => `<button class="chip" data-lf="${k}" aria-pressed="${L.filter === k}">${l}</button>`).join("")}
    </div>
    <div class="log" id="log-body">${files.length ? "불러오는 중…" : "로그 파일이 없어요."}</div>
  </section>`;
  $("#log-file")?.addEventListener("change", (e) => { L.file = e.target.value; L.text = ""; renderLogs(view); });
  $("#log-q").addEventListener("input", (e) => { L.q = e.target.value; paintLog(); });
  view.querySelectorAll("[data-lf]").forEach((b) => b.addEventListener("click", () => { L.filter = b.dataset.lf; renderLogs(view); }));
  if (!files.length) return;
  if (!L.text) {
    try { L.text = MODE === "demo" ? S.data.logText : await source.text(`logs/${L.file}`); }
    catch (e) { $("#log-body").textContent = apiMessage(e); return; }
  }
  paintLog();
}
function paintLog() {
  const L = S.logs, body = $("#log-body");
  if (!body) return;
  const q = L.q.trim();
  let lines = L.text.split("\n").filter(Boolean);
  if (L.filter === "issue") lines = lines.filter((l) => /\[(ERROR|WARNING)\]/.test(l));
  if (L.filter === "notify") lines = lines.filter((l) => l.includes("알림:"));
  if (L.filter === "buy") lines = lines.filter((l) => /구매|충전|예치금/.test(l));
  if (q) lines = lines.filter((l) => l.includes(q));
  const shown = lines.slice(-800);
  body.innerHTML = (shown.length < lines.length ? `<span class="n">… 앞부분 ${lines.length - shown.length}줄 생략</span>\n` : "")
    + (shown.map((l) => {
      const cls = /\[ERROR\]/.test(l) ? "e" : /\[WARNING\]/.test(l) ? "w" : /알림:|구매 완료|=====/.test(l) ? "n" : "";
      return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
    }).join("\n") || "해당하는 줄이 없어요.");
  body.scrollTop = body.scrollHeight;
}

/* ───────────── 연결 / PIN / 설정 ───────────── */
function showApp() {
  $("#gate").hidden = true;
  ["#top", "#view", "#tabs"].forEach((s) => { $(s).hidden = false; });
}
function showGate(html) {
  ["#top", "#view", "#tabs"].forEach((s) => { $(s).hidden = true; });
  const g = $("#gate");
  g.hidden = false;
  g.innerHTML = `<div class="gate">${html}</div>`;
  return g;
}

function showSetup(error = "") {
  const cfg = store.get();
  const g = showGate(`
    <div class="brand"><img src="icon-192.png" alt="" style="width:40px;height:40px;border-radius:10px"></div>
    <h1>복권 수첩 연결</h1>
    <p class="muted" style="margin:0">내 비공개 저장소의 기록을 이 폰에서만 읽어와요. 입력한 값은 이 폰에만 저장돼요.</p>
    <ol class="steps">
      <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub 토큰 만들기</a> (Fine-grained)</li>
      <li>Repository access → <b>Only select repositories</b> → <b>lotto-auto</b></li>
      <li>Permissions → <b>Contents: Read-only</b>, <b>Actions: Read and write</b></li>
      <li>만든 토큰을 아래에 붙여넣기</li>
    </ol>
    <div class="field"><label for="f-repo">저장소</label><input type="text" id="f-repo" placeholder="아이디/lotto-auto" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(cfg.repo || "")}"></div>
    <div class="field"><label for="f-token">토큰</label><input type="password" id="f-token" placeholder="github_pat_…" autocomplete="off"></div>
    <div class="field"><label for="f-pin">앱 PIN (4~8자리 숫자, 권장)</label><input type="password" id="f-pin" class="pin" inputmode="numeric" maxlength="8" autocomplete="new-password">
      <span class="hint">PIN 을 정하면 토큰을 암호화해서 저장해요. 폰을 누가 열어도 PIN 없이는 기록을 못 봐요.</span></div>
    <p class="err" id="f-err">${esc(error)}</p>
    <button class="btn primary grow" id="f-go">연결</button>
    <a class="btn grow" href="?demo">연결 없이 데모 먼저 보기</a>
  `);
  g.querySelector("#f-go").addEventListener("click", async () => {
    const repo = g.querySelector("#f-repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
    const token = g.querySelector("#f-token").value.trim();
    const pin = g.querySelector("#f-pin").value.trim();
    const err = g.querySelector("#f-err");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { err.textContent = "저장소는 '아이디/저장소이름' 형식으로 입력하세요."; return; }
    if (!token) { err.textContent = "토큰을 붙여넣으세요."; return; }
    if (pin && !/^\d{4,8}$/.test(pin)) { err.textContent = "PIN 은 숫자 4~8자리로 정하세요."; return; }
    err.textContent = "확인 중…";
    source.repo = repo; source.token = token;
    try { await source.check(); } catch (e) { err.textContent = apiMessage(e); return; }
    store.set(pin ? { repo, sealed: await sealToken(token, pin), token: undefined } : { repo, token, sealed: undefined });
    showApp();
    loadAll();
  });
}

function showPin() {
  const cfg = store.get();
  const g = showGate(`
    <div class="brand"><img src="icon-192.png" alt="" style="width:40px;height:40px;border-radius:10px"></div>
    <h1>PIN 입력</h1>
    <input type="password" id="p-pin" class="pin" inputmode="numeric" maxlength="8" autocomplete="off" aria-label="PIN">
    <p class="err" id="p-err"></p>
    <button class="btn primary grow" id="p-go">열기</button>
    <button class="btn grow" id="p-reset">PIN 을 잊었어요 (연결 다시 하기)</button>
  `);
  const input = g.querySelector("#p-pin");
  input.focus();
  const go = async () => {
    try {
      source.repo = cfg.repo;
      source.token = await openToken(cfg.sealed, input.value.trim());
      showApp();
      loadAll();
    } catch { g.querySelector("#p-err").textContent = "PIN 이 맞지 않아요."; input.value = ""; }
  };
  g.querySelector("#p-go").addEventListener("click", go);
  input.addEventListener("keyup", (e) => { if (e.key === "Enter" || input.value.length === 8) go(); });
  g.querySelector("#p-reset").addEventListener("click", () => { if (confirm("이 폰에 저장된 연결 정보를 지우고 다시 연결할까요?")) { store.clear(); showSetup(); } });
}

function openSettings() {
  const cfg = store.get();
  const theme = cfg.theme || "system";
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="설정">
    <h3>설정</h3>
    <div class="field"><label>연결된 저장소</label><div>${esc(MODE === "demo" ? "데모 (예시 데이터)" : MODE === "local" ? "로컬 파일" : cfg.repo)}</div>
      ${MODE === "live" ? `<span class="hint">${cfg.sealed ? "토큰은 PIN 으로 암호화되어 이 폰에만 저장돼 있어요." : "토큰이 암호화 없이 저장돼 있어요. PIN 을 설정하면 더 안전해요."}</span>` : ""}</div>
    <div class="field"><label for="s-theme">화면 모드</label><select id="s-theme">
      ${[["system", "시스템 설정 따르기"], ["light", "밝게"], ["dark", "어둡게"]].map(([k, l]) => `<option value="${k}" ${k === theme ? "selected" : ""}>${l}</option>`).join("")}
    </select></div>
    ${MODE === "live" ? `<button class="btn grow" id="s-pin">${cfg.sealed ? "PIN 바꾸기 / 연결 다시 하기" : "PIN 설정하기 (연결 다시 하기)"}</button>
      <button class="btn grow" id="s-lock">지금 잠그기</button>
      <button class="btn grow" id="s-out" style="color:var(--bad)">이 폰에서 연결 해제</button>` : ""}
    ${MODE !== "live" ? `<a class="btn grow" href="./">내 계정으로 연결하기</a>` : `<a class="btn grow" href="?demo">데모 화면 보기 (공유용)</a>`}
    <p class="hint">다른 사람에게 보여줄 때는 이 앱 주소 뒤에 <b>?demo</b> 를 붙인 링크를 보내세요. 예시 데이터만 보이고 내 기록은 보이지 않아요.</p>
    <button class="btn primary grow" id="s-close">닫기</button>
  </div>`;
  document.body.append(bg);
  const close = () => bg.remove();
  bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
  bg.querySelector("#s-close").addEventListener("click", close);
  bg.querySelector("#s-theme").addEventListener("change", (e) => { store.set({ theme: e.target.value }); applyTheme(); });
  bg.querySelector("#s-pin")?.addEventListener("click", () => { close(); showSetup(); });
  bg.querySelector("#s-lock")?.addEventListener("click", () => { close(); source.token = ""; S.data = null; store.get().sealed ? showPin() : showSetup(); });
  bg.querySelector("#s-out")?.addEventListener("click", () => {
    if (!confirm("이 폰에서 토큰과 연결 정보를 지울까요? (GitHub 의 토큰 자체는 GitHub 설정에서 삭제하세요)")) return;
    store.clear(); close(); source.token = ""; S.data = null; showSetup();
  });
}

function applyTheme() {
  const t = store.get().theme;
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
}

/* ───────────── 데모 데이터 (공유용, 전부 예시) ───────────── */
function demoData() {
  let seed = 20260921;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick6 = () => { const s = new Set(); while (s.size < 6) s.add(1 + Math.floor(rnd() * 45)); return [...s].sort((a, b) => a - b); };
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d, h = 7, mi = 17) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(h)}:${pad(mi)}`;
  const day = (d) => iso(d).slice(0, 10);

  const now = new Date();
  const monday = new Date(now); monday.setHours(7, 20, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weeks = 40, lottoNow = 1244, pensionNow = 335;
  const ledger = [], purchases = [], balances = [], notifications = [];
  const draws = { lotto: {}, pension: {} };
  const hitsOf = (nums, drawNums) => nums.filter((n) => drawNums.includes(n)).length;
  const game = (drawNums, bonus, want) => {  // want 개만 맞는 게임 (want 없으면 2개 이하)
    for (;;) {
      let nums;
      if (want) {
        const hit = [...drawNums].sort(() => rnd() - 0.5).slice(0, want);
        const rest = new Set(hit);
        while (rest.size < 6) { const n = 1 + Math.floor(rnd() * 45); if (!drawNums.includes(n) && n !== bonus) rest.add(n); }
        nums = [...rest].sort((a, b) => a - b);
      } else nums = pick6();
      if (want || hitsOf(nums, drawNums) <= 2) return nums;
    }
  };
  let bal = 20000;
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(monday); d.setDate(d.getDate() - i * 7);
    const sat = new Date(d); sat.setDate(sat.getDate() + 5);
    const thu = new Date(d); thu.setDate(thu.getDate() + 3);
    const lr = lottoNow - i, pr = pensionNow - i, last = i === 0;
    const drawNums = pick6();
    let bonus; do { bonus = 1 + Math.floor(rnd() * 45); } while (drawNums.includes(bonus));
    const lottoWin = last ? 0 : rnd() < 0.09 ? (rnd() < 0.12 ? 50000 : 5000) : 0;
    const games = Array.from({ length: 5 }, (_, k) => ({ slot: "ABCDE"[k], numbers: game(drawNums, bonus, k === 0 && lottoWin ? (lottoWin === 50000 ? 4 : 3) : 0), mode: "자동" }));
    if (!last) draws.lotto[lr] = { round: lr, date: day(sat), numbers: drawNums, bonus };
    ledger.push({ key: `l${i}`, date: day(d), game: "로또6/45", code: "LO40", round: lr, qty: 5, result: last ? "미추첨" : lottoWin ? "당첨" : "낙첨", rank: lottoWin === 50000 ? 4 : lottoWin ? 5 : null, prize: lottoWin, draw_date: "", info: "", games });

    const pnum = String(Math.floor(rnd() * 1e6)).padStart(6, "0");
    const pw = last ? 0 : rnd() < 0.1 ? 1000 : rnd() < 0.012 ? 5000 : 0;
    const keep = pw === 5000 ? 2 : pw === 1000 ? 1 : 0;  // 끝에서 몇 자리 맞출지
    let wnum = String(Math.floor(rnd() * 1e6)).padStart(6, "0").split("");
    for (let k = 0; k < keep; k++) wnum[5 - k] = pnum[5 - k];
    if (wnum[5 - keep] === pnum[5 - keep]) wnum[5 - keep] = String((+pnum[5 - keep] + 1) % 10);
    if (!last) draws.pension[pr] = { round: pr, date: day(thu), group: 1 + Math.floor(rnd() * 5), number: wnum.join(""), bonus: String(Math.floor(rnd() * 1e6)).padStart(6, "0") };
    for (let g = 1; g <= 5; g++) ledger.push({ key: `p${i}${g}`, date: day(d), game: "연금복권720+", code: "LP72", round: pr, qty: 1, result: last ? "미추첨" : pw ? "당첨" : "낙첨", rank: pw === 1000 ? 7 : pw ? 6 : null, prize: pw, draw_date: "", info: `${g}:${pnum}` });
    if (i < 10) {
      purchases.push({ game: "lotto645", round: lr, bought_at: iso(d, 9, 19), tickets: games.map((g) => ({ ...g, mode: "수동" })), result: last ? null : games.map((g) => (lottoRankOf(g.numbers, draws.lotto[lr]) || "낙첨")) });
      purchases.push({ game: "pension720", round: pr, bought_at: iso(d, 9, 20), tickets: [1, 2, 3, 4, 5].map((g) => ({ group: g, number: pnum })), result: last ? null : Array(5).fill(pw === 1000 ? "7등 (1천원)" : pw ? "6등 (5천원)" : "낙첨") });
    }
    bal = bal - 10000 + lottoWin + pw * 5;
    if (bal < 0) bal += 20000;
    balances.push({ at: iso(d, 9, 21), balance: bal });
  }
  const prev = new Date(monday); prev.setDate(prev.getDate() - 7);
  notifications.push(
    { at: iso(prev, 9, 21), title: "복권 구매 완료", message: `로또 ${lottoNow - 1}회\n  A:  3 11 19 28 34 42\n연금복권 ${pensionNow - 1}회: 482910 (5매)\n남은 예치금 3,000원`, priority: 3, tags: [], buttons: [] },
    { at: iso(monday, 7, 19), title: "지난 복권 결과", message: `로또 ${lottoNow - 1}회 (4 15 22 30 38 44 + 7)\n  A 3 11 19 28 34 42 → 낙첨\n연금복권 ${pensionNow - 1}회 (3조 482915)\n  1조 482910 → 낙첨`, priority: 3, tags: [], buttons: [] },
    { at: iso(monday, 7, 20), title: "예치금 충전 요청", message: "예치금 3,000원 / 이번 주 필요 10,000원\n→ 10,000원 충전해주세요 (부족 7,000원, 최소 충전 단위라 3,000원은 다음 주로 이월)", priority: 4, tags: [], buttons: [["충전하기", "https://www.dhlottery.co.kr/mypage/mndpChrg"]] },
  );
  const logText = [
    `${iso(monday, 7, 19).replace("T", " ")}:02 [INFO] ===== 주간 구매 시작 (실제 구매) =====`,
    `${iso(monday, 7, 19).replace("T", " ")}:11 [INFO] 로그인 성공`,
    `${iso(monday, 7, 19).replace("T", " ")}:14 [INFO] 계정 구매내역 동기화: 최근 2달`,
    `${iso(monday, 7, 19).replace("T", " ")}:16 [INFO] 예치금 3,000원 / 이번 구매 필요 10,000원`,
    `${iso(monday, 7, 20).replace("T", " ")}:01 [WARNING] 예치금 부족: 예치금 3,000원 / 이번 주 필요 10,000원 → 10,000원 충전해주세요`,
    `${iso(monday, 7, 20).replace("T", " ")}:02 [INFO] 알림: 예치금 충전 요청 | 예치금 3,000원 / 이번 주 필요 10,000원`,
  ].join("\n");
  const nextTry = new Date(monday); nextTry.setHours(9, 17, 0, 0);
  return {
    app: {
      generated_at: iso(monday, 7, 20),
      status: {
        week: lottoNow, kind: "charge", headline: "예치금 충전 대기", checked_at: iso(monday, 7, 20),
        details: ["예치금 3,000원 / 이번 주 필요 10,000원 → 10,000원 충전", `충전하면 다음 자동 시도(${fmtWhen(nextTry)})에 구매합니다. 금요일 21:17 까지 재시도.`],
        next_try_text: fmtWhen(nextTry), shortfall: { balance: 3000, need: 10000, amount: 10000 }, bought: [],
        charge_url: "https://www.dhlottery.co.kr/mypage/mndpChrg",
      },
      balance: { at: iso(monday, 7, 20), balance: 3000 },
    },
    ledger, purchases, balances, notifications, draws,
    logFiles: [`${monday.getFullYear()}-${pad(monday.getMonth() + 1)}.log`], logText,
    runs: [
      { run_number: 48, event: "schedule", status: "completed", conclusion: "success", created_at: iso(monday, 7, 17), html_url: "" },
      { run_number: 47, event: "schedule", status: "completed", conclusion: "success", created_at: iso(prev, 9, 17), html_url: "" },
      { run_number: 46, event: "schedule", status: "completed", conclusion: "success", created_at: iso(prev, 7, 17), html_url: "" },
    ],
  };
}

/* ───────────── 시작 ───────────── */
function boot() {
  applyTheme();
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));
  $("#btn-refresh").addEventListener("click", () => { S.logs.text = ""; loadAll(); });
  $("#btn-settings").addEventListener("click", openSettings);
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.tab === "stats") render(); }, 200); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.data && MODE === "live" && Date.now() - (S.loadedAt || 0) > 5 * 60000) loadAll();
  });
  const saved = store.get().tab;
  if (["home", "alerts", "history", "stats", "logs"].includes(saved)) S.tab = saved;
  if (MODE === "demo") $("#demo-bar").hidden = false;

  if (MODE !== "live") { showApp(); loadAll(); return; }
  const cfg = store.get();
  if (cfg.repo && cfg.sealed) showPin();
  else if (cfg.repo && cfg.token) { source.repo = cfg.repo; source.token = cfg.token; showApp(); loadAll(); }
  else showSetup();
}

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
boot();
