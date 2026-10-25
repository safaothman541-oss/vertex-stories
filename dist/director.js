// Vertex Story Studio - director runtime (runtime/director.js)
//
// Loaded by the story-engine character's custom code in Perchance AI Character Chat (ACC), e.g.
//   const m = await import("https://cdn.jsdelivr.net/gh/safaothman541-oss/vertex-stories@main/dist/director.js");  // = runtime/director.js, published as dist/director.js
//   m.start(oc);
//
// Dependency-free ES module. It only uses the documented custom-code API:
//   oc.thread.messages (push; message props author, content, name, hiddenFrom, expectsReply, avatar, customData),
//   oc.thread.on("MessageAdded", ...), oc.thread.customData, oc.character.customData.PUBLIC.
//   It also sets oc.thread.character.name (and avatar.url) to the speaker while a turn is written, so ACC prompts
//   the model as that speaker; both are reset to null (= the character's own) when auto-play stops.
// It runs entirely inside the user's own ACC tab, with ACC's own AI. It never contacts perchance.org.
//
// How a turn works (matches the ACC source): a message pushed by custom code does NOT fire MessageAdded, but
// once ACC syncs it, ACC replies when the last AI-visible message has expectsReply:true. So the director pushes
// a hidden-from-user system instruction "[DIRECTOR] ..." with expectsReply:true, ACC's AI writes the turn, and
// MessageAdded for that AI message lets the director name it after the speaker and schedule the next turn.
// An answered (or abandoned) instruction is then hidden from the AI too, so at most one [DIRECTOR] note is ever
// in the model's context.
//
// Plan (oc.character.customData.PUBLIC.vsPlan, or the JSON at plan.planUrl). Accepted shape:
//   { id, title?, narrator?: {name, role?, avatarUrl?}, cast: [{id, name, role?, avatarUrl?}],
//     beats: [{id?, title, goal?, mustHappen?: [..], speakers: ["narrator" | cast id, ..], turns}],
//     paragraphLimit? | limits.paragraphLimit?, maxAutoTurns? | limits.maxAutoTurns?, planUrl? }
//   A full `vertex-story-v1` story source is accepted too (beats/limits are read from `story`).
//
// Thread state (oc.thread.customData.vs):
//   {beat, turnInBeat, totalTurns, auto, speakerIdx, lastSpeaker,
//    storyId, pending: null | {token, beat, speakerId, cancelled}, ended, runTurns, deferStart}
//   pending.cancelled: the turn was stopped (/stop, watchdog, reload); a late reply is still named and counted,
//   but auto-play does not continue. deferStart: /play arrived while ACC was answering a user message; the first
//   instruction is issued once that answer has arrived.
//
// Commands (user messages, exact text after trim): /play N, /stop, /next, /status.

export const VERSION = "1.0.0";

const REGISTRY_KEY = Symbol.for("vertex-story-studio.director");
const OWN = "vsDirector"; // message.customData marker on every message the director pushes

const DEFAULTS = {
  planTimeoutMs: 8000, // remote plan fetch timeout
  watchdogMs: 120000, // stop auto-play when no AI reply arrives in this time
  turnDelayMs: 1500, // pause between auto turns
  defaultPlayTurns: 6, // "/play" without a number
  pauseOnUserMessage: true, // a normal user message during auto-play pauses it
  noteName: "🎬 دەرهێنەر", // display name of the director's notes to the user
  hardMaxAutoTurns: 50, // absolute ceiling, whatever the plan says
};

const NARRATOR_DEFAULT_NAME = "چیرۆکبێژ";
const KU_DIGITS = "٠١٢٣٤٥٦٧٨٩";

// ---------------------------------------------------------------- small helpers

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v) {
  return typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

function clampInt(v, min, max, def) {
  let n = NaN;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && v.trim() !== "") n = Number(v.trim());
  if (!Number.isFinite(n)) return def;
  n = Math.trunc(n);
  return Math.min(max, Math.max(min, n));
}

function safeUrl(v) {
  const s = str(v);
  return /^https:\/\/\S+$/i.test(s) ? s : "";
}

function ku(n) {
  return String(n).replace(/[0-9]/g, (d) => KU_DIGITS[Number(d)]);
}

function toAsciiDigits(s) {
  return s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
}

function clip(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------- plan

/**
 * Validates and normalises a story plan. Never throws.
 * @returns {{ok: true, plan: object, warnings: string[]} | {ok: false, reason: string, warnings: string[]}}
 */
export function normalizePlan(input) {
  const warnings = [];
  const fail = (reason) => ({ ok: false, reason, warnings });
  let raw = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      return fail("plan is not valid JSON");
    }
  }
  if (!isObj(raw)) return fail("story plan is missing");
  if (raw.format === "vertex-story-v1" && isObj(raw.story)) {
    raw = {
      id: raw.id,
      title: raw.title,
      narrator: raw.narrator,
      cast: raw.cast,
      beats: raw.story.beats,
      paragraphLimit: raw.story.paragraphLimit,
      maxAutoTurns: raw.story.maxAutoTurns,
      planUrl: raw.planUrl,
    };
  }
  const id = str(raw.id) || str(raw.storyId);
  if (!id) return fail("story plan has no id");
  const limits = isObj(raw.limits) ? raw.limits : {};
  const castIn = Array.isArray(raw.cast) ? raw.cast : [];
  const narratorIn = isObj(raw.narrator) ? raw.narrator : castIn.find((c) => isObj(c) && c.id === "narrator") || {};
  const narrator = {
    id: "narrator",
    name: str(narratorIn.name) || NARRATOR_DEFAULT_NAME,
    role: str(narratorIn.role) || "narrator",
    avatarUrl: safeUrl(narratorIn.avatarUrl),
    isNarrator: true,
  };
  const known = new Set(["narrator"]);
  const cast = [];
  for (const c of castIn) {
    if (!isObj(c)) continue;
    const cid = str(c.id);
    const name = str(c.name);
    if (!cid || !name) {
      warnings.push("cast entry without id or name skipped");
      continue;
    }
    if (known.has(cid)) continue;
    known.add(cid);
    cast.push({ id: cid, name, role: str(c.role), avatarUrl: safeUrl(c.avatarUrl), isNarrator: false });
  }
  const beats = [];
  (Array.isArray(raw.beats) ? raw.beats : []).forEach((b, i) => {
    if (!isObj(b)) return;
    const wanted = (Array.isArray(b.speakers) ? b.speakers : []).map(str).filter(Boolean);
    let speakers = wanted.filter((s) => known.has(s));
    if (speakers.length !== wanted.length) warnings.push(`beat ${i + 1}: unknown speaker ids skipped`);
    if (!speakers.length) speakers = ["narrator"];
    beats.push({
      id: str(b.id) || `b${i + 1}`,
      title: str(b.title) || `#${i + 1}`,
      goal: str(b.goal),
      mustHappen: (Array.isArray(b.mustHappen) ? b.mustHappen : []).map(str).filter(Boolean),
      speakers,
      turns: clampInt(b.turns, 1, 50, 1),
    });
  });
  if (!beats.length) return fail("story plan has no beats");
  const plan = {
    id,
    title: str(raw.title),
    narrator,
    cast,
    beats,
    paragraphLimit: clampInt(raw.paragraphLimit ?? limits.paragraphLimit, 1, 10, 3),
    maxAutoTurns: clampInt(raw.maxAutoTurns ?? limits.maxAutoTurns, 1, DEFAULTS.hardMaxAutoTurns, 12),
    planUrl: safeUrl(raw.planUrl),
  };
  return { ok: true, plan, warnings };
}

function speakerById(plan, id) {
  if (id === "narrator") return plan.narrator;
  return plan.cast.find((c) => c.id === id) || null;
}

function speakerFor(plan, s) {
  const beat = plan.beats[Math.min(s.beat, plan.beats.length - 1)];
  const id = beat.speakers[s.speakerIdx % beat.speakers.length];
  return speakerById(plan, id) || plan.narrator;
}

// ---------------------------------------------------------------- state

function freshState(plan) {
  return {
    storyId: plan ? plan.id : null,
    beat: 0,
    turnInBeat: 0,
    totalTurns: 0,
    auto: 0,
    speakerIdx: 0,
    lastSpeaker: null,
    pending: null,
    ended: false,
    runTurns: 0,
    deferStart: false,
  };
}

function normalizeState(vs, plan) {
  const base = freshState(plan);
  if (!isObj(vs)) return base;
  if (plan && typeof vs.storyId === "string" && vs.storyId && vs.storyId !== plan.id) return base;
  const nBeats = plan ? plan.beats.length : 100000;
  const p = vs.pending;
  const s = {
    storyId: plan ? plan.id : typeof vs.storyId === "string" ? vs.storyId : null,
    beat: clampInt(vs.beat, 0, nBeats, 0),
    turnInBeat: clampInt(vs.turnInBeat, 0, 100000, 0),
    totalTurns: clampInt(vs.totalTurns, 0, 1e9, 0),
    auto: clampInt(vs.auto, 0, 100000, 0),
    speakerIdx: clampInt(vs.speakerIdx, 0, 1e9, 0),
    lastSpeaker: typeof vs.lastSpeaker === "string" ? vs.lastSpeaker : null,
    pending:
      isObj(p) && typeof p.token === "string" && p.token
        ? { token: p.token, beat: clampInt(p.beat, 0, nBeats, 0), speakerId: str(p.speakerId), cancelled: !!p.cancelled }
        : null,
    ended: !!vs.ended,
    runTurns: clampInt(vs.runTurns, 0, 100000, 0),
    deferStart: !!vs.deferStart,
  };
  if (plan) {
    if (s.beat >= plan.beats.length) s.ended = true;
    if (!s.ended && s.turnInBeat >= plan.beats[s.beat].turns) s.turnInBeat = plan.beats[s.beat].turns - 1;
  }
  if (s.ended) {
    s.auto = 0;
    s.deferStart = false;
  }
  return s;
}

// ---------------------------------------------------------------- commands

/** Parses a user message into a director command, or null. Exact text after trim; Kurdish digits allowed. */
export function parseCommand(content) {
  if (typeof content !== "string") return null;
  const t = toAsciiDigits(content).trim();
  let m = /^\/play(?:\s+([0-9]{1,6}))?$/i.exec(t);
  if (m) return { name: "play", n: m[1] === undefined ? null : parseInt(m[1], 10) };
  m = /^\/(stop|next|status)$/i.exec(t);
  if (m) return { name: m[1].toLowerCase() };
  return null;
}

// ---------------------------------------------------------------- instruction text (English, for the model)

/** Builds the hidden [DIRECTOR] instruction for the turn described by state `s` (plan must be normalised). */
export function buildInstruction(plan, s) {
  const beatIdx = Math.min(s.beat, plan.beats.length - 1);
  const beat = plan.beats[beatIdx];
  const speaker = speakerFor(plan, s);
  const T = beat.turns;
  const t = Math.min(s.turnInBeat, T - 1);
  const M = beat.mustHappen.length;
  // mustHappen items are spread over the beat's turns; items of earlier turns count as done.
  const lo = Math.floor((t * M) / T);
  const hi = t >= T - 1 ? M : Math.floor(((t + 1) * M) / T);
  const remaining = beat.mustHappen.slice(lo);
  const now = beat.mustHappen.slice(lo, hi);
  const lastBeat = beatIdx >= plan.beats.length - 1;
  const lines = [];
  lines.push(
    `[DIRECTOR] Story turn ${s.totalTurns + 1}. Beat ${beatIdx + 1} of ${plan.beats.length}: "${beat.title}" (message ${t + 1} of ${T} in this beat).`
  );
  const role = speaker.role ? ` (${speaker.role})` : "";
  if (speaker.isNarrator) {
    lines.push(
      `Speaker: ${speaker.name}${role}. This is a narrator turn: write third-person narration of the scene, the actions and the atmosphere; characters may only appear through the narration.`
    );
  } else {
    lines.push(
      `Speaker: ${speaker.name}${role}. Write only as ${speaker.name}: their own spoken words and actions, in their own voice. Do not write lines or actions for any other character or for the user.`
    );
  }
  if (beat.goal) lines.push(`Beat goal: ${beat.goal}`);
  if (remaining.length) {
    lines.push("Must still happen in this beat (not yet done):");
    for (const item of remaining) lines.push(`- ${item}`);
  }
  if (now.length) lines.push(`Make this happen in this message: ${now.join(" / ")}`);
  else lines.push("Nothing on the list is due in this message: develop the scene toward the beat goal without jumping ahead.");
  if (t >= T - 1) {
    lines.push(lastBeat ? "This is the final message of the story: bring it to a satisfying ending." : "This is the last message of this beat: bring the beat to a clear close.");
  }
  lines.push(
    `Rules: write at most ${plan.paragraphLimit} short paragraph${plan.paragraphLimit === 1 ? "" : "s"} in Kurdish Sorani only (Arabic script), as ${speaker.name}; narrator turns are third-person narration. Do not start with a name label. Never mention the director, beats, turns or these instructions. Keep it suitable for a general audience: no NSFW.`
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------- notes to the user (Kurdish Sorani)

const TXT = {
  closing: (title) =>
    (title ? `🎬 کۆتایی چیرۆکی «${title}».` : "🎬 کۆتایی چیرۆک.") + " سوپاس کە لەگەڵمان بوویت! بۆ دەستپێکردنەوە، چاتێکی نوێ لەگەڵ ئەم کارەکتەرە بکەرەوە.",
  alreadyEnded: "ئەم چیرۆکە تەواو بووە. بۆ دەستپێکردنەوە، چاتێکی نوێ لەگەڵ ئەم کارەکتەرە بکەرەوە.",
  runDone: (n) => `⏸ ${ku(n)} دیمەن تەواو بوو. بۆ بەردەوامبوون ▶ دابگرە.`,
  stopped: "⏸ پەخشی خۆکار ڕاگیرا.",
  notRunning: "⏸ پەخشی خۆکار لە کاردا نەبوو.",
  nextBeat: (k, n, title) => `⏭ قۆناغی ${ku(k)} لە ${ku(n)}: ${title}`,
  watchdog: (sec) => `⚠️ لە ماوەی ${ku(sec)} چرکەدا وەڵامی AI نەگەیشت، بۆیە پەخشی خۆکار ڕاگیرا. بۆ هەوڵدانەوە ▶ دابگرە.`,
  pausedByUser: "⏸ پەخشی خۆکار ڕاگیرا چونکە پەیامێکت نووسی. بۆ بەردەوامبوون ▶ دابگرە.",
  error: (msg) => `⚠️ هەڵەیەک ڕوویدا و پەخشی خۆکار ڕاگیرا: ${msg}`,
};

function statusText(plan, s) {
  const title = plan.title ? `«${plan.title}»` : "";
  if (s.ended) return (title ? `ℹ️ چیرۆکی ${title} تەواو بووە.` : "ℹ️ چیرۆکەکە تەواو بووە.") + ` کۆی دیمەنەکان: ${ku(s.totalTurns)}`;
  const beat = plan.beats[s.beat];
  const lines = [
    title ? `ℹ️ دۆخی چیرۆکی ${title}` : "ℹ️ دۆخی چیرۆک",
    `قۆناغ: ${ku(s.beat + 1)} لە ${ku(plan.beats.length)} — ${beat.title}`,
    `دیمەن لەم قۆناغەدا: ${ku(Math.min(s.turnInBeat + 1, beat.turns))} لە ${ku(beat.turns)}`,
    `قسەکەری داهاتوو: ${speakerFor(plan, s).name}`,
    `کۆی دیمەنەکان: ${ku(s.totalTurns)}`,
    `پەخشی خۆکار: ${s.auto > 0 ? `${ku(s.auto)} دیمەنی ماوە` : "ڕاگیراوە"}`,
  ];
  if ((s.pending && !s.pending.cancelled) || s.deferStart) lines.push("⏳ چاوەڕێی وەڵامی AI");
  return lines.join("\n");
}

// ---------------------------------------------------------------- director

/**
 * Starts the director for this chat thread. Idempotent: a second call with the same `oc` is a no-op that
 * returns the same controller.
 * @param {object} oc ACC custom-code object
 * @param {object} [options] {fetch, planTimeoutMs, watchdogMs, turnDelayMs, defaultPlayTurns, pauseOnUserMessage,
 *   noteName, setTimeout, clearTimeout, log}
 * @returns {{version: string, ready: Promise<void>, getPlan: Function, getPlanSource: Function, getState: Function, dispose: Function} | null}
 */
export function start(oc, options) {
  const log = (options && options.log) || globalThis.console;
  if (!oc || typeof oc !== "object" || !oc.thread || typeof oc.thread.on !== "function") {
    if (log) log.error("[vertex-story-director] start(oc): oc.thread.on is not available");
    return null;
  }
  let registry = globalThis[REGISTRY_KEY];
  if (!(registry instanceof WeakMap)) {
    registry = new WeakMap();
    globalThis[REGISTRY_KEY] = registry;
  }
  if (registry.has(oc)) return registry.get(oc);
  const controller = createDirector(oc, options || {});
  registry.set(oc, controller);
  return controller;
}

function createDirector(oc, options) {
  const opt = Object.assign({}, DEFAULTS);
  for (const k of Object.keys(options)) if (options[k] !== undefined && options[k] !== null) opt[k] = options[k];
  for (const k of ["planTimeoutMs", "watchdogMs", "turnDelayMs"]) opt[k] = clampInt(opt[k], 0, 3600000, DEFAULTS[k]);
  opt.defaultPlayTurns = clampInt(opt.defaultPlayTurns, 1, DEFAULTS.hardMaxAutoTurns, DEFAULTS.defaultPlayTurns);
  opt.hardMaxAutoTurns = clampInt(opt.hardMaxAutoTurns, 1, DEFAULTS.hardMaxAutoTurns, DEFAULTS.hardMaxAutoTurns);
  const log = opt.log || globalThis.console;
  const setT = typeof opt.setTimeout === "function" ? opt.setTimeout : (fn, ms) => globalThis.setTimeout(fn, ms);
  const clearT = typeof opt.clearTimeout === "function" ? opt.clearTimeout : (id) => globalThis.clearTimeout(id);

  let plan = null;
  let planError = null;
  let planSource = "none";
  let errorShown = false;
  let disposed = false;
  let turnTimer = null;
  let watchdogTimer = null;

  // ---- plan
  const embedded = normalizePlan(readEmbeddedPlan());
  if (embedded.ok) {
    plan = embedded.plan;
    planSource = "embedded";
    if (embedded.warnings.length) logWarn("plan warnings:", embedded.warnings.join("; "));
  } else {
    planError = embedded.reason;
  }

  // ---- a reload never resumes auto-play: stop auto/pending left over from a previous page load. The pending turn
  // is kept (cancelled), so a reply ACC was still writing for it is named and counted, without continuing.
  guarded(() => {
    const cd = oc.thread.customData;
    const vs = isObj(cd) ? cd.vs : null;
    if (isObj(vs) && (Number(vs.auto) > 0 || vs.deferStart || (isObj(vs.pending) && !vs.pending.cancelled))) {
      const s = normalizeState(vs, plan);
      cancelPending(s);
      s.auto = 0;
      s.deferStart = false;
      saveState(s);
    }
    clearReplySpeaker();
  });

  const ready = plan && plan.planUrl ? loadRemotePlan(plan).catch(() => {}) : Promise.resolve();

  oc.thread.on("MessageAdded", onMessageAdded);

  return {
    version: VERSION,
    ready,
    getPlan: () => plan,
    getPlanSource: () => planSource,
    getState: () => loadState(),
    dispose() {
      disposed = true;
      clearTurnTimer();
      clearWatchdog();
      try {
        if (typeof oc.thread.off === "function") oc.thread.off("MessageAdded", onMessageAdded);
      } catch (e) {
        /* ignore */
      }
    },
  };

  // ---------------------------------------------------------- internals

  function logWarn(...args) {
    try {
      if (log) log.warn("[vertex-story-director]", ...args);
    } catch (e) {
      /* ignore */
    }
  }

  function readEmbeddedPlan() {
    try {
      const cd = oc.character && oc.character.customData;
      const pub = cd && cd.PUBLIC;
      return pub ? pub.vsPlan : undefined;
    } catch (e) {
      return undefined;
    }
  }

  async function loadRemotePlan(embeddedPlan) {
    const fetchFn = typeof opt.fetch === "function" ? opt.fetch : typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null;
    if (!fetchFn) return;
    let timer = null;
    try {
      const body = await Promise.race([
        (async () => {
          const res = await fetchFn(embeddedPlan.planUrl, { cache: "no-cache" });
          if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "?"}`);
          if (typeof res.text === "function") return JSON.parse(await res.text());
          return await res.json();
        })(),
        new Promise((_, reject) => {
          timer = setT(() => reject(new Error(`timeout after ${opt.planTimeoutMs} ms`)), opt.planTimeoutMs);
        }),
      ]);
      const r = normalizePlan(body);
      if (!r.ok) throw new Error(r.reason);
      if (r.plan.id !== embeddedPlan.id) throw new Error(`story id mismatch (${r.plan.id} != ${embeddedPlan.id})`);
      r.plan.planUrl = embeddedPlan.planUrl;
      plan = r.plan;
      planSource = "remote";
    } catch (e) {
      logWarn("remote plan not used, keeping the embedded plan:", e && e.message ? e.message : e);
    } finally {
      if (timer !== null) clearT(timer);
    }
  }

  function threadData() {
    let cd = oc.thread.customData;
    if (!cd || typeof cd !== "object") {
      oc.thread.customData = {};
      cd = oc.thread.customData;
    }
    return cd;
  }

  function loadState() {
    return normalizeState(threadData().vs, plan);
  }

  // Always assign a fresh plain object through oc.thread.customData, so ACC notices the change.
  function saveState(s) {
    threadData().vs = JSON.parse(JSON.stringify(s));
  }

  function isOwn(message) {
    const cd = message.customData;
    return !!(cd && typeof cd === "object" && cd[OWN]);
  }

  function note(text, kind) {
    oc.thread.messages.push({
      author: "system",
      name: opt.noteName,
      hiddenFrom: ["ai"],
      expectsReply: false,
      content: text,
      customData: { [OWN]: "note", kind },
    });
  }

  function findInstruction(token) {
    const msgs = oc.thread.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const cd = m && m.customData;
      if (cd && cd[OWN] === "turn" && cd.token === token) return m;
    }
    return null;
  }

  // Marks the pending instruction so ACC will not answer it (if it has not started yet). It stays visible to the
  // AI (and s.pending stays set) because a reply may already be in progress; retireInstruction() hides it later.
  function cancelPending(s) {
    if (!s.pending || s.pending.cancelled) return;
    const ins = findInstruction(s.pending.token);
    if (ins) ins.expectsReply = false;
    s.pending.cancelled = true;
  }

  // An answered or abandoned instruction: hidden from the AI too, so stale [DIRECTOR] notes never pile up in
  // the model's context (and in ACC's summaries).
  function retireInstruction(token) {
    const ins = token ? findInstruction(token) : null;
    if (!ins) return;
    ins.expectsReply = false;
    ins.hiddenFrom = ["user", "ai"];
  }

  // Drops a pending turn (the caller saves the state) and retires its instruction.
  function dropPending(s) {
    if (!s.pending) return;
    retireInstruction(s.pending.token);
    s.pending = null;
  }

  // ---- reply name/avatar: ACC prompts the model as oc.thread.character.name (falling back to the character's
  // own name when null), so the speaker of the current turn is put there while the turn is written.
  function speakers() {
    return plan ? [plan.narrator, ...plan.cast] : [];
  }

  function threadCharacter() {
    try {
      const tc = oc.thread.character;
      return tc && typeof tc === "object" ? tc : null;
    } catch (e) {
      return null;
    }
  }

  // Best effort: a failure here only costs the prompt name, so it is logged and never stops the story.
  function setReplySpeaker(speaker) {
    try {
      setReplySpeakerUnsafe(speaker);
    } catch (e) {
      logWarn("could not set the reply name:", e && e.message ? e.message : e);
    }
  }

  function setReplySpeakerUnsafe(speaker) {
    const tc = threadCharacter();
    if (!tc) return;
    if (tc.name !== speaker.name) tc.name = speaker.name;
    // only speakers with their own avatar touch it; others fall back to the character's avatar
    const av = isObj(tc.avatar) ? tc.avatar : null;
    if (av && speakers().some((c) => c.avatarUrl)) {
      const url = speaker.avatarUrl || null;
      if (av.url !== url && (url || speakers().some((c) => c.avatarUrl && c.avatarUrl === av.url))) av.url = url;
    }
  }

  // Resets name/avatar to null (= the character's own), but only while they hold a name/avatar from the plan.
  function clearReplySpeaker(o) {
    try {
      clearReplySpeakerUnsafe(o);
    } catch (e) {
      logWarn("could not reset the reply name:", e && e.message ? e.message : e);
    }
  }

  function clearReplySpeakerUnsafe({ nameToo = true } = {}) {
    const tc = threadCharacter();
    if (!tc) return;
    const list = speakers();
    if (nameToo && typeof tc.name === "string" && list.some((c) => c.name === tc.name)) tc.name = null;
    const av = isObj(tc.avatar) ? tc.avatar : null;
    if (av && typeof av.url === "string" && av.url && list.some((c) => c.avatarUrl === av.url)) av.url = null;
  }

  // The last message the AI can see "expects a reply" the way ACC decides it (doBotReplyIfNeeded): ACC is
  // answering it right now, or will as soon as the current command has been stored.
  function aiIsAnswering(exclude) {
    const msgs = oc.thread.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m === exclude) continue;
      if (Array.isArray(m.hiddenFrom) && m.hiddenFrom.includes("ai")) continue;
      return m.author !== "ai" && !isOwn(m) && m.expectsReply !== false;
    }
    return false;
  }

  // True when the last AI-visible message before `message` is our instruction with this token.
  function followsInstruction(message, token) {
    const msgs = oc.thread.messages || [];
    let i = msgs.indexOf(message);
    if (i < 0) i = msgs.length - 1;
    for (let j = i - 1; j >= 0; j--) {
      const m = msgs[j];
      if (!m) continue;
      if (Array.isArray(m.hiddenFrom) && m.hiddenFrom.includes("ai")) continue;
      const cd = m.customData;
      return !!(cd && cd[OWN] === "turn" && cd.token === token);
    }
    return false;
  }

  function clearTurnTimer() {
    if (turnTimer !== null) {
      clearT(turnTimer);
      turnTimer = null;
    }
  }

  function clearWatchdog() {
    if (watchdogTimer !== null) {
      clearT(watchdogTimer);
      watchdogTimer = null;
    }
  }

  // The pending turn stays in the state (cancelled), so a reply that still arrives is named and counted.
  function armWatchdog(token) {
    clearWatchdog();
    watchdogTimer = setT(() => {
      watchdogTimer = null;
      guarded(() => {
        if (disposed || !plan) return;
        const s = loadState();
        if (!s.pending || s.pending.token !== token) return;
        const silent = s.pending.cancelled; // already stopped by the user
        cancelPending(s);
        s.auto = 0;
        clearTurnTimer();
        saveState(s);
        clearReplySpeaker();
        if (!silent) note(TXT.watchdog(Math.round(opt.watchdogMs / 1000)), "watchdog");
      });
    }, opt.watchdogMs);
  }

  // /play while ACC was answering a user message: if that answer never arrives, start anyway after watchdogMs
  // (ACC then answers the instruction, which is the last AI-visible message).
  function armDeferWatchdog() {
    clearWatchdog();
    watchdogTimer = setT(() => {
      watchdogTimer = null;
      guarded(() => {
        if (disposed || !plan) return;
        const s = loadState();
        if (!s.deferStart) return;
        s.deferStart = false;
        if (s.ended || s.auto <= 0 || s.pending) return saveState(s);
        issueTurn(s);
      });
    }, opt.watchdogMs);
  }

  function issueTurn(s) {
    const speaker = speakerFor(plan, s);
    const token = `t${s.totalTurns + 1}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const content = buildInstruction(plan, s);
    s.pending = { token, beat: s.beat, speakerId: speaker.id, cancelled: false };
    s.deferStart = false;
    saveState(s);
    setReplySpeaker(speaker);
    oc.thread.messages.push({
      author: "system",
      hiddenFrom: ["user"],
      expectsReply: true,
      content,
      customData: { [OWN]: "turn", token },
    });
    armWatchdog(token);
  }

  function scheduleNextTurn() {
    clearTurnTimer();
    turnTimer = setT(() => {
      turnTimer = null;
      guarded(() => {
        if (disposed || !plan) return;
        const s = loadState();
        if (s.ended || s.auto <= 0 || s.pending) return;
        issueTurn(s);
      });
    }, opt.turnDelayMs);
  }

  function endStory(s) {
    cancelPending(s);
    clearTurnTimer();
    s.ended = true;
    s.auto = 0;
    s.deferStart = false;
    s.beat = plan.beats.length;
    s.turnInBeat = 0;
    s.speakerIdx = 0;
    saveState(s);
    clearReplySpeaker();
    note(TXT.closing(plan.title), "end");
  }

  function applySpeaker(message, speaker) {
    message.name = speaker.name;
    let url = speaker.avatarUrl;
    // when some speakers have avatars, pin the others to the character's own avatar, so a thread avatar set for
    // a later speaker's turn cannot show up on this message
    if (!url && speakers().some((c) => c.avatarUrl)) {
      try {
        url = safeUrl(oc.character && oc.character.avatarUrl);
      } catch (e) {
        url = "";
      }
    }
    if (url) {
      const a = isObj(message.avatar) ? message.avatar : {};
      const av = {};
      if (typeof a.size === "number") av.size = a.size;
      if (typeof a.shape === "string") av.shape = a.shape;
      av.url = url;
      message.avatar = av;
    }
  }

  async function onMessageAdded(ev) {
    if (disposed) return;
    const message = ev && ev.message;
    if (!message || typeof message !== "object") return;
    try {
      if (isOwn(message)) return; // the director's own instructions and notes
      if (message.author === "user") {
        const cmd = parseCommand(message.content);
        if (cmd) {
          // the user still sees the command; the AI neither sees nor answers it
          message.expectsReply = false;
          message.hiddenFrom = ["ai"];
        }
        await ready;
        if (disposed) return;
        if (cmd) runCommand(cmd);
        else onUserMessage();
      } else if (message.author === "ai") {
        await ready;
        if (disposed) return;
        onAiMessage(message);
      }
    } catch (e) {
      reportError(e);
    }
  }

  function runCommand(cmd) {
    if (!plan) throw new Error(planError || "story plan is missing");
    if (cmd.name === "play") return cmdPlay(cmd.n);
    if (cmd.name === "stop") return cmdStop();
    if (cmd.name === "next") return cmdNext();
    if (cmd.name === "status") return note(statusText(plan, loadState()), "status");
  }

  function cmdPlay(n) {
    const s = loadState();
    if (s.ended) return note(TXT.alreadyEnded, "ended");
    const max = Math.min(plan.maxAutoTurns, opt.hardMaxAutoTurns);
    const turns = clampInt(n === null || n === undefined ? opt.defaultPlayTurns : n, 1, max, 1);
    clearTurnTimer();
    s.auto = turns;
    s.runTurns = turns;
    // a pending turn that was cancelled, or whose instruction got lost, must not block a new run
    if (s.pending && (s.pending.cancelled || !findInstruction(s.pending.token))) {
      dropPending(s);
      clearWatchdog();
    }
    if (s.pending) {
      // a turn is already being written; the run continues after it (with a fresh watchdog)
      s.deferStart = false;
      saveState(s);
      return armWatchdog(s.pending.token);
    }
    if (aiIsAnswering()) {
      // ACC is answering a user message (a shortcut button can be tapped meanwhile): start after that answer,
      // so it is not taken for the first story turn
      s.deferStart = true;
      saveState(s);
      return armDeferWatchdog();
    }
    issueTurn(s);
  }

  function cmdStop() {
    const s = loadState();
    clearTurnTimer();
    const wasRunning = s.auto > 0 || !!(s.pending && !s.pending.cancelled) || s.deferStart;
    s.auto = 0;
    s.deferStart = false;
    cancelPending(s); // a reply already being written is still named when it arrives
    saveState(s);
    clearReplySpeaker();
    note(wasRunning ? TXT.stopped : TXT.notRunning, "stop");
  }

  function cmdNext() {
    const s = loadState();
    if (s.ended) return note(TXT.alreadyEnded, "ended");
    s.beat += 1;
    s.turnInBeat = 0;
    s.speakerIdx = 0;
    if (s.beat >= plan.beats.length) return endStory(s);
    saveState(s);
    note(TXT.nextBeat(s.beat + 1, plan.beats.length, plan.beats[s.beat].title), "next");
  }

  function onUserMessage() {
    if (!opt.pauseOnUserMessage || !plan) return;
    const s = loadState();
    const active = s.auto > 0 || !!(s.pending && !s.pending.cancelled) || s.deferStart;
    if (!active) {
      // a stopped turn that never got its reply: ACC now answers the user, so drop it
      if (s.pending) {
        dropPending(s);
        saveState(s);
      }
      return;
    }
    clearTurnTimer();
    clearWatchdog();
    s.auto = 0;
    s.deferStart = false;
    cancelPending(s);
    dropPending(s); // ACC now answers the user's message, not our instruction
    saveState(s);
    clearReplySpeaker();
    note(TXT.pausedByUser, "pause");
  }

  function onAiMessage(message) {
    if (!plan) return;
    const s = loadState();
    if (!s.pending) {
      if (s.deferStart) {
        // ACC's answer to the user message that /play waited for: not a story turn; start the run now
        clearWatchdog();
        s.deferStart = false;
        saveState(s);
        if (!s.ended && s.auto > 0) scheduleNextTurn();
      }
      return;
    }
    if (!followsInstruction(message, s.pending.token)) return;
    clearWatchdog();
    const speaker = speakerById(plan, s.pending.speakerId) || speakerFor(plan, s);
    applySpeaker(message, speaker);
    retireInstruction(s.pending.token);
    const sameBeat = !s.ended && s.pending.beat === s.beat; // false after /next during the turn
    const wasCancelled = s.pending.cancelled;
    const autoBefore = s.auto;
    s.pending = null;
    s.totalTurns += 1;
    s.lastSpeaker = speaker.id;
    if (s.auto > 0) s.auto -= 1;
    if (sameBeat) {
      s.turnInBeat += 1;
      s.speakerIdx += 1;
      if (s.turnInBeat >= plan.beats[s.beat].turns) {
        s.beat += 1;
        s.turnInBeat = 0;
        s.speakerIdx = 0;
      }
    }
    if (!s.ended && s.beat >= plan.beats.length) return endStory(s);
    saveState(s);
    if (s.ended) return;
    if (s.auto > 0) {
      clearReplySpeaker({ nameToo: false }); // the next turn sets its own speaker
      return scheduleNextTurn();
    }
    clearReplySpeaker();
    if (autoBefore === 1 && !wasCancelled) note(TXT.runDone(s.runTurns || 1), "done");
  }

  function guarded(fn) {
    try {
      fn();
    } catch (e) {
      reportError(e);
    }
  }

  // Every error: logged, auto-play stopped; only the first one is shown to the user (hidden from the AI).
  function reportError(e) {
    try {
      if (log) log.error("[vertex-story-director]", e);
    } catch (x) {
      /* ignore */
    }
    try {
      clearTurnTimer();
      const s = loadState();
      if (s.auto > 0 || s.deferStart) {
        s.auto = 0;
        s.deferStart = false;
        saveState(s);
      }
      clearReplySpeaker();
    } catch (x) {
      /* ignore */
    }
    if (errorShown) return;
    errorShown = true;
    try {
      note(TXT.error(clip((e && e.message) || e || "unknown error", 200)), "error");
    } catch (x) {
      /* ignore */
    }
  }
}
