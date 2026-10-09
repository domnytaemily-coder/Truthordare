(function () {
  "use strict";
  const C = window.TOD_CONFIG || {};
  const BANK = window.TOD_BANK || { truth: [], dare: [] };
  const DEMO = !C.firebase || !C.firebase.apiKey || C.firebase.apiKey === "DEMO";
  const BASE = "games/" + (C.game || "party");
  const IS_HOST = location.hash === "#host-" + C.hostCode;
  const HOST_ALIVE_MS = 90000;

  // ---------- small helpers ----------
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const clean = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }

  // ?p=name gives a separate player per tab (handy for testing on one device)
  const tabP = new URLSearchParams(location.search).get("p");
  let pid = tabP ? "t_" + tabP.replace(/[^a-z0-9]/gi, "").slice(0, 20) : ls.get("tod_pid");
  if (!pid) { pid = rid(); ls.set("tod_pid", pid); }

  // ---------- data layer (Firebase, or a same-browser demo store) ----------
  let store;
  if (DEMO) {
    const KEY = "tod_demo_" + BASE;
    const listeners = [];
    const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
    const emit = () => { const v = read(); setTimeout(() => listeners.forEach((f) => f(v)), 0); };
    window.addEventListener("storage", (e) => { if (e.key === KEY) emit(); });
    const setPath = (obj, path, val) => {
      const parts = path.split("/").filter(Boolean);
      let o = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        if (typeof o[parts[i]] !== "object" || o[parts[i]] === null) o[parts[i]] = {};
        o = o[parts[i]];
      }
      const last = parts[parts.length - 1];
      if (val === null) delete o[last]; else o[last] = val;
    };
    store = {
      on(f) { listeners.push(f); emit(); },
      update(map) {
        const v = read();
        Object.keys(map).forEach((p) => setPath(v, p, clean(map[p])));
        try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {}
        emit();
        return Promise.resolve();
      },
      key: rid,
    };
  } else {
    firebase.initializeApp(C.firebase);
    const ref = firebase.database().ref(BASE);
    store = {
      on(f) { ref.on("value", (s) => f(s.val() || {}), (e) => toast("Connection problem: " + e.message)); },
      update(map) {
        const m = {};
        Object.keys(map).forEach((k) => (m[k] = clean(map[k])));
        return ref.update(m).catch((e) => toast("Couldn't save: " + e.message));
      },
      key: () => ref.push().key,
    };
  }

  // ---------- state ----------
  let S = {};
  let composerOpen = false;
  let lastTurnKey = "";
  const accepted = new Set(); // suggestion texts that are already checked

  const players = () => S.players || {};
  const me = () => players()[pid];
  const st = () => S.state || {};
  const phase = () => st().phase || "lobby";
  const round = () => st().round || 1;
  const nameOf = (id) => (players()[id] && players()[id].name) || "Someone";
  const activeIds = () => Object.keys(players()).filter((id) => players()[id].active !== false);
  const eligible = (r) => activeIds().filter((id) => (players()[id].joinedRound || 1) <= r);
  const allCards = () => Object.entries(S.cards || {}).map(([id, c]) => Object.assign({ id }, c));
  const hostAI = () => !!(S.host && S.host.ai && Date.now() - (S.host.alive || 0) < HOST_ALIVE_MS);

  // ---------- AI requests from players (answered by the host's phone) ----------
  const waiting = {};
  function aiRequest(kind, payload) {
    if (!hostAI() && !IS_HOST) return Promise.resolve(null);
    if (IS_HOST) return hostCompute(Object.assign({ kind, pid }, payload)).catch(() => null);
    const id = store.key();
    store.update({ ["ai/" + id]: Object.assign({ kind, pid, status: "pending", at: Date.now() }, payload) });
    return new Promise((res) => {
      waiting[id] = { res, timer: setTimeout(() => finishAI(id, null), 25000) };
    });
  }
  function finishAI(id, result) {
    const w = waiting[id]; if (!w) return;
    clearTimeout(w.timer); delete waiting[id];
    store.update({ ["ai/" + id]: null });
    w.res(result);
  }
  function checkWaiting() {
    Object.keys(waiting).forEach((id) => {
      const r = S.ai && S.ai[id];
      if (r && r.status === "done") finishAI(id, r.result || null);
      else if (r && r.status === "error") finishAI(id, null);
    });
  }

  // ---------- text checks and backup suggestions ----------
  function precheck(text) {
    const t = text.trim();
    const words = t.split(/\s+/).filter((w) => /[a-z]{2,}/i.test(w));
    const nonSpace = t.replace(/\s/g, "");
    const letters = (nonSpace.match(/[a-z]/gi) || []).length;
    if (words.length < 3) return { ok: false, reason: "Too short. Write a full question or dare." };
    if (letters / Math.max(1, nonSpace.length) < 0.65) return { ok: false, reason: "That doesn't look like real words." };
    if (/(.)\1{4,}/i.test(t)) return { ok: false, reason: "That doesn't look like real words." };
    return { ok: true };
  }
  function existingSet() { return new Set(allCards().map((c) => norm(c.text))); }
  function localSuggest(type, seed, n) {
    const have = existingSet();
    const pool = (BANK[type] || []).filter((t) => !have.has(norm(t)));
    const keys = norm(seed).split(" ").filter((w) => w.length >= 3);
    let hits = keys.length ? pool.filter((t) => keys.some((k) => norm(t).includes(k))) : [];
    const rest = pool.filter((t) => !hits.includes(t)).sort(() => Math.random() - 0.5);
    hits = hits.sort(() => Math.random() - 0.5);
    return hits.concat(rest).slice(0, n);
  }

  // ---------- Claude (host phone only; key never leaves this device) ----------
  const keyLS = "tod_claude_key";
  const apiKey = () => ls.get(keyLS) || "";
  async function claude(prompt, maxTokens) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey(),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: C.model || "claude-haiku-5-5", max_tokens: maxTokens || 500, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) {
      let m = "HTTP " + r.status;
      try { const j = await r.json(); m = (j.error && j.error.message) || m; } catch (e) {}
      throw new Error(m);
    }
    const j = await r.json();
    const txt = (j.content || []).map((b) => b.text || "").join("");
    const a = txt.indexOf("{"), b = txt.lastIndexOf("}");
    if (a < 0 || b < a) throw new Error("No JSON in reply");
    return JSON.parse(txt.slice(a, b + 1));
  }
  function gameContext() {
    const cards = allCards().sort((a, b) => (a.at || 0) - (b.at || 0));
    const recent = cards.slice(-25).map((c) => "- [" + c.type + "] " + c.text).join("\n") || "(none yet)";
    const avoid = cards.slice(-120).map((c) => "- " + c.text).join("\n") || "(none)";
    return { recent, avoid };
  }
  const RULES =
    "You help run a Truth or Dare party game for a group of friends aged 20-30. Everything is in English.\n" +
    "A TRUTH is a question the player must answer honestly. A DARE is an action they must do right now at a house party.\n" +
    "Keep it fun and playful: spicy is fine, but nothing dangerous, illegal, cruel or sexually explicit.\n" +
    "Match the tone and spice level of the group's recent cards.\n";
  async function hostCompute(req) {
    const ctx = gameContext();
    const T = req.type === "dare" ? "DARE" : "TRUTH";
    if (req.kind === "check") {
      const p = precheck(req.text || "");
      if (!p.ok) return { valid: false, reason: p.reason, suggestions: await suggestFor(req.type, req.text) };
      if (!apiKey()) return { valid: true };
      const out = await claude(
        RULES +
          "\nRecent cards from this group:\n" + ctx.recent +
          "\n\nA player wrote this " + T + ":\n\"\"\"" + req.text + "\"\"\"\n\n" +
          "Is it a usable " + T + "? It must be understandable and make sense as a " + T.toLowerCase() + ". Casual wording and spelling mistakes are fine. " +
          "Reject gibberish, random symbols, a lone word, or something that is not a " + T.toLowerCase() + ".\n" +
          "If usable reply {\"valid\":true}.\n" +
          "If not, reply {\"valid\":false,\"reason\":\"<friendly reason, max 10 words>\",\"suggestions\":[\"...\",\"...\",\"...\"]} " +
          "with 3 " + T + "s inspired by any meaningful word in what they wrote. Suggestions must not repeat these existing cards:\n" + ctx.avoid +
          "\n\nReply with JSON only.", 500);
      if (out.valid) return { valid: true };
      return { valid: false, reason: out.reason || "That doesn't work as a " + T.toLowerCase() + ".", suggestions: (out.suggestions || []).slice(0, 3) };
    }
    if (req.kind === "suggest") return { suggestions: await suggestFor(req.type, req.seed) };
    return null;
  }
  async function suggestFor(type, seed) {
    if (IS_HOST && apiKey()) {
      try {
        const ctx = gameContext();
        const T = type === "dare" ? "DARE" : "TRUTH";
        const out = await claude(
          RULES + "\nRecent cards from this group:\n" + ctx.recent +
            "\n\nWrite 3 fresh " + T + "s." +
            (seed && seed.trim() ? " Build them around this idea the player typed: \"" + seed.trim().slice(0, 120) + "\"." : "") +
            " Each one sentence. They must not repeat or closely copy any of these existing cards:\n" + ctx.avoid +
            "\n\nReply with JSON only: {\"suggestions\":[\"...\",\"...\",\"...\"]}", 400);
        const list = (out.suggestions || []).filter((s) => typeof s === "string" && s.trim()).slice(0, 3);
        if (list.length) return list;
      } catch (e) { console.warn(e); }
    }
    return localSuggest(type, seed || "", 3);
  }
  async function generateCard(type, forName) {
    if (apiKey()) {
      try {
        const ctx = gameContext();
        const T = type === "dare" ? "DARE" : "TRUTH";
        const out = await claude(
          RULES + "\nRecent cards from this group:\n" + ctx.recent +
            "\n\nWrite one new " + T + " for " + forName + ". One sentence. It must not repeat or closely copy any of these:\n" + ctx.avoid +
            "\n\nReply with JSON only: {\"text\":\"...\"}", 200);
        if (out.text && out.text.trim()) return { text: out.text.trim(), source: "ai" };
      } catch (e) { console.warn(e); }
    }
    const l = localSuggest(type, "", 1);
    return { text: l[0] || (type === "truth" ? "What's something nobody here knows about you?" : "Do your best dance move for 20 seconds."), source: "bank" };
  }

  // ---------- host logic ----------
  const hostBusy = new Set();
  let resolving = false;
  function hostTick() {
    if (!IS_HOST) return;
    // answer players' AI requests
    Object.entries(S.ai || {}).forEach(([id, r]) => {
      if (r.status === "pending" && !hostBusy.has(id)) {
        hostBusy.add(id);
        store.update({ ["ai/" + id + "/status"]: "working" });
        hostCompute(r)
          .then((result) => store.update({ ["ai/" + id + "/status"]: "done", ["ai/" + id + "/result"]: result }))
          .catch((e) => { console.warn(e); store.update({ ["ai/" + id + "/status"]: "error" }); })
          .finally(() => hostBusy.delete(id));
      } else if (Date.now() - (r.at || 0) > 120000) {
        store.update({ ["ai/" + id]: null });
      }
    });
    // draw a card once the player picked truth or dare
    const t = st().turn;
    if (phase() === "playing" && t && t.status === "choosing" && t.choice && !resolving) {
      resolving = true;
      resolveTurn(t).finally(() => (resolving = false));
    }
  }
  async function resolveTurn(t) {
    const type = t.choice, who = t.pid;
    const open = allCards().filter((c) => !c.used && c.type === type);
    const direct = open.filter((c) => c.target === who && !c.released);
    let card = direct.length ? pick(direct) : null;
    const isDirect = !!card;
    if (!card) {
      // shared pile: cards for everyone, plus cards whose person already had a turn,
      // were written in an earlier round, or left the game
      const general = open.filter((c) => !c.target || c.released || (c.round || 1) < round() ||
        !players()[c.target] || players()[c.target].active === false);
      const notOwn = general.filter((c) => c.author !== who);
      const list = notOwn.length ? notOwn : general;
      card = list.length ? pick(list) : null;
    }
    const up = {};
    let text, source;
    if (card) {
      text = card.text; source = card.source || "player";
      up["cards/" + card.id + "/used"] = true;
      up["cards/" + card.id + "/usedBy"] = who;
      up["cards/" + card.id + "/usedRound"] = round();
    } else {
      const g = await generateCard(type, nameOf(who));
      text = g.text; source = g.source;
      const id = store.key();
      up["cards/" + id] = { type, text, target: null, author: "ai", round: round(), at: Date.now(), source, used: true, usedBy: who, usedRound: round() };
    }
    // other cards written for this player go to the shared pile now
    allCards().forEach((c) => {
      if (!c.used && c.target === who && !c.released && (!card || c.id !== card.id)) up["cards/" + c.id + "/released"] = true;
    });
    const cur = st().turn;
    if (!cur || cur.key !== t.key) return; // host moved on meanwhile
    up["state/turn/status"] = "revealed";
    up["state/turn/text"] = text;
    up["state/turn/direct"] = isDirect;
    up["state/turn/source"] = source;
    await store.update(up);
  }
  function nextTurnUpdate(markDone, exclude) {
    let r = round();
    const done = Object.assign({}, st().done || {});
    if (markDone) done[markDone] = true;
    const prev = markDone;
    const ok = (id) => id !== exclude;
    let pool = eligible(r).filter((id) => !done[id] && ok(id));
    let newDone = done;
    if (!pool.length) {
      r = r + 1; newDone = {};
      pool = eligible(r).filter(ok);
      if (pool.length > 1 && prev) pool = pool.filter((id) => id !== prev);
    }
    const turn = pool.length ? { pid: pick(pool), status: "choosing", key: rid() } : null;
    return { "state/round": r, "state/done": Object.keys(newDone).length ? newDone : null, "state/turn": turn };
  }
  function hostStart() {
    if (!eligible(1).length) return toast("Nobody has joined yet");
    const up = { "state/phase": "playing", "state/round": 1, "state/done": null };
    // everyone in the lobby plays from round 1
    activeIds().forEach((id) => (up["players/" + id + "/joinedRound"] = 1));
    const ids = activeIds();
    up["state/turn"] = { pid: pick(ids), status: "choosing", key: rid() };
    store.update(up);
    requestWake();
  }
  function hostNext() {
    const t = st().turn;
    store.update(nextTurnUpdate(t && t.pid));
  }
  let resetArmed = false;
  function hostReset() {
    if (!resetArmed) {
      resetArmed = true; renderHostPanel();
      setTimeout(() => { resetArmed = false; renderHostPanel(); }, 4000);
      return;
    }
    resetArmed = false;
    store.update({ state: null, cards: null, ai: null, players: null });
    toast("New game ready. Everyone joins again.");
  }
  let wake;
  async function requestWake() {
    try { if (navigator.wakeLock && !wake) { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => (wake = null)); } } catch (e) {}
  }
  document.addEventListener("visibilitychange", () => { if (IS_HOST && document.visibilityState === "visible" && phase() === "playing") requestWake(); });
  function heartbeat() {
    if (!IS_HOST) return;
    store.update({ "host/alive": Date.now(), "host/ai": !!apiKey() });
  }

  // ---------- player actions ----------
  function join(name) {
    name = name.trim().slice(0, 24);
    if (!name) return toast("Write your name first");
    ls.set("tod_name", name);
    const playing = phase() === "playing";
    const existing = me();
    store.update({
      ["players/" + pid]: {
        name,
        active: true,
        joinedAt: Date.now(),
        joinedRound: playing && !IS_HOST ? round() + 1 : round(),
        wroteTruth: existing ? !!existing.wroteTruth : false,
        wroteDare: existing ? !!existing.wroteDare : false,
      },
    });
  }
  function choose(type) {
    const t = st().turn;
    if (!t || t.pid !== pid || t.status !== "choosing" || t.choice) return;
    store.update({ "state/turn/choice": type });
  }
  function refuse() {
    const t = st().turn;
    if (!t || t.pid !== pid || t.status !== "revealed") return;
    store.update({ "state/turn/status": "refused" });
  }

  // ---------- composer ----------
  let compType = "truth";
  let compBusy = false;
  const comp = {
    el: $("#composer"), text: $("#comp-text"), target: $("#comp-target"), msg: $("#comp-msg"), sugs: $("#comp-sugs"),
    title: $("#comp-title"), label: $("#comp-label"), seg: $("#comp-seg"), close: $("#comp-close"),
    suggest: $("#comp-suggest"), submit: $("#comp-submit"),
  };
  function lobbyStep() {
    const m = me();
    if (!m || phase() !== "lobby") return null;
    if (!m.wroteTruth) return "truth";
    if (!m.wroteDare) return "dare";
    return null;
  }
  function setType(type) {
    compType = type;
    comp.el.classList.toggle("truth", type === "truth");
    comp.el.classList.toggle("dare", type === "dare");
    $("#seg-truth").setAttribute("aria-pressed", String(type === "truth"));
    $("#seg-dare").setAttribute("aria-pressed", String(type === "dare"));
    comp.title.textContent = type === "truth" ? "Your truth" : "Your dare";
    comp.title.className = "comp-title " + type;
    comp.label.textContent = type === "truth" ? "Question" : "Dare";
    comp.text.placeholder = type === "truth" ? "What's the most... ? Or type one word and tap Suggest" : "Do... ! Or type one word and tap Suggest";
  }
  function setMsg(text, kind) { comp.msg.textContent = text || ""; comp.msg.className = "msg" + (kind ? " " + kind : ""); }
  function showSugs(list, note) {
    comp.sugs.innerHTML = "";
    (list || []).forEach((s) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "sug";
      b.innerHTML = esc(s) + "<small>" + esc(note || "Tap to use") + "</small>";
      b.addEventListener("click", () => {
        comp.text.value = s; accepted.add(s.trim());
        comp.sugs.innerHTML = ""; setMsg("Edit it if you like, then Submit.", "good");
      });
      comp.sugs.appendChild(b);
    });
  }
  function busy(on, label) {
    compBusy = on;
    comp.submit.disabled = on; comp.suggest.disabled = on;
    if (on) setMsg(label, ""), comp.msg.classList.add("dots");
    else comp.msg.classList.remove("dots");
  }
  async function onSuggest() {
    if (compBusy) return;
    busy(true, hostAI() || IS_HOST ? "Asking Claude" : "Finding ideas");
    let list = null;
    const r = await aiRequest("suggest", { type: compType, seed: comp.text.value.trim() });
    if (r && r.suggestions && r.suggestions.length) list = r.suggestions;
    if (!list) list = localSuggest(compType, comp.text.value, 3);
    busy(false);
    setMsg(list.length ? "Pick one, or keep writing your own." : "No ideas left. Write your own.", "");
    showSugs(list);
  }
  async function onSubmit() {
    if (compBusy) return;
    const text = comp.text.value.trim();
    if (!text) return setMsg("Write something first.", "bad");
    let res;
    if (accepted.has(text)) res = { valid: true };
    else {
      const p = precheck(text);
      if (!p.ok) {
        busy(true, "Checking");
        let list = null;
        const r = await aiRequest("suggest", { type: compType, seed: text });
        if (r && r.suggestions && r.suggestions.length) list = r.suggestions;
        busy(false);
        res = { valid: false, reason: p.reason, suggestions: list || localSuggest(compType, text, 3) };
      } else {
        busy(true, "Checking");
        res = await aiRequest("check", { type: compType, text });
        busy(false);
        if (!res) res = { valid: true };
      }
    }
    if (!res.valid) {
      setMsg(res.reason + " Try one of these:", "bad");
      showSugs(res.suggestions || []);
      return;
    }
    const target = comp.target.value || null;
    const id = store.key();
    const up = {};
    up["cards/" + id] = {
      type: compType, text, target, author: pid, at: Date.now(),
      round: phase() === "playing" ? round() : 1, source: accepted.has(text) ? "suggested" : "player", used: false,
    };
    const step = lobbyStep();
    if (step === compType) up["players/" + pid + "/" + (compType === "truth" ? "wroteTruth" : "wroteDare")] = true;
    await store.update(up);
    comp.text.value = ""; comp.target.value = ""; comp.sugs.innerHTML = "";
    setMsg("");
    toast(compType === "truth" ? "Truth added" : "Dare added");
    if (!step) composerOpen = false;
    render();
  }
  $("#seg-truth").addEventListener("click", () => setType("truth"));
  $("#seg-dare").addEventListener("click", () => setType("dare"));
  comp.close.addEventListener("click", () => { composerOpen = false; render(); });
  comp.suggest.addEventListener("click", onSuggest);
  comp.submit.addEventListener("click", onSubmit);

  let targetSig = "";
  function updateTargets() {
    const others = activeIds().filter((id) => id !== pid).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const sig = others.map((id) => id + ":" + nameOf(id)).join("|");
    if (sig === targetSig) return;
    targetSig = sig;
    const cur = comp.target.value;
    comp.target.innerHTML = '<option value="">Everyone (random)</option>' + others.map((id) => '<option value="' + esc(id) + '">' + esc(nameOf(id)) + "</option>").join("");
    if (others.includes(cur)) comp.target.value = cur;
  }

  // ---------- rendering ----------
  function chips() {
    const out = [];
    if (DEMO) out.push('<span class="chip">Demo</span>');
    if (phase() === "playing") out.push('<span class="chip">Round ' + round() + "</span>");
    if (IS_HOST) out.push('<span class="chip' + (apiKey() ? " on" : "") + '">' + (apiKey() ? "AI on" : "AI off") + "</span>");
    if (me() && me().active !== false) out.push('<span class="chip">' + esc(me().name) + "</span>");
    $("#chips").innerHTML = out.join("");
  }

  function viewJoin() {
    const playing = phase() === "playing";
    const removed = me() && me().active === false;
    return (
      '<h1 class="hero"><span class="t">Truth</span><span class="o">or</span><span class="d">Dare</span></h1>' +
      '<form class="stack" id="join-form">' +
      '<div class="field"><label class="label" for="join-name">Your name</label>' +
      '<input type="text" id="join-name" maxlength="24" autocomplete="nickname" placeholder="So people know it\'s you" value="' + esc(ls.get("tod_name") || "") + '"></div>' +
      '<button class="btn block" type="submit">' + (removed ? "Join again" : "Join the game") + "</button>" +
      (playing && !IS_HOST ? '<p class="hint">The game already started. You\'ll jump in at the start of the next round.</p>' : "") +
      (IS_HOST ? '<p class="hint">You are the host. You play too, and you also get the controls.</p>' : "") +
      "</form>"
    );
  }

  function playerRows(showActions) {
    const ids = activeIds().sort((a, b) => (players()[a].joinedAt || 0) - (players()[b].joinedAt || 0));
    if (!ids.length) return '<p class="lead">Nobody here yet.</p>';
    return '<ul class="list">' + ids.map((id) => {
      const p = players()[id];
      let tag;
      if (phase() === "lobby") tag = p.wroteTruth && p.wroteDare ? '<span class="tag ok">Ready</span>' : '<span class="tag wait">Writing</span>';
      else if ((p.joinedRound || 1) > round()) tag = '<span class="tag wait">Joins next round</span>';
      else if (st().done && st().done[id]) tag = '<span class="tag">Played</span>';
      else if (st().turn && st().turn.pid === id) tag = '<span class="tag ok">Now</span>';
      else tag = '<span class="tag">Waiting</span>';
      let acts = "";
      if (showActions) {
        if (phase() === "playing" && (p.joinedRound || 1) > round()) acts += '<button class="btn small ghost" data-add="' + esc(id) + '">Add now</button>';
        if (id !== pid) acts += '<button class="btn small danger" data-remove="' + esc(id) + '">Remove</button>';
      }
      return '<li><span class="nm">' + esc(p.name) + (id === pid ? ' <span class="tag">(you)</span>' : "") + '</span><span class="acts">' + tag + acts + "</span></li>";
    }).join("") + "</ul>";
  }

  function viewLobby() {
    const step = lobbyStep();
    const ids = activeIds();
    const ready = ids.filter((id) => players()[id].wroteTruth && players()[id].wroteDare).length;
    if (step) {
      return (
        '<h2>Write one truth and one dare</h2>' +
        '<p class="lead">Step ' + (step === "truth" ? 1 : 2) + " of 2. Nobody will know you wrote it. You can send it to someone specific or to everyone.</p>"
      );
    }
    return (
      "<h2>You're in. Waiting for the others</h2>" +
      '<p class="lead">' + ready + " of " + ids.length + " are ready. The host starts the game when everyone has written.</p>" +
      '<div style="margin-top:20px">' + (IS_HOST ? "" : playerRows(false)) + "</div>" +
      (composerOpen ? "" : '<button class="btn ghost block addbtn" id="add-more">Write another one (optional)</button>')
    );
  }

  function viewPlaying() {
    const t = st().turn;
    const m = me();
    const waitingNext = m && (m.joinedRound || 1) > round();
    let h = "";
    if (waitingNext) h += '<div class="banner">You\'re in! You join from the next round. Meanwhile you can write truths and dares.</div>';
    if (!t) {
      h += '<div class="waiting">Waiting for the host to pick the next player<span class="dots"></span></div>';
    } else {
      const mine = t.pid === pid;
      h += '<div class="stage"><div class="label">' + (mine ? "It's your turn" : "Now playing") + "</div>" +
        '<div class="who' + (mine ? " me" : "") + '">' + (mine ? "You" : esc(nameOf(t.pid))) + "</div>";
      if (t.status === "choosing" && !t.choice) {
        if (mine) {
          h += '<div class="choose"><button class="pick truth" data-choose="truth">Truth</button><button class="pick dare" data-choose="dare">Dare</button></div>';
        } else {
          h += '<div class="waiting">Choosing truth or dare<span class="dots"></span></div>';
        }
      } else if (t.status === "choosing" && t.choice) {
        h += '<div class="waiting">Drawing a ' + esc(t.choice) + ' card<span class="dots"></span></div>';
      } else if (t.status === "revealed") {
        h += '<div class="card ' + esc(t.choice) + '"><div class="type"><span>' + esc(t.choice) + "</span><span>" + (t.direct ? "Written for " + (mine ? "you" : esc(nameOf(t.pid))) : "") + "</span></div>" +
          '<div class="text">' + esc(t.text) + "</div></div>";
        if (mine) h += '<button class="btn danger block" style="margin-top:14px" id="refuse">Refuse and take a shot</button>';
      } else if (t.status === "refused") {
        h += '<div class="shot"><div class="big">Shot!</div><p class="lead">' + (mine ? "You" : esc(nameOf(t.pid))) + " refused the " + esc(t.choice) + ". Drink up.</p></div>";
      }
      const elig = eligible(round());
      const played = Object.keys(st().done || {}).filter((id) => elig.includes(id)).length;
      h += '<div class="meta"><span>Round ' + round() + "</span><span>" + played + " of " + elig.length + " played</span></div></div>";
    }
    if (!composerOpen) h += '<button class="btn ghost block addbtn" id="add-more">Write a truth or dare</button>';
    return h;
  }

  function render() {
    chips();
    updateTargets();
    const m = me();
    const joined = m && m.active !== false;
    let html;
    if (!joined) html = viewJoin();
    else if (phase() === "lobby") html = viewLobby();
    else html = viewPlaying();
    const changed = html !== lastView;
    if (changed) { $("#view").innerHTML = html; lastView = html; }

    // composer visibility
    const step = joined ? lobbyStep() : null;
    const showComp = joined && (!!step || composerOpen);
    comp.el.hidden = !showComp;
    if (showComp) {
      if (step && compType !== step) { setType(step); comp.sugs.innerHTML = ""; setMsg(""); }
      comp.seg.hidden = !!step;
      comp.close.hidden = !!step;
    }

    // vibrate when it becomes your turn
    const t = st().turn;
    const k = t ? t.key + t.pid : "";
    if (t && t.pid === pid && k !== lastTurnKey && t.status === "choosing" && navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch (e) {} }
    lastTurnKey = k;

    // wire view buttons (only when the view was rebuilt)
    if (changed) wireView();
    renderHostBar();
    renderHostPanel();
  }
  let lastView = "";
  function wireView() {
    const jf = $("#join-form");
    if (jf) jf.addEventListener("submit", (e) => { e.preventDefault(); join($("#join-name").value); });
    document.querySelectorAll("[data-choose]").forEach((b) => b.addEventListener("click", () => choose(b.dataset.choose)));
    const rf = $("#refuse"); if (rf) rf.addEventListener("click", refuse);
    const am = $("#add-more");
    if (am) am.addEventListener("click", () => { composerOpen = true; setType(compType); render(); comp.text.focus(); });
  }

  // ---------- host UI ----------
  function renderHostBar() {
    const bar = $("#hostbar");
    if (!IS_HOST) { bar.hidden = true; return; }
    bar.hidden = false;
    const inner = $("#hostbar-in");
    let h = "";
    if (phase() === "lobby") {
      const ids = activeIds();
      const ready = ids.filter((id) => players()[id].wroteTruth && players()[id].wroteDare).length;
      const all = ids.length > 0 && ready === ids.length;
      h += '<button class="btn ' + (all ? "dare" : "") + '" id="h-start"' + (ids.length ? "" : " disabled") + ">" +
        (all ? "Start game" : "Start anyway (" + (ids.length - ready) + " writing)") + "</button>";
    } else {
      const t = st().turn;
      const label = !t ? "Pick next player" : "Next player";
      h += '<button class="btn ghost" id="h-skip"' + (t ? "" : " disabled") + ">Skip" + (t ? " " + esc(nameOf(t.pid)) : "") + "</button>";
      h += '<button class="btn dare" id="h-next">' + label + "</button>";
    }
    inner.innerHTML = h;
    const s = $("#h-start"); if (s) s.addEventListener("click", hostStart);
    const n = $("#h-next"); if (n) n.addEventListener("click", hostNext);
    const k = $("#h-skip"); if (k) k.addEventListener("click", hostNext);
  }

  let panelBuilt = false;
  function buildHostPanel() {
    const p = $("#hostpanel");
    p.className = "hostpanel";
    const link = location.origin + location.pathname;
    p.innerHTML =
      '<div><h3>Players</h3><div id="hp-players"></div></div>' +
      '<div><h3>Player link</h3><div class="linkbox"><code id="hp-link">' + esc(link) + '</code><button class="btn small ghost" id="hp-copy">Copy</button></div>' +
      '<p class="hint">Send this link to everyone. Keep your host link (with #host-…) to yourself and open it on one device only.</p></div>' +
      '<div><h3>Claude AI</h3><div class="field"><label class="label" for="hp-key">API key (stays on this phone)</label>' +
      '<input type="password" id="hp-key" autocomplete="off" placeholder="sk-ant-..."></div>' +
      '<div class="row" style="margin-top:10px"><button class="btn small" id="hp-save">Save key</button><button class="btn small ghost" id="hp-test">Test AI</button><button class="btn small ghost" id="hp-clear">Remove key</button></div>' +
      '<p class="hint" id="hp-ai-msg">Keep this page open during the game: your phone answers everyone\'s AI requests. Without a key the game uses its built-in card list.</p></div>' +
      '<div><h3>Game</h3><button class="btn danger small" id="hp-reset">New game</button><p class="hint">Clears players, cards and rounds.</p></div>';
    $("#hp-key").value = apiKey();
    $("#hp-copy").addEventListener("click", () => {
      navigator.clipboard.writeText(link).then(() => toast("Link copied"), () => {
        const r = document.createRange(); r.selectNodeContents($("#hp-link")); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      });
    });
    $("#hp-save").addEventListener("click", () => { ls.set(keyLS, $("#hp-key").value.trim()); heartbeat(); render(); toast("Key saved on this phone"); });
    $("#hp-clear").addEventListener("click", () => { ls.set(keyLS, ""); $("#hp-key").value = ""; heartbeat(); render(); toast("Key removed"); });
    $("#hp-test").addEventListener("click", async () => {
      const msg = $("#hp-ai-msg");
      if (!apiKey()) { msg.textContent = "Save a key first."; return; }
      msg.textContent = "Testing...";
      try {
        const out = await claude('Reply with JSON only: {"ok":true,"truth":"<one fun truth question for a party>"}', 120);
        msg.textContent = "Works! Example: " + (out.truth || "ok");
      } catch (e) { msg.textContent = "Didn't work: " + e.message; }
    });
    $("#hp-reset").addEventListener("click", hostReset);
    $("#hp-players").addEventListener("click", (e) => {
      const a = e.target.closest("[data-add]"), r = e.target.closest("[data-remove]");
      if (a) store.update({ ["players/" + a.dataset.add + "/joinedRound"]: round() });
      if (r) {
        const id = r.dataset.remove;
        const up = { ["players/" + id + "/active"]: false };
        const t = st().turn;
        Object.assign(up, t && t.pid === id ? nextTurnUpdate(null, id) : {});
        store.update(up);
      }
    });
    panelBuilt = true;
  }
  function renderHostPanel() {
    const p = $("#hostpanel");
    if (!IS_HOST) { p.hidden = true; return; }
    p.hidden = false;
    if (!panelBuilt) buildHostPanel();
    $("#hp-players").innerHTML = playerRows(true);
    const rb = $("#hp-reset");
    rb.textContent = resetArmed ? "Tap again to clear everything" : "New game";
  }

  // ---------- boot ----------
  setType("truth");
  store.on((data) => {
    S = data || {};
    checkWaiting();
    render();
    hostTick();
  });
  if (IS_HOST) { heartbeat(); setInterval(heartbeat, 20000); }
  setInterval(() => { if (!IS_HOST) chips(); }, 30000);
})();
