// ── M3U / M3U8 playlist support ───────────────────────────────────────────────
//
// Parses a remote M3U8 playlist URL and returns channels + categories in the
// same shape as xtreamGetLiveChannels / xtreamGetCategories so the rest of the
// app works without changes.
//
// #EXTINF attributes understood:
//   tvg-id, tvg-name, tvg-logo, group-title   (and #EXTGRP for the group)
// #EXTM3U attributes understood:
//   url-tvg / x-tvg-url — the playlist's own XMLTV guide

/* Keyed by the playlist URL. The old single key ("iptv_m3u_v1") survived a
   profile editing its playlist URL, so the previous playlist's channels kept
   loading from cache for up to four hours after the change. */
const M3U_CACHE_PREFIX = "iptv_m3u_v2:";
const M3U_CACHE_LEGACY = "iptv_m3u_v1";
const M3U_TTL_MS       = 4 * 60 * 60 * 1000;   // 4 hours
const M3U_TIMEOUT_MS   = 45000;                // a 20 000-channel playlist is several MB

/* The active profile's playlist. Read from the profile itself — the separate
   "iptv_m3u_config" key is only kept in step by the Save button, so any other
   way of activating a profile left Live TV loading the previous playlist (or
   none). The old key is still honoured for installs from before profiles. */
function m3uLoadConfig() {
    let cfg = null;
    try { cfg = Config.resolve(); } catch (_) {}
    if (cfg && cfg.type === "m3u" && cfg.playlist_url) return Promise.resolve(cfg);
    const stored = Store.get("iptv_m3u_config", null);
    if (stored?.playlist_url) return Promise.resolve(stored);
    if (window.IPTV_M3U_CONFIG?.playlist_url) return Promise.resolve(window.IPTV_M3U_CONFIG);
    return Promise.reject(new Error("No M3U playlist URL configured"));
}

// ── Disk cache ────────────────────────────────────────────────────────────────

function _m3uCacheKey(url) { return M3U_CACHE_PREFIX + Config.hash(String(url || "")); }

/* `_source` is the same on every row, and at 20 000 channels that one field
   is a few hundred KB of a ~5 MB store — so it is dropped on the way in and
   put back on the way out. */
function m3uLoadCache(url) {
    Store.remove(M3U_CACHE_LEGACY);
    const hit = Store.cacheGet(_m3uCacheKey(url), M3U_TTL_MS);
    if (!hit || !Array.isArray(hit.channels) || !hit.channels.length) return null;
    hit.channels.forEach(ch => { ch._source = "m3u"; });
    return { channels: hit.channels, categories: hit.categories || [], epgUrl: hit.epgUrl || "" };
}

function m3uSaveCache(url, parsed) {
    const channels = parsed.channels.map(ch => ({
        stream_id: ch.stream_id, name: ch.name, stream_icon: ch.stream_icon,
        epg_channel_id: ch.epg_channel_id, category_id: ch.category_id, stream_url: ch.stream_url
    }));
    Store.cacheSet(_m3uCacheKey(url), { channels, categories: parsed.categories, epgUrl: parsed.epgUrl || "" });
}

function m3uClearCache() {
    Store.remove(M3U_CACHE_LEGACY);
    Store.removeByPrefix(M3U_CACHE_PREFIX);
}

// ── Parser ────────────────────────────────────────────────────────────────────

const _attrReCache = {};
function _parseAttr(extinf, attr) {
    let re = _attrReCache[attr];
    // Handles: attr="value"  attr='value'  attr=value (unquoted)
    if (!re) re = _attrReCache[attr] = new RegExp('(?:^|[\\s,])' + attr + '=(?:"([^"]*)"|\'([^\']*)\'|([^\\s"\',]*))', "i");
    const m = extinf.match(re);
    return m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] || "").trim() : "";
}

/* The display name is whatever follows the first comma that is NOT inside a
   quoted attribute. Splitting on the first comma outright broke on the very
   common group-title="News, UK": the "name" became ` UK" tvg-logo=…,BBC One`. */
function _extinfName(extinf) {
    let quote = "";
    for (let i = 0; i < extinf.length; i++) {
        const c = extinf[i];
        if (quote) { if (c === quote) quote = ""; continue; }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === ",") return extinf.slice(i + 1).trim();
    }
    return "";
}

function m3uParse(text) {
    // Normalise all line-ending styles (\r\n, \r, \n) before splitting
    const lines      = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
    const channels   = [];
    const catSet     = new Map();   // category_name → category_id
    let   extinf     = null;
    let   extgrp     = "";
    let   streamId   = 1;
    let   epgUrl     = "";

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (line.startsWith("#EXTM3U")) {
            epgUrl = (_parseAttr(line, "url-tvg") || _parseAttr(line, "x-tvg-url")).split(",")[0].trim();
            continue;
        }
        if (line.startsWith("#EXTINF")) {
            extinf = line;
            extgrp = "";
            continue;
        }
        if (line.startsWith("#EXTGRP:")) {
            extgrp = line.slice(8).trim();
            continue;
        }

        // Skip other directives
        if (line.startsWith("#")) continue;

        // This line is a URL — pair with the preceding #EXTINF
        if (extinf) {
            const name     = _extinfName(extinf) || _parseAttr(extinf, "tvg-name") || "Unknown";
            const tvgId    = _parseAttr(extinf, "tvg-id")    || _parseAttr(extinf, "tvg-name") || name;
            const logo     = _parseAttr(extinf, "tvg-logo");
            const group    = _parseAttr(extinf, "group-title") || extgrp || "Uncategorised";

            if (!catSet.has(group)) catSet.set(group, String(catSet.size + 1));
            const categoryId = catSet.get(group);

            channels.push({
                stream_id:      streamId++,
                name,
                stream_icon:    logo,
                epg_channel_id: tvgId,
                category_id:    categoryId,
                // M3U channels carry their URL directly — stored here so
                // xtreamBuildLiveURL can be skipped
                stream_url:     line,
                _source:        "m3u",
            });

            extinf = null;
            extgrp = "";
        }
    }

    const categories = [];
    catSet.forEach((id, name) => { categories.push({ category_id: id, category_name: name }); });

    return { channels, categories, epgUrl };
}

// ── Fetch + parse ─────────────────────────────────────────────────────────────

/* Through Net so the timeout is real on every webOS version — a bare fetch +
   AbortController never timed out on webOS 4/5, where the controller is a stub. */
async function m3uFetchPlaylist(url) {
    const text = await Net.text(url, { timeout: M3U_TIMEOUT_MS });
    // A playlist without the #EXTM3U header is common enough to accept; one
    // without a single #EXTINF is an HTML error page or a login wall.
    if (text.indexOf("#EXTINF") === -1) throw new Error("Not a valid M3U playlist");
    return m3uParse(text);
}

// ── Public API (mirrors xtream shape) ─────────────────────────────────────────

async function m3uGetChannelsAndCategories(m3uCfg) {
    return m3uFetchPlaylist(m3uCfg.playlist_url);
}

// M3U channels have no server-side EPG API — return empty so the app
// falls back to XMLTV if the user has configured one.
function m3uGetEPG(/*streamId*/) {
    return Promise.resolve([]);
}

// Build the playback URL for an M3U channel — it's stored directly on the
// channel object, so just return it.
function m3uBuildLiveURL(channel) {
    return channel.stream_url || "";
}
