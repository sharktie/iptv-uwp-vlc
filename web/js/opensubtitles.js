/* opensubtitles.js — subtitle search & download via the OpenSubtitles REST API.
 *
 * Exists because most Xtream panels don't host separate subtitle files: subs
 * are embedded in the video, which the webOS decoder may not expose. Pulling
 * them from OpenSubtitles sidesteps the provider entirely.
 *
 * Requires a free API key from https://www.opensubtitles.com/consumers, entered
 * in Settings → Subtitles. An optional account login raises the daily download
 * quota (anonymous keys get very few downloads per day).
 *
 * Notes on browser constraints:
 *   • The API asks clients to send a custom User-Agent. Browsers forbid setting
 *     that header, so it's omitted — the Api-Key is what actually authenticates.
 *   • Every call is cross-origin. The Xtream and remote-setup calls elsewhere in
 *     this app already work, so cross-origin fetch is fine on webOS, but if
 *     OpenSubtitles ever refuses the app's origin the errors surface verbatim in
 *     the player menu rather than failing silently.
 *
 * ES5-friendly (Babel target Chrome 38): no fetch options beyond what
 * polyfills.js guarantees, no template literals in the shipped output.
 */
window.OpenSubtitles = (function () {
    'use strict';

    var API   = 'https://api.opensubtitles.com/api/v1';
    var KEY_API_KEY  = 'os_api_key';
    var KEY_LANG     = 'os_language';
    var KEY_USER     = 'os_username';
    var KEY_PASS     = 'os_password';
    var KEY_TOKEN    = 'os_token';
    var KEY_TOKEN_TS = 'os_token_ts';
    var TOKEN_TTL    = 20 * 60 * 60 * 1000;   // tokens last ~24h; refresh early

    function get(key, fallback) {
        try { return localStorage.getItem(key) || fallback || ''; } catch (e) { return fallback || ''; }
    }
    function set(key, val) {
        try { localStorage.setItem(key, val); } catch (e) {}
    }

    function apiKey()   { return get(KEY_API_KEY); }
    function language() { return get(KEY_LANG, 'en') || 'en'; }
    function configured() { return !!apiKey(); }

    function headers(extra) {
        var h = { 'Api-Key': apiKey(), 'Content-Type': 'application/json' };
        if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
        return h;
    }

    /* Turns an HTTP failure into something a user can act on, rather than
       "HTTP 401" which tells them nothing about which field is wrong. */
    function describeError(status, body) {
        if (status === 401 || status === 403) return 'OpenSubtitles rejected the API key. Check it in Settings → Subtitles.';
        if (status === 406) return 'Download quota reached for today. Add your OpenSubtitles login in Settings → Subtitles to raise it.';
        if (status === 429) return 'Too many requests — wait a moment and try again.';
        if (status >= 500)  return 'OpenSubtitles is having trouble (server error ' + status + ').';
        if (body && body.message) return String(body.message);
        return 'OpenSubtitles request failed (HTTP ' + status + ').';
    }

    function request(path, opts) {
        opts = opts || {};
        if (!configured()) return Promise.reject(new Error('No OpenSubtitles API key set. Add one in Settings → Subtitles.'));
        /* Net.timed rather than bare fetch: without a timeout that actually
           fires (webOS 4/5 have no real AbortController) a slow API left the
           subtitle menu on "Searching…" indefinitely. */
        var timed = (typeof Net !== 'undefined' && Net.timed)
            ? Net.timed(API + path, opts, 15000)
            : fetch(API + path, opts);
        return timed.then(function (r) {
            return r.text().then(function (text) {
                var body = null;
                try { body = text ? JSON.parse(text) : null; } catch (e) {}
                if (!r.ok) throw new Error(describeError(r.status, body));
                return body;
            });
        });
    }

    /* ── Optional login (raises the download quota) ─────────────────────────── */
    function cachedToken() {
        var t = get(KEY_TOKEN), ts = parseInt(get(KEY_TOKEN_TS, '0'), 10) || 0;
        if (t && Date.now() - ts < TOKEN_TTL) return t;
        return '';
    }

    function login() {
        var user = get(KEY_USER), pass = get(KEY_PASS);
        if (!user || !pass) return Promise.resolve('');       // anonymous is allowed
        var cached = cachedToken();
        if (cached) return Promise.resolve(cached);
        return request('/login', {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ username: user, password: pass })
        }).then(function (data) {
            var token = (data && data.token) || '';
            if (token) { set(KEY_TOKEN, token); set(KEY_TOKEN_TS, String(Date.now())); }
            return token;
        }).catch(function () { return ''; });                 // fall back to anonymous
    }

    /* ── Title cleaning ─────────────────────────────────────────────────────────
       Xtream panels name VOD entries for their own browser, not for a search
       API: "EN - Inception (2010) 1080p", "[VIP] Inception.2010.BluRay.x264",
       "FR| Inception 4K". Sending that raw as the query is the single biggest
       cause of bad matches, so strip it back to the bare title and pull the year
       out separately. Everything is best-effort — if a pattern doesn't apply the
       string is left alone rather than mangled. */
    var JUNK = new RegExp(
        '\\b(' +
        '4k|uhd|2160p|1080p|1080i|720p|576p|480p|hdr10\\+?|hdr|dolby ?vision|dv|' +
        'hevc|h ?26[45]|x ?26[45]|xvid|divx|av1|' +
        'web ?-? ?dl|web ?rip|webdl|blu ?-? ?ray|bluray|br ?rip|bd ?rip|dvd ?rip|hd ?rip|hdts|' +
        'cam ?rip|telesync|remux|imax|extended|unrated|uncut|repack|proper|' +
        'multi|dual|dublado|legendado|subbed|dubbed|vostfr|' +
        'aac|ac ?3|eac ?3|dts(?: ?hd)?|atmos|truehd|5 ?1|7 ?1|' +
        'season|complete' +
        ')\\b', 'gi');

    /* Films are sometimes named after a year ("1917", "1984", "2012"), so a
       single year-like token at the very start is the TITLE, not a release year.
       When there are several, the last one is the release year — "1917 2019
       BluRay" is the 2019 release of the film 1917. */
    function extractYear(s) {
        s = String(s == null ? '' : s);
        var all = s.match(/\b(?:19|20)\d{2}\b/g);
        if (!all || !all.length) return '';
        if (all.length === 1 && s.indexOf(all[0]) === 0) return '';
        return all[all.length - 1];
    }

    function cleanTitle(raw) {
        var s = String(raw == null ? '' : raw);

        // Dotted/underscored release names -> spaces, but only when they look
        // like separators (plenty of real titles contain a single dot, e.g.
        // "Dr. Strangelove", so require two or more dot-separated words).
        if (/\w\.\w+\.\w/.test(s)) s = s.replace(/[._]+/g, ' ');
        else s = s.replace(/_+/g, ' ');

        // Leading provider/language tags: "EN - ", "|FR| ", "[VIP] ", "AR: "
        s = s.replace(/^\s*[\[\(\|]?\s*[A-Za-z]{2,4}\s*[\]\)\|]?\s*[-–—:|]\s+/, '');
        s = s.replace(/^\s*[\[\(\|][^\]\)\|]{1,15}[\]\)\|]\s*/, '');

        // Bracketed extras anywhere ("[4K]", "(MULTI)") — but keep a bare year.
        s = s.replace(/\[[^\]]*\]/g, ' ');
        s = s.replace(/\((?!\s*(?:19|20)\d{2}\s*\))[^)]*\)/g, ' ');

        // Everything from the year onwards is release noise in these names —
        // unless that would leave nothing, in which case the year was the title.
        var y = extractYear(s);
        if (y) {
            // lastIndexOf, not indexOf: for "1984 (1984)" the first occurrence
            // is the title itself and slicing there would leave nothing.
            var head = s.slice(0, s.lastIndexOf(y));
            if (head.replace(/[^A-Za-z0-9]/g, '')) s = head;
        }

        s = s.replace(JUNK, ' ');
        s = s.replace(/[-–—_|:]+\s*$/, ' ');
        s = s.replace(/\s{2,}/g, ' ').trim();
        /* Trailing set includes opening brackets: slicing at a parenthesised
           year ("Inception (2010)") otherwise leaves a dangling "(". */
        s = s.replace(/^[\s\-–—_|:.)\]}]+/, '').replace(/[\s\-–—_|:.([{]+$/, '');
        return s;
    }

    /* ── Search ─────────────────────────────────────────────────────────────── */
    /* `q` accepts { title, year, imdbId, tmdbId, season, episode, language }.
       IDs match far more reliably than a title string, so they're preferred when
       the panel supplied them; the title is the fallback. */
    function buildQuery(q) {
        var parts = [];
        function add(k, v) {
            if (v === undefined || v === null || v === '') return;
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        }
        var isEpisode = q.season || q.episode;
        if (isEpisode) {
            if (q.imdbId) add('parent_imdb_id', String(q.imdbId).replace(/^tt/i, ''));
            if (q.tmdbId) add('parent_tmdb_id', q.tmdbId);
            add('season_number', q.season);
            add('episode_number', q.episode);
            if (!q.imdbId && !q.tmdbId) add('query', q.title);
            add('type', 'episode');
        } else {
            if (q.imdbId)      add('imdb_id', String(q.imdbId).replace(/^tt/i, ''));
            else if (q.tmdbId) add('tmdb_id', q.tmdbId);
            else {
                add('query', q.title);
                add('year', q.year);
            }
            add('type', 'movie');
        }
        add('languages', q.language || language());
        add('order_by', 'download_count');
        add('order_direction', 'desc');
        return parts.join('&');
    }

    function searchOnce(q) {
        return request('/subtitles?' + buildQuery(q || {}), { headers: headers() })
            .then(function (data) {
                var rows = (data && data.data) || [];
                var out = [];
                for (var i = 0; i < rows.length; i++) {
                    var a = rows[i] && rows[i].attributes;
                    if (!a || !a.files || !a.files.length) continue;
                    var f = a.files[0];
                    if (!f || !f.file_id) continue;
                    var fd = a.feature_details || {};
                    out.push({
                        fileId:    f.file_id,
                        fileName:  f.file_name || '',
                        lang:      a.language || '',
                        release:   a.release || f.file_name || 'Subtitle',
                        downloads: a.download_count || 0,
                        hearingImpaired: !!a.hearing_impaired,
                        fps:       a.fps || 0,
                        /* Which film/episode OpenSubtitles thinks this is. Shown
                           in the picker so a wrong match is obvious at a glance
                           instead of only becoming apparent during playback. */
                        featureTitle: fd.parent_title || fd.title || fd.movie_name || '',
                        featureYear:  fd.year || '',
                        season:       fd.season_number,
                        episode:      fd.episode_number
                    });
                }
                return out;
            });
    }

    /* Try the most precise identifier first and fall back progressively, so a
       panel that supplies no IDs and a messy title still lands on something.
       Stops at the first strategy that returns anything. */
    function search(q) {
        q = q || {};
        var raw   = q.title || '';
        var clean = cleanTitle(raw);
        var year  = q.year || extractYear(raw);
        var isEp  = !!(q.season || q.episode);

        var plans = [];
        if (q.imdbId) plans.push({ imdbId: q.imdbId });
        if (q.tmdbId) plans.push({ tmdbId: q.tmdbId });
        if (clean && year && !isEp) plans.push({ title: clean, year: year });
        if (clean)                  plans.push({ title: clean });
        if (raw && raw !== clean)   plans.push({ title: raw });
        if (!plans.length) return Promise.resolve([]);

        var base = { season: q.season, episode: q.episode, language: q.language };
        function attempt(i) {
            if (i >= plans.length) return Promise.resolve([]);
            var p = {}, k;
            for (k in base)     if (Object.prototype.hasOwnProperty.call(base, k)) p[k] = base[k];
            for (k in plans[i]) if (Object.prototype.hasOwnProperty.call(plans[i], k)) p[k] = plans[i][k];
            return searchOnce(p).then(function (res) {
                if (res.length) return res;
                return attempt(i + 1);
            }, function (err) {
                /* A hard failure (bad key, quota) shouldn't be retried through
                   every remaining plan — surface it immediately. */
                if (i === 0) throw err;
                return attempt(i + 1);
            });
        }
        return attempt(0);
    }

    /* ── Download ───────────────────────────────────────────────────────────── */
    /* Returns a direct link to the subtitle file. Downloads count against a
       daily quota, so this is only called for the one the user picked, never
       eagerly for search results. */
    function download(fileId) {
        return login().then(function (token) {
            var h = headers(token ? { 'Authorization': 'Bearer ' + token } : null);
            return request('/download', {
                method: 'POST',
                headers: h,
                body: JSON.stringify({ file_id: fileId })
            });
        }).then(function (data) {
            if (!data || !data.link) throw new Error('OpenSubtitles returned no download link.');
            return {
                url: data.link,
                fileName: data.file_name || '',
                remaining: (typeof data.remaining === 'number') ? data.remaining : null
            };
        });
    }

    return {
        KEY_API_KEY: KEY_API_KEY, KEY_LANG: KEY_LANG,
        KEY_USER: KEY_USER, KEY_PASS: KEY_PASS,
        configured: configured, language: language,
        cleanTitle: cleanTitle, extractYear: extractYear,
        search: search, download: download
    };
}());
