/* data/assrt.js — subtitle search against assrt.net. Exposes window.Assrt.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Diagnostics on a real provider, for a real film, said this:
 *
 *   sub src : files=0 embedded=0 | panel lists no subtitles
 *             sidecar: none — 2086518.srt: HTTP 551; …(9 candidates, all 551)
 *   panel sent: info{none; has kinopoisk_url, tmdb_id, name, …, runtime, status}
 *   subs    : 0 shown / 0 raw — platform exposed none      source: .mkv via native
 *
 * Read that carefully, because it closes every door at once. The panel's `info`
 * block is a pure CATALOGUE payload — plot, cast, genre, rating, runtime — with
 * no `subtitles` key and no ffprobe `streams` array anywhere in it. This
 * provider never probes its own files, so it will report subtitles for no title
 * ever, not just this one. No sidecar exists either. And the .mkv plays on the
 * platform decoder, which on this firmware exposes zero text tracks.
 *
 * So there is nothing to parse, nothing to fetch, and nothing to switch to. The
 * only remaining source of a subtitle for that film is an external database.
 *
 * The app already had one — OpenSubtitles — but it is gated behind a free API
 * key the user has to go and register for, so on a fresh install the subtitle
 * menu offers nothing at all. Assrt is the one worth adding next to it because
 * it needs NO signup: it publishes a shared OSS token, so search works on first
 * run with zero configuration.
 *
 * ── Honest limits ───────────────────────────────────────────────────────────
 * Assrt is a Chinese subtitle community. It indexes Chinese subtitles densely
 * and English ones sparsely, so for an English-language film it is a useful
 * fallback rather than a replacement for OpenSubtitles. Both are searched
 * together and the results merged; adding the free OpenSubtitles key is still
 * the better answer for English. Saying otherwise here would just move the dead
 * end somewhere less visible.
 *
 * ES5 — Babel target is Chrome 38.                                            */
window.Assrt = (function () {
    'use strict';

    var BASE      = 'https://api.assrt.net/v1';
    var KEY_TOKEN = 'assrt_token';        // optional personal token
    var SUB_EXT   = /\.(srt|vtt|ass|ssa)$/i;
    var TIMEOUT   = 12000;

    /* The public OSS token published in AssrtOSS/mpv-assrt (src/assrt.lua) for
       open-source clients. Shared, rate-limited, and explicitly offered for this
       purpose — a personal token from Settings overrides it. Its whole value is
       that search works before the user has configured anything. */
    var DEFAULT_TOKEN = 'tNjXZUnOJWcHznHDyalNMYqqP6IdDdpQ';

    function get(key, dflt) {
        try { return localStorage.getItem(key) || (dflt || ''); }
        catch (e) { return dflt || ''; }
    }

    function token() {
        var t = String(get(KEY_TOKEN, '')).replace(/^\s+|\s+$/g, '');
        return t || DEFAULT_TOKEN;
    }

    /* Always true, and that is the point: a token always exists, so the
       "Search online…" row can be offered on every title instead of being
       hidden behind setup the user has not done. */
    function configured() { return true; }

    /* Assrt labels a subtitle's language with a Chinese description rather than
       a code ("简体中文", "英文", "简繁英"). Mapped so the merged result list can
       be ranked by language alongside OpenSubtitles' ISO codes. Checked English
       first: a "简英" dual subtitle carries English text too, and for this app's
       users that is the more useful of the two labels. */
    function langOf(desc) {
        var d = String(desc || '');
        if (d.indexOf('英') !== -1) return 'en';
        if (d.indexOf('简') !== -1) return 'zh-CN';
        if (d.indexOf('繁') !== -1) return 'zh-TW';
        return 'zh';
    }

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    /* Assrt matches free text against the RELEASE name, so the query is built
       to look like one. A film's release name carries its own year, so
       title+year narrows well. An episode's release name carries the season's
       year rather than the series' first-air year, so sending the year there
       matches nothing — episodes go by SxxEyy instead. */
    function buildQuery(q) {
        q = q || {};
        if (q.manualQuery) return String(q.manualQuery).replace(/^\s+|\s+$/g, '');
        var parts = [q.title || ''];
        if (q.season || q.episode) {
            if (q.season != null && q.season !== '') {
                parts.push(q.episode != null && q.episode !== ''
                    ? 'S' + pad2(Number(q.season)) + 'E' + pad2(Number(q.episode))
                    : 'S' + pad2(Number(q.season)));
            }
        } else if (q.year) {
            parts.push(String(q.year));
        }
        var out = [];
        for (var i = 0; i < parts.length; i++) if (parts[i]) out.push(parts[i]);
        return out.join(' ').replace(/^\s+|\s+$/g, '');
    }

    /* ── Search ───────────────────────────────────────────────────────────────
       Rows come back in the SAME shape OpenSubtitles.search() produces, so the
       player's picker and download path treat both providers identically and
       neither needs to know the other exists. `provider` is the only extra
       field, and it exists solely so download() can be routed. */
    function search(q) {
        var query = buildQuery(q);
        /* Two characters matches half the database and wastes a request on a
           result list nobody can choose from. */
        if (query.length < 3) return Promise.resolve([]);

        var url = BASE + '/sub/search?token=' + encodeURIComponent(token()) +
                  '&cnt=15&q=' + encodeURIComponent(query);

        return Net.json(url, { timeout: TIMEOUT }).then(function (body) {
            /* Assrt signals failure in the BODY with a non-zero status, not with
               an HTTP code, so a bad token or a rate-limit arrives as a 200.
               THROW rather than returning [] — the built-in token is shared by
               every install of this app, so exhausting its quota is routine
               rather than exceptional, and reporting it as "no subtitles found"
               tells the user the title has none when the request was refused.
               The caller turns this into a visible reason. */
            if (!body) throw new Error('Assrt returned an empty reply.');
            if (body.status !== 0) throw statusError(body);
            var subs = (body.sub && body.sub.subs) || [];
            var out = [];
            for (var i = 0; i < subs.length; i++) {
                var s = subs[i];
                if (!s || s.id === undefined || s.id === null || s.id === '') continue;
                var desc = (s.lang && s.lang.desc) || '';
                out.push({
                    provider:  'assrt',
                    fileId:    String(s.id),
                    fileName:  String(s.videoname || ''),
                    lang:      langOf(desc),
                    release:   String(s.native_name || s.videoname || 'Subtitle'),
                    downloads: Number(s.down_count) || 0,
                    hearingImpaired: false,
                    /* Assrt indexes by release name and has no separate notion
                       of "which film is this" — so there is no verified title to
                       show, and inventing one from the release name would be a
                       guess dressed up as a match. Left blank; the picker falls
                       back to the release name. */
                    featureTitle: '',
                    featureYear:  '',
                    season:  null,
                    episode: null
                });
            }
            return out;
        });
    }

    /* ── Download ─────────────────────────────────────────────────────────────
       Returns { text, format } rather than a URL, because Assrt serves the file
       from a host with its own rules and the body has to be decoded here (see
       decode() below). The player accepts either shape.

       Two of the three routes his implementation has are kept. The third — a
       .zip that has to be inflated — is deliberately dropped: it needs a full
       DEFLATE implementation, it is the rare case even upstream ("filelist
       usually covers it"), and a clear "this one is a zip, pick another" beats
       shipping an inflater to this app for it. */
    function download(fileId, lang) {
        var url = BASE + '/sub/detail?token=' + encodeURIComponent(token()) +
                  '&id=' + encodeURIComponent(fileId);

        return Net.json(url, { timeout: TIMEOUT }).then(function (body) {
            if (body && body.status !== undefined && body.status !== 0) throw statusError(body);
            var sub = body && body.sub && body.sub.subs && body.sub.subs[0];
            if (!sub) throw new Error('Assrt returned no detail for that subtitle.');

            /* 1. A file Assrt has already extracted server-side. The common
                  case, and the only one that works for a multi-file archive. */
            var list = sub.filelist || [];
            for (var i = 0; i < list.length; i++) {
                var f = list[i];
                var name = strip(String((f && f.f) || ''));
                if (f && f.url && SUB_EXT.test(name)) {
                    return fetchText(String(f.url), name, lang);
                }
            }

            /* 2. A single un-archived file. */
            var direct = strip(String(sub.url || ''));
            if (sub.url && SUB_EXT.test(direct)) return fetchText(String(sub.url), direct, lang);

            if (sub.url && /\.zip$/i.test(direct)) {
                throw new Error('That subtitle is a .zip archive, which this app can’t open — try another result.');
            }
            throw new Error('Assrt had no downloadable file for that subtitle.');
        });
    }

    /* Assrt's documented failure statuses, named so the user gets an answer they
       can act on instead of a number. The quota one is the case that actually
       matters: the shared token is spent by everyone using this app, so "try
       again later, or add your own token" is the true and useful message. */
    var STATUS_TEXT = {
        20001: 'Assrt is rate-limiting the app’s shared token — try again in a minute.',
        20002: 'Assrt is rate-limiting the app’s shared token — try again in a minute.',
        20003: 'Assrt rejected the token. Clear any personal token in Settings to use the built-in one.',
        20004: 'Assrt’s daily quota for the app’s shared token is used up — try again tomorrow, or add your own free token.',
        20900: 'Assrt is temporarily unavailable.'
    };

    function statusError(body) {
        var code = body && body.status;
        var msg = STATUS_TEXT[code] ||
                  ((body && body.errmsg) ? 'Assrt: ' + body.errmsg
                                         : 'Assrt refused the request (status ' + code + ').');
        var err = new Error(msg);
        err.status = code;
        return err;
    }

    function strip(u) { return String(u).split('?')[0].split('#')[0]; }

    function formatOf(name) {
        var m = /\.([a-z0-9]+)$/i.exec(strip(String(name || '')));
        var ext = m ? m[1].toLowerCase() : '';
        return (ext === 'ass' || ext === 'ssa' || ext === 'vtt') ? ext : 'srt';
    }

    function fetchText(url, name, lang) {
        return Net.request(url, { timeout: TIMEOUT, responseType: 'arraybuffer' })
            .then(function (res) {
                /* Bytes are what this needs (see decode), but a Response without
                   arrayBuffer() must not be fatal — degrade to the decoded
                   string instead of throwing "res.arrayBuffer is not a
                   function". Feature-detected rather than assumed because the
                   app's fetch may be the XHR shim in polyfills.js on older
                   firmware, and its capabilities vary with what XHR there
                   supports. */
                if (typeof res.arrayBuffer === 'function') {
                    return res.arrayBuffer().then(function (buf) { return decode(buf, lang); });
                }
                return res.text();
            })
            .then(function (text) {
                return { text: text, format: formatOf(name), fileName: name };
            });
    }

    /* Subtitle files are frequently not UTF-8, and the wrong charset does not
       fail loudly — it renders as a screenful of the wrong characters, so the
       download looks like it worked. UTF-8 is tried STRICTLY first (fatal:true
       turns "wrong encoding" into a throw we can act on); what follows depends
       on the language, because the two plausible legacy encodings disagree
       about exactly the bytes that matter:

         Chinese      → GB18030
         everything   → windows-1252

       Ordering by language rather than always trying GB18030 first is the fix
       for a real failure: a CP1252 French or Spanish .srt has bytes like 0xE9
       for "é", and GB18030 maps those high bytes to CJK ideographs — so the
       subtitle came out as English words interleaved with Chinese characters.
       Plain ASCII is unaffected either way, which is why it survives casual
       testing and only shows up on accented text.

       A CJK sanity check backstops the ordering: if a non-Chinese result decodes
       to a lot of ideographs, the guess was wrong and the other encoding wins.

       TextDecoder is feature-detected rather than assumed — it exists on the
       Chrome 38 floor this app targets, but the set of supported encoding labels
       varies by build, and a missing one must degrade rather than throw. */
    function decode(buf, lang) {
        var bytes = new Uint8Array(buf);
        if (typeof TextDecoder !== 'function') return rawDecode(bytes);

        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) {}

        var chinese = /^zh/i.test(String(lang || ''));
        var order = chinese ? ['gb18030', 'windows-1252'] : ['windows-1252', 'gb18030'];
        var first = tryDecode(bytes, order[0]);

        /* Only second-guess the first choice when it produced CJK in a language
           that should not contain any — the signature of decoding CP1252 bytes
           as GB18030 (or the reverse leaving stray accents is harmless enough to
           leave alone). */
        if (first !== null && !chinese && cjkRatio(first) > 0.05) {
            var second = tryDecode(bytes, order[1]);
            if (second !== null) return second;
        }
        if (first !== null) return first;

        var fallback = tryDecode(bytes, order[1]);
        if (fallback !== null) return fallback;
        try { return new TextDecoder('utf-8').decode(bytes); } catch (e) {}
        return rawDecode(bytes);
    }

    function tryDecode(bytes, label) {
        try { return new TextDecoder(label).decode(bytes); } catch (e) { return null; }
    }

    /* Proportion of CJK ideographs, sampled from the head — enough to tell a
       mis-decode from a stray accented character without walking a whole film's
       worth of dialogue. */
    function cjkRatio(text) {
        var head = String(text).slice(0, 4000);
        if (!head.length) return 0;
        var hits = head.match(/[一-鿿]/g);
        return hits ? hits.length / head.length : 0;
    }

    function rawDecode(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
    }

    return {
        KEY_TOKEN: KEY_TOKEN, DEFAULT_TOKEN: DEFAULT_TOKEN,
        configured: configured, search: search, download: download,
        /* Exported for tests and for the merged picker's language ranking. */
        buildQuery: buildQuery, langOf: langOf, formatOf: formatOf
    };
}());
