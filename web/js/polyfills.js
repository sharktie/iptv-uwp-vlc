/* polyfills.js — runtime shims for older WebOS browsers.
 *
 * Babel transpiles ES6+ *syntax* (arrow fns, let/const, classes) but does NOT
 * add the missing built-in *methods* below. WebOS 3 ships Chrome 38, WebOS 4
 * Chrome 53 — both lack many of these, which previously threw and killed whole
 * pages (e.g. Settings → "can't create profiles"). Each shim is feature-detected
 * so newer TVs are untouched. Plain ES5 so it runs before Babel output. Load
 * this FIRST on every page.
 */
(function () {
    'use strict';

    var G = typeof window !== 'undefined' ? window : this;

    /* ── Promise (webOS 1.x/2.x) ─────────────────────────────────────────────
       Every Chromium webOS has Promise; the WebKit browser in webOS 1 and 2 may
       not, and without it nothing in this app runs at all — every page starts
       with a fetch or an async function. Minimal but spec-shaped: thenables
       are adopted, handlers run asynchronously, and a rejection with no
       handler is simply dropped (there is no console to report it to). */
    if (typeof G.Promise !== 'function') {
        var asap = function (fn) { setTimeout(fn, 0); };
        var P = function (executor) {
            var self = this;
            self._state = 0;            // 0 pending, 1 fulfilled, 2 rejected
            self._value = undefined;
            self._handlers = [];
            var done = false;
            function settle(state, value) {
                if (self._state) return;
                self._state = state; self._value = value;
                var hs = self._handlers; self._handlers = [];
                for (var i = 0; i < hs.length; i++) handle(self, hs[i]);
            }
            function resolve(value) {
                if (done) return; done = true;
                if (value === self) { settle(2, new TypeError('Promise resolved with itself')); return; }
                if (value && (typeof value === 'object' || typeof value === 'function')) {
                    var then;
                    try { then = value.then; } catch (e) { settle(2, e); return; }
                    if (typeof then === 'function') {
                        var called = false;
                        try {
                            then.call(value,
                                function (v) { if (called) return; called = true; done = false; resolve(v); },
                                function (r) { if (called) return; called = true; settle(2, r); });
                        } catch (e) { if (!called) settle(2, e); }
                        return;
                    }
                }
                settle(1, value);
            }
            function reject(reason) { if (done) return; done = true; settle(2, reason); }
            try { executor(resolve, reject); } catch (e) { reject(e); }
        };
        var handle = function (p, h) {
            if (!p._state) { p._handlers.push(h); return; }
            asap(function () {
                var cb = p._state === 1 ? h.onFulfilled : h.onRejected;
                if (typeof cb !== 'function') {
                    if (p._state === 1) h.resolve(p._value); else h.reject(p._value);
                    return;
                }
                var out;
                try { out = cb(p._value); } catch (e) { h.reject(e); return; }
                h.resolve(out);
            });
        };
        P.prototype.then = function (onFulfilled, onRejected) {
            var self = this;
            return new P(function (resolve, reject) {
                handle(self, { onFulfilled: onFulfilled, onRejected: onRejected, resolve: resolve, reject: reject });
            });
        };
        P.prototype['catch'] = function (onRejected) { return this.then(null, onRejected); };
        P.resolve = function (v) { return (v instanceof P) ? v : new P(function (res) { res(v); }); };
        P.reject  = function (r) { return new P(function (res, rej) { rej(r); }); };
        P.all = function (list) {
            return new P(function (resolve, reject) {
                var arr = Array.prototype.slice.call(list), left = arr.length, out = new Array(arr.length);
                if (!left) { resolve(out); return; }
                arr.forEach(function (item, i) {
                    P.resolve(item).then(function (v) { out[i] = v; if (--left === 0) resolve(out); }, reject);
                });
            });
        };
        P.race = function (list) {
            return new P(function (resolve, reject) {
                Array.prototype.slice.call(list).forEach(function (item) { P.resolve(item).then(resolve, reject); });
            });
        };
        G.Promise = P;
    }

    /* ── Map / Set (webOS 1.x/2.x) ───────────────────────────────────────────
       Only what this app uses: get/set/has/delete/clear/forEach/size, keys(),
       values(), entries(). Linear lookup — the largest map here is the Live
       TV row cache, capped at a few hundred entries. */
    function makeIter(arr) {
        var i = 0;
        var it = { next: function () { return i < arr.length ? { value: arr[i++], done: false } : { value: undefined, done: true }; } };
        if (typeof Symbol !== 'undefined' && Symbol.iterator) it[Symbol.iterator] = function () { return this; };
        return it;
    }
    if (typeof G.Map !== 'function') {
        var M = function (iterable) {
            this._k = []; this._v = []; this.size = 0;
            if (iterable) for (var i = 0; i < iterable.length; i++) this.set(iterable[i][0], iterable[i][1]);
        };
        M.prototype.indexOf = function (k) {
            for (var i = 0; i < this._k.length; i++) if (this._k[i] === k || (k !== k && this._k[i] !== this._k[i])) return i;
            return -1;
        };
        M.prototype.get = function (k) { var i = this.indexOf(k); return i < 0 ? undefined : this._v[i]; };
        M.prototype.has = function (k) { return this.indexOf(k) >= 0; };
        M.prototype.set = function (k, v) {
            var i = this.indexOf(k);
            if (i < 0) { this._k.push(k); this._v.push(v); this.size++; } else this._v[i] = v;
            return this;
        };
        M.prototype['delete'] = function (k) {
            var i = this.indexOf(k);
            if (i < 0) return false;
            this._k.splice(i, 1); this._v.splice(i, 1); this.size--;
            return true;
        };
        M.prototype.clear = function () { this._k = []; this._v = []; this.size = 0; };
        M.prototype.forEach = function (cb, thisArg) {
            var ks = this._k.slice(), vs = this._v.slice();
            for (var i = 0; i < ks.length; i++) cb.call(thisArg, vs[i], ks[i], this);
        };
        M.prototype.keys    = function () { return makeIter(this._k.slice()); };
        M.prototype.values  = function () { return makeIter(this._v.slice()); };
        M.prototype.entries = function () {
            var out = [];
            for (var i = 0; i < this._k.length; i++) out.push([this._k[i], this._v[i]]);
            return makeIter(out);
        };
        G.Map = M;
    }
    if (typeof G.Set !== 'function') {
        var S = function (iterable) {
            this._m = new G.Map(); this.size = 0;
            if (iterable) for (var i = 0; i < iterable.length; i++) this.add(iterable[i]);
        };
        S.prototype.add = function (v) { this._m.set(v, v); this.size = this._m.size; return this; };
        S.prototype.has = function (v) { return this._m.has(v); };
        S.prototype['delete'] = function (v) { var r = this._m['delete'](v); this.size = this._m.size; return r; };
        S.prototype.clear = function () { this._m.clear(); this.size = 0; };
        S.prototype.forEach = function (cb, thisArg) {
            var self = this;
            this._m.forEach(function (v) { cb.call(thisArg, v, v, self); });
        };
        S.prototype.values = S.prototype.keys = function () { return this._m.keys(); };
        S.prototype.entries = function () { return this._m.entries(); };
        G.Set = S;
    }

    /* ── Map / Set constructed from an iterable (early Chromium) ──────────────
       `new Set(array)` is how this app builds every lookup set. Where the
       constructor ignores its argument the set is silently empty — no error,
       just categories that never hide and favourites that never match — so it
       is tested, not assumed. */
    (function () {
        function wrap(name, add) {
            var Native = G[name];
            var ok = false;
            try { ok = new Native([[1, 1]]).size === 1; } catch (e) {}
            if (ok) return;
            var Wrapped = function (iterable) {
                var inst = new Native();
                if (iterable) {
                    /* Array.from (polyfilled below if needed) also walks an
                       iterator such as another Map's keys(), which slice can't. */
                    var arr = Array.from ? Array.from(iterable) : Array.prototype.slice.call(iterable);
                    for (var i = 0; i < arr.length; i++) add(inst, arr[i]);
                }
                return inst;
            };
            Wrapped.prototype = Native.prototype;
            G[name] = Wrapped;
        }
        wrap('Map', function (m, pair) { m.set(pair[0], pair[1]); });
        wrap('Set', function (s, v) { s.add(v); });
    }());

    /* ── NodeList / HTMLCollection iteration (Chrome 51+) ─────────────────────
       Babel compiles `for…of` and array spread into helpers that look for
       Symbol.iterator, and old Chromium's NodeList has none — so the helper
       throws "non-iterable instance" and takes the page down with it. Array's
       own iterator works on anything array-like. */
    if (typeof Symbol !== 'undefined' && Symbol.iterator && Array.prototype[Symbol.iterator]) {
        if (typeof NodeList !== 'undefined' && !NodeList.prototype[Symbol.iterator]) {
            NodeList.prototype[Symbol.iterator] = Array.prototype[Symbol.iterator];
        }
        if (typeof HTMLCollection !== 'undefined' && !HTMLCollection.prototype[Symbol.iterator]) {
            HTMLCollection.prototype[Symbol.iterator] = Array.prototype[Symbol.iterator];
        }
    }

    /* ── Typed array methods (Chrome 45+) ─────────────────────────────────────
       hls.js slices, fills and searches Uint8Arrays throughout its MPEG-TS
       demuxer. Chromium 38 (webOS 3) has typed arrays but none of these
       methods, so the HLS engine died on the first segment it tried to parse
       and every stream that needed it failed. Each method borrows the generic
       Array implementation, which works on any array-like; slice() is the
       exception, because it must return a typed array of the same kind. */
    (function () {
        var kinds = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
                     'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array'];
        var generic = ['indexOf', 'lastIndexOf', 'join', 'forEach', 'every', 'some',
                       'reduce', 'reduceRight', 'reverse', 'find', 'findIndex', 'includes', 'fill'];
        function borrow(name) {
            var fn = Array.prototype[name];
            return function () { return fn.apply(this, arguments); };
        }
        kinds.forEach(function (k) {
            var T = G[k];
            if (!T || !T.prototype) return;
            var proto = T.prototype;
            generic.forEach(function (name) {
                if (!proto[name] && Array.prototype[name]) proto[name] = borrow(name);
            });
            if (!proto.slice) {
                proto.slice = function (begin, end) {
                    var sub = this.subarray(begin || 0, end === undefined ? this.length : end);
                    var out = new this.constructor(sub.length);
                    out.set(sub);
                    return out;
                };
            }
            if (!proto.map) {
                proto.map = function (cb, thisArg) {
                    var out = new this.constructor(this.length);
                    for (var i = 0; i < this.length; i++) out[i] = cb.call(thisArg, this[i], i, this);
                    return out;
                };
            }
            if (!proto.filter) {
                proto.filter = function (cb, thisArg) {
                    var kept = [];
                    for (var i = 0; i < this.length; i++) if (cb.call(thisArg, this[i], i, this)) kept.push(this[i]);
                    return new this.constructor(kept);
                };
            }
            if (!T.from) {
                T.from = function (src, mapFn, thisArg) { return new T(Array.from(src, mapFn, thisArg)); };
            }
            if (!T.of) {
                T.of = function () { return new T(Array.prototype.slice.call(arguments)); };
            }
        });
    }());

    /* ── Array.from (Chrome 45+) ─────────────────────────────────────────── */
    if (!Array.from) {
        Array.from = function (arrayLike, mapFn, thisArg) {
            if (arrayLike == null) throw new TypeError('Array.from requires an array-like object');
            var items = Object(arrayLike);
            var len = arrayLike.length >>> 0;
            var out = [];
            // Iterable (Set/Map/NodeList with Symbol.iterator)
            if (typeof Symbol !== 'undefined' && Symbol.iterator && items[Symbol.iterator]) {
                var it = items[Symbol.iterator]();
                var step, i = 0;
                while (!(step = it.next()).done) {
                    out.push(mapFn ? mapFn.call(thisArg, step.value, i) : step.value);
                    i++;
                }
                return out;
            }
            for (var j = 0; j < len; j++) {
                out.push(mapFn ? mapFn.call(thisArg, items[j], j) : items[j]);
            }
            return out;
        };
    }

    /* ── Array.prototype.find / findIndex (Chrome 45+) ───────────────────── */
    if (!Array.prototype.find) {
        Array.prototype.find = function (cb, thisArg) {
            for (var i = 0; i < this.length; i++) {
                if (cb.call(thisArg, this[i], i, this)) return this[i];
            }
            return undefined;
        };
    }
    if (!Array.prototype.findIndex) {
        Array.prototype.findIndex = function (cb, thisArg) {
            for (var i = 0; i < this.length; i++) {
                if (cb.call(thisArg, this[i], i, this)) return i;
            }
            return -1;
        };
    }

    /* ── Array.prototype.includes (Chrome 47+) ───────────────────────────── */
    if (!Array.prototype.includes) {
        Array.prototype.includes = function (search, fromIndex) {
            var o = Object(this), len = o.length >>> 0;
            if (len === 0) return false;
            var i = fromIndex | 0;
            if (i < 0) i = Math.max(len + i, 0);
            for (; i < len; i++) {
                var v = o[i];
                if (v === search || (v !== v && search !== search)) return true; // NaN
            }
            return false;
        };
    }

    /* ── Array.prototype.fill (Chrome 45+) ───────────────────────────────── */
    if (!Array.prototype.fill) {
        Array.prototype.fill = function (value, start, end) {
            var len = this.length >>> 0;
            var i = start >> 0;
            i = i < 0 ? Math.max(len + i, 0) : Math.min(i, len);
            var e = end === undefined ? len : end >> 0;
            e = e < 0 ? Math.max(len + e, 0) : Math.min(e, len);
            for (; i < e; i++) this[i] = value;
            return this;
        };
    }

    /* ── String.prototype.includes / startsWith / endsWith (Chrome 41+) ──── */
    if (!String.prototype.includes) {
        String.prototype.includes = function (search, start) {
            return this.indexOf(search, start || 0) !== -1;
        };
    }
    if (!String.prototype.startsWith) {
        String.prototype.startsWith = function (search, pos) {
            pos = pos || 0;
            return this.substr(pos, search.length) === search;
        };
    }
    if (!String.prototype.endsWith) {
        String.prototype.endsWith = function (search, len) {
            var s = String(this);
            if (len === undefined || len > s.length) len = s.length;
            return s.substring(len - search.length, len) === search;
        };
    }
    if (!String.prototype.repeat) {
        String.prototype.repeat = function (count) {
            return new Array((count | 0) + 1).join(this);
        };
    }

    /* ── Object.assign (Chrome 45+) ──────────────────────────────────────── */
    if (typeof Object.assign !== 'function') {
        Object.assign = function (target) {
            if (target == null) throw new TypeError('Cannot convert undefined or null to object');
            var to = Object(target);
            for (var i = 1; i < arguments.length; i++) {
                var src = arguments[i];
                if (src == null) continue;
                for (var key in src) {
                    if (Object.prototype.hasOwnProperty.call(src, key)) to[key] = src[key];
                }
            }
            return to;
        };
    }

    /* ── Object.entries / values (Chrome 54+) ────────────────────────────── */
    if (!Object.entries) {
        Object.entries = function (obj) {
            var keys = Object.keys(obj), out = [];
            for (var i = 0; i < keys.length; i++) out.push([keys[i], obj[keys[i]]]);
            return out;
        };
    }
    if (!Object.values) {
        Object.values = function (obj) {
            var keys = Object.keys(obj), out = [];
            for (var i = 0; i < keys.length; i++) out.push(obj[keys[i]]);
            return out;
        };
    }

    /* ── NodeList / HTMLCollection forEach (Chrome 51+) ──────────────────── */
    if (typeof NodeList !== 'undefined' && NodeList.prototype && !NodeList.prototype.forEach) {
        NodeList.prototype.forEach = Array.prototype.forEach;
    }
    if (typeof HTMLCollection !== 'undefined' && HTMLCollection.prototype && !HTMLCollection.prototype.forEach) {
        HTMLCollection.prototype.forEach = Array.prototype.forEach;
    }

    /* ── Element.matches / closest (Chrome 41/45+) ───────────────────────── */
    if (typeof Element !== 'undefined') {
        var ep = Element.prototype;
        if (!ep.matches) {
            ep.matches = ep.matchesSelector || ep.webkitMatchesSelector ||
                ep.mozMatchesSelector || ep.msMatchesSelector ||
                function (sel) {
                    var nodes = (this.document || this.ownerDocument).querySelectorAll(sel);
                    var i = nodes.length;
                    while (--i >= 0 && nodes[i] !== this) {}
                    return i > -1;
                };
        }
        if (!ep.closest) {
            ep.closest = function (sel) {
                var el = this;
                while (el && el.nodeType === 1) {
                    if (el.matches(sel)) return el;
                    el = el.parentElement || el.parentNode;
                }
                return null;
            };
        }
    }

    /* ── scrollIntoView(options) (Chrome 61+) ─────────────────────────────────
       Every D-pad screen in this app moves its focus ring with
       `el.scrollIntoView({ block: 'nearest' })` — seventeen call sites across
       the channel list, the VOD rails, catch-up, settings and the player menu.

       Old Blink does not understand the dictionary. It does NOT throw, which is
       what makes this worth polyfilling rather than try/catching: the argument
       is coerced to a boolean, `{}` is truthy, and every one of those calls
       silently becomes `scrollIntoView(true)` — "align to the TOP". So on the
       TVs this app targets, each press of the D-pad yanked the focused row to
       the top of its container instead of nudging it just into view, which
       reads as the list jumping around under you.

       Installed only where the dictionary is unsupported, and it defers to the
       native method for the boolean/no-arg forms, so modern engines are
       untouched. `scrollBehavior` in the style object is the detection: CSSOM
       View smooth scrolling shipped alongside the dictionary form. */
    if (typeof Element !== 'undefined' && Element.prototype && Element.prototype.scrollIntoView &&
        document.documentElement && !('scrollBehavior' in document.documentElement.style)) {

        var _nativeSIV = Element.prototype.scrollIntoView;

        /* The nearest ancestor that actually scrolls on the given axis. Falls
           back to null, where the native call is the better answer than
           guessing at the viewport. */
        var _scrollParent = function (el, axis) {
            var node = el.parentNode;
            while (node && node.nodeType === 1) {
                var s;
                try { s = window.getComputedStyle(node); } catch (e) { return null; }
                var ov = axis === 'x' ? s.overflowX : s.overflowY;
                var scrolls = axis === 'x'
                    ? node.scrollWidth  > node.clientWidth
                    : node.scrollHeight > node.clientHeight;
                if ((ov === 'auto' || ov === 'scroll' || ov === 'overlay') && scrolls) return node;
                node = node.parentNode;
            }
            return null;
        };

        Element.prototype.scrollIntoView = function (arg) {
            if (!arg || typeof arg !== 'object') return _nativeSIV.call(this, arg);

            var block  = arg.block  || 'start';
            var inline = arg.inline || 'nearest';
            var handled = false;

            var vp = _scrollParent(this, 'y');
            if (vp) {
                var er = this.getBoundingClientRect(), pr = vp.getBoundingClientRect();
                var top = er.top - pr.top + vp.scrollTop, bot = top + er.height;
                if      (block === 'start')  vp.scrollTop = top;
                else if (block === 'end')    vp.scrollTop = bot - vp.clientHeight;
                else if (block === 'center') vp.scrollTop = top - (vp.clientHeight - er.height) / 2;
                else if (top < vp.scrollTop)                      vp.scrollTop = top;
                else if (bot > vp.scrollTop + vp.clientHeight)    vp.scrollTop = bot - vp.clientHeight;
                handled = true;
            }

            var hp = _scrollParent(this, 'x');
            if (hp) {
                var er2 = this.getBoundingClientRect(), pr2 = hp.getBoundingClientRect();
                var left = er2.left - pr2.left + hp.scrollLeft, right = left + er2.width;
                if      (inline === 'start')  hp.scrollLeft = left;
                else if (inline === 'end')    hp.scrollLeft = right - hp.clientWidth;
                else if (inline === 'center') hp.scrollLeft = left - (hp.clientWidth - er2.width) / 2;
                else if (left < hp.scrollLeft)                    hp.scrollLeft = left;
                else if (right > hp.scrollLeft + hp.clientWidth)  hp.scrollLeft = right - hp.clientWidth;
                handled = true;
            }

            /* Nothing scrollable around it — let the platform decide, using the
               boolean that matches the requested block. */
            if (!handled) _nativeSIV.call(this, block !== 'end' && block !== 'nearest');
        };
    }

    /* ── Number.isNaN / isFinite (Chrome 25/19 — safe guard) ─────────────── */
    if (!Number.isNaN)    Number.isNaN    = function (v) { return v !== v; };
    if (!Number.isFinite) Number.isFinite = function (v) { return typeof v === 'number' && isFinite(v); };

    /* ── AbortController + fetch interplay ───────────────────────────────────
       Three cases across WebOS versions:
         • Modern (WebOS 6+/Chrome 79+): both native → leave untouched.
         • WebOS 5.40-ish: native fetch but NO AbortController. We stub
           AbortController, but its fake `signal` is not a real AbortSignal, so
           passing it to native fetch throws "signal is not of type
           AbortSignal". We therefore wrap native fetch to strip that stub
           signal (timeouts stop cancelling early, but the request still works).
         • Old (WebOS 3/Chrome 38): no fetch at all → XHR-based fetch shim that
           honours the stub signal.
       Without this, the stub would merely swap "AbortController not defined"
       for a fetch TypeError on WebOS 5.40. */
    var hadNativeFetch = (typeof window.fetch === 'function');
    var abortStubbed   = (typeof AbortController === 'undefined');

    if (abortStubbed) {
        window.AbortController = function () {
            this.signal = { aborted: false, addEventListener: function () {}, removeEventListener: function () {} };
        };
        window.AbortController.prototype.abort = function () {
            this.signal.aborted = true;
            if (typeof this.signal.onabort === 'function') this.signal.onabort();
        };
    }

    if (!hadNativeFetch) {
        // No native fetch — XHR shim that honours the (stub) signal.
        window.fetch = function (url, opts) {
            opts = opts || {};
            return new Promise(function (resolve, reject) {
                var xhr = new XMLHttpRequest();
                xhr.open(opts.method || 'GET', url, true);
                /* Callers that need the raw BYTES rather than a decoded string
                   ask for them up front, because XHR cannot supply both: setting
                   responseType makes responseText unavailable. Subtitle
                   downloads are the case that needs this — a .srt from a Chinese
                   or Western European source is frequently not UTF-8, and once
                   the browser has decoded it with the wrong charset the original
                   bytes are gone and the mojibake is unrecoverable. */
                var wantBuffer = opts.responseType === 'arraybuffer';
                if (wantBuffer) {
                    try { xhr.responseType = 'arraybuffer'; }
                    catch (e) { wantBuffer = false; }
                }
                if (opts.headers) {
                    for (var h in opts.headers) {
                        if (Object.prototype.hasOwnProperty.call(opts.headers, h)) {
                            try { xhr.setRequestHeader(h, opts.headers[h]); } catch (e) {}
                        }
                    }
                }
                /* A file inside the app package (appinfo.json, say) loads with
                   status 0 — there is no HTTP on file:// — so 0 from a local URL
                   is a success, not a failure. */
                var isLocal = /^file:/i.test(url) ||
                    (!/^[a-z][a-z0-9+.\-]*:/i.test(url) && location.protocol === 'file:');
                xhr.onload = function () {
                    var body = 'response' in xhr ? xhr.response : xhr.responseText;
                    var status = (xhr.status === 0 && isLocal) ? 200 : xhr.status;
                    resolve({
                        ok:     status >= 200 && status < 300,
                        status: status,
                        /* Enough of the Headers interface for the one thing the
                           app does with it: refusing to read a response body
                           that turns out to be a 2 GB movie rather than the
                           subtitle file we asked for. Header names are
                           case-insensitive per spec, and getResponseHeader
                           already handles that. */
                        headers: {
                            get: function (name) {
                                try { return xhr.getResponseHeader(name); }
                                catch (e) { return null; }
                            }
                        },
                        /* arrayBuffer() is part of the Response interface the app
                           actually uses (subtitle downloads decode bytes
                           themselves), and omitting it meant a caller that
                           reached this shim died on "res.arrayBuffer is not a
                           function" rather than degrading. Present in both
                           modes: without responseType support the body is
                           already a string, so it is widened back to bytes —
                           lossy for non-ASCII, but a working ASCII path beats a
                           TypeError, and callers that care ask for the buffer. */
                        arrayBuffer: function () {
                            if (wantBuffer && body && body.byteLength !== undefined) {
                                return Promise.resolve(body);
                            }
                            var s = String(body === null || body === undefined ? '' : body);
                            var buf = new ArrayBuffer(s.length);
                            var view = new Uint8Array(buf);
                            for (var i = 0; i < s.length; i++) view[i] = s.charCodeAt(i) & 0xff;
                            return Promise.resolve(buf);
                        },
                        text:   function () { return Promise.resolve(bodyText()); },
                        json:   function () { return Promise.resolve(JSON.parse(bodyText())); }
                    });

                    /* In arraybuffer mode `body` is an ArrayBuffer, so text()
                       and json() have to decode it rather than hand back
                       "[object ArrayBuffer]". */
                    function bodyText() {
                        if (!wantBuffer || !body || body.byteLength === undefined) return body;
                        var bytes = new Uint8Array(body), out = '';
                        for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
                        try { return decodeURIComponent(escape(out)); } catch (e) { return out; }
                    }
                };
                xhr.onerror = function () { reject(new TypeError('Network request failed')); };
                if (opts.signal) {
                    if (opts.signal.aborted) { xhr.abort(); reject(new Error('Aborted')); return; }
                    opts.signal.onabort = function () { try { xhr.abort(); } catch (e) {} reject(new Error('Aborted')); };
                }
                xhr.send(opts.body || null);
            });
        };
    } else if (abortStubbed) {
        // Native fetch present but AbortController was stubbed: strip the fake
        // signal so native fetch doesn't reject it.
        var _nativeFetch = window.fetch;
        window.fetch = function (url, opts) {
            if (opts && opts.signal) {
                var clean = {};
                for (var k in opts) {
                    if (Object.prototype.hasOwnProperty.call(opts, k) && k !== 'signal') clean[k] = opts[k];
                }
                return _nativeFetch.call(this, url, clean);
            }
            return _nativeFetch.call(this, url, opts);
        };
    }
}());
