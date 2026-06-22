// ============================================================
// NoaPro Caller — application logic
// Static front end talking directly to Supabase (Postgres + Auth
// + Realtime + Storage). No backend server required.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
import XLSXStyle from "https://esm.sh/xlsx-js-style@1.2.0";
import { SUPABASE_URL, SUPABASE_ANON_KEY, DAILY_CALL_TARGET, DAILY_SIGNUP_TARGET,
         WORKING_DAYS_PER_WEEK, WORKING_DAYS_PER_MONTH } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// statuses that still need calling (shown in the queue)
const CALLABLE = ["New", "No answer", "Voicemail left", "Callback"];
const OUTCOMES = [
  { label: "No answer",      cls: "" },
  { label: "Voicemail left", cls: "" },
  { label: "Callback",       cls: "" },
  { label: "Not interested", cls: "bad" },
  { label: "Wrong number",   cls: "" },
  { label: "Do not call",    cls: "bad" },
  { label: "Signed up",      cls: "win" },
];

let me = null;            // my profile
let profiles = {};        // id -> profile
let active = null;        // lead I've claimed
let online = new Set();   // user ids currently online
let timerInt = null, timerSec = 0;
let targetPeriod = "day"; // day | week | month (targets panel)
let settings = { daily_call_target: DAILY_CALL_TARGET, daily_signup_target: DAILY_SIGNUP_TARGET }; // live, admin-editable

const $  = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const stClass = (s) => "st " + String(s).replace(/[^a-z]/gi, "");
const initials = (p) => p?.initials || "??";
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const ICON_PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

// ---------------- AUTH ----------------
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#loginErr").textContent = "";
  $("#loginBtn").disabled = true;
  const { error } = await sb.auth.signInWithPassword({
    email: $("#email").value.trim(),
    password: $("#password").value,
  });
  $("#loginBtn").disabled = false;
  if (error) { $("#loginErr").textContent = error.message; return; }
  boot();
});

$("#magicBtn").addEventListener("click", async () => {
  const email = $("#email").value.trim();
  const note = $("#magicNote");
  note.className = "magic-note";
  if (!email) { $("#loginErr").textContent = "Enter your email first."; return; }
  $("#magicBtn").disabled = true;
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href.split("#")[0] },
  });
  $("#magicBtn").disabled = false;
  if (error) { $("#loginErr").textContent = error.message; return; }
  $("#loginErr").textContent = "";
  note.classList.add("ok");
  note.textContent = "Check your email — click the link to sign in.";
});

$("#signout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

// ---- change-your-own-password (no email needed) ----
const pwModal = () => $("#pwModal");
$("#changePw") && $("#changePw").addEventListener("click", () => {
  $("#pwNew").value = ""; $("#pwNew2").value = ""; $("#pwMsg").textContent = "";
  pwModal().classList.remove("hidden");
  $("#pwNew").focus();
});
$("#pwClose") && $("#pwClose").addEventListener("click", () => pwModal().classList.add("hidden"));
$("#pwModal") && $("#pwModal").addEventListener("click", (e) => { if (e.target.id === "pwModal") pwModal().classList.add("hidden"); });
$("#pwSave") && $("#pwSave").addEventListener("click", async () => {
  const a = $("#pwNew").value, b = $("#pwNew2").value, msg = $("#pwMsg");
  if (a.length < 6) { msg.style.color = "#dc2626"; msg.textContent = "Password must be at least 6 characters."; return; }
  if (a !== b)     { msg.style.color = "#dc2626"; msg.textContent = "Passwords don't match."; return; }
  msg.style.color = "var(--muted)"; msg.textContent = "Saving…";
  const { error } = await sb.auth.updateUser({ password: a });
  if (error) { msg.style.color = "#dc2626"; msg.textContent = error.message; return; }
  msg.style.color = "#16a34a"; msg.textContent = "Password updated ✓";
  setTimeout(() => pwModal().classList.add("hidden"), 1200);
});

// ---------------- BOOT ----------------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { $("#loginView").classList.remove("hidden"); $("#appView").classList.add("hidden"); return; }

  $("#loginView").classList.add("hidden");
  $("#appView").classList.remove("hidden");

  await loadProfiles();
  // if an admin has removed this caller's profile, block access
  if (Object.keys(profiles).length && !profiles[session.user.id]) {
    await sb.auth.signOut();
    alert("Your access to NoaPro Caller has been removed by an admin.");
    location.reload();
    return;
  }
  me = profiles[session.user.id] || { id: session.user.id, full_name: "You", initials: "ME", color: "#0d7d6b" };

  // record this sign-in / activity, and reveal the Admin tab for admins
  sb.from("profiles").update({ last_seen: new Date().toISOString() }).eq("id", me.id).then(() => {});
  if (me.is_admin && $("#navAdmin")) $("#navAdmin").style.display = "";

  await loadSettings();
  // admins get the inline target editor in the Targets panel
  if (me.is_admin && $("#tgEdit")) {
    $("#tgEdit").style.display = "flex";
    $("#tgCall").value = settings.daily_call_target;
    $("#tgSign").value = settings.daily_signup_target;
  }

  await loadActive();
  await loadQueue();
  await loadDashboard();
  await loadFiles();

  subscribeRealtime();
  subscribePresence(session.user.id);
}

async function loadProfiles() {
  const { data } = await sb.from("profiles").select("*");
  profiles = {};
  (data || []).forEach(p => { profiles[p.id] = p; });
  renderTeam();
}

function renderTeam() {
  $("#teamList").innerHTML = Object.values(profiles).map(p => `
    <div class="member">
      <span class="ava" style="background:${esc(p.color)}">${esc(initials(p))}
        <span class="dot ${online.has(p.id) ? "on" : ""}"></span>
      </span>
      ${esc(p.full_name)}
    </div>`).join("") || `<div class="empty" style="padding:8px">No profiles yet.</div>`;
}

// ---------------- QUEUE ----------------
const RENDER_CAP = 150;   // max lead rows drawn at once (keeps the page snappy)

// Region split — the two imported batches came from different sheets:
//   Leeds = "Construction Outreach" sheet, Kent = "LEADS" sheet.
let region = "";  // "", "leeds", "kent"
function regionClause(q) {
  // region column: 'leeds' | 'kent' | 'both' | null. "both" shows under either filter.
  if (region === "leeds") return q.in("region", ["leeds", "both"]);
  if (region === "kent")  return q.in("region", ["kent", "both"]);
  return q;
}

// Region is derived from the postcode: starts with "LS" = Leeds, everything else = Kent.
function regionFor(area) { return (area || "").trim().toLowerCase().startsWith("ls") ? "leeds" : "kent"; }

// Apply the active filters (area, category, search, region) to a Supabase query —
// runs server-side so filters reach ALL leads, not just the ones on screen.
// Status is applied by the caller so the queue can prioritise certain statuses.
function queueFilter(q) {
  q = regionClause(q);
  const area = (($("#fArea") || {}).value || "").trim();
  const cat  = (($("#fCat")  || {}).value || "").trim();
  const term = (($("#search")|| {}).value || "").trim().replace(/[,()%*]/g, " ").trim();
  if (area) q = q.ilike("area", `%${area}%`);
  if (cat)  q = q.ilike("category", `%${cat}%`);
  if (term) q = q.or(`business.ilike.%${term}%,phone.ilike.%${term}%`);
  return q;
}

// Callbacks + voicemails get chased first, so they sit at the very top of the queue.
const QUEUE_PRIORITY = ["Callback", "Voicemail left"];
const QUEUE_REGULAR  = ["New", "No answer", "Calling"];

// Restore my in-progress call from the DB (e.g. after a refresh mid-call).
async function loadActive() {
  const { data } = await sb.from("leads").select("*").eq("claimed_by", me.id).eq("status", "Calling").limit(1);
  active = (data && data[0]) || null;
}

function leadRow(l) {
  const overdue = l.callback_at && new Date(l.callback_at) <= new Date();
  const right = l.claimed_by
    ? `<span class="locked">🔒 ${esc(initials(profiles[l.claimed_by]))} calling</span>`
    : `<span class="${stClass(l.status)}">${esc(l.status)}</span><button class="claim" data-id="${l.id}">Claim</button><button class="del" data-del="${l.id}" title="Delete lead">${ICON_TRASH}</button>`;
  return `<div class="lead">
      <div>
        <div class="nm">${esc(l.business)}</div>
        <div class="meta">${esc(l.category || "")}${l.area ? " · " + esc(l.area) : ""}${overdue ? ' · <b style="color:var(--amber)">callback due</b>' : ""}</div>
      </div>
      <div class="right">${right}</div>
    </div>`;
}

async function loadQueue() {
  const { count } = await queueFilter(sb.from("leads").select("*", { count: "exact", head: true }))
    .in("status", [...CALLABLE, "Calling"]);

  // 1) Priority: callbacks & voicemails to chase — soonest callback first, then most recently actioned.
  const { data: prio, error: e1 } = await queueFilter(sb.from("leads").select("*"))
    .in("status", QUEUE_PRIORITY)
    .order("callback_at", { ascending: true, nullsFirst: false })
    .order("last_called_at", { ascending: false, nullsFirst: false })
    .limit(RENDER_CAP);
  if (e1) { toast(e1.message); return; }

  // 2) Everything else (new / no-answer / in-progress), oldest first.
  let rest = [];
  const need = RENDER_CAP - (prio ? prio.length : 0);
  if (need > 0) {
    const { data: r, error: e2 } = await queueFilter(sb.from("leads").select("*"))
      .in("status", QUEUE_REGULAR)
      .order("created_at", { ascending: true })
      .limit(need);
    if (e2) { toast(e2.message); return; }
    rest = r || [];
  }
  const data = [...(prio || []), ...rest];

  const list = (data || []).filter(l => !(l.status === "Calling" && l.claimed_by === me.id));
  const total = count || 0;
  $("#queueCount").textContent = total;

  let html = list.length
    ? list.map(leadRow).join("")
    : `<div class="empty">No leads match these filters. Clear them, or import a list.</div>`;
  if (total > list.length)
    html += `<div class="empty">Showing ${list.length} of ${total}. Work through these — or use the Area / Category filters to narrow down.</div>`;
  $("#queueList").innerHTML = html;

  $$("#queueList .claim").forEach(b => b.addEventListener("click", () => claim(b.dataset.id)));
  $$("#queueList .del").forEach(b => b.addEventListener("click", () => deleteLead(b.dataset.del)));
  renderCall();
}

async function claim(id) {
  if (active) { toast("Finish your current call first."); return; }
  // atomic: only succeeds if still unclaimed
  const { data, error } = await sb.from("leads")
    .update({ claimed_by: me.id, claimed_at: new Date().toISOString(), status: "Calling" })
    .eq("id", id).is("claimed_by", null)
    .select();
  if (error) { toast(error.message); return; }
  if (!data || !data.length) { toast("That lead was just taken by someone else."); loadQueue(); return; }
  active = data[0];
  startTimer();
  renderCall();
  loadQueue();
}

function renderCall() {
  const c = $("#callCard");
  if (!active) {
    $("#callHeader").innerHTML = "Your active call";
    c.innerHTML = `<div class="noactive">No lead claimed. Pick one from the queue to start calling.</div>`;
    return;
  }
  $("#callHeader").innerHTML = `Your active call <span class="pill" style="margin-left:auto;color:var(--amber);background:var(--amber-bg)"><span class="blink" style="background:var(--amber)"></span> claimed by you</span>`;
  c.innerHTML = `
    <div class="call">
      <div class="biz">${esc(active.business)}</div>
      <div class="cat">${esc(active.category || "")}${active.area ? " · " + esc(active.area) : ""}</div>
      ${active.email ? `<div class="cat">✉ <a href="mailto:${esc(active.email)}">${esc(active.email)}</a></div>` : ""}
      <div class="phone"><span class="phicon">${ICON_PHONE}</span><span class="num">${esc(active.phone || "—")}</span><span class="timer" id="timer">00:00</span></div>
      ${active.notes ? `<div class="scriptbox"><b>Previous notes:</b> ${esc(active.notes)}</div>` : ""}
      <label class="fl">Call notes</label>
      <textarea id="callNote" placeholder="Spoke to owner, interested but wants to think about it…">${esc(active.notes || "")}</textarea>
      <label class="fl">Outcome</label>
      <div class="outcomes" id="ocBtns">
        ${OUTCOMES.map(o => `<button class="oc ${o.cls}" data-o="${esc(o.label)}">${o.label === "Signed up" ? "✓ " : ""}${o.label}</button>`).join("")}
      </div>
      <div class="cb-row" id="cbRow">
        <input type="datetime-local" class="dt" id="cbTime">
        <button class="btn pri" id="cbSave">Save callback</button>
        <span>shows under Callbacks for the whole team</span>
      </div>
      <div class="savebar">
        <button class="btn ghost" id="releaseBtn">Release lead</button>
        <button class="btn ghost" id="delLeadBtn" style="color:var(--red);border-color:var(--red)">Delete lead</button>
      </div>
    </div>`;
  // wire outcome buttons
  $$("#ocBtns .oc").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.o === "Callback") { $("#cbRow").classList.add("show"); $("#cbTime").focus(); }
    else logOutcome(b.dataset.o);
  }));
  $("#cbSave").addEventListener("click", () => logOutcome("Callback"));
  $("#releaseBtn").addEventListener("click", releaseLead);
  $("#delLeadBtn").addEventListener("click", () => deleteLead(active && active.id));
  restoreTimerDisplay();
}

async function logOutcome(outcome) {
  if (!active) return;
  const note = ($("#callNote")?.value || "").trim();
  const cb = outcome === "Callback" ? ($("#cbTime")?.value || null) : null;
  if (outcome === "Callback" && !cb) { toast("Pick a callback time."); return; }

  const { error: e1 } = await sb.from("call_log").insert({
    lead_id: active.id, caller_id: me.id, outcome, note,
  });
  if (e1) { toast(e1.message); return; }

  const { error: e2 } = await sb.from("leads").update({
    status: outcome,
    claimed_by: null, claimed_at: null,
    last_called_at: new Date().toISOString(),
    callback_at: cb ? new Date(cb).toISOString() : null,
    notes: note || active.notes || null,
  }).eq("id", active.id);
  if (e2) { toast(e2.message); return; }

  toast(`Logged: ${outcome}`);
  active = null; stopTimer();
  await loadQueue(); await loadDashboard();
}

async function releaseLead() {
  if (!active) return;
  const id = active.id;
  const { error } = await sb.from("leads").update({ claimed_by: null, claimed_at: null, status: "New" }).eq("id", id);
  if (error) { toast(error.message); return; }
  active = null; stopTimer();
  toast("Lead released — back in the queue as New.");
  loadQueue();
  if ($("#all").classList.contains("show")) loadAllLeads();
}

async function deleteLead(id) {
  if (!id) return;
  if (!confirm("Delete this lead permanently? This also removes its call history.")) return;
  const { error } = await sb.from("leads").delete().eq("id", id);
  if (error) { toast(error.message); return; }
  if (active && active.id === id) { active = null; stopTimer(); }
  toast("Lead deleted.");
  loadQueue();
}

// ---- timer ----
function startTimer() { timerSec = 0; clearInterval(timerInt); timerInt = setInterval(tick, 1000); }
function restoreTimerDisplay() { if (active && !timerInt) { timerInt = setInterval(tick, 1000); } tick(); }
function stopTimer() { clearInterval(timerInt); timerInt = null; timerSec = 0; }
function tick() {
  timerSec++;
  const el = $("#timer"); if (!el) return;
  el.textContent = `${String(Math.floor(timerSec / 60)).padStart(2,"0")}:${String(timerSec % 60).padStart(2,"0")}`;
}

// ---------------- DASHBOARD ----------------
async function loadDashboard() {
  const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
  const iso = startOfDay.toISOString();

  const { data: todays } = await sb.from("call_log").select("outcome,caller_id").gte("created_at", iso);
  const calls = todays || [];
  const signups = calls.filter(c => c.outcome === "Signed up").length;

  const { count: callbacksTotal } = await sb.from("leads").select("*", { count: "exact", head: true })
    .eq("status", "Callback");
  const { count: callbacksDue } = await sb.from("leads").select("*", { count: "exact", head: true })
    .eq("status", "Callback").lte("callback_at", new Date().toISOString());
  const { count: remaining } = await sb.from("leads").select("*", { count: "exact", head: true })
    .in("status", CALLABLE).is("claimed_by", null);

  const conv = calls.length ? Math.round((signups / calls.length) * 1000) / 10 : 0;
  $("#statCards").innerHTML = `
    ${card("Calls today", calls.length, "", "", "calls-today")}
    ${card("Sign-ups today", signups, conv + "% conversion", "", "signups-today")}
    ${card("Callbacks", callbacksTotal ?? 0, (callbacksDue ?? 0) > 0 ? `${callbacksDue} due now` : ((callbacksTotal ?? 0) > 0 ? "all upcoming" : ""), "var(--amber)", "callbacks-due")}
    ${card("Leads remaining", remaining ?? 0, "", "var(--muted)", "leads-remaining")}`;

  // leaderboard (sign-ups by caller)
  const byCaller = {};
  calls.filter(c => c.outcome === "Signed up" && !(profiles[c.caller_id] && profiles[c.caller_id].is_admin)).forEach(c => byCaller[c.caller_id] = (byCaller[c.caller_id]||0)+1);
  const lbRows = Object.entries(byCaller).sort((a,b)=>b[1]-a[1]);
  const max = Math.max(1, ...lbRows.map(r=>r[1]));
  $("#leaderboard").innerHTML = lbRows.length ? lbRows.map(([id,n]) =>
    `<div class="lb"><span class="n">${esc(profiles[id]?.full_name || "?")}</span><span class="bar"><i style="width:${n/max*100}%"></i></span><span class="v">${n}</span></div>`
  ).join("") : `<div class="empty">No sign-ups yet today.</div>`;

  // outcome breakdown
  const byOut = {};
  calls.forEach(c => byOut[c.outcome] = (byOut[c.outcome]||0)+1);
  const outRows = Object.entries(byOut).sort((a,b)=>b[1]-a[1]);
  const omax = Math.max(1, ...outRows.map(r=>r[1]));
  $("#outcomes").innerHTML = outRows.length ? outRows.map(([o,n]) =>
    `<div class="lb"><span class="n">${esc(o)}</span><span class="bar"><i style="width:${n/omax*100}%"></i></span><span class="v">${n}</span></div>`
  ).join("") : `<div class="empty">No calls logged yet today.</div>`;

  // targets panel (day / week / month) is rendered separately
  await renderTargets();
}

// ---- live team targets (admin-editable, shared via app_settings) ----
async function loadSettings() {
  const { data } = await sb.from("app_settings").select("daily_call_target,daily_signup_target").eq("id", 1).maybeSingle();
  if (data) settings = {
    daily_call_target:   data.daily_call_target   ?? settings.daily_call_target,
    daily_signup_target: data.daily_signup_target ?? settings.daily_signup_target,
  };
}

// admin clicks Save on the target editor
$("#tgSave") && $("#tgSave").addEventListener("click", async () => {
  const call = Math.max(1, parseInt($("#tgCall").value, 10) || settings.daily_call_target);
  const sign = Math.max(0, parseInt($("#tgSign").value, 10) || 0);
  const { error } = await sb.from("app_settings")
    .update({ daily_call_target: call, daily_signup_target: sign, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) { toast(error.message); return; }
  settings = { daily_call_target: call, daily_signup_target: sign };
  $("#tgCall").value = call; $("#tgSign").value = sign;
  $("#tgSaved").textContent = "Saved ✓";
  setTimeout(() => { if ($("#tgSaved")) $("#tgSaved").textContent = ""; }, 2000);
  renderTargets();
});

// ---- targets, per caller, for the selected period ----
async function renderTargets() {
  const now = new Date();
  let start, mult, label;
  if (targetPeriod === "week") {
    start = new Date(now);
    const dow = (start.getDay() + 6) % 7;        // Monday = 0
    start.setDate(start.getDate() - dow); start.setHours(0,0,0,0);
    mult = WORKING_DAYS_PER_WEEK; label = "this week";
  } else if (targetPeriod === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    mult = WORKING_DAYS_PER_MONTH; label = "this month";
  } else {
    start = new Date(now); start.setHours(0,0,0,0);
    mult = 1; label = "today";
  }

  const { data } = await sb.from("call_log").select("outcome,caller_id").gte("created_at", start.toISOString());
  const rows = data || [];
  const callsBy = {}, signBy = {};
  rows.forEach(c => {
    callsBy[c.caller_id] = (callsBy[c.caller_id] || 0) + 1;
    if (c.outcome === "Signed up") signBy[c.caller_id] = (signBy[c.caller_id] || 0) + 1;
  });

  const callTgt = settings.daily_call_target * mult, signTgt = settings.daily_signup_target * mult;
  const callers = Object.values(profiles).filter(p => !p.is_admin);   // owners/admins aren't tracked
  const teamCalls = rows.filter(c => !(profiles[c.caller_id] && profiles[c.caller_id].is_admin)).length;
  $("#targetPill").textContent = `team ${teamCalls}/${callers.length * callTgt} calls ${label}`;
  const bar = (n, t) => { const pct = Math.min(100, Math.round(n / t * 100)); const hit = n >= t ? "hit" : ""; return `<span class="bar"><i class="${hit}" style="width:${pct}%"></i></span><span class="num">${n}/${t}${n>=t?" ✓":""}</span>`; };
  $("#targets").innerHTML = callers.length ? callers.map(p => {
    const c = callsBy[p.id] || 0, s = signBy[p.id] || 0;
    return `<div class="tg ${p.id===me.id?"mine":""}">
      <span class="who"><span class="ava" style="background:${esc(p.color)};width:24px;height:24px;font-size:10px">${esc(initials(p))}</span>${esc(p.full_name)}</span>
      <span class="grp"><span class="lbl">Calls</span>${bar(c, callTgt)}</span>
      <span class="grp"><span class="lbl">Sign-ups</span>${bar(s, signTgt)}</span>
    </div>`;
  }).join("") : `<div class="empty">No callers yet.</div>`;
}

// ---------------- BRANDED XLSX EXPORT ----------------
// Writes a proper Excel file (no "possible data loss" warning) styled in
// NoaPro branding: blue title banner, blue header row, zebra striping.
const X_BRAND = "FF1190EF", X_BRANDDK = "FF0B66A8", X_ZEBRA = "FFF1F7FE";
function xThin() { const s = { style: "thin", color: { rgb: "FFE5E7EB" } }; return { top: s, bottom: s, left: s, right: s }; }
function exportXlsx({ filename, sheet, subtitle, columns, rows }) {
  const U = XLSXStyle.utils, ncol = columns.length;
  const aoa = [];
  aoa.push(["NoaPro"]);                                                    // r0 banner
  aoa.push([subtitle]);                                                    // r1 subtitle
  aoa.push([`Generated ${new Date().toLocaleString("en-GB")}  •  noapro.co.uk`]); // r2
  aoa.push([]);                                                            // r3 spacer
  aoa.push(columns.map(c => c.label));                                     // r4 header
  rows.forEach(r => aoa.push(columns.map(c => (r[c.key] == null ? "" : r[c.key]))));
  const ws = U.aoa_to_sheet(aoa);
  ws["!merges"] = [0, 1, 2].map(r => ({ s: { r, c: 0 }, e: { r, c: ncol - 1 } }));
  ws["!cols"] = columns.map(c => ({ wch: c.width || 16 }));
  ws["!rows"] = [{ hpt: 34 }, { hpt: 20 }, { hpt: 16 }, { hpt: 6 }, { hpt: 22 }];
  const cell = (r, c) => { const ref = U.encode_cell({ r, c }); return (ws[ref] = ws[ref] || { t: "s", v: "" }); };
  cell(0, 0).s = { font: { bold: true, sz: 20, color: { rgb: "FFFFFFFF" } }, fill: { fgColor: { rgb: X_BRAND } }, alignment: { vertical: "center", horizontal: "left", indent: 1 } };
  cell(1, 0).s = { font: { bold: true, sz: 12, color: { rgb: "FFFFFFFF" } }, fill: { fgColor: { rgb: X_BRANDDK } }, alignment: { vertical: "center", horizontal: "left", indent: 1 } };
  cell(2, 0).s = { font: { sz: 10, color: { rgb: "FF6B7280" } }, alignment: { horizontal: "left", indent: 1 } };
  for (let c = 0; c < ncol; c++)
    cell(4, c).s = { font: { bold: true, sz: 11, color: { rgb: "FFFFFFFF" } }, fill: { fgColor: { rgb: X_BRAND } }, alignment: { horizontal: "left", vertical: "center" }, border: xThin() };
  for (let r = 5; r < aoa.length; r++)
    for (let c = 0; c < ncol; c++)
      cell(r, c).s = { font: { sz: 10, color: { rgb: "FF1F2937" } }, alignment: { horizontal: "left", vertical: "center" }, border: xThin(), ...((r % 2) ? { fill: { fgColor: { rgb: X_ZEBRA } } } : {}) };
  const wb = U.book_new();
  U.book_append_sheet(wb, ws, sheet);
  XLSXStyle.writeFile(wb, filename);
}

// ---------------- EXPORT RESULTS ----------------
$("#exportBtn").addEventListener("click", async () => {
  const { data, error } = await sb.from("leads")
    .select("business,phone,email,category,area,status,last_called_at,callback_at,notes")
    .order("status", { ascending: true });
  if (error) { toast(error.message); return; }
  const fmt = (v) => v ? new Date(v).toLocaleString("en-GB") : "";
  const rows = (data || []).map(r => ({ ...r, last_called_at: fmt(r.last_called_at), callback_at: fmt(r.callback_at) }));
  exportXlsx({
    filename: `noapro-results-${new Date().toISOString().slice(0,10)}.xlsx`,
    sheet: "Results",
    subtitle: "Lead Results Export",
    columns: [
      { key: "business", label: "Business", width: 32 },
      { key: "phone", label: "Phone", width: 16 },
      { key: "email", label: "Email", width: 30 },
      { key: "category", label: "Category", width: 20 },
      { key: "area", label: "Area", width: 14 },
      { key: "status", label: "Status", width: 16 },
      { key: "last_called_at", label: "Last called", width: 20 },
      { key: "callback_at", label: "Callback", width: 20 },
      { key: "notes", label: "Notes", width: 44 },
    ],
    rows,
  });
  toast(`Exported ${(data||[]).length} leads.`);
});

// ---------------- EXPORT CALL LOG ----------------
// Every dial: when, who, which business, outcome, note.
$("#exportLogBtn").addEventListener("click", async () => {
  const { data, error } = await sb.from("call_log")
    .select("created_at,outcome,note,caller_id,leads(business,phone,area)")
    .order("created_at", { ascending: false });
  if (error) { toast(error.message); return; }
  const rows = (data || []).map(r => ({
    timestamp: new Date(r.created_at).toLocaleString("en-GB"),
    caller: profiles[r.caller_id]?.full_name || "",
    business: r.leads?.business || "",
    phone: r.leads?.phone || "",
    area: r.leads?.area || "",
    outcome: r.outcome,
    note: r.note || "",
  }));
  exportXlsx({
    filename: `noapro-call-log-${new Date().toISOString().slice(0,10)}.xlsx`,
    sheet: "Call Log",
    subtitle: "Call Log Export",
    columns: [
      { key: "timestamp", label: "Timestamp", width: 22 },
      { key: "caller", label: "Caller", width: 20 },
      { key: "business", label: "Business", width: 32 },
      { key: "phone", label: "Phone", width: 16 },
      { key: "area", label: "Area", width: 14 },
      { key: "outcome", label: "Outcome", width: 18 },
      { key: "note", label: "Note", width: 44 },
    ],
    rows,
  });
  toast(`Exported ${(data||[]).length} call-log rows.`);
});

// ---------------- TARGETS PERIOD TOGGLE ----------------
$("#tgSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  targetPeriod = b.dataset.period;
  [...$("#tgSeg").children].forEach(x => x.classList.toggle("active", x === b));
  renderTargets();
});
function card(k, v, d, color, action) {
  return `<div class="stat${action ? " clickable" : ""}"${action ? ` data-action="${action}"` : ""}><div class="k">${esc(k)}${action ? ' <span class="go"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>' : ""}</div><div class="v">${esc(v)}</div>${d?`<div class="d" style="color:${color||"var(--ok)"}">${esc(d)}</div>`:""}</div>`;
}

function goTab(p) { const b = document.querySelector(`#nav button[data-p="${p}"]`); if (b) b.click(); }

// Drill-down: list of today's calls (or just sign-ups), each row opens that lead.
async function openCallsModal(signedOnly) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  let q = sb.from("call_log").select("created_at,outcome,note,caller_id,lead_id,leads(business)")
    .gte("created_at", start.toISOString()).order("created_at", { ascending: false });
  if (signedOnly) q = q.eq("outcome", "Signed up");
  const { data, error } = await q;
  if (error) { toast(error.message); return; }
  const rows = data || [];
  $("#lmTitle").textContent = signedOnly ? `Sign-ups today (${rows.length})` : `Calls today (${rows.length})`;
  $("#lmBody").innerHTML = rows.length
    ? `<div class="hist" style="border-top:0;padding-top:0">` + rows.map(h =>
        `<div class="hevent" data-lead="${h.lead_id}" style="cursor:pointer"><div><div class="ho">${esc(h.leads?.business || "(lead)")}</div><div>${esc(h.outcome)}${h.note ? " · " + esc(h.note) : ""}</div></div><div class="ht" style="margin-left:auto">${esc(profiles[h.caller_id]?.full_name || "")} · ${new Date(h.created_at).toLocaleTimeString()}</div></div>`
      ).join("") + `</div>`
    : `<div class="empty">No calls logged today yet.</div>`;
  $("#leadModal").classList.remove("hidden");
  $$("#lmBody .hevent[data-lead]").forEach(el => el.addEventListener("click", () => { if (el.dataset.lead) openLeadDetail(el.dataset.lead); }));
}

// ---------------- FILES ----------------
// general shared docs live at the bucket root; imported lead files live under "imports/"
async function loadFiles()   { return loadFileList("",        "#fileList",   "No documents yet. Upload one to share with the team."); }
async function loadImports() { return loadFileList("imports/", "#importList", "No imported files yet — upload a spreadsheet above."); }

// ---- Duplicate leads (skipped on import, kept for review) ----
async function loadDuplicates() {
  if (!$("#dupBody")) return;
  const { data, count, error } = await sb.from("duplicate_leads")
    .select("*", { count: "exact" }).order("created_at", { ascending: false }).limit(300);
  if (error) {
    $("#dupBody").innerHTML = `<tr><td colspan="7" class="empty">Run <b>duplicate-leads.sql</b> in Supabase to switch this on, then reload.</td></tr>`;
    if ($("#dupCount")) $("#dupCount").textContent = "";
    return;
  }
  const rows = data || [];
  if ($("#dupCount")) $("#dupCount").textContent = rows.length ? `${count} skipped` : "";
  $("#dupBody").innerHTML = rows.length ? rows.map(d => `
    <tr data-dup="${d.id}">
      <td title="${esc(d.business)}">${esc(d.business)}</td>
      <td>${esc(d.phone || "")}</td>
      <td>${esc(d.area || "")}</td>
      <td>${esc(d.reason || "")}</td>
      <td title="${esc(d.source_file || "")}">${esc((d.source_file || "").slice(0, 38))}</td>
      <td>${new Date(d.created_at).toLocaleDateString()}</td>
      <td style="white-space:nowrap;text-align:right">
        <button class="btn ghost dupAdd" data-id="${d.id}">Add as new</button>
        <button class="btn ghost dupDismiss" data-id="${d.id}" style="color:var(--red);border-color:var(--red)">Dismiss</button>
      </td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty">No duplicates — re-imports that already exist will appear here for review.</td></tr>`;
  $$("#dupBody .dupAdd").forEach(b => b.addEventListener("click", () => addDuplicate(b.dataset.id)));
  $$("#dupBody .dupDismiss").forEach(b => b.addEventListener("click", () => dismissDuplicate(b.dataset.id)));
}

async function addDuplicate(id) {
  const { data } = await sb.from("duplicate_leads").select("*").eq("id", id).limit(1);
  const d = data && data[0]; if (!d) return;
  const { error } = await sb.from("leads").insert({
    business: d.business, phone: d.phone, email: d.email,
    category: d.category, area: d.area, status: "New", source_file: d.source_file,
    region: regionFor(d.area)
  });
  if (error) { toast(error.message); return; }
  await sb.from("duplicate_leads").delete().eq("id", id);
  toast("Added to the call queue."); loadDuplicates(); loadQueue();
}

async function dismissDuplicate(id) {
  const { error } = await sb.from("duplicate_leads").delete().eq("id", id);
  if (error) { toast(error.message); return; }
  loadDuplicates();
}

async function loadFileList(prefix, containerId, emptyMsg) {
  const { data, error } = await sb.storage.from("files").list(prefix || "", { sortBy: { column: "created_at", order: "desc" } });
  if (error) { $(containerId).innerHTML = `<div class="empty">${esc(error.message)}</div>`; return; }
  const files = (data || []).filter(f => f.id);   // folders have null id — skipped
  $(containerId).innerHTML = files.length ? files.map(f => {
    const ext = (f.name.split(".").pop() || "").toUpperCase().slice(0,4);
    const full = (prefix || "") + f.name;
    return `<div class="file" data-path="${esc(full)}"><span class="fic">${esc(ext)}</span><div><div class="nm">${esc(f.name)}</div><div class="mt">${new Date(f.created_at).toLocaleDateString()}</div></div><button class="fdel" data-fdel="${esc(full)}" title="Delete file">${ICON_TRASH}</button></div>`;
  }).join("") : `<div class="empty">${esc(emptyMsg)}</div>`;
  $$(`${containerId} .file`).forEach(el => el.addEventListener("click", () => downloadFile(el.dataset.path)));
  $$(`${containerId} .fdel`).forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); deleteFile(b.dataset.fdel); }));
}

async function deleteFile(path) {
  if (!confirm("Delete this file permanently?")) return;
  const { error } = await sb.storage.from("files").remove([path]);
  if (error) { toast(error.message); return; }
  toast("File deleted.");
  loadFiles(); loadImports();
}

// ---------------- ALL LEADS (full traceability) ----------------
let allSort = { col: "created_at", dir: "desc" };

function allFilter(q) {
  q = regionClause(q);
  const term = (($("#aSearch") || {}).value || "").trim().replace(/[,()%*]/g, " ").trim();
  const st   = (($("#aStatus") || {}).value || "");
  const area = (($("#aArea")   || {}).value || "").trim();
  const cat  = (($("#aCat")    || {}).value || "").trim();
  if (st)   q = q.eq("status", st);
  if (area) q = q.ilike("area", `%${area}%`);
  if (cat)  q = q.ilike("category", `%${cat}%`);
  if (term) q = q.or(`business.ilike.%${term}%,phone.ilike.%${term}%`);
  return q;
}

async function loadAllLeads() {
  const { count } = await allFilter(sb.from("leads").select("*", { count: "exact", head: true }));
  const { data, error } = await allFilter(sb.from("leads").select("*"))
    .order(allSort.col, { ascending: allSort.dir === "asc", nullsFirst: false })
    .limit(200);
  if (error) { toast(error.message); return; }
  const rows = data || [], total = count || 0;
  $("#allCount").textContent = total > rows.length ? `${rows.length} of ${total}` : `${total} leads`;
  $("#allBody").innerHTML = rows.length ? rows.map(l => `
    <tr data-id="${l.id}">
      <td title="${esc(l.business)}">${esc(l.business)}</td>
      <td>${esc(l.category || "")}</td>
      <td>${esc(l.area || "")}</td>
      <td>${esc(l.phone || "")}</td>
      <td>${l.email ? `<a href="mailto:${esc(l.email)}" onclick="event.stopPropagation()">${esc(l.email)}</a>` : ""}</td>
      <td><span class="${stClass(l.status)}">${esc(l.status)}</span></td>
      <td>${l.last_called_at ? new Date(l.last_called_at).toLocaleDateString() : "—"}</td>
      <td>${l.callback_at ? new Date(l.callback_at).toLocaleString() : "—"}</td>
    </tr>`).join("") : `<tr><td colspan="7" class="empty">No leads match these filters.</td></tr>`;
  $$("#all .ltable th").forEach(th => {
    th.classList.toggle("sorted", th.dataset.sort === allSort.col);
    th.classList.toggle("asc", th.dataset.sort === allSort.col && allSort.dir === "asc");
  });
  $$("#allBody tr[data-id]").forEach(tr => tr.addEventListener("click", () => openLeadDetail(tr.dataset.id)));
}

// ---------------- CONNECTED LEADS (contacted to date) ----------------
let connSort = { col: "last_contact", dir: "desc" };
let connCallerFilled = false;

function connFilter(q) {
  q = regionClause(q);
  const term    = (($("#cSearch")  || {}).value || "").trim().replace(/[,()%*]/g, " ").trim();
  const caller  = (($("#cCaller")  || {}).value || "");
  const outcome = (($("#cOutcome") || {}).value || "");
  const area    = (($("#cArea")    || {}).value || "").trim();
  if (caller)  q = q.eq("last_caller_id", caller);
  if (outcome) q = q.eq("last_outcome", outcome);
  if (area)    q = q.ilike("area", `%${area}%`);
  if (term)    q = q.or(`business.ilike.%${term}%,phone.ilike.%${term}%`);
  return q;
}

// caller dropdown is built from the team list (once)
function fillConnCaller() {
  if (connCallerFilled) return;
  const sel = $("#cCaller"); if (!sel) return;
  const opts = Object.values(profiles).filter(p => p.full_name)
    .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""))
    .map(p => `<option value="${p.id}">${esc(p.full_name)}</option>`).join("");
  sel.innerHTML = `<option value="">All callers</option>` + opts;
  connCallerFilled = true;
}

async function loadConnected() {
  fillConnCaller();
  const { count } = await connFilter(sb.from("contacted_leads").select("*", { count: "exact", head: true }));
  const { data, error } = await connFilter(sb.from("contacted_leads").select("*"))
    .order(connSort.col, { ascending: connSort.dir === "asc", nullsFirst: false })
    .limit(300);
  if (error) { toast(error.message); return; }
  const rows = data || [], total = count || 0;
  $("#connCount").textContent = total > rows.length ? `${rows.length} of ${total} contacted` : `${total} contacted`;
  $("#connBody").innerHTML = rows.length ? rows.map(l => `
    <tr data-id="${l.id}">
      <td title="${esc(l.business)}">${esc(l.business)}</td>
      <td>${esc(l.area || "")}</td>
      <td>${esc(l.phone || "")}</td>
      <td>${esc(profiles[l.last_caller_id]?.full_name || "—")}</td>
      <td><span class="${stClass(l.last_outcome)}">${esc(l.last_outcome || "")}</span></td>
      <td><span class="${stClass(l.status)}">${esc(l.status)}</span></td>
      <td>${l.attempts}</td>
      <td>${l.last_contact ? new Date(l.last_contact).toLocaleString() : "—"}</td>
    </tr>`).join("") : `<tr><td colspan="8" class="empty">No contacted leads match these filters.</td></tr>`;
  $$("#connected .ltable th").forEach(th => {
    th.classList.toggle("sorted", th.dataset.sort === connSort.col);
    th.classList.toggle("asc", th.dataset.sort === connSort.col && connSort.dir === "asc");
  });
  $$("#connBody tr[data-id]").forEach(tr => tr.addEventListener("click", () => openLeadDetail(tr.dataset.id)));
}

async function openLeadDetail(id) {
  const { data: la } = await sb.from("leads").select("*").eq("id", id).limit(1);
  const l = la && la[0]; if (!l) { toast("Lead not found."); return; }
  const { data: log } = await sb.from("call_log").select("*").eq("lead_id", id).order("created_at", { ascending: false });
  $("#lmTitle").textContent = l.business;
  $("#lmBody").innerHTML = `
    <div class="kv">
      <span class="k">Status</span><span><span class="${stClass(l.status)}">${esc(l.status)}</span></span>
      <span class="k">Phone</span><span>${esc(l.phone || "—")}</span>
      <span class="k">Email</span><span>${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : "—"}</span>
      <span class="k">Category</span><span>${esc(l.category || "—")}</span>
      <span class="k">Area</span><span>${esc(l.area || "—")}</span>
      <span class="k">Claimed by</span><span>${esc(l.claimed_by ? (profiles[l.claimed_by]?.full_name || "—") : "—")}</span>
      <span class="k">Last called</span><span>${l.last_called_at ? new Date(l.last_called_at).toLocaleString() : "—"}</span>
      <span class="k">Callback</span><span>${l.callback_at ? new Date(l.callback_at).toLocaleString() : "—"}</span>
      <span class="k">Source</span><span>${esc(l.source_file || "—")}</span>
    </div>
    <label class="fl">Change status</label>
    <div class="status-row">
      <select id="lmStatus">${["New","No answer","Voicemail left","Callback","Not interested","Wrong number","Do not call","Signed up"].map(s => `<option${s === l.status ? " selected" : ""}>${s}</option>`).join("")}</select>
      <button class="btn pri" id="lmStatusSave">Update status</button>
    </div>
    <label class="fl">Notes</label>
    <textarea id="lmNotes">${esc(l.notes || "")}</textarea>
    <div class="modal-actions">
      <button class="btn ghost" id="lmSave">Save notes</button>
      <button class="btn ghost" id="lmDelete" style="color:var(--red);border-color:var(--red)">Delete lead</button>
    </div>
    <div class="hist">
      <h4>Call history (${(log || []).length})</h4>
      ${(log && log.length) ? log.map(h => `<div class="hevent"><div><div class="ho">${esc(h.outcome)}</div>${h.note ? `<div>${esc(h.note)}</div>` : ""}</div><div class="ht" style="margin-left:auto">${esc(profiles[h.caller_id]?.full_name || "")} · ${new Date(h.created_at).toLocaleString()}</div></div>`).join("") : `<div class="empty">No calls logged yet.</div>`}
    </div>`;
  $("#leadModal").classList.remove("hidden");
  $("#lmSave").addEventListener("click", async () => {
    const { error } = await sb.from("leads").update({ notes: $("#lmNotes").value }).eq("id", id);
    if (error) { toast(error.message); return; } toast("Notes saved.");
  });
  $("#lmStatusSave").addEventListener("click", async () => {
    const ns = $("#lmStatus").value;
    const upd = { status: ns, claimed_by: null, claimed_at: null };
    if (ns !== "Callback") upd.callback_at = null;   // clear stale callback time
    const { error } = await sb.from("leads").update(upd).eq("id", id);
    if (error) { toast(error.message); return; }
    if (active && active.id === id) { active = null; stopTimer(); }
    toast("Status changed to " + ns);
    closeModal(); loadAllLeads(); loadQueue();
    if ($("#dash").classList.contains("show")) loadDashboard();
  });
  $("#lmDelete").addEventListener("click", async () => {
    if (!confirm("Delete this lead permanently? This also removes its call history.")) return;
    const { error } = await sb.from("leads").delete().eq("id", id);
    if (error) { toast(error.message); return; }
    if (active && active.id === id) { active = null; stopTimer(); }
    toast("Lead deleted."); closeModal(); loadAllLeads(); loadQueue();
  });
}
function closeModal() { $("#leadModal").classList.add("hidden"); $("#lmBody").innerHTML = ""; }

// ---------------- TEAM CHAT ----------------
async function loadMessages() {
  const { data, error } = await sb.from("messages").select("*").order("created_at", { ascending: true }).limit(300);
  if (error) {
    $("#chatLog").innerHTML = `<div class="empty">Chat isn't set up yet — run <b>messages-table.sql</b> in Supabase, then reload this page.</div>`;
    return;
  }
  $("#chatLog").innerHTML = (data && data.length) ? "" : `<div class="empty">No messages yet — say hello 👋</div>`;
  (data || []).forEach(appendMessage);
  scrollChat();
}
function appendMessage(m) {
  const log = $("#chatLog"); if (!log) return;
  const ph = log.querySelector(".empty"); if (ph) ph.remove();
  if (log.querySelector(`[data-mid="${m.id}"]`)) return;
  const div = document.createElement("div");
  div.className = "msg" + (m.author_id === me.id ? " mine" : "");
  div.dataset.mid = m.id;
  div.innerHTML = `<div class="who">${esc(profiles[m.author_id]?.full_name || "Someone")}</div><div class="bub">${esc(m.body)}</div><div class="ht">${new Date(m.created_at).toLocaleString()}${me.is_admin ? ' · <a href="#" class="msgdel">delete</a>' : ''}</div>`;
  log.appendChild(div);
  if (me.is_admin) { const d = div.querySelector(".msgdel"); if (d) d.addEventListener("click", (e) => { e.preventDefault(); deleteMessage(m.id, div); }); }
  scrollChat();
}

async function deleteMessage(id, el) {
  if (!confirm("Delete this message for everyone?")) return;
  const { error } = await sb.from("messages").delete().eq("id", id);
  if (error) { toast(error.message); return; }
  if (el) el.remove();
  toast("Message deleted.");
}
function scrollChat() { const l = $("#chatLog"); if (l) l.scrollTop = l.scrollHeight; }
async function sendMessage() {
  const inp = $("#chatInput"); const body = inp.value.trim(); if (!body) return;
  inp.value = "";
  const { error } = await sb.from("messages").insert({ author_id: me.id, body });
  if (error) { toast(error.message); inp.value = body; }
}

async function downloadFile(path) {
  const { data, error } = await sb.storage.from("files").createSignedUrl(path, 60);
  if (error) { toast(error.message); return; }
  window.open(data.signedUrl, "_blank");
}

$("#fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const { error } = await sb.storage.from("files").upload(file.name, file, { upsert: true });
  if (error) { toast(error.message); return; }
  toast("Uploaded " + file.name); loadFiles();
});

// ---------------- LEAD IMPORT (Excel .xlsx/.xls or CSV) ----------------
// Turns a table (array-of-rows) into lead objects. Finds the header row
// even if it's not first, and maps columns flexibly across naming styles.
function leadsFromTable(aoa, sourceFile) {
  const BSET = ["business","name","company","business name","trade name","company name"];
  let hi = -1, head = null;
  for (let i = 0; i < Math.min(aoa.length, 15); i++) {
    const r = (aoa[i] || []).map(c => String(c == null ? "" : c).trim().toLowerCase());
    if (r.some(h => BSET.includes(h))) { hi = i; head = r; break; }
  }
  if (hi < 0) return [];                       // not a lead sheet (e.g. a dashboard)
  const colsFor = names => head.map((h, idx) => names.includes(h) ? idx : -1).filter(i => i >= 0);
  const bCols = colsFor(BSET);
  const pCols = colsFor(["phone","telephone","tel","number","phone number","mobile","contact number","tel no","phone no"]);
  const cCols = colsFor(["category","trade","type","trade category","sector","industry"]);
  const aCols = colsFor(["area","town","location","city","region","postcode","post code","county"]);
  const eCols = colsFor(["email","e-mail","email address","contact email","emails"]);
  const pick = (r, cols) => { for (const c of cols) { const v = String(r[c] == null ? "" : r[c]).trim(); if (v) return v; } return null; };
  const out = [];
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const business = pick(r, bCols);
    if (!business) continue;
    out.push({ business, phone: pick(r, pCols), category: pick(r, cCols), area: pick(r, aCols), email: pick(r, eCols), status: "New", source_file: sourceFile });
  }
  return out;
}

async function importLeadFile(file) {
  let leads = [];
  const lname = file.name.toLowerCase();
  try {
    if (lname.endsWith(".csv")) {
      leads = leadsFromTable(parseCSV(await file.text()), file.name);
    } else {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      for (const sn of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, blankrows: false, defval: "" });
        leads = leads.concat(leadsFromTable(aoa, `${file.name} — ${sn}`));
      }
    }
  } catch (err) { toast("Couldn't read file: " + err.message); return; }

  const norm   = s => (s || "").trim().toLowerCase();
  const digits = s => (s || "").replace(/\D/g, "");

  // de-duplicate within this file (same business name OR same phone)
  const seenName = new Set(), seenPhone = new Set();
  leads = leads.filter(l => {
    const nk = norm(l.business), pk = digits(l.phone);
    if (seenName.has(nk) || (pk && seenPhone.has(pk))) return false;
    seenName.add(nk); if (pk) seenPhone.add(pk);
    return true;
  });
  if (!leads.length) { toast('No leads found — the file needs a "business" column.'); return; }

  // Build lookups of everything already in the list (by name and by phone)
  toast("Checking for duplicates…");
  const nameToId = new Map(), phoneToId = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("leads").select("id,business,phone").range(from, from + 999);
    if (error || !data || !data.length) break;
    data.forEach(l => {
      const nk = norm(l.business); if (nk && !nameToId.has(nk)) nameToId.set(nk, l.id);
      const pk = digits(l.phone);  if (pk && !phoneToId.has(pk)) phoneToId.set(pk, l.id);
    });
    if (data.length < 1000) break;
  }

  // New leads go to the queue; anything that already exists is parked for review.
  const inserts = [], dupes = [];
  for (const l of leads) {
    const nk = norm(l.business), pk = digits(l.phone);
    const phoneMatch = pk ? phoneToId.get(pk) : null;
    const nameMatch  = nameToId.get(nk);
    if (phoneMatch || nameMatch) {
      const reason = (phoneMatch && nameMatch) ? "Same name & phone" : phoneMatch ? "Same phone number" : "Same business name";
      dupes.push({ business: l.business, phone: l.phone, email: l.email, category: l.category, area: l.area,
                   source_file: l.source_file, reason, matched_lead_id: phoneMatch || nameMatch, imported_by: me.id });
    } else {
      l.region = regionFor(l.area);
      inserts.push(l);
    }
  }

  let nIns = 0;
  for (let i = 0; i < inserts.length; i += 500) {
    const { error } = await sb.from("leads").insert(inserts.slice(i, i + 500));
    if (error) { toast("Insert error: " + error.message); break; }
    nIns += Math.min(500, inserts.length - i);
  }
  let nDup = 0;
  for (let i = 0; i < dupes.length; i += 500) {
    const { error } = await sb.from("duplicate_leads").insert(dupes.slice(i, i + 500));
    if (error) { toast("Couldn't log duplicates (run duplicate-leads.sql): " + error.message); break; }
    nDup += Math.min(500, dupes.length - i);
  }
  toast(`Import done — ${nIns} new added, ${nDup} duplicate${nDup === 1 ? "" : "s"} skipped${nDup ? " (see Duplicate leads)" : ""}.`);
  try { await sb.storage.from("files").upload("imports/" + file.name, file, { upsert: true }); } catch (_) {}
  loadQueue(); loadImports(); loadDuplicates();
}

$("#csvInput").addEventListener("change", async (e) => {
  const file = e.target.files[0]; if (!file) return;
  toast("Reading " + file.name + "…");
  await importLeadFile(file);
  e.target.value = "";
});

// Duplicate leads: clear the whole review list
$("#dupClear") && $("#dupClear").addEventListener("click", async () => {
  if (!confirm("Dismiss ALL duplicate leads from the review list? Your real leads are untouched.")) return;
  const { error } = await sb.from("duplicate_leads").delete().neq("id", 0);
  if (error) { toast(error.message); return; }
  toast("Duplicate review list cleared."); loadDuplicates();
});

// minimal CSV parser (handles quoted fields & commas)
function parseCSV(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i+1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ",") { row.push(cur); cur = ""; }
      else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (ch === "\r") { /* skip */ }
      else cur += ch;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

// ---------------- ADD LEAD ----------------
$("#addLeadBtn").addEventListener("click", async () => {
  const business = prompt("Business name?"); if (!business) return;
  const phone = prompt("Phone number?") || null;
  const category = prompt("Category / trade?") || null;
  const area = prompt("Area / postcode?") || null;
  const { error } = await sb.from("leads").insert({ business, phone, category, area, status: "New", region: regionFor(area) });
  if (error) { toast(error.message); return; }
  toast("Lead added."); loadQueue();
});

// ---------------- SEARCH & FILTERS ----------------
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const reloadQueue = debounce(loadQueue, 300);
["#search", "#fArea", "#fCat"].forEach(sel => { const el = $(sel); if (el) el.addEventListener("input", reloadQueue); });
$("#fClear") && $("#fClear").addEventListener("click", () => {
  if ($("#fArea")) $("#fArea").value = "";
  if ($("#fCat")) $("#fCat").value = "";
  if ($("#search")) $("#search").value = "";
  loadQueue();
});

// All Leads: sortable headers + filters
$$("#all .ltable th").forEach(th => th.addEventListener("click", () => {
  const c = th.dataset.sort;
  if (allSort.col === c) allSort.dir = allSort.dir === "asc" ? "desc" : "asc";
  else allSort = { col: c, dir: "asc" };
  loadAllLeads();
}));
const reloadAll = debounce(loadAllLeads, 300);
["#aSearch", "#aArea", "#aCat"].forEach(s => { const e = $(s); if (e) e.addEventListener("input", reloadAll); });
$("#aStatus") && $("#aStatus").addEventListener("change", loadAllLeads);
$("#aClear") && $("#aClear").addEventListener("click", () => {
  ["#aSearch", "#aArea", "#aCat"].forEach(s => { if ($(s)) $(s).value = ""; });
  if ($("#aStatus")) $("#aStatus").value = "";
  loadAllLeads();
});

// Connected leads: sortable headers + filters
$$("#connected .ltable th[data-sort]").forEach(th => th.addEventListener("click", () => {
  const c = th.dataset.sort;
  if (connSort.col === c) connSort.dir = connSort.dir === "asc" ? "desc" : "asc";
  else connSort = { col: c, dir: "asc" };
  loadConnected();
}));
const reloadConn = debounce(loadConnected, 300);
["#cSearch", "#cArea"].forEach(s => { const e = $(s); if (e) e.addEventListener("input", reloadConn); });
["#cCaller", "#cOutcome"].forEach(s => { const e = $(s); if (e) e.addEventListener("change", loadConnected); });
$("#cClear") && $("#cClear").addEventListener("click", () => {
  ["#cSearch", "#cArea"].forEach(s => { if ($(s)) $(s).value = ""; });
  if ($("#cCaller")) $("#cCaller").value = "";
  if ($("#cOutcome")) $("#cOutcome").value = "";
  loadConnected();
});

// Region toggle (All / Leeds / Kent) — shared across Queue, All Leads, Connected
$$("[data-region-seg]").forEach(seg => seg.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-r]"); if (!b) return;
  region = b.dataset.r;
  $$("[data-region-seg] button").forEach(x => x.classList.toggle("active", x.dataset.r === region));
  loadQueue();
  if ($("#all").classList.contains("show")) loadAllLeads();
  if ($("#connected").classList.contains("show")) loadConnected();
}));

// Lead detail modal close
$("#lmClose") && $("#lmClose").addEventListener("click", closeModal);
$("#leadModal") && $("#leadModal").addEventListener("click", (e) => { if (e.target.id === "leadModal") closeModal(); });

// Team chat send
$("#chatSend") && $("#chatSend").addEventListener("click", sendMessage);
$("#chatInput") && $("#chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendMessage(); } });

// Dashboard stat cards → drill into the detail
$("#statCards") && $("#statCards").addEventListener("click", (e) => {
  const c = e.target.closest(".stat[data-action]"); if (!c) return;
  const a = c.dataset.action;
  if (a === "calls-today") openCallsModal(false);
  else if (a === "signups-today") openCallsModal(true);
  else if (a === "callbacks-due") { if ($("#aStatus")) $("#aStatus").value = "Callback"; goTab("all"); }
  else if (a === "leads-remaining") { goTab("queue"); }
});

// ---------------- NAV ----------------
$("#nav").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  $$("#nav button").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  $$(".page").forEach(p => p.classList.remove("show"));
  $("#" + b.dataset.p).classList.add("show");
  if (b.dataset.p === "dash") loadDashboard();
  if (b.dataset.p === "files") loadFiles();
  if (b.dataset.p === "imports") { loadImports(); loadDuplicates(); }
  if (b.dataset.p === "all") loadAllLeads();
  if (b.dataset.p === "connected") loadConnected();
  if (b.dataset.p === "chat") loadMessages();
  if (b.dataset.p === "admin") loadAdmin();
});

// ---------------- ADMIN PANEL (admins only) ----------------
async function loadAdmin() {
  const { data: profs } = await sb.from("profiles").select("*");
  (profs || []).forEach(p => { profiles[p.id] = p; });
  // all-time totals per caller (calls + sign-ups to date)
  const { data: stats } = await sb.from("caller_stats").select("caller_id,calls,signups");
  const callsBy = {}, signBy = {};
  (stats || []).forEach(s => { callsBy[s.caller_id] = s.calls; signBy[s.caller_id] = s.signups; });
  $("#adminTeam").innerHTML = Object.values(profiles).map(p => {
    const on = online.has(p.id);
    const seen = p.last_seen ? new Date(p.last_seen).toLocaleString() : "never";
    const actions = p.id === me.id
      ? `<span style="width:210px;text-align:right;color:var(--muted);font-size:12px">you</span>`
      : `<span style="display:flex;gap:8px;justify-content:flex-end;width:210px">
           <button class="btn ghost mkadmin" data-id="${p.id}" data-val="${p.is_admin ? '0' : '1'}">${p.is_admin ? 'Remove admin' : 'Make admin'}</button>
           <button class="btn ghost rmcaller" data-id="${p.id}" data-name="${esc(p.full_name)}" style="color:var(--red);border-color:var(--red)">Remove</button>
         </span>`;
    return `<div class="lb">
      <span class="who" style="width:150px"><span class="ava" style="background:${esc(p.color)};width:26px;height:26px;font-size:11px">${esc(initials(p))}</span>${esc(p.full_name)}${p.is_admin ? ' <span class="st New" style="font-size:9px">admin</span>' : ''}</span>
      <span style="width:84px;font-size:12px;font-weight:700;color:${on ? 'var(--ok)' : 'var(--muted)'}">${on ? '● online' : 'offline'}</span>
      <span style="flex:1;color:var(--muted);font-size:12px">last active: ${esc(seen)}</span>
      <span style="min-width:62px;text-align:right;font-weight:800;font-size:12px">${callsBy[p.id] || 0} calls</span>
      <span style="min-width:66px;text-align:right;font-weight:800;font-size:12px;color:var(--ok)">${signBy[p.id] || 0} signed</span>
      ${actions}
    </div>`;
  }).join("") || `<div class="empty">No callers.</div>`;
  $$("#adminTeam .mkadmin").forEach(b => b.addEventListener("click", () => makeAdmin(b.dataset.id, b.dataset.val === '1')));
  $$("#adminTeam .rmcaller").forEach(b => b.addEventListener("click", () => removeCaller(b.dataset.id, b.dataset.name)));

  const { data: log } = await sb.from("call_log").select("created_at,outcome,note,caller_id,leads(business)").order("created_at", { ascending: false }).limit(60);
  $("#adminActivity").innerHTML = (log && log.length) ? log.map(h =>
    `<div class="hevent" style="padding:10px 16px"><div><div class="ho">${esc(profiles[h.caller_id]?.full_name || "Someone")} — ${esc(h.outcome)}</div><div>${esc(h.leads?.business || "")}${h.note ? " · " + esc(h.note) : ""}</div></div><div class="ht" style="margin-left:auto">${new Date(h.created_at).toLocaleString()}</div></div>`
  ).join("") : `<div class="empty">No activity logged yet.</div>`;
}

async function makeAdmin(id, val) {
  const { error } = await sb.from("profiles").update({ is_admin: val }).eq("id", id);
  if (error) { toast(error.message); return; }
  toast(val ? "Admin rights granted." : "Admin rights removed.");
  loadAdmin();
}

async function removeCaller(id, name) {
  if (!confirm(`Remove ${name} from the team? They'll be signed out and can no longer use the app.\n\nTheir leads are kept (any in-progress call is released). To also delete their login permanently, do it in Supabase → Authentication → Users.`)) return;
  // release any lead they were mid-call on
  await sb.from("leads").update({ status: "New", claimed_by: null, claimed_at: null }).eq("claimed_by", id).eq("status", "Calling");
  const { error } = await sb.from("profiles").delete().eq("id", id);
  if (error) { toast(error.message); return; }
  toast(name + " removed from the team.");
  loadAdmin();
}

// ---------------- REALTIME ----------------
let reloadTimer = null;
function subscribeRealtime() {
  sb.channel("leads-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "leads" }, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        loadQueue();
        if ($("#dash").classList.contains("show")) loadDashboard();
        if ($("#all").classList.contains("show")) loadAllLeads();
        if ($("#connected").classList.contains("show")) loadConnected();
      }, 250);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "call_log" }, () => {
      if ($("#dash").classList.contains("show")) loadDashboard();
      if ($("#admin").classList.contains("show")) loadAdmin();
      if ($("#connected").classList.contains("show")) loadConnected();
    })
    .subscribe();

  // live team chat
  sb.channel("messages-changes")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
      appendMessage(payload.new);
    })
    .subscribe();

  // live target changes — everyone's bars + the editor update instantly
  sb.channel("settings-changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "app_settings" }, async () => {
      await loadSettings();
      if ($("#tgCall")) $("#tgCall").value = settings.daily_call_target;
      if ($("#tgSign")) $("#tgSign").value = settings.daily_signup_target;
      if ($("#dash").classList.contains("show")) renderTargets();
    })
    .subscribe();
}

// presence: who's online right now
function subscribePresence(uid) {
  const ch = sb.channel("online", { config: { presence: { key: uid } } });
  ch.on("presence", { event: "sync" }, () => {
    online = new Set(Object.keys(ch.presenceState()));
    renderTeam();
  });
  ch.subscribe(async (status) => {
    if (status === "SUBSCRIBED") await ch.track({ at: Date.now() });
  });
}

// ---------------- START ----------------
sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") location.reload(); });
boot();
