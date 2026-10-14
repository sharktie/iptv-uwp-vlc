/* livetv/epg.js — the programme guide: fetching, caching, the timeline window,
 * and the coloured strips drawn on each channel row.
 *
 * Three sources feed one cache, keyed by stream id:
 *   • Xtream get_short_epg   — per channel, batched, and abandoned entirely on
 *                              the first 403 (the panel has EPG switched off
 *                              for this account, so every further request is a
 *                              wasted round trip)
 *   • M3U                    — no server-side guide at all; returns empty
 *   • XMLTV                  — a user-supplied file, merged over the top
 *
 * Times are the fiddly part: Xtream returns BOTH Unix timestamps and localised
 * strings, and only the timestamps are unambiguous. epgStart/epgEnd prefer
 * them and fall back to parsing the strings as UTC.
 *
 * Requires: livetv/state.js.
 */

// ── EPG disk cache ────────────────────────────────────────────────────────────

/* Namespaced per profile. The cache is keyed internally by stream_id, and
   Xtream stream ids are small integers starting near 1 — so two providers
   collide on almost every id. With one global key, switching profiles left the
   previous provider's guide in place and drew its programme titles and times
   against the new provider's channels for the whole 30-minute TTL. */
const EPG_CACHE_BASE   = "iptv_epg_v2";
const EPG_CACHE_LEGACY = EPG_CACHE_BASE;      // the old unscoped key
const EPG_TTL_MS       = 30 * 60 * 1000;

function epgCacheKey() {
    var scope = "none";
    try { scope = Config.scope(); } catch (e) {}
    return EPG_CACHE_BASE + ":" + scope;
}

function loadEpgDiskCache() {
    /* The unscoped key can only hold another profile's data now, and it is one
       of the largest things in a store with a ~5 MB ceiling. Drop it once. */
    Store.remove(EPG_CACHE_LEGACY);
    return Store.cacheGet(epgCacheKey(), EPG_TTL_MS) || {};
}

// Writing is debounced because the guide arrives in batches of four channels
// and each batch would otherwise serialise the entire cache again — on a large
// category that is hundreds of full re-serialisations during one scroll.
let _epgSaveTimer = null;
function scheduleEpgSave() {
    clearTimeout(_epgSaveTimer);
    _epgSaveTimer = setTimeout(() => {
        // `null` marks "request in flight" and must not be persisted — on the
        // next launch it would read as "already fetched, nothing found" and
        // that channel would show no guide until the cache expired. XMLTV
        // listings are skipped too: they have their own cache, and storing
        // them twice is how a large guide pushed the channel list out.
        const toSave = {};
        for (const [k, v] of Object.entries(epgCache)) {
            if (Array.isArray(v) && !(v.length && v[0] && v[0]._plain)) toSave[k] = v;
        }
        Store.cacheSet(epgCacheKey(), toSave);
    }, 2000);
}


// ── EPG loading ───────────────────────────────────────────────────────────────

/* `null` in epgCache means "request in flight". Every path out of the loader
   below has to hand those entries back, because the retry filter only picks up
   `undefined` — an entry left at `null` is never fetched again for the rest of
   the session, and buildEpgStrip draws it as a permanent "Loading…". Switching
   category mid-load is the ordinary way that happened. */
function releaseInFlightEpg(list) {
    let n = 0;
    for (let i = 0; i < list.length; i++) {
        const id = list[i].stream_id;
        if (epgCache[id] === null) { delete epgCache[id]; n++; }
    }
    return n;
}

/* Only the rows around the viewport are fetched. This used to request the
   guide for EVERY channel in the list — on "All" with a 20 000-channel
   provider that was 20 000 get_short_epg calls, four at a time, for as long as
   the page stayed open: thousands of requests for rows nobody scrolled to,
   enough to get an account rate-limited by its panel, and a guide cache that
   filled the storage quota. Scrolling asks again (see channels.js), so every
   row still gets its guide by the time it is on screen. */
const EPG_ROWS_BEHIND = 8;
const EPG_ROWS_AHEAD  = 24;

function _epgWindowChannels() {
    const list = (typeof _vsChannels !== "undefined" && _vsChannels.length) ? _vsChannels : getFilteredChannels();
    if (!list.length) return [];
    const rowH  = (typeof VS_ROW_H !== "undefined" && VS_ROW_H > 0) ? VS_ROW_H : 96;
    const top   = typeof _vsScrollTop !== "undefined" ? _vsScrollTop : 0;
    const h     = (typeof _vsHeight !== "undefined" && _vsHeight > 0) ? _vsHeight : window.innerHeight;
    const first = Math.max(0, Math.floor(top / rowH) - EPG_ROWS_BEHIND);
    const last  = Math.min(list.length - 1, Math.ceil((top + h) / rowH) + EPG_ROWS_AHEAD);
    return list.slice(first, last + 1);
}

let _epgLoadTimer = null;
function scheduleEpgWindowLoad(delay) {
    clearTimeout(_epgLoadTimer);
    _epgLoadTimer = setTimeout(loadEPGForCurrentCategory, delay === undefined ? 250 : delay);
}

async function loadEPGForCurrentCategory() {
    if (epgBlocked) return;
    const myKey  = ++epgLoadAbortKey;
    const needed = _epgWindowChannels().filter(ch => epgCache[ch.stream_id] === undefined);
    if (!needed.length) return;
    needed.forEach(ch => { epgCache[ch.stream_id] = null; });

    try {
        const BATCH = 4;
        for (let i = 0; i < needed.length; i += BATCH) {
            if (epgLoadAbortKey !== myKey || epgBlocked) return;
            await Promise.all(needed.slice(i, i + BATCH).map(async ch => {
                if (epgBlocked) return;
                try {
                    epgCache[ch.stream_id] = ch._source === "m3u"
                        ? await m3uGetEPG(ch.stream_id)
                        : await xtreamGetEPG(cfg, ch.stream_id);
                } catch (err) {
                    /* A 403 means this account has EPG switched off at the panel —
                       every remaining request would get the same answer, so stop
                       asking entirely rather than firing one per channel. Matched
                       on the status Net attaches, not on the digits "403" appearing
                       somewhere in a message. */
                    if (Net.isHttpError(err, 403) || Net.isHttpError(err, 401)) {
                        epgBlocked = true;
                    } else {
                        epgCache[ch.stream_id] = [];
                    }
                }
            }));
            if (epgLoadAbortKey !== myKey || epgBlocked) return;
            needed.slice(i, i + BATCH).forEach(ch => patchEpgStrip(ch.stream_id));
        }
        scheduleEpgSave();
    } finally {
        /* Covers every exit: the two aborts above, an epgBlocked bail inside a
           batch, a throw, and the normal finish (where nothing is left null).
           A superseding call computed its own list while these were still
           marked in flight and so skipped them — ask again once they are
           released, or rows on screen would sit on "Loading…". */
        if (releaseInFlightEpg(needed) && !epgBlocked && epgLoadAbortKey !== myKey) {
            scheduleEpgWindowLoad();
        }
    }
}


// ── Timeline ──────────────────────────────────────────────────────────────────

function getTimelineStart() {
    const now     = new Date();
    const rounded = Math.floor((now.getHours() * 60 + now.getMinutes()) / 30) * 30;
    const d       = new Date(now);
    d.setHours(0, rounded + timelineOffset, 0, 0);
    return d;
}
function getTimelineEnd() { return new Date(getTimelineStart().getTime() + TIMELINE_HOURS * 3600000); }

function setupTimelineNav() {
    document.getElementById("tl-prev").addEventListener("click", () => { timelineOffset -= 60; refreshTimeline(); });
    document.getElementById("tl-next").addEventListener("click", () => { timelineOffset += 60; refreshTimeline(); });
    document.getElementById("tl-now").addEventListener("click",  () => { timelineOffset  = 0;  refreshTimeline(); });
}
function refreshTimeline() { renderTimelineHeader(); getFilteredChannels().forEach(ch => patchEpgStrip(ch.stream_id)); }

function renderTimelineHeader() {
    const header = document.getElementById("tl-time-header");
    const start  = getTimelineStart();
    const frag   = document.createDocumentFragment();
    for (let i = 0; i < TIMELINE_HOURS * 2; i++) {
        const t = new Date(start.getTime() + i * 30 * 60000);
        const d = document.createElement("div");
        d.className = "tl-header-slot";
        d.textContent = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        frag.appendChild(d);
    }
    header.innerHTML = ""; header.appendChild(frag);
    const tlS = getTimelineStart().getTime(), tlE = getTimelineEnd().getTime();
    const pct = ((Date.now() - tlS) / (tlE - tlS)) * 100;
    const line = document.getElementById("tl-now-line");
    if (pct >= 0 && pct <= 100) { line.style.left = pct + "%"; line.style.display = "block"; }
    else line.style.display = "none";
}


// ── EPG strip rendering ───────────────────────────────────────────────────────

function patchEpgStrip(streamId) {
    const entry = rowCache.get(String(streamId));
    if (entry) buildEpgStrip(entry.epgStrip, String(streamId));
}

function buildEpgStrip(strip, sid) {
    const listings = epgCache[sid];
    const tlStart  = getTimelineStart().getTime();
    const tlEnd    = getTimelineEnd().getTime();
    const tlDur    = tlEnd - tlStart;

    if (listings === undefined || listings === null) {
        if (strip.dataset.state === "loading") return;
        strip.innerHTML = ""; strip.dataset.state = "loading";
        const ph = document.createElement("div");
        ph.className = "tl-epg-block tl-loading"; ph.style.cssText = "left:0%;width:calc(100% - 2px)"; ph.textContent = "Loading…";
        strip.appendChild(ph); return;
    }
    if (!listings.length) {
        if (strip.dataset.state === "empty") return;
        strip.innerHTML = ""; strip.dataset.state = "empty";
        const ph = document.createElement("div");
        ph.className = "tl-epg-block tl-no-epg"; ph.style.cssText = "left:0%;width:calc(100% - 2px)"; ph.textContent = "No EPG";
        strip.appendChild(ph); return;
    }

    // Skip re-render if already built from THIS data for this timeline window.
    // The data matters as much as the window: when an XMLTV guide arrives it
    // replaces the panel's listings for the same channel, and a strip that
    // only compared the window kept drawing the old programmes.
    if (strip.dataset.state === "filled" && strip.dataset.tlStart === String(tlStart) &&
        strip._listings === listings) return;

    strip.dataset.state = "filled"; strip.dataset.tlStart = String(tlStart); strip.innerHTML = "";
    strip._listings = listings;
    const now  = Date.now();
    const frag = document.createDocumentFragment();

    listings.forEach(e => {
        const eStart = epgStart(e), eEnd = epgEnd(e);
        if (eEnd <= tlStart || eStart >= tlEnd) return;
        const cs    = Math.max(eStart, tlStart), ce = Math.min(eEnd, tlEnd);
        const left  = ((cs - tlStart) / tlDur) * 100;
        const width = ((ce - cs)      / tlDur) * 100;
        const isNow  = now >= eStart && now < eEnd;
        const isPast = eEnd < now;

        const block = document.createElement("div");
        block.className = "tl-epg-block" + (isNow ? " tl-now" : "") + (isPast ? " tl-past" : "");
        block.style.left  = left + "%";
        block.style.width = `calc(${width}% - 2px)`;

        const timeSpan  = document.createElement("span"); timeSpan.className = "tl-block-time";  timeSpan.textContent = `${fmtTime(eStart)}–${fmtTime(eEnd)}`;
        const titleSpan = document.createElement("span"); titleSpan.className = "tl-block-title"; titleSpan.textContent = epgTitle(e);
        block.appendChild(timeSpan); block.appendChild(titleSpan);

        if (isNow) {
            const fill = document.createElement("div"); fill.className = "tl-progress-fill";
            fill.style.width = ((now - eStart) / (eEnd - eStart) * 100) + "%";
            block.appendChild(fill);
        }
        block.addEventListener("click", ev => {
            ev.stopPropagation();
            const cached = rowCache.get(sid);
            if (cached) { const ch = allChannels.find(c => String(c.stream_id) === sid); if (ch) selectChannel(ch); }
        });
        frag.appendChild(block);
    });
    strip.appendChild(frag);
}


// ── EPG time helpers ──────────────────────────────────────────────────────────

/* Memoised because a full guide re-parses the same handful of strings per
   channel — but bounded, because the key is provider text: a 20 000-channel
   panel that returns no `start_timestamp` (the only case that reaches here)
   would otherwise leave a couple of hundred thousand entries in it for the
   session. Cleared wholesale rather than evicted one at a time; the parse is
   cheap and this only has to stop being unbounded. */
const EPG_TIME_CACHE_MAX = 20000;
let _epgTimeCache = Object.create(null);
let _epgTimeCacheN = 0;

function parseEpgTime(s) {
    if (!s) return 0;
    if (_epgTimeCache[s] !== undefined) return _epgTimeCache[s];
    if (++_epgTimeCacheN > EPG_TIME_CACHE_MAX) {
        _epgTimeCache = Object.create(null);
        _epgTimeCacheN = 1;
    }
    // The `start`/`end` strings are in the provider's timezone (unknown), so we
    // can't parse them reliably — used only as a fallback. Treated as UTC.
    return (_epgTimeCache[s] = new Date(s.replace(" ", "T") + "Z").getTime());
}
// Prefer the Unix-epoch timestamps: they're absolute UTC and unambiguous, which
// avoids the constant timezone offset the localized strings caused.
function epgStart(e) {
    if (e && e.start_timestamp) return Number(e.start_timestamp) * 1000;
    return parseEpgTime(e && e.start);
}
function epgEnd(e) {
    const ts = e && (e.stop_timestamp || e.end_timestamp);
    if (ts) return Number(ts) * 1000;
    return parseEpgTime(e && e.end);
}
// Current programme + the one after it. Falls back to the first two listings
// when nothing matches "now" (e.g. all-future or stale EPG data).
function _findNowNext(listings) {
    const now = Date.now();
    const idx = listings.findIndex(e => { const s = epgStart(e), n = epgEnd(e); return now >= s && now < n; });
    return { cur: listings[idx >= 0 ? idx : 0], next: listings[idx >= 0 ? idx + 1 : 1] };
}
function fmtTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function formatTimeRange(e) {
    const a = fmtTime(epgStart(e)), b = fmtTime(epgEnd(e));
    return a && b ? `${a} – ${b}` : (a || "");
}
function calcProgress(e) {
    try {
        const s = epgStart(e), en = epgEnd(e), now = Date.now();
        if (now < s || now > en) return 0;
        return Math.round(((now - s) / (en - s)) * 100);
    } catch { return 0; }
}

/* Xtream sends titles and descriptions base64-encoded; XMLTV sends plain text
   and its entries are marked `_plain`. Decoding a plain title as base64 is not
   harmless — "News" and "Golf" are valid base64 and came out as binary junk. */
function epgTitle(e) { return !e ? "" : e._plain ? (e.title || "") : xtreamDecodeEPG(e.title); }
function epgDesc(e)  { return !e ? "" : e._plain ? (e.description || "") : xtreamDecodeEPG(e.description); }


// ── XMLTV / custom EPG ────────────────────────────────────────────────────────
//
// A user-supplied guide, from (in order) the active profile's EPG URL, the
// app-wide one in Settings → EPG, or the url-tvg an M3U playlist names in its
// own header. Both settings used to be saved and then never read: nothing
// called the loader, so a configured guide simply never appeared.
//
// Parsed with regular expressions rather than DOMParser. A full XMLTV file is
// tens of MB; building a DOM of it on a TV is the slowest and most
// memory-hungry way to read it, where a forward scan over the text holds
// nothing but the programmes being kept.

const XMLTV_CACHE_KEY = "iptv_xmltv_cache";
const XMLTV_TTL_MS    = 12 * 60 * 60 * 1000;
const XMLTV_TIMEOUT   = 60000;
/* Only what the timeline can show. Guides run days ahead, and keeping all of
   it neither fits the storage quota nor is worth the TV's memory. */
const XMLTV_KEEP_BEHIND_MS = 3 * 60 * 60 * 1000;
const XMLTV_KEEP_AHEAD_MS  = 30 * 60 * 60 * 1000;
const XMLTV_DESC_MAX       = 400;

let xmltvCache = {};
let _xmltvLoading = "";

function xmltvSource(playlistEpgUrl) {
    let active = null;
    try { active = Config.resolve(); } catch (_) {}
    const own = active && active.epg_url ? String(active.epg_url).trim() : "";
    const app = String(Store.get("iptv_custom_epg_url", "") || "").trim();
    return {
        url:   own || app || String(playlistEpgUrl || "").trim(),
        match: (own ? active.epg_match : Store.get("iptv_custom_epg_match", "")) || "tvg-id"
    };
}

/* The entry point, called once the channel list is known. */
function loadXMLTV(playlistEpgUrl) {
    const src = xmltvSource(playlistEpgUrl);
    if (!src.url) return;
    if (loadXMLTVFromCache(src.url)) {
        xmltvCache.matchField = src.match;
        mergeXMLTVIntoEpgCache();
        refreshTimeline();
        return;
    }
    loadCustomXMLTV(src.url, src.match);
}

async function loadCustomXMLTV(url, matchField) {
    if (!url || _xmltvLoading === url) return;
    _xmltvLoading = url;
    try {
        const text = await Net.text(url, { timeout: XMLTV_TIMEOUT });
        if (text.indexOf("<programme") === -1) {
            throw new Error(/\.gz(\?|$)/i.test(url)
                ? "Compressed (.gz) guides can't be read on the TV — use the plain .xml address."
                : "That address didn't return an XMLTV guide.");
        }
        const now    = Date.now();
        const parsed = parseXMLTV(text, now - XMLTV_KEEP_BEHIND_MS, now + XMLTV_KEEP_AHEAD_MS);
        xmltvCache = { url, programmes: parsed.programmes, channelMap: parsed.channelMap, matchField };
        Store.cacheSet(XMLTV_CACHE_KEY, xmltvCache);

        const count = Object.keys(parsed.programmes).length;
        setSettingsStatus("epg-load-status", `✓ Loaded ${count} channels from XMLTV.`, "ok");
        mergeXMLTVIntoEpgCache();
        refreshTimeline();
    } catch (err) {
        setSettingsStatus("epg-load-status", "Error: " + err.message, "err");
    } finally {
        _xmltvLoading = "";
    }
}

const _XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" };

function _charFromCode(code) {
    if (!(code > 0 && code < 0x110000)) return "";
    if (code <= 0xFFFF) return String.fromCharCode(code);
    code -= 0x10000;                     // String.fromCodePoint is Chromium 41+
    return String.fromCharCode(0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF));
}

function _xmlText(s) {
    return String(s || "")
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]*>/g, "")
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent) => {
            if (ent.charAt(0) === "#") {
                const x = ent.charAt(1) === "x" || ent.charAt(1) === "X";
                return _charFromCode(parseInt(ent.slice(x ? 2 : 1), x ? 16 : 10)) || m;
            }
            const named = _XML_ENTITIES[ent.toLowerCase()];
            return named !== undefined ? named : m;
        });
}

const _xmlAttrRe = {};
function _xmlAttr(attrs, name) {
    const re = _xmlAttrRe[name] || (_xmlAttrRe[name] = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')"));
    const m = re.exec(attrs);
    return m ? _xmlText(m[1] !== undefined ? m[1] : m[2]) : "";
}

function parseXMLTV(text, keepFrom, keepTo) {
    const channelMap = {};
    const chRe = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
    let m;
    while ((m = chRe.exec(text))) {
        const id = _xmlAttr(m[1], "id");
        const dn = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/.exec(m[2]);
        channelMap[id] = (dn ? _xmlText(dn[1]).trim() : "") || id;
    }

    const programmes = {};
    const prRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
    while ((m = prRe.exec(text))) {
        const attrs = m[1];
        const stop  = parseXMLTVDate(_xmlAttr(attrs, "stop"));
        if (!stop || stop < keepFrom) continue;
        const start = parseXMLTVDate(_xmlAttr(attrs, "start"));
        if (!start || start > keepTo) continue;
        const chId = _xmlAttr(attrs, "channel");
        const t = /<title\b[^>]*>([\s\S]*?)<\/title>/.exec(m[2]);
        const d = /<desc\b[^>]*>([\s\S]*?)<\/desc>/.exec(m[2]);
        let desc = d ? _xmlText(d[1]).trim() : "";
        if (desc.length > XMLTV_DESC_MAX) desc = desc.slice(0, XMLTV_DESC_MAX - 1) + "…";
        (programmes[chId] || (programmes[chId] = [])).push({
            title: t ? _xmlText(t[1]).trim() : "",
            description: desc,
            start_timestamp: Math.floor(start / 1000),
            stop_timestamp:  Math.floor(stop / 1000),
            _plain: 1
        });
    }
    // Guides are not always in time order per channel; now/next assumes they are.
    Object.keys(programmes).forEach(k => {
        programmes[k].sort((a, b) => a.start_timestamp - b.start_timestamp);
    });
    return { channelMap, programmes };
}

/* "20240101203000 +0100". Computed with Date.UTC rather than by building an
   ISO string for Date to parse — older engines disagree about how to read an
   ISO string with an offset, and this needs no parsing at all. */
function parseXMLTVDate(str) {
    if (!str) return 0;
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-])?(\d{2})?(\d{2})?/.exec(String(str).trim());
    if (!m) return 0;
    let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    if (m[7] && m[8]) {
        const off = (+m[8] * 60 + +(m[9] || 0)) * 60000;
        t -= m[7] === "-" ? -off : off;
    }
    return t;
}

function loadXMLTVFromCache(url) {
    const data = Store.cacheGet(XMLTV_CACHE_KEY, XMLTV_TTL_MS);
    if (!data || !data.programmes || (url && data.url !== url)) return false;
    xmltvCache = data;
    return true;
}

function mergeXMLTVIntoEpgCache() {
    if (!xmltvCache.programmes) return;
    const matchField = xmltvCache.matchField || "tvg-id";
    const progs = xmltvCache.programmes;

    /* Lower-cased lookups built once, instead of a scan per channel. Ids are
       matched case-insensitively — "BBCOne.uk" in the guide and "bbcone.uk"
       on the channel are the same channel. */
    const byId = {};
    Object.keys(progs).forEach(id => { byId[id.toLowerCase()] = progs[id]; });
    const byName = {};
    for (const [xmlId, name] of Object.entries(xmltvCache.channelMap || {})) {
        if (progs[xmlId]) byName[String(name).toLowerCase()] = progs[xmlId];
    }

    allChannels.forEach(ch => {
        const name = String(ch.name || "").toLowerCase();
        let listings = null;
        if (matchField === "tvg-id") {
            listings = byId[String(ch.epg_channel_id || "").toLowerCase()] || byName[name] || null;
        } else {
            listings = byName[name] || null;
        }
        if (listings) epgCache[String(ch.stream_id)] = listings;
    });
}
