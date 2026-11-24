/* ==========================================================================
   Inspera v3 — "The pen never lifts"
   One file, no build step. Three modes (see site.css): cinema · flow · still.
   The default HTML is the finished, static page; this script only adds motion.
   ========================================================================== */
(function () {
  'use strict';

  const d = document, w = window, root = d.documentElement;
  const $ = (s, c) => (c || d).querySelector(s);
  const $$ = (s, c) => Array.prototype.slice.call((c || d).querySelectorAll(s));
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const seg01 = (v, a, b) => clamp((v - a) / (b - a));
  const easeIO = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs, parent) => {
    const e = d.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const r1 = n => Math.round(n * 10) / 10;

  let mode = root.getAttribute('data-mode') || 'still';
  const finePointer = w.matchMedia('(hover:hover) and (pointer:fine)').matches;
  let gsap, ScrollTrigger, lenis = null;
  const K = () => parseFloat(getComputedStyle(root).getPropertyValue('--k')) || 1;

  /* rounded polyline: straight runs with filleted corners, the vocabulary of the mark */
  function rp(pts, r) {
    let s = 'M' + r1(pts[0][0]) + ',' + r1(pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i - 1], c = pts[i], n = pts[i + 1];
      const l1 = Math.hypot(c[0] - p[0], c[1] - p[1]), l2 = Math.hypot(n[0] - c[0], n[1] - c[1]);
      if (l1 < 0.5 || l2 < 0.5) { s += ' L' + r1(c[0]) + ',' + r1(c[1]); continue; }
      const rr = Math.min(r, l1 / 2, l2 / 2);
      const ax = c[0] + (p[0] - c[0]) / l1 * rr, ay = c[1] + (p[1] - c[1]) / l1 * rr;
      const bx = c[0] + (n[0] - c[0]) / l2 * rr, by = c[1] + (n[1] - c[1]) / l2 * rr;
      s += ' L' + r1(ax) + ',' + r1(ay) + ' Q' + r1(c[0]) + ',' + r1(c[1]) + ' ' + r1(bx) + ',' + r1(by);
    }
    const e = pts[pts.length - 1];
    return s + ' L' + r1(e[0]) + ',' + r1(e[1]);
  }

  /* ------------------------------------------------------------------------
     The line: an ordered chain of path segments across many SVGs.
     ------------------------------------------------------------------------ */
  const LINE = { chain: [], dirty: true, detached: false, total: 0 };

  class Seg {
    constructor(path, opts) {
      opts = opts || {};
      this.path = path;
      this.tipPath = opts.tipPath || path;
      this.len = path.getTotalLength() || 1;
      this._p = 0; this._e = 0;
      path.style.strokeDasharray = this.len + ' ' + (this.len + 6);
      this.apply();
    }
    get p() { return this._p; }
    set p(v) { v = clamp(v); if (v !== this._p) { this._p = v; this.apply(); } }
    get e() { return this._e; }
    set e(v) { v = clamp(v); if (v !== this._e) { this._e = v; this.apply(); } }
    apply() {
      const s = this.path.style;
      s.strokeDashoffset = this._e > 0 ? -this._e * this.len : this.len * (1 - this._p);
      s.visibility = this._p > 0.0004 && this._e < 0.9996 ? 'visible' : 'hidden';
      LINE.dirty = true;
    }
    tip() {
      const t = this.tipPath, pt = t.getPointAtLength((t.getTotalLength() || 1) * this._p), m = t.getScreenCTM();
      return m ? [m.a * pt.x + m.c * pt.y + m.e, m.b * pt.x + m.d * pt.y + m.f] : null;
    }
    drawn() { return this.len * this._p; }
  }

  /* ------------------------------------------------------------------------
     Split text (words in masks). Idempotent.
     ------------------------------------------------------------------------ */
  function splitWords(el) {
    if (el.dataset.splitDone) return $$('.w>span', el);
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    const walk = node => {
      Array.prototype.slice.call(node.childNodes).forEach(ch => {
        if (ch.nodeType === 3) {
          const frag = d.createDocumentFragment();
          ch.textContent.split(/(\s+)/).forEach(tok => {
            if (!tok) return;
            if (/^\s+$/.test(tok)) { frag.appendChild(d.createTextNode(' ')); return; }
            const o = d.createElement('span'), i = d.createElement('span');
            o.className = 'w'; i.textContent = tok; o.appendChild(i); frag.appendChild(o);
          });
          node.replaceChild(frag, ch);
        } else if (ch.nodeType === 1 && ch.tagName !== 'svg') walk(ch);
      });
    };
    walk(el);
    // one readable copy for screen readers; the word-by-word version is presentation only
    const vis = d.createElement('span'); vis.setAttribute('aria-hidden', 'true'); vis.className = 'split';
    while (el.firstChild) vis.appendChild(el.firstChild);
    const sr = d.createElement('span'); sr.className = 'sr-only'; sr.textContent = text;
    el.appendChild(sr); el.appendChild(vis);
    el.dataset.splitDone = '1';
    return $$('.w>span', el);
  }

  /* ------------------------------------------------------------------------
     Where the ink of a phrase really is (not its line box), relative to a host
     ------------------------------------------------------------------------ */
  function inkBox(span, host) {
    const rs = span.getClientRects(); if (!rs.length) return null;
    const cs = getComputedStyle(span), fs = parseFloat(cs.fontSize), hr = host.getBoundingClientRect();
    const probe = d.createElement('i'); probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    span.insertBefore(probe, span.firstChild);
    const bo = probe.getBoundingClientRect().top - span.getClientRects()[0].top; // baseline below the top of the first line box
    probe.remove();
    const ctx = d.createElement('canvas').getContext('2d');
    ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' 100px ' + cs.fontFamily;
    const m = ctx.measureText(span.textContent), k = fs / 100;
    let x0 = 1e9, x1 = -1e9;
    for (const r of rs) { x0 = Math.min(x0, r.left); x1 = Math.max(x1, r.right); }
    const first = rs[0], last = rs[rs.length - 1];
    return { x0: x0 - hr.left, x1: x1 - hr.left, top: first.top + bo - m.actualBoundingBoxAscent * k - hr.top, bottom: last.top + bo + m.actualBoundingBoxDescent * k - hr.top, base: last.top + bo - hr.top, fs };
  }

  /* ------------------------------------------------------------------------
     Revision cloud around a phrase (the red markup in the problem section)
     ------------------------------------------------------------------------ */
  function buildCloud() {
    const span = $('[data-cloud]'); if (!span) return null;
    const host = span.closest('h2'); host.style.position = 'relative';
    const old = $('.cloud__svg', host); if (old) old.remove();
    const b = inkBox(span, host); if (!b) return null;
    const hr = host.getBoundingClientRect(), fs = b.fs;
    const x0 = b.x0 - fs * 0.24, x1 = b.x1 + fs * 0.2, y0 = b.top - fs * 0.13, y1 = b.bottom + fs * 0.13;
    const R = Math.max(7, fs * 0.115);
    const run = (ax, ay, bx, by) => {
      const L = Math.hypot(bx - ax, by - ay), n = Math.max(2, Math.round(L / (R * 1.75)));
      let out = '';
      for (let i = 1; i <= n; i++) {
        const k = 0.9 + ((i * 7) % 5) * 0.06; // slightly uneven scallops, as by hand
        out += ' A' + r1(R * k) + ',' + r1(R * k) + ' 0 0 1 ' + r1(ax + (bx - ax) * i / n) + ',' + r1(ay + (by - ay) * i / n);
      }
      return out;
    };
    const dd = 'M' + r1(x0) + ',' + r1(y0) + run(x0, y0, x1, y0) + run(x1, y0, x1, y1) + run(x1, y1, x0, y1) + run(x0, y1, x0, y0);
    const svg = svgEl('svg', { class: 'cloud__svg', 'aria-hidden': 'true', focusable: 'false', width: Math.ceil(hr.width), height: Math.ceil(hr.height), viewBox: '0 0 ' + Math.ceil(hr.width) + ' ' + Math.ceil(hr.height) });
    svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible;pointer-events:none';
    const p = svgEl('path', { d: dd, fill: 'none', stroke: 'var(--red)', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
    host.appendChild(svg);
    return p;
  }

  /* ------------------------------------------------------------------------
     Gesture lines inside vignettes: keep the stroke at a constant screen width
     ------------------------------------------------------------------------ */
  function fitGlines() {
    const k = mode === 'cinema' ? K() : 1;
    $$('svg.gline').forEach(svg => {
      const vb = svg.viewBox.baseVal, bw = svg.getBoundingClientRect().width;
      if (!vb || !vb.width || !bw || svg.getAttribute('preserveAspectRatio') === 'none') return;
      const sc = bw / vb.width;
      svg.style.setProperty('--glw', (2.25 * k / sc).toFixed(3));
      svg.style.setProperty('--gdw', (0.9 * k / sc).toFixed(3));
      svg.style.setProperty('--gfs', ((mode === 'cinema' ? 9.4 * k : 9.6) / sc).toFixed(2));
    });
  }

  /* ------------------------------------------------------------------------
     HERO: one stroke. Site boundary, then the plan, then the plan rises.
     Plan units: the building is 26 x 16, six rooms; doors are part of the stroke.
     ------------------------------------------------------------------------ */
  const HERO = (function () {
    const C30 = Math.cos(Math.PI / 6);
    const SITE = [[-4.5, -4.2], [30.5, -5.2], [31.5, 21], [-4, 22.2]];
    const G = [-4.05, 19.5], JR = [14.5, 16];
    const MX = 13.5, MY = 8.5;
    const WALL_H = 2.9, ROOF_GAP = 2.3;
    const SOUTH = Math.max.apply(null, SITE.map(p => (p[0] - MX + p[1] - MY) * 0.5)); // the site's lowest corner in the axonometric, in plan units
    const KEY_H = 80; // the room schedule's band under the drawing (stacked layouts)
    const door = (h, u, v, wd, n) => {
      n = n || 9; const pts = [h.slice(), [h[0] + v[0] * wd, h[1] + v[1] * wd]];
      for (let i = 1; i <= n; i++) { const a = (i / n) * Math.PI / 2; pts.push([h[0] + (v[0] * Math.cos(a) + u[0] * Math.sin(a)) * wd, h[1] + (v[1] * Math.cos(a) + u[1] * Math.sin(a)) * wd]); }
      return pts;
    };
    const rev = a => a.slice().reverse();

    // the route: [x, y, pace]. pace < 1 = the pen retraces a wall, faster.
    const R = [];
    const go = (pts, pace) => { pts.forEach(p => R.push([p[0], p[1], pace])); };
    go([G], 1);
    go([SITE[0], SITE[1], SITE[2], SITE[3], G], 0.5);
    const I_SITE = R.length - 1;
    go([[14.5, 19.5], JR], 0.8);
    go([[18, 16], [26, 16], [26, 9], [26, 0], [9, 0], [0, 0], [0, 6], [9, 6]], 1);
    const MARK = {}; // route index at which each room is enclosed
    const d1 = [[9, 4.5]].concat(door([9, 4.5], [0, -1], [-1, 0], 2).slice(1), [[9, 0]]);
    go(d1, 1); MARK.contracts = R.length - 1; go(rev(d1).slice(1).concat([[9, 6]]), 0.2);
    go([[9, 7]].concat(door([9, 7], [0, 1], [-1, 0], 1.6).slice(1), [[9, 9], [9, 11], [0, 11], [0, 6]]), 1); MARK.accounts = R.length - 1;
    go([[0, 11]], 0.2);
    go([[0, 16], [9, 16]], 1);
    go([[9, 14.5]].concat(door([9, 14.5], [0, -1], [-1, 0], 2).slice(1), [[9, 11]]), 1); MARK.people = R.length - 1;
    go([[9, 9]], 0.2);
    go([[12, 9]].concat(door([12, 9], [1, 0], [0, 1], 2).slice(1), [[18, 9], [26, 9]]), 1); MARK.projects = R.length - 1;
    go([[18, 9]], 0.2);
    go([[18, 12]].concat(door([18, 12], [0, 1], [1, 0], 2).slice(1), [[18, 16]]), 1); MARK.time = R.length - 1;
    go([[14.5, 16]], 0.2);
    const dE = door([14.5, 16], [-1, 0], [0, -1], 2);
    go(dE.slice(1), 1);
    go([[9, 16]], 1); MARK.insight = R.length - 1;
    go([[12.5, 16]], 0.2);
    go(rev(dE).slice(1), 0.2);
    const EXIT = [[14.5, 16], [14.5, 19.5], [14.5, 21.57], [14.5, 24.2]];

    const WALLS = [
      [0, 16, 9, 16], [9, 16, 12.5, 16], [14.5, 16, 18, 16], [18, 16, 26, 16], [26, 16, 26, 9], [26, 9, 26, 0], [26, 0, 9, 0], [9, 0, 0, 0],
      [0, 0, 0, 6], [0, 6, 0, 11], [0, 11, 0, 16], [9, 0, 9, 2.5], [9, 4.5, 9, 6], [9, 6, 9, 7], [9, 8.6, 9, 9], [9, 9, 9, 11], [9, 11, 9, 12.5],
      [9, 14.5, 9, 16], [0, 6, 9, 6], [0, 11, 9, 11], [9, 9, 12, 9], [14, 9, 18, 9], [18, 9, 26, 9], [18, 9, 18, 12], [18, 14, 18, 16]
    ].map(a => ({ a: [a[0], a[1]], b: [a[2], a[3]], hz: a[1] === a[3], front: (a[1] === 16 && a[3] === 16) || (a[0] === 26 && a[2] === 26), depth: (a[0] + a[2] + a[1] + a[3]) / 2 }))
      .sort((p, q) => p.depth - q.depth);
    const FOOT = [[0, 0], [26, 0], [26, 16], [0, 16]];
    const ROOMS = { projects: [17.5, 4.3], contracts: [4.3, 3], accounts: [4.3, 8.5], people: [4.2, 13.6], insight: [13.5, 12.3], time: [22.6, 13.4] };
    const GRIDX = [0, 9, 18, 26], GRIDY = [0, 6, 11, 16];

    let svg, L = {}, els = {}, geo = null, state = { p: -1 }, cfg = { cinema: false, small: false }, origin = null;

    function measureOrigin() {
      // the full stop of the headline: where the pen first touches the paper
      const o = $('.origin'); if (!o) return null;
      const fs = parseFloat(getComputedStyle(o).fontSize);
      const probe = d.createElement('i'); probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
      o.parentNode.insertBefore(probe, o);
      const base = probe.getBoundingClientRect().top, left = o.getBoundingClientRect().left;
      probe.remove();
      const ctx = d.createElement('canvas').getContext('2d');
      ctx.font = '400 100px "DM Serif Display", Georgia, serif';
      const m = ctx.measureText('.');
      const k = fs / 100, asc = m.actualBoundingBoxAscent * k, desc = m.actualBoundingBoxDescent * k;
      const bl = m.actualBoundingBoxLeft * k, br = m.actualBoundingBoxRight * k;
      const sr = svg.getBoundingClientRect();
      return { x: left + (br - bl) / 2 - sr.left, y: base - (asc - desc) / 2 - sr.top, r: Math.max(3, (asc + desc) / 2) };
    }

    function setup(el, options) {
      svg = el; cfg = options;
      svg.replaceChildren();
      const g = (cls, parent) => svgEl('g', cls ? { class: cls } : null, parent || svg);
      L.bg = g(); L.site = svgEl('polygon', { class: 'h-site' }, svg);
      L.annoTop = g(); L.shadow = svgEl('polygon', { class: 'h-shadow' }, svg); L.floor = svgEl('polygon', { class: 'h-floor' }, svg);
      L.lead = svgEl('path', { class: 'h-line' }, svg);
      L.main = svgEl('path', { class: 'h-line' }, svg);
      L.exit = svgEl('path', { class: 'h-line' }, svg);
      L.walls = g(); L.roofStems = g(); L.roof = svgEl('polygon', { class: 'h-wall-b' }, svg); L.roofEdge = svgEl('polygon', { class: 'h-thin', fill: 'none' }, svg);
      L.labels = g(); L.key = g();
      L.dot = svgEl('circle', { class: 'h-dot', r: 5 }, svg);
      if (!cfg.cinema) svg.classList.add('is-small');
      els.walls = WALLS.map(wl => ({ w: wl, face: svgEl('polygon', { class: wl.hz ? 'h-wall-a' : 'h-wall-b' }, L.walls), edge: svgEl('path', { class: 'h-thin' }, L.walls), base: svgEl('path', { class: 'h-line' }, L.walls) }));
      els.stems = FOOT.map(() => svgEl('path', { class: 'h-gd h-gd--dash' }, L.roofStems));
      const names = {};
      $$('.rooms li').forEach((li, i) => { names[li.dataset.room] = { n: i + 1, t: $('.rooms__t', li).textContent }; });
      // in plan a room carries its name; in the axonometric, a numbered tag keyed to a schedule
      els.labels = Object.keys(ROOMS).map(key => {
        const info = names[key] || { n: 0, t: key }, grp = svgEl('g', null, L.labels);
        const tag = svgEl('g', null, grp), name = svgEl('g', null, grp);
        svgEl('circle', { class: 'h-num', r: cfg.small ? 8.5 : 9.5 }, tag);
        const tn = svgEl('text', { class: 'h-t h-t--bub', 'text-anchor': 'middle', dy: '.35em' }, tag); tn.textContent = info.n;
        if (!cfg.small) {
          const parts = info.t.toUpperCase().split(' & ');
          const a = svgEl('text', { class: 'h-t h-t--room', 'text-anchor': 'middle' }, name); a.textContent = parts[0];
          const b = svgEl('text', { class: 'h-t h-t--room', 'text-anchor': 'middle', dy: '1.25em' }, name); b.textContent = parts[1] ? '& ' + parts[1] : '';
        }
        return { key, grp, tag, name, n: info.n, t: info.t };
      });
      els.labels.sort((p, q) => p.n - q.n);
      layout();
    }

    function layout() {
      const box = svg.getBoundingClientRect(), W = box.width, H = box.height;
      if (!W || !H) return;
      svg.setAttribute('viewBox', '0 0 ' + r1(W) + ' ' + r1(H));
      let rx0, rx1, ry0, ry1;
      if (cfg.cinema) { rx0 = W * 0.47; rx1 = W - 14 - Math.max(30, W * 0.03); ry0 = 96; ry1 = H - 118; }
      else { rx0 = 4; rx1 = W - 4; ry0 = 6; ry1 = H - 6 - (cfg.small ? 0 : KEY_H); }
      const rw = rx1 - rx0, rh = ry1 - ry0;
      const s = Math.min(rw / 38.5, rh / 30.5), s2 = Math.min(rw / 55, (rh - 12) / 38.5);
      const cx = (rx0 + rx1) / 2, cy = (ry0 + ry1) / 2 - s * 0.4;
      // the room schedule sits under the drawing's south corner, never across it
      const ky = cfg.cinema ? ry1 - 62 : H - 55;
      let cy2 = (ry0 + ry1) / 2 + s2 * 3.4;
      if (!cfg.small) cy2 = Math.min(cy2, ky - 36 - s2 * SOUTH);
      const cx2 = cx;
      geo = { W, H, s, s2, cx, cy, cx2, cy2, hpx: WALL_H * s2, rx0, rx1, ry0, ry1 };
      origin = cfg.cinema ? measureOrigin() : null;
      // top-view route, with pace-weighted "time" and true length at every vertex
      const P = R.map(p => top(p[0], p[1]));
      const cumL = [0], cumT = [0];
      for (let i = 1; i < P.length; i++) { const l = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); cumL.push(cumL[i - 1] + l); cumT.push(cumT[i - 1] + l * R[i][2]); }
      geo.P = P; geo.cumL = cumL; geo.cumT = cumT; geo.len = cumL[cumL.length - 1]; geo.time = cumT[cumT.length - 1];
      geo.dTop = 'M' + P.map(p => r1(p[0]) + ',' + r1(p[1])).join(' L');
      geo.tSite = cumT[I_SITE] / geo.time;
      geo.tRoom = {}; Object.keys(MARK).forEach(k => { geo.tRoom[k] = Math.min(0.965, cumT[MARK[k]] / geo.time); });
      // background graph grid, fading out at its edges
      L.bg.replaceChildren();
      if (cfg.cinema) {
        const step = s * 2; let gd = '';
        for (let x = cx - Math.ceil((cx - rx0) / step) * step; x <= rx1 + 40; x += step) gd += 'M' + r1(x) + ',' + r1(ry0 - 60) + 'V' + r1(ry1 + 70);
        for (let y = cy - Math.ceil((cy - ry0) / step) * step - step * 3; y <= ry1 + 70; y += step) gd += 'M' + r1(rx0 - 20) + ',' + r1(y) + 'H' + r1(rx1 + 40);
        const defs = svgEl('defs', null, L.bg), rg = svgEl('radialGradient', { id: 'hgf', cx: '50%', cy: '50%', r: '58%' }, defs);
        svgEl('stop', { offset: '0.45', 'stop-color': '#fff' }, rg); svgEl('stop', { offset: '1', 'stop-color': '#000' }, rg);
        const mk = svgEl('mask', { id: 'hgm', maskUnits: 'userSpaceOnUse', x: r1(rx0 - 30), y: r1(ry0 - 70), width: r1(rw + 80), height: r1(rh + 150) }, defs);
        svgEl('rect', { x: r1(rx0 - 30), y: r1(ry0 - 70), width: r1(rw + 80), height: r1(rh + 150), fill: 'url(#hgf)' }, mk);
        svgEl('path', { class: 'h-grid', d: gd, mask: 'url(#hgm)' }, L.bg);
      }
      buildAnnoTop();
      // the room schedule that keys the numbered tags (axonometric, large screens)
      L.key.replaceChildren();
      if (!cfg.small) {
        const kx = rx1 - 318;
        const hd = svgEl('text', { class: 'h-t', x: r1(kx), y: r1(ky - 12) }, L.key); hd.textContent = 'Room schedule';
        svgEl('path', { class: 'h-gd', d: 'M' + r1(kx) + ',' + r1(ky - 4) + 'H' + r1(rx1) }, L.key);
        els.labels.forEach((lb, i) => {
          const col = i < 3 ? 0 : 1, row = i % 3, x = kx + col * 168, y = ky + 13 + row * 16.5;
          const n = svgEl('text', { class: 'h-t h-t--bub', x: r1(x), y: r1(y) }, L.key); n.textContent = lb.n;
          const t = svgEl('text', { class: 'h-t', x: r1(x + 16), y: r1(y) }, L.key); t.textContent = lb.t;
        });
      }
      state.p = -1;
    }

    const top = (x, y) => [geo.cx + geo.s * (x - MX), geo.cy + geo.s * (y - MY)];
    const iso = (x, y) => [geo.cx2 + geo.s2 * ((x - MX) - (y - MY)) * C30, geo.cy2 + geo.s2 * ((x - MX) + (y - MY)) * 0.5];
    const proj = (x, y, t) => { const a = top(x, y); if (t <= 0) return a; const b = iso(x, y); return t >= 1 ? b : [lerp(a[0], b[0], t), lerp(a[1], b[1], t)]; };
    const ptsStr = a => a.map(p => r1(p[0]) + ',' + r1(p[1])).join(' ');

    function buildAnnoTop() {
      const g = L.annoTop; g.replaceChildren();
      if (cfg.small) return;
      const b = 13;
      GRIDX.forEach((x, i) => {
        const a = top(x, -2.4), c = top(x, 17.3);
        svgEl('path', { class: 'h-gd h-gd--dash', d: 'M' + r1(a[0]) + ',' + r1(a[1]) + 'V' + r1(c[1]) }, g);
        svgEl('circle', { class: 'h-bub', cx: r1(a[0]), cy: r1(a[1] - b), r: b }, g);
        const t = svgEl('text', { class: 'h-t h-t--bub', x: r1(a[0]), y: r1(a[1] - b), 'text-anchor': 'middle', dy: '.35em' }, g); t.textContent = 'ABCD'[i];
      });
      GRIDY.forEach((y, i) => {
        const a = top(-2.4, y), c = top(27.4, y);
        svgEl('path', { class: 'h-gd h-gd--dash', d: 'M' + r1(a[0]) + ',' + r1(a[1]) + 'H' + r1(c[0]) }, g);
        svgEl('circle', { class: 'h-bub', cx: r1(a[0] - b), cy: r1(a[1]), r: b }, g);
        const t = svgEl('text', { class: 'h-t h-t--bub', x: r1(a[0] - b), y: r1(a[1]), 'text-anchor': 'middle', dy: '.35em' }, g); t.textContent = i + 1;
      });
      // north point
      const n = top(33.4, -2.6);
      const nc = svgEl('circle', { class: 'h-gd', cx: r1(n[0]), cy: r1(n[1]), r: 15 }, g);
      const na = svgEl('path', { class: 'h-gd', d: 'M' + r1(n[0]) + ',' + r1(n[1] + 11) + 'L' + r1(n[0]) + ',' + r1(n[1] - 22) + 'M' + r1(n[0] - 5) + ',' + r1(n[1] - 12) + 'L' + r1(n[0]) + ',' + r1(n[1] - 22) + 'L' + r1(n[0] + 5) + ',' + r1(n[1] - 12) }, g);
      const nt = svgEl('text', { class: 'h-t', x: r1(n[0]), y: r1(n[1] - 28), 'text-anchor': 'middle' }, g); nt.textContent = 'N';
      // scale bar
      const sb = top(21.2, 23.7), u = geo.s * 5;
      svgEl('path', { class: 'h-gd', d: 'M' + r1(sb[0]) + ',' + r1(sb[1]) + 'h' + r1(u * 2) + 'M' + r1(sb[0]) + ',' + r1(sb[1] - 4) + 'v8M' + r1(sb[0] + u) + ',' + r1(sb[1] - 4) + 'v8M' + r1(sb[0] + u * 2) + ',' + r1(sb[1] - 4) + 'v8' }, g);
      ['0', '5', '10 m'].forEach((tx, i) => { const t = svgEl('text', { class: 'h-t', x: r1(sb[0] + u * i), y: r1(sb[1] - 9), 'text-anchor': 'middle' }, g); t.textContent = tx; });
      // labels
      const sl = top(13, -5.5); const st = svgEl('text', { class: 'h-t', x: r1(sl[0]), y: r1(sl[1]), 'text-anchor': 'middle', transform: 'rotate(-1.6 ' + r1(sl[0]) + ' ' + r1(sl[1]) + ')' }, g); st.textContent = 'Site boundary';
      const gl = top(G[0], 19.5); const gt = svgEl('text', { class: 'h-t', x: r1(gl[0] + 10), y: r1(gl[1] - 9) }, g); gt.textContent = 'Gate';
      const el = top(15.2, 18.4); const et = svgEl('text', { class: 'h-t', x: r1(el[0]), y: r1(el[1]) }, g); et.textContent = 'Entry';
      els.annoSite = [st, gt, nc, na, nt]; // the site's own notes (boundary, gate, north point) are shown early; the grid arrives with the plan
    }

    // point on the route at paced progress u (0..1)
    function along(u) {
      const T = u * geo.time, cumT = geo.cumT; let lo = 0, hi = cumT.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cumT[m] <= T) lo = m; else hi = m; }
      const f = cumT[hi] > cumT[lo] ? (T - cumT[lo]) / (cumT[hi] - cumT[lo]) : 0;
      return { x: lerp(geo.P[lo][0], geo.P[hi][0], f), y: lerp(geo.P[lo][1], geo.P[hi][1], f), len: lerp(geo.cumL[lo], geo.cumL[hi], f) };
    }

    function render(p) {
      if (!geo) return;
      p = clamp(p);
      if (p === state.p) return;
      state.p = p;
      const pd = seg01(p, cfg.cinema ? 0.0 : 0.0, 0.6);
      const tm = easeIO(seg01(p, 0.62, 0.8));
      const hr = easeIO(seg01(p, 0.75, 0.9));
      const rf = seg01(p, 0.87, 0.96);
      const pe = cfg.exit ? seg01(p, 0.9, 1) : 0;
      state.pd = pd; state.pe = pe; state.tm = tm;

      // site and floor
      L.site.setAttribute('points', ptsStr(SITE.map(q => proj(q[0], q[1], tm))));
      L.site.style.opacity = seg01(pd, geo.tSite * 0.9, geo.tSite) * 1;
      const fl = FOOT.map(q => proj(q[0], q[1], tm));
      L.floor.setAttribute('points', ptsStr(fl));
      L.floor.style.opacity = tm;
      const sh = hr * 1.5;
      L.shadow.setAttribute('points', ptsStr(FOOT.map(q => proj(q[0] + sh, q[1] + sh * 0.55, tm))));
      L.shadow.style.opacity = hr > 0 ? 0.09 : 0;

      // the stroke
      let tip;
      if (tm <= 0) {
        if (state.dMode !== 'top') { L.main.setAttribute('d', geo.dTop); state.dMode = 'top'; }
        if (pd < 1) {
          const a = along(pd);
          L.main.style.strokeDasharray = r1(geo.len) + ' ' + r1(geo.len + 8);
          L.main.style.strokeDashoffset = r1(geo.len - a.len);
          L.main.style.visibility = pd > 0 ? 'visible' : 'hidden';
          tip = [a.x, a.y]; state.drawn = a.len;
        } else { L.main.style.strokeDasharray = 'none'; L.main.style.visibility = 'visible'; tip = geo.P[geo.P.length - 1]; state.drawn = geo.len; }
      } else {
        state.dMode = 'morph';
        const pts = R.map(q => proj(q[0], q[1], tm));
        L.main.setAttribute('d', 'M' + pts.map(q => r1(q[0]) + ',' + r1(q[1])).join(' L'));
        L.main.style.strokeDasharray = 'none'; L.main.style.visibility = 'visible';
        tip = pts[pts.length - 1]; state.drawn = geo.len;
      }

      // lead-in from the full stop to the gate (cinema)
      if (origin) {
        const g = proj(G[0], G[1], tm), xm = g[0] - Math.max(26, geo.s * 2.2);
        const dl = rp([[origin.x, origin.y], [xm, origin.y], [xm, g[1]], [g[0], g[1]]], 14);
        if (state.dLead !== dl) { L.lead.setAttribute('d', dl); state.dLead = dl; if (HERO.leadSeg) { if (tm > 0) { L.lead.style.strokeDasharray = 'none'; } else { HERO.leadSeg.len = L.lead.getTotalLength(); L.lead.style.strokeDasharray = HERO.leadSeg.len + ' ' + (HERO.leadSeg.len + 6); HERO.leadSeg.apply(); } } }
        L.dot.setAttribute('cx', r1(origin.x)); L.dot.setAttribute('cy', r1(origin.y)); L.dot.setAttribute('r', r1(origin.r));
      } else {
        const g = proj(G[0], G[1], tm);
        L.dot.setAttribute('cx', r1(g[0])); L.dot.setAttribute('cy', r1(g[1])); L.dot.setAttribute('r', cfg.small ? 3.5 : 4.5);
      }

      // walls
      const hpx = geo.hpx * hr;
      L.walls.style.display = hr > 0 ? '' : 'none';
      if (hr > 0) {
        for (const o of els.walls) {
          const a = proj(o.w.a[0], o.w.a[1], tm), b = proj(o.w.b[0], o.w.b[1], tm);
          const a2 = [a[0], a[1] - hpx], b2 = [b[0], b[1] - hpx];
          o.face.setAttribute('points', ptsStr([a, b, b2, a2]));
          o.face.style.opacity = o.w.front ? 0.42 : 0.9;
          o.edge.setAttribute('d', 'M' + r1(a[0]) + ',' + r1(a[1]) + 'L' + r1(a2[0]) + ',' + r1(a2[1]) + 'L' + r1(b2[0]) + ',' + r1(b2[1]) + 'L' + r1(b[0]) + ',' + r1(b[1]));
          o.base.setAttribute('d', 'M' + r1(a[0]) + ',' + r1(a[1]) + 'L' + r1(b[0]) + ',' + r1(b[1]));
        }
      }
      // roof, lifted: an exploded axonometric
      const lift = (WALL_H + ROOF_GAP + (1 - easeOut(rf)) * 5) * geo.s2;
      const roof = FOOT.map(q => { const a = proj(q[0], q[1], tm); return [a[0], a[1] - lift]; });
      L.roof.setAttribute('points', ptsStr(roof)); L.roofEdge.setAttribute('points', ptsStr(roof));
      L.roof.style.opacity = rf * 0.34; L.roofEdge.style.opacity = rf;
      FOOT.forEach((q, i) => { const a = proj(q[0], q[1], tm); els.stems[i].setAttribute('d', 'M' + r1(a[0]) + ',' + r1(a[1] - hpx) + 'V' + r1(a[1] - lift)); els.stems[i].style.opacity = rf * 0.9; });

      // labels: each room is named the moment the stroke encloses it
      const toTag = cfg.small ? 1 : seg01(tm, 0.45, 0.9), toName = cfg.small ? 0 : 1 - seg01(tm, 0, 0.4);
      for (const lb of els.labels) {
        const c = ROOMS[lb.key], q = proj(c[0], c[1], tm), on = seg01(pd, geo.tRoom[lb.key], geo.tRoom[lb.key] + 0.025);
        lb.grp.setAttribute('transform', 'translate(' + r1(q[0]) + ',' + r1(q[1] - (cfg.small ? 0 : 3 * (1 - tm))) + ')');
        lb.tag.style.opacity = on * toTag; lb.name.style.opacity = on * toName;
      }
      L.key.style.opacity = cfg.small ? 0 : seg01(hr, 0.4, 1);
      // top-view annotations
      if (els.annoSite) {
        L.annoTop.style.opacity = 1 - seg01(tm, 0, 0.35);
        L.annoTop.style.display = tm >= 0.35 ? 'none' : '';
        const a1 = seg01(pd, geo.tSite * 0.55, geo.tSite), a2 = seg01(pd, geo.tSite + 0.06, geo.tSite + 0.22);
        Array.prototype.forEach.call(L.annoTop.children, ch => { ch.style.opacity = els.annoSite.indexOf(ch) >= 0 ? a1 : a2; });
      }
      // exit: back out of the front door, across the boundary, down the page
      if (cfg.exit) {
        const e = EXIT.map(q => proj(q[0], q[1], tm)), last = e[e.length - 1];
        const de = rp(e.concat([[last[0], last[1] + 30], [last[0], geo.H + 2]]), 16);
        if (state.dExit !== de) { L.exit.setAttribute('d', de); state.dExit = de; state.exitLen = L.exit.getTotalLength(); }
        L.exit.style.strokeDasharray = r1(state.exitLen) + ' ' + r1(state.exitLen + 8);
        L.exit.style.strokeDashoffset = r1(state.exitLen * (1 - pe));
        L.exit.style.visibility = pe > 0 ? 'visible' : 'hidden';
        if (pe > 0) { const q = L.exit.getPointAtLength(state.exitLen * pe); tip = [q.x, q.y]; }
        state.exitX = last[0];
      } else L.exit.style.visibility = 'hidden';
      state.tip = tip;
      LINE.dirty = true;
    }

    return {
      setup, layout, render,
      get p() { return state.p; },
      tipScreen() { if (!state.tip || !svg) return null; const b = svg.getBoundingClientRect(); return [b.left + state.tip[0], b.top + state.tip[1]]; },
      drawn() { return (state.drawn || 0) + (state.exitLen || 0) * (state.pe || 0); },
      started() { return (state.pd || 0) > 0; },
      pSite() { return geo ? geo.tSite * 0.6 : 0.14; }, // hero progress at which the site boundary closes
      exitX() { // where the stroke leaves the hero, in iso, as a page x
        if (!geo) return 0; const q = iso(EXIT[3][0], EXIT[3][1]); return q[0];
      },
      leadPath() { return L.lead; }, leadSeg: null, origin() { return origin; }
    };
  })();

  /* ------------------------------------------------------------------------
     Behaviours every mode has
     ------------------------------------------------------------------------ */
  const themed = () => $$('[data-theme]');
  let themeEls = [], navLinks = [];
  function trackTheme() {
    const H = w.innerHeight, navY = mode === 'cinema' ? 40 : 30, hudY = H - 30;
    let nav = 'paper', hud = 'paper', sheetEl = null;
    for (const el of themeEls) {
      const r = el.getBoundingClientRect();
      if (r.top <= navY && r.bottom > navY) nav = el.dataset.theme;
      if (r.top <= hudY && r.bottom > hudY) { hud = el.dataset.theme; sheetEl = el; }
    }
    if (root.dataset.nav !== nav) root.dataset.nav = nav;
    if (root.dataset.hud !== hud) root.dataset.hud = hud;
    const mid = H * 0.45; let cur = '';
    for (const el of themeEls) { if (!el.id) continue; const r = el.getBoundingClientRect(); if (r.top <= mid && r.bottom > mid) cur = el.id; }
    if (cur !== trackTheme.cur) { trackTheme.cur = cur; navLinks.forEach(a => { if (a.getAttribute('href') === '#' + cur) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); }); }
    return sheetEl;
  }

  function initMenu() {
    const btn = $('.nav__toggle'), menu = $('#menu'), main = $('#main'), foot = $('.foot');
    if (!btn || !menu) return;
    const set = open => {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      menu.hidden = !open; root.classList.toggle('menu-open', open);
      [main, foot].forEach(el => { if (el) { if (open) el.setAttribute('inert', ''); else el.removeAttribute('inert'); } });
      if (open) { const a = $('a', menu); if (a) a.focus(); }
    };
    btn.addEventListener('click', () => set(btn.getAttribute('aria-expanded') !== 'true'));
    menu.addEventListener('click', e => { if (e.target.closest('a')) set(false); });
    d.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { set(false); btn.focus(); } });
    w.matchMedia('(min-width:900px)').addEventListener('change', e => { if (e.matches) set(false); });
  }

  /* Folded lists (phones). A schedule shows its first rows and a role its first lines; the rest are one tap away.
     The script only marks the rows and adds the button: the phone style sheet does the hiding, so a wide screen,
     a print-out and a page without script all show every row. */
  function initFold() {
    let n = 0;
    const fold = (list, keep, what) => {
      const rows = Array.from(list.children).filter(el => el.tagName === 'LI');
      if (rows.length < keep + 2) return; // never fold a single row away
      rows.slice(keep).forEach(li => li.classList.add('fold__more'));
      if (!list.id) list.id = 'fold-' + (++n);
      const btn = d.createElement('button');
      btn.type = 'button'; btn.className = 'fold__btn';
      btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', list.id);
      btn.innerHTML = '<span>Show all ' + rows.length + ' ' + what + '</span><i aria-hidden="true"></i>';
      list.classList.add('fold'); list.insertAdjacentElement('afterend', btn);
      btn.addEventListener('click', () => {
        list.classList.add('is-open'); btn.remove();
        const first = rows[keep]; first.setAttribute('tabindex', '-1'); first.focus({ preventScroll: true });
        if (ScrollTrigger && mode !== 'still') ScrollTrigger.refresh(); // the page below has moved
      });
    };
    $$('.sheet .sch__list').forEach(l => fold(l, 4, 'items'));
    $$('.role__list').forEach(l => fold(l, 2, 'lines'));
  }

  /* Small screens: the walkthrough button joins the bar once the hero's own button has scrolled away, and leaves
     again at the form. Wide screens always show it; there the attribute changes nothing. */
  function initBarCta() {
    const hero = $('.hero__cta .btn'), form = $('#walkthrough');
    if (!hero || !form || !('IntersectionObserver' in w)) return;
    const seen = new Map([[hero, true], [form, false]]);
    const io = new IntersectionObserver(es => {
      es.forEach(en => seen.set(en.target, en.isIntersecting));
      if (!seen.get(hero) && !seen.get(form)) root.setAttribute('data-cta', 'on'); else root.removeAttribute('data-cta');
    });
    io.observe(hero); io.observe(form);
  }

  const JOURNEY = { st: null, panels: [], go: null };
  function targetY(id) {
    const t = d.getElementById(id); if (!t) return null;
    if (id === 'top') return 0;
    if (mode === 'cinema' && JOURNEY.st) {
      if (id === 'journey') return JOURNEY.st.start + 2;
      const i = JOURNEY.panels.indexOf(t);
      if (i >= 0) return JOURNEY.st.start + (JOURNEY.st.end - JOURNEY.st.start) * (i / (JOURNEY.panels.length - 1));
    }
    if (mode === 'cinema' && CLOSE.st && id === 'walkthrough') return CLOSE.st.end; // past the pinned drawing, on the finished sheet
    const off = mode === 'cinema' ? 0 : 58;
    return Math.max(0, t.getBoundingClientRect().top + w.scrollY - off);
  }
  function initAnchors() {
    d.addEventListener('click', e => {
      const a = e.target.closest('a[href^="#"]'); if (!a) return;
      const id = a.getAttribute('href').slice(1); if (!id) return;
      const y = targetY(id); if (y === null) return;
      e.preventDefault();
      const t = d.getElementById(id);
      if (lenis) lenis.scrollTo(y, { duration: Math.min(2.6, 1.1 + Math.abs(y - w.scrollY) / 9000) });
      else w.scrollTo({ top: y, behavior: mode === 'still' ? 'auto' : 'smooth' });
      const focusEl = t.matches('section,article,div') ? ($('h1,h2,h3', t) || t) : t;
      if (!focusEl.hasAttribute('tabindex')) focusEl.setAttribute('tabindex', '-1');
      focusEl.focus({ preventScroll: true });
      if (history.replaceState) history.replaceState(null, '', '#' + id);
    });
  }

  function initForm() {
    const form = $('#walkForm'), ok = $('#walkOk'); if (!form) return;
    const btn = $('.form__btn', form), msg = $('.form__msg', form), label = btn.textContent;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (btn.disabled) return;
      btn.disabled = true; btn.textContent = 'Sending…'; msg.textContent = '';
      try {
        const resp = await fetch(form.action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } });
        if (resp.ok) {
          form.hidden = true; ok.hidden = false; ok.setAttribute('tabindex', '-1'); ok.focus({ preventScroll: true });
          if (gsap && mode !== 'still') gsap.from(ok, { autoAlpha: 0, y: 18, duration: 0.9, ease: 'expo.out' });
        } else { btn.textContent = 'Try again'; btn.disabled = false; msg.textContent = 'That did not go through. Please try again.'; }
      } catch (err) { btn.textContent = label; btn.disabled = false; msg.textContent = 'No connection just now. Please try again.'; }
    });
  }

  /* key plan: light the rooms of the role being read */
  function initKeyplan() {
    const plan = $('#keyplan'), roles = $$('.role'); if (!plan || !roles.length) return;
    const cap = $('.planbox__role');
    const show = role => {
      let rooms; try { rooms = JSON.parse(role.dataset.rooms); } catch (e) { return; }
      $$('.kp-room', plan).forEach(r => { r.setAttribute('class', 'kp-room kp-' + (rooms[r.dataset.room] || 'none')); });
      $$('.kp-label', plan).forEach(t => { t.classList.toggle('is-full', rooms[t.dataset.room] === 'full'); });
      if (cap) cap.textContent = $('.role__name', role).textContent;
      roles.forEach(r => r.classList.toggle('is-on', r === role));
    };
    show(roles[0]);
    if (!('IntersectionObserver' in w)) return;
    const io = new IntersectionObserver(es => { es.forEach(en => { if (en.isIntersecting) show(en.target); }); }, { rootMargin: '-46% 0px -46% 0px', threshold: 0 });
    roles.forEach(r => io.observe(r));
  }

  /* ------------------------------------------------------------------------
     Reveals (flow and cinema)
     ------------------------------------------------------------------------ */
  function initReveals() {
    // nothing is prepared up front: each element is set and released the moment it arrives
    const ROWS = '.sheet__no,.sheet__t,.sheet__lede,.sch__head,.sch__list li,.fold__btn,.dev,.stamp,.fnote';
    const show = el => {
      if (el.classList.contains('is-in')) return;
      if (el.hasAttribute('data-split')) {
        const ws = splitWords(el); gsap.set(ws, { yPercent: 118 }); el.classList.add('is-in');
        gsap.to(ws, { yPercent: 0, duration: 1.25, ease: 'expo.out', stagger: 0.045 });
      } else if (el.classList.contains('sheet')) {
        // opacity only: a heading that has keyboard focus must not be hidden from it
        const rows = $$(ROWS, el); gsap.set(rows, { opacity: 0, y: 18 }); el.classList.add('is-in');
        gsap.to(rows, { opacity: 1, y: 0, duration: 0.95, ease: 'expo.out', stagger: 0.035, delay: 0.05 });
      } else {
        gsap.set(el, { opacity: 0, y: 26 }); el.classList.add('is-in');
        gsap.to(el, { opacity: 1, y: 0, duration: 1.15, ease: 'expo.out' });
      }
    };
    const io = new IntersectionObserver(es => { es.forEach(en => { if (en.isIntersecting) { io.unobserve(en.target); show(en.target); } }); }, { rootMargin: '0px 0px -9% 0px', threshold: 0.12 });
    $$('[data-split],[data-reveal]').forEach(el => io.observe(el));
    const io2 = new IntersectionObserver(es => { es.forEach(en => { if (en.isIntersecting) { io2.unobserve(en.target); show(en.target); } }); }, { threshold: 0.06 });
    $$('.sheet').forEach(sh => io2.observe(sh));
  }

  /* ------------------------------------------------------------------------
     Vignette timelines. Authored on a 0..1 clock; the default DOM is the end state.
     In cinema the clock is the sheet's travel across the screen; in flow it plays once.
     ------------------------------------------------------------------------ */
  /* The mark, set out: the construction plate in the closing sheet. Its default DOM is the finished drawing;
     prep() hides what a timeline will bring in. Times are on the caller's clock: a = start, d = length. */
  const CLOSE = { st: null };
  const PLATE = {
    fit() { $$('.plate__svg').forEach(s => { const r = s.getBoundingClientRect(); if (r.width > 0) s.style.setProperty('--u', (r.width / 110).toFixed(3)); }); },
    prep(svg) {
      // no transform-box here: GSAP places an SVG element's origin itself, and with fill-box as well the element slides in from the lower right while it scales
      const q = sel => $$(sel, svg), fb = { transformOrigin: '50% 50%' };
      const P = { grid: q('.pl-grid'), rules: q('.pl-rule').map(l => new Seg(l)), labs: q('.pl-lab'), circs: q('.pl-circ'), ctrs: q('.pl-ctr'),
        weight: new Seg($('.pl-weight', svg)), line: new Seg($('.pl-line', svg)), dims: q('.pl-dim'), dot: $('.pl-dotfill', svg), cap: $('.plate__cap', svg.parentNode),
        on: q('.pl-ctr--dot'), ink: '#4F378A' };   // ink = --purple in site.css, written out: reading it here would force a style pass in the middle of set-up
      gsap.set(P.weight.path, { strokeOpacity: 0.2 });   // while it is being drawn the weight is a ghost; issue() makes it the solid mark
      gsap.set(P.on, { stroke: '#fff' });                 // what sits on the line is white until the line turns solid under it
      gsap.set([P.grid, P.labs, P.dims, P.cap], { autoAlpha: 0 });
      gsap.set(P.circs, Object.assign({ autoAlpha: 0, scale: 0.88 }, fb));
      gsap.set(P.ctrs, Object.assign({ scale: 0 }, fb));
      gsap.set(P.dot, Object.assign({ scale: 0 }, fb));
      gsap.set(P.dims, { y: 1.6 });
      return P;
    },
    setOut(tl, P, a, d) {   // grid, the two rules, the centres, the circles the line will follow
      tl.to(P.grid, { autoAlpha: 1, duration: d * 0.36 }, a);
      P.rules.forEach((s, i) => tl.to(s, { p: 1, duration: d * 0.36 }, a + d * (0.18 + i * 0.1)));
      tl.to(P.labs, { autoAlpha: 1, duration: d * 0.16, stagger: d * 0.1 }, a + d * 0.52)
        .to(P.ctrs, { scale: 1, duration: d * 0.16, stagger: d * 0.07, ease: 'back.out(2.4)' }, a + d * 0.5)
        .to(P.circs, { autoAlpha: 1, scale: 1, duration: d * 0.3, stagger: d * 0.08, ease: 'power2.out' }, a + d * 0.54);
    },
    draw(tl, P, a, d, ease) {   // the pen follows the circles; its weight follows the pen
      tl.to(P.line, { p: 1, duration: d, ease: ease || 'none' }, a).to(P.weight, { p: 1, duration: d * 0.95, ease: ease || 'none' }, a + d * 0.05);
    },
    issue(tl, P, a, d) {   // the drawing becomes the logo: the weight fills, the dot lands, and what is drawn on the line takes the ground's colour
      tl.to(P.weight.path, { strokeOpacity: 1, duration: d, ease: 'power1.inOut' }, a)
        .to(P.dot, { scale: 1, duration: d * 0.5, ease: 'back.out(3)' }, a + d * 0.7)
        .to(P.on, { stroke: P.ink, duration: d * 0.4 }, a + d * 0.6);
    },
    note(tl, P, a, d) {   // the dimensions, one after another, then the caption
      tl.to(P.dims, { autoAlpha: 1, y: 0, duration: d * 0.36, stagger: d * 0.5 / Math.max(1, P.dims.length - 1), ease: 'power2.out' }, a)
        .to(P.cap, { autoAlpha: 1, duration: d * 0.3 }, a + d * 0.7);
    }
  };

  function flip(tl, at, on, off) { const o = { v: 0 }; off(); tl.to(o, { v: 1, duration: 0.0008, ease: 'none', onUpdate() { (o.v >= 0.5 ? on : off)(); } }, at); }
  function gseg(svg) { const p = $('.gl', svg); return p ? new Seg(p) : null; }

  /* Each sheet's picture: its screens come up one after another, the one behind first, then the pen makes the
     sheet's gesture (a signature, a loop, the week's comb, the section, the status stair, the pipeline, the trend).
     Times are fractions of the sheet's scene; g is the gesture's line and at is when it is drawn. */
  const shotIn = (el, tl) => {
    $$('.scr', el).forEach((s, i) => tl.from(s, { autoAlpha: 0, y: i ? '1.8em' : '2.4em', duration: i ? 0.14 : 0.16 }, 0.1 + Math.min(i, 2) * 0.13));
    const grp = $('.scr__group', el); if (grp) tl.from(grp, { autoAlpha: 0, duration: 0.1 }, 0.3);
  };
  const VG = {
    contract(el, tl) {
      shotIn(el, tl);
      tl.from($('.sign__t', el), { autoAlpha: 0, duration: 0.08 }, 0.7);
      return { g: gseg($('.gline--sign', el)), at: [0.72, 0.93] };
    },
    planner(el, tl) {
      shotIn(el, tl);
      tl.from($('.roll__n', el), { autoAlpha: 0, duration: 0.08 }, 0.72)
        .from($('.roll__t', el), { autoAlpha: 0, x: '-.8em', duration: 0.1 }, 0.76);
      return { g: gseg($('.gline--loop', el)), at: [0.6, 0.8] };
    },
    week(el, tl) {
      shotIn(el, tl);
      tl.from($('.gline--comb .gt', el), { autoAlpha: 0, duration: 0.1, ease: 'none' }, 0.4);
      return { g: gseg($('.gline--comb', el)), at: [0.38, 0.93] };
    },
    site(el, tl) {
      shotIn(el, tl);
      tl.from($('[data-a="sitegd"]', el), { autoAlpha: 0, duration: 0.2, ease: 'none' }, 0.5)
        .from($('.gline--site .gt', el), { autoAlpha: 0, duration: 0.12, ease: 'none' }, 0.6);
      return { g: gseg($('.gline--site', el)), at: [0.3, 0.93] };
    },
    money(el, tl) {
      shotIn(el, tl);
      const nodes = $$('.gline--rail [data-a="node"]', el);
      [0.363, 0.495, 0.628, 0.76, 0.886].forEach((t, i) => flip(tl, t, () => nodes[i].classList.add('is-on'), () => nodes[i].classList.remove('is-on')));
      tl.from($('.gline--rail .gt', el), { autoAlpha: 0, duration: 0.1, ease: 'none' }, 0.3);
      return { g: gseg($('.gline--rail', el)), at: [0.3, 0.93] };
    },
    people(el, tl) {
      shotIn(el, tl);
      const nodes = $$('.gline--pipe [data-a="node"]', el);
      [0.209, 0.328, 0.446, 0.565, 0.684].forEach((t, i) => flip(tl, t, () => nodes[i].classList.add('is-on'), () => nodes[i].classList.remove('is-on')));
      tl.from($('.gline--pipe .gt', el), { autoAlpha: 0, duration: 0.1, ease: 'none' }, 0.16);
      return { g: gseg($('.gline--pipe', el)), at: [0.16, 0.93] };
    },
    insight(el, tl) {
      shotIn(el, tl);
      tl.from($('.gline--chart .gd', el), { autoAlpha: 0, duration: 0.12, ease: 'none' }, 0.34);
      return { g: gseg($('.gline--chart', el)), at: [0.4, 0.9] };
    }
  };
  const VG_ORDER = ['contract', 'planner', 'week', 'site', 'money', 'people', 'insight'];

  function buildStation(sheet, i) {
    const vg = $('.vg', sheet), name = VG_ORDER[i];
    const tl = gsap.timeline({ paused: true, defaults: { ease: 'expo.out' } });
    tl.to({}, { duration: 1 }, 0);
    const res = VG[name](vg, tl);
    if (res.g) tl.to(res.g, { p: 1, duration: res.at[1] - res.at[0], ease: 'none' }, res.at[0]);
    return { sheet, vg, tl, g: res.g, at: res.at, name };
  }
  // heavy set-up runs as a queue of short tasks, so the page stays responsive while it builds
  const LENIS = { src: 'https://cdn.jsdelivr.net/npm/lenis@1.1.13/dist/lenis.min.js', sri: 'sha384-B2WBjDzEjJpYvhmi2UyEn7rektqkf5suS6sNoyyrf0EBAwBHdkiXxIlU0V5Ru2ed' };
  const loadScript = (src, sri) => new Promise((res, rej) => { const el = d.createElement('script'); el.src = src; if (sri) { el.integrity = sri; el.crossOrigin = 'anonymous'; } el.onload = res; el.onerror = rej; d.head.appendChild(el); });
  // a narrow or short hero figure gets the compact drawing: numbered tags only, the list beside it is the schedule
  const compactHero = el => { const b = el.getBoundingClientRect(); return b.width < 560 || b.height < 400; };
  const tick = () => new Promise(r => setTimeout(r, 0));
  async function runSteps(steps) { for (const st of steps) { st(); await tick(); } }

  /* ------------------------------------------------------------------------
     FLOW: stacked layout; a spine fills with scroll; scenes play when they arrive
     ------------------------------------------------------------------------ */
  async function flow() {
    gsap.registerPlugin(ScrollTrigger);
    // hero first: it is what is on screen
    // the headline is already on the page (it is the first thing a phone should paint); only the drawing moves
    const hsvg = $('.hero__svg'), small = compactHero(hsvg);
    HERO.setup(hsvg, { cinema: false, small, exit: false });
    HERO.render(0);
    const hp = { v: 0 };
    const draw = gsap.to(hp, { v: 0.97, duration: 9, ease: 'none', paused: true, onUpdate() { HERO.render(hp.v); } });
    new IntersectionObserver((es, ob) => { es.forEach(en => { if (en.isIntersecting) { ob.disconnect(); draw.play(); } }); }, { threshold: 0.3 }).observe(hsvg);
    await tick();

    const steps = [];
    let cloudPath = null;
    steps.push(() => { $$('.problem [data-split]').forEach(splitWords); cloudPath = buildCloud(); fitGlines(); });
    steps.push(() => {
      // each sheet's scene is built as it approaches and plays once when it arrives
      const sheets = $$('.sheet'), built = new Map();
      const build = vg => { if (!built.has(vg)) { const sheet = vg.closest('.sheet'); built.set(vg, buildStation(sheet, sheets.indexOf(sheet))); } return built.get(vg); };
      const near = new IntersectionObserver(es => { es.forEach(en => { if (en.isIntersecting) { near.unobserve(en.target); build(en.target); } }); }, { rootMargin: '70% 0px 70% 0px' });
      const play = new IntersectionObserver(es => { es.forEach(en => { if (en.isIntersecting) { play.unobserve(en.target); build(en.target).tl.timeScale(1 / 3.4).play(0); } }); }, { threshold: 0.28 });
      $$('.sheet .vg').forEach(vg => { near.observe(vg); play.observe(vg); });
    });
    steps.push(() => {
      gsap.from('.rooms li', { autoAlpha: 0, y: 14, duration: 0.8, ease: 'expo.out', stagger: 0.06, scrollTrigger: { trigger: '.rooms', start: 'top 88%' } });
      if (cloudPath) { const cs = new Seg(cloudPath); gsap.to(cs, { p: 1, duration: 1.6, ease: 'power2.inOut', scrollTrigger: { trigger: '.problem__h', start: 'top 62%' } }); }
      // the mark, set out: the plate draws itself when it arrives
      const psvg = $('.plate__svg');
      if (psvg) {
        const P = PLATE.prep(psvg);
        const pt = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: psvg, start: 'top 70%' } });
        PLATE.setOut(pt, P, 0, 1.5); PLATE.draw(pt, P, 1.2, 2.2, 'power2.inOut'); PLATE.note(pt, P, 3.0, 1.3);
        PLATE.issue(pt, P, 3.3, 1.1);
      }
      // the logo: its "in" is drawn, the dot lands, the rest of the word follows
      const mp = $('.close__logo .cl-in'), md = $('.close__logo .cl-dot'), mw = $('.close__logo .cl-word');
      if (mp) {
        const ms = new Seg(mp); gsap.set(md, { scale: 0, transformOrigin: '50% 50%' }); gsap.set(mw, { autoAlpha: 0, x: -14 });
        gsap.timeline({ scrollTrigger: { trigger: '.close__mark', start: 'top 74%' } }).to(ms, { p: 1, duration: 1.7, ease: 'power2.inOut' }).to(md, { scale: 1, duration: 0.6, ease: 'back.out(3)' }, '-=0.15').to(mw, { autoAlpha: 1, x: 0, duration: 1, ease: 'expo.out' }, '-=0.5');
      }
    });
    steps.push(initReveals);
    await runSteps(steps);

    // the spine fills as the page is read
    const secs = $$('.problem,.journey,.roles,.setup,.close');
    let ticking = false;
    const upd = () => { ticking = false; const pen = w.innerHeight * 0.62; secs.forEach(sec => { const r = sec.getBoundingClientRect(), v = clamp((pen - r.top) / r.height).toFixed(4); if (sec.__p !== v) { sec.__p = v; sec.style.setProperty('--p', v); } }); trackTheme(); };
    w.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(upd); } }, { passive: true });
    upd();
    let rw = w.innerWidth;
    w.addEventListener('resize', () => { if (Math.abs(w.innerWidth - rw) > 40) { rw = w.innerWidth; HERO.layout(); HERO.render(hp.v || 0.97); buildCloud(); fitGlines(); upd(); } });
  }

  /* ------------------------------------------------------------------------
     STILL: everything drawn, nothing moves
     ------------------------------------------------------------------------ */
  function still() {
    const hsvg = $('.hero__svg');
    const draw = () => { HERO.setup(hsvg, { cinema: false, small: compactHero(hsvg), exit: false }); HERO.render(0.97); buildCloud(); fitGlines(); };
    draw();
    let rw = w.innerWidth;
    w.addEventListener('resize', () => { if (Math.abs(w.innerWidth - rw) > 40) { rw = w.innerWidth; draw(); } });
    let ticking = false;
    w.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; trackTheme(); }); } }, { passive: true });
    trackTheme();
  }

  /* ------------------------------------------------------------------------
     CINEMA
     ------------------------------------------------------------------------ */
  async function cinema() {
    gsap.registerPlugin(ScrollTrigger);
    ScrollTrigger.config({ ignoreMobileResize: true });
    const pen = $('.pen'), hudXY = $('.hud__xy'), hudLen = $('.hud__len'), hudSheet = $('.hud__sheet'), hudTitle = $('.hud__title'), hudIndex = $('.hud__index');
    const W = () => w.innerWidth, H = () => w.innerHeight;
    const em = () => 16 * K();
    const foot = $('.foot'); if (foot) { foot.dataset.theme = 'purple'; foot.dataset.sheet = 'Sheet 11'; foot.dataset.title = 'Handover'; }

    // smooth wheel scrolling, only where there is a wheel; fetched on demand, and optional
    if (finePointer) {
      loadScript(LENIS.src, LENIS.sri).then(() => {
        if (!w.Lenis) return;
        lenis = new w.Lenis({ duration: 1.15, easing: t => Math.min(1, 1.001 - Math.pow(2, -10 * t)), smoothWheel: true, wheelMultiplier: 0.95 });
        lenis.on('scroll', ScrollTrigger.update);
        gsap.ticker.add(t => lenis.raf(t * 1000));
        gsap.ticker.lagSmoothing(0);
        root.classList.add('lenis');
      }).catch(() => {});
    }

    /* ---- hero ---- */
    const hsvg = $('.hero__svg');
    HERO.setup(hsvg, { cinema: true, small: false, exit: true });
    HERO.render(0);
    const lead = new Seg(HERO.leadPath()); HERO.leadSeg = lead;
    const heroMain = { get p() { return HERO.started() ? 1 : 0; }, tip: () => HERO.tipScreen(), drawn: () => HERO.drawn() };
    const lines = $$('.hl>span'), copy = $$('.hero__kicker,.hero__sub,.hero__cta'), cue = $('.hero__cue');
    gsap.set(lines, { yPercent: 112 }); gsap.set(copy, { autoAlpha: 0, y: 22 }); gsap.set(cue, { autoAlpha: 0 });
    gsap.set('.h-dot', { scale: 0, transformOrigin: '50% 50%' });
    $('.hero__copy').classList.add('is-in');
    // on arrival the pen leaves the full stop, reaches the gate and walks the site boundary by itself;
    // from there the drawing belongs to the reader's scroll
    const hs = { p: 0, base: 0 }, phases = $$('.hero__phases li');
    const heroP = () => hs.base + (1 - hs.base) * hs.p;
    const heroFrame = () => {
      const p = heroP();
      HERO.render(p);
      const ph = p < 0.03 ? 0 : p < 0.21 ? 1 : p < 0.66 ? 2 : 3;
      phases.forEach((li, i) => li.classList.toggle('is-on', i + 1 === ph));
    };
    const intro = gsap.timeline({ delay: 0.2 });
    intro.to(lines, { yPercent: 0, duration: 1.35, ease: 'expo.out', stagger: 0.11 }, 0)
      .to('.h-dot', { scale: 1, duration: 0.7, ease: 'back.out(2.6)' }, 0.75)
      .to(copy, { autoAlpha: 1, y: 0, duration: 1.15, ease: 'expo.out', stagger: 0.1 }, 0.5)
      .to(lead, { p: 1, duration: 1.3, ease: 'power2.inOut' }, 1.05)
      .to(hs, { base: HERO.pSite(), duration: 2.6, ease: 'power1.inOut', onUpdate: heroFrame }, 2.2)
      .to(cue, { autoAlpha: 1, duration: 0.8 }, 3.6);
    const heroTween = gsap.to(hs, {
      p: 1, ease: 'none',
      scrollTrigger: { trigger: '.hero', start: 'top top', end: () => '+=' + Math.round(H() * 3.4), pin: '.hero__pin', scrub: 0.55, anticipatePin: 1, invalidateOnRefresh: true },
      onUpdate() {
        if (hs.p > 0.002 && intro.progress() < 1) intro.progress(1);
        heroFrame();
        cue.style.opacity = hs.p > 0.02 ? 0 : '';
      }
    });

    /* ---- sections with a vertical line: map scroll to the stroke by y ---- */
    function penAt(y, hgt) { // where the pen tip sits in the viewport (fraction of height) at section-y
      const ramp = Math.min(H() * 0.7, hgt / 2.2);
      const a = 1 - seg01(y, 0, ramp), b = seg01(y, hgt - ramp, hgt);
      return 0.6 + 0.32 * Math.max(a * a, b * b);
    }
    function scrubChain(section, items, opts) {
      opts = opts || {};
      const hgt = section.offsetHeight;
      const S = y => y + (0.92 - penAt(y, hgt)) * H();
      const tl = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: section, start: 'top 92%', end: 'bottom 92%', scrub: 0.5 } });
      const total = S(hgt);
      let cur = 0;
      items.forEach(it => {
        const a = Math.max(cur, S(it.y0));
        const b = Math.max(a + it.seg.len * (it.pace || 0.42), S(it.y1));
        tl.to(it.seg, { p: 1, duration: b - a }, a);
        if (it.then) it.then(tl, b);
        cur = b;
      });
      if (cur < total) tl.to({}, { duration: total - cur }, cur);
      return tl;
    }
    const rel = (el, host) => { const a = el.getBoundingClientRect(), b = host.getBoundingClientRect(); return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height, r: a.right - b.left, b: a.bottom - b.top, cx: a.left - b.left + a.width / 2, cy: a.top - b.top + a.height / 2 }; };
    const mkRoute = (svg, pathsD) => { svg.replaceChildren(); return pathsD.map(dd => new Seg(svgEl('path', { d: dd }, svg))); };
    const gpoint = (svg, attr, host) => { const v = svg.getAttribute(attr).split(',').map(Number), vb = svg.viewBox.baseVal, r = rel(svg, host); return [r.x + v[0] / vb.width * r.w, r.y + v[1] / vb.height * r.h]; };

    const chains = { hero: [lead, heroMain], problem: [], journey: [], roles: [], setup: [], close: [] };

    /* ---- 01 problem ---- */
    const X1 = HERO.exitX() + hsvg.getBoundingClientRect().left;
    const problem = $('.problem');
    let XL;
    const steps = [];
    await tick();
    steps.push(function () {
      $$('[data-split]', problem).forEach(splitWords);
      const svg = $('.route', problem), hgt = problem.offsetHeight;
      const bs = $$('.survey .bubble', problem).map(b => rel(b, problem));
      XL = bs[0].cx;
      const yT = Math.min(H() * 0.13, 120);
      const pts = [[X1, 0], [X1, yT], [XL, yT]];
      const ds = [];
      let prevY = yT;
      bs.forEach((b, i) => {
        const rr = b.w / 2 + 8, side = i % 2 ? 1 : -1;
        // down to the bubble, then around it on alternating sides
        ds.push({ d: null, pts: (i === 0 ? pts : [[XL, prevY]]).concat([[XL, b.cy - rr]]), y0: i === 0 ? 0 : prevY, y1: b.cy - rr });
        ds.push({ d: 'M' + r1(XL) + ',' + r1(b.cy - rr) + ' A' + r1(rr) + ',' + r1(rr) + ' 0 0 ' + (side > 0 ? 1 : 0) + ' ' + r1(XL) + ',' + r1(b.cy + rr), y0: b.cy - rr, y1: b.cy + rr, pace: 0.6 });
        prevY = b.cy + rr;
      });
      ds.push({ pts: [[XL, prevY], [XL, hgt]], y0: prevY, y1: hgt });
      const segs = mkRoute(svg, ds.map(o => o.d || rp(o.pts, 22)));
      scrubChain(problem, segs.map((s, i) => ({ seg: s, y0: ds[i].y0, y1: ds[i].y1, pace: ds[i].pace })));
      chains.problem = segs;
      const cp = buildCloud();
      if (cp) { const cs = new Seg(cp); gsap.to(cs, { p: 1, duration: 1.7, ease: 'power2.inOut', scrollTrigger: { trigger: '.problem__h', start: 'top 58%' } }); }
      // the broken line under "a broken line."
      const br = $('.broken', problem);
      if (br) {
        const ib = inkBox(br, problem), y = ib.base + ib.fs * 0.17;
        const bp = svgEl('path', { d: 'M' + r1(ib.x0) + ',' + r1(y) + 'H' + r1(ib.x1), style: 'stroke:var(--red);stroke-dasharray:15 9;stroke-linecap:butt' }, svg);
        gsap.from(bp, { attr: { d: 'M' + r1(ib.x0) + ',' + r1(y) + 'H' + r1(ib.x0) }, duration: 1.3, ease: 'power2.out', scrollTrigger: { trigger: br, start: 'top 72%' } });
      }
      const turn = $('[data-anchor="turn"]', problem);
      if (turn) { const r = rel(turn, problem); const lp = svgEl('path', { d: 'M' + r1(XL + 16) + ',' + r1(r.cy) + 'H' + r1(r.x - 16), style: 'stroke:var(--purple);stroke-width:1px' }, svg); gsap.from(lp, { autoAlpha: 0, duration: 0.8, scrollTrigger: { trigger: turn, start: 'top 80%' } }); }
    });

    /* ---- A-00 … A-07 journey ---- */
    const journey = $('.journey'), track = $('.journey__track'), panels = $$('.panel', track), rsvg = $('.route--track', track);
    JOURNEY.panels = panels;
    const stations = [], J = { n: panels.length, Q0: 0.36, Q1: 0.93 };
    const addSeg = dd => new Seg(svgEl('path', { d: dd }, rsvg));
    steps.push(function () {
      // measure every sheet before any timeline moves its parts
      const Wd = J.Wd = W(), Hh = J.Hh = H();
      rsvg.setAttribute('width', J.n * Wd); rsvg.setAttribute('height', Hh); rsvg.style.width = J.n * Wd + 'px';
      rsvg.setAttribute('viewBox', '0 0 ' + J.n * Wd + ' ' + Hh);
      rsvg.replaceChildren();
      fitGlines();
      J.E = em(); J.Yg = rel($('.ground', panels[1]), track).cy;
      J.sheets = $$('.sheet', track);
      if ('IntersectionObserver' in w) { const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); $$('.shot img').forEach(im => { im.loading = 'eager'; }); } }, { rootMargin: '200% 0px 200% 0px' }); io.observe(journey); }
      J.M = J.sheets.map(sheet => { const vg = $('.vg', sheet), svg = $('svg.gline', vg); return { vr: rel(vg, track), pin: gpoint(svg, 'data-in', track), pout: gpoint(svg, 'data-out', track) }; });
    });
    $$('.sheet', track).forEach((sheet, i) => steps.push(function () { stations.push(buildStation(sheet, i)); }));
    steps.push(function () {
      const Wd = J.Wd, Hh = J.Hh, n = J.n, E = J.E, Yg = J.Yg, Q0 = J.Q0, Q1 = J.Q1, travel = (n - 1) * Wd;
      // cover: down the left margin, then along the ground to the first sheet
      const c0 = addSeg('M' + r1(XL) + ',0V' + r1(Yg - 30)), c1 = addSeg(rp([[XL, Yg - 30], [XL, Yg], [Wd, Yg]], 24));
      gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: journey, start: 'top 92%', end: 'top top', scrub: 0.5 } }).to(c0, { p: 1, duration: 0.42 }).to(c1, { p: 1, duration: 0.58 });
      chains.journey.push(c0, c1);
      // sheets: off the ground line, through the drawing, back to the ground line
      stations.forEach((st, i) => {
        const x0 = (i + 1) * Wd, x1 = x0 + Wd, m = J.M[i], vr = m.vr, pin = m.pin, pout = m.pout;
        let din, dout;
        if (st.name === 'planner') {
          const ga = vr.x - 1.2 * E, gb = ga - 1.3 * E;
          din = rp([[x0, Yg], [ga, Yg], [ga, pin[1]], [pin[0], pin[1]]], 16);
          dout = rp([[pout[0], pout[1]], [gb, pout[1]], [gb, Yg], [x1, Yg]], 16);
        } else {
          let gx = pin[0] - 2.1 * E, ox = vr.r + 1.5 * E;
          if (st.name === 'contract') { gx = pin[0] - 2.4 * E; ox = pout[0] + 1.5 * E; }
          if (st.name === 'insight') gx = vr.x - 2.1 * E;
          din = rp([[x0, Yg], [gx, Yg], [gx, pin[1]], [pin[0], pin[1]]], 16);
          dout = rp([[pout[0], pout[1]], [ox, pout[1]], [ox, Yg], [x1, Yg]], 16);
        }
        st.cin = addSeg(din); st.cout = addSeg(dout); st.no = $('.sheet__no', st.sheet);
        st.qa = Q0 + (Q1 - Q0) * st.at[0]; st.qb = Q0 + (Q1 - Q0) * st.at[1];
        chains.journey.push(st.cin, st.g, st.cout);
      });
      // end of the set: off the ground line and down, to the key plan
      const xo = (n - 1) * Wd;
      const o0 = addSeg('M' + r1(xo) + ',' + r1(Yg) + 'H' + r1(xo + XL - 24)), o1 = addSeg(rp([[xo + XL - 24, Yg], [xo + XL, Yg], [xo + XL, Hh + 2]], 24));
      chains.journey.push(o0, o1);

      // sheet index in the title strip
      hudIndex.replaceChildren(); panels.forEach(() => hudIndex.appendChild(d.createElement('i')));
      const ticks = $$('i', hudIndex);
      const js = { x: 0 };
      const tw = gsap.to(js, {
        x: 1, ease: 'none',
        scrollTrigger: { trigger: journey, start: 'top top', end: () => '+=' + Math.round(travel * 0.86), pin: true, scrub: 0.6, anticipatePin: 1, invalidateOnRefresh: true },
        onUpdate: renderTrack
      });
      JOURNEY.st = tw.scrollTrigger;
      function renderTrack() {
        const o = js.x * travel;
        track.style.transform = 'translate3d(' + r1(-o) + 'px,0,0)';
        stations.forEach((st, i) => {
          // q: 0 as the sheet's edge enters at the right, 0.9 when the sheet is square on the screen
          const q = (Wd * 0.9 - ((i + 1) * Wd - o)) / Wd;
          if ((q <= 0 && st.q <= 0) || (q >= 1 && st.q >= 1)) { st.q = q; return; } // off screen and already settled
          st.q = q;
          if (st.no) st.no.style.setProperty('--px', r1((0.9 - q) * 46) + 'px');
          st.cin.p = seg01(q, 0, st.qa);
          st.tl.progress(seg01(q, Q0, Q1));
          st.cout.p = seg01(q, st.qb, 1);
        });
        const qo = (Wd * 0.9 - ((n - 1) * Wd - o)) / Wd;
        o0.p = seg01(qo, 0, 0.2); o1.p = seg01(qo, 0.7, 0.9);
        const idx = Math.round(o / Wd);
        if (idx !== JOURNEY.idx) { ticks.forEach((t, i) => t.classList.toggle('is-on', i === idx)); JOURNEY.idx = idx; }
      }
      renderTrack();
      // keyboard: keep the focused sheet on screen
      track.addEventListener('focusin', e => { const p = e.target.closest('.panel'); if (!p) return; const r = p.getBoundingClientRect(); if (r.left < -8 || r.right > Wd + 8) { const y = targetY(p.id); if (y !== null) { if (lenis) lenis.scrollTo(y, { immediate: true }); else w.scrollTo(0, y); } } });
      $('.journey__view').addEventListener('scroll', e => { e.currentTarget.scrollLeft = 0; e.currentTarget.scrollTop = 0; });
    });

    /* ---- 09 key plan ---- */
    steps.push(function () {
      const sec = $('.roles'), svg = $('.route', sec), hgt = sec.offsetHeight;
      const grid = rel($('.roles__grid', sec), sec), bubs = $$('.role .bubble', sec).map(b => rel(b, sec)), notes = rel($('.anotes', sec), sec);
      const xr = bubs[0].cx, yA = grid.y - Math.min(60, (grid.y - rel($('.roles__intro', sec), sec).b) / 2), yB = (grid.b + notes.y) / 2;
      const items = [];
      const push = (dd, y0, y1, pace) => items.push({ d: dd, y0, y1, pace });
      push(rp([[XL, 0], [XL, yA], [xr, yA], [xr, bubs[0].y - 12]], 22), 0, bubs[0].y - 12);
      const dw = 30;
      bubs.forEach((b, i) => {
        const y0 = b.b + 14, nextY = i < bubs.length - 1 ? bubs[i + 1].y - 12 : yB;
        // past the bubble, then a door: leaf out, quarter arc back to the wall
        push('M' + r1(xr) + ',' + r1(b.b + 2) + 'V' + r1(y0) + 'H' + r1(xr + dw) + 'A' + dw + ',' + dw + ' 0 0 1 ' + r1(xr) + ',' + r1(y0 + dw), b.b + 2, y0 + dw, 0.7);
        if (i < bubs.length - 1) push('M' + r1(xr) + ',' + r1(y0 + dw) + 'V' + r1(nextY), y0 + dw, nextY);
        else push(rp([[xr, y0 + dw], [xr, yB], [XL, yB], [XL, hgt]], 22), y0 + dw, hgt);
      });
      const segs = mkRoute(svg, items.map(o => o.d));
      scrubChain(sec, segs.map((s, i) => ({ seg: s, y0: items[i].y0, y1: items[i].y1, pace: items[i].pace })));
      chains.roles = segs;
    });

    /* (the "proposed work" sheet, the roadmap, was taken off the page on 20 Nov 2026: the line now runs from the key plan
       straight into the sequence of works, both on the left spine XL) */

    /* ---- 10 sequence of works: the stair ---- */
    let XR;
    steps.push(function () {
      const sec = $('.setup'), svg = $('.route', sec), hgt = sec.offsetHeight;
      const stair = $('.gline--stair', sec), sr = rel(stair, sec), gn = rel($('.gnotes', sec), sec), wr = rel($('.wrap', sec), sec);
      XR = Math.min(W() - 40, gn.r + 34);
      const pin = [sr.x, sr.y + sr.h * 270 / 300], pout = [sr.r, sr.y + sr.h * 22 / 300];
      const dIn = rp([[XL, 0], [XL, pin[1]], [pin[0], pin[1]]], 22), dOut = rp([[pout[0], pout[1]], [XR, pout[1]], [XR, hgt]], 22);
      const segs = mkRoute(svg, [dIn, dOut]);
      const gl = $('.gl', stair); gl.removeAttribute('vector-effect');
      // redraw the stair in pixels so the dash is exact
      const sx = sr.w / 1000, sy = sr.h / 300;
      const pts = [[0, 270], [30, 270], [30, 208], [265, 208], [265, 146], [500, 146], [500, 84], [735, 84], [735, 22], [1000, 22]].map(p => [p[0] * sx, p[1] * sy]);
      stair.setAttribute('viewBox', '0 0 ' + r1(sr.w) + ' ' + r1(sr.h)); stair.removeAttribute('preserveAspectRatio');
      gl.setAttribute('d', rp(pts, 8)); gl.style.strokeWidth = 'var(--lw)';
      const gs = new Seg(gl);
      const steps = $$('.step', sec);
      gsap.set(steps, { autoAlpha: 0, y: 18 });
      const tl = scrubChain(sec, [
        { seg: segs[0], y0: 0, y1: pin[1] },
        { seg: gs, y0: pin[1], y1: pin[1] + 10, pace: 0.36 },
        { seg: segs[1], y0: pout[1], y1: hgt }
      ]);
      // each step appears as the pen reaches its tread
      const gst = tl.getChildren().filter(t => t.targets && t.targets()[0] === gs)[0];
      if (gst) steps.forEach((s, i) => tl.to(s, { autoAlpha: 1, y: 0, duration: Math.max(60, gst.duration() * 0.14), ease: 'power2.out' }, gst.startTime() + gst.duration() * (0.04 + i * 0.235)));
      chains.setup = [segs[0], gs, segs[1]];
    });

    /* ---- 11 handover: the line sets the mark out, draws it over its own construction, and lets go ---- */
    steps.push(function () {
      const sec = $('.close'), svg = $('.route', sec);
      const plate = $('.plate__svg', sec), br = rel(plate, sec), lock = $('.close__mark', sec);
      const sx = br.w / 110, mx = br.x + 23.5 * sx, myTop = br.y + 32.5 * sx;
      const yT = Math.min(H() * 0.16, br.y * 0.7); // the run across sits clear of the nav rule above and of the plate below
      const tail = mkRoute(svg, [rp([[XR, 0], [XR, yT], [mx, yT], [mx, myTop]], 26)])[0];
      const P = PLATE.prep(plate), ms = P.line;
      gsap.set(lock, { autoAlpha: 0, x: -24 });
      // arriving: the line comes down as the sheet rises, and the mark is set out ahead of the pen
      const t1 = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: { trigger: sec, start: 'top 92%', end: 'top top', scrub: 0.5 } });
      t1.to(tail, { p: 1, duration: 1 }, 0);
      PLATE.setOut(t1, P, 0.3, 0.68);
      // held: the pen draws the mark, the dimensions are noted, the line lets go and the mark is issued
      const t2 = gsap.timeline({ defaults: { ease: 'none' } });
      PLATE.draw(t2, P, 0, 0.56);
      PLATE.note(t2, P, 0.5, 0.3);
      PLATE.issue(t2, P, 0.66, 0.2);
      t2.to(tail, { e: 1, duration: 0.24, ease: 'power1.in' }, 0.62)
        .to(lock, { autoAlpha: 1, x: 0, duration: 0.24, ease: 'power2.out' }, 0.72)
        .to({}, { duration: 0.04 }, 0.96);
      flip(t2, 0.8, () => { LINE.detached = true; }, () => { LINE.detached = false; });
      CLOSE.st = ScrollTrigger.create({ trigger: sec, start: 'top top', end: () => '+=' + Math.round(H() * 0.8), pin: true, scrub: 0.5, animation: t2, anticipatePin: 1, invalidateOnRefresh: true });
      // the strip under the held sheet belongs to the same sheet until the footer arrives: same ground, same title block
      const sp = CLOSE.st.spacer; if (sp) { sp.dataset.theme = sec.dataset.theme; sp.dataset.sheet = sec.dataset.sheet; sp.dataset.title = sec.dataset.title; themeEls.push(sp); }
      chains.close = [tail, ms];
    });

    await runSteps(steps);
    LINE.chain = [].concat(chains.hero, chains.problem, chains.journey, chains.roles, chains.setup, chains.close);
    await tick();
    initReveals();
    // a little depth: the sketches drift against the scroll
    $$('.survey__fig').forEach(f => gsap.fromTo(f, { y: 26 }, { y: -26, ease: 'none', scrollTrigger: { trigger: f.closest('.survey__item'), start: 'top bottom', end: 'bottom top', scrub: 0.6 } }));
    gsap.fromTo('.planbox .keyplan', { scale: 0.96 }, { scale: 1, ease: 'none', scrollTrigger: { trigger: '.roles__grid', start: 'top 80%', end: 'top 20%', scrub: 0.6 } });
    await tick();

    /* ---- magnetic buttons and the crosshair ---- */
    if (finePointer) {
      $$('[data-magnetic]').forEach(b => {
        const qx = gsap.quickTo(b, 'x', { duration: 0.5, ease: 'power3.out' }), qy = gsap.quickTo(b, 'y', { duration: 0.5, ease: 'power3.out' });
        b.addEventListener('pointermove', e => { const r = b.getBoundingClientRect(); qx((e.clientX - r.left - r.width / 2) * 0.22); qy((e.clientY - r.top - r.height / 2) * 0.34); });
        b.addEventListener('pointerleave', () => { qx(0); qy(0); });
      });
      const xh = $('.xhair');
      if (xh) {
        const qx = gsap.quickTo(xh, 'x', { duration: 0.16, ease: 'power3.out' }), qy = gsap.quickTo(xh, 'y', { duration: 0.16, ease: 'power3.out' });
        w.addEventListener('pointermove', e => {
          qx(e.clientX); qy(e.clientY); xh.classList.add('is-on');
          xh.classList.toggle('is-hot', !!e.target.closest('a,button,input'));
          hudXY.textContent = 'X ' + ('000' + Math.round(e.clientX)).slice(-4) + ' · Y ' + ('000' + Math.round(e.clientY)).slice(-4);
        }, { passive: true });
        d.addEventListener('pointerleave', () => xh.classList.remove('is-on'));
      }
    }

    /* ---- every frame: the pen, the title block ---- */
    let lastSheet = '', lastLen = -1;
    gsap.ticker.add(() => {
      const sheetEl = trackTheme();
      // title block
      let sh = '', ti = '';
      if (sheetEl) { let src = sheetEl; if (sheetEl === journey && JOURNEY.idx != null) src = panels[JOURNEY.idx] || sheetEl; sh = src.dataset.sheet || ''; ti = src.dataset.title || ''; }
      if (sh + ti !== lastSheet) { lastSheet = sh + ti; hudSheet.textContent = sh; hudTitle.textContent = ti; }
      hudIndex.classList.toggle('is-on', sheetEl === journey);
      if (!LINE.dirty && !lenis && !ScrollTrigger.isScrolling()) return;
      LINE.dirty = false;
      // the pen: the far end of everything drawn so far
      const ch = LINE.chain; let tip = null, sum = 0;
      for (let i = ch.length - 1; i >= 0; i--) { const s = ch[i]; if (s && s.p > 0.0004) { if (!tip) tip = s.tip(); sum += s.drawn ? s.drawn() : 0; } }
      if (tip && !LINE.detached && tip[1] > -20 && tip[1] < H() + 20 && tip[0] > -20 && tip[0] < W() + 20) { pen.style.transform = 'translate3d(' + r1(tip[0]) + 'px,' + r1(tip[1]) + 'px,0)'; pen.style.opacity = HERO.p < 0.004 && lead.p < 0.02 ? 0 : 1; }
      else pen.style.opacity = 0;
      const m = Math.round(sum / 2) / 10;
      if (m !== lastLen) { lastLen = m; hudLen.textContent = 'LINE ' + ('0000' + m.toFixed(1)).slice(-6) + ' m'; }
    });

    // rebuild on a real resize: the geometry is all derived from layout
    let rw = W(), rh = H(), to;
    w.addEventListener('resize', () => { clearTimeout(to); to = setTimeout(() => { if (Math.abs(W() - rw) > 8 || Math.abs(H() - rh) > 60) location.reload(); }, 350); });
  }

  /* ------------------------------------------------------------------------
     The viewer: a selected screen at reading size, with the next and the previous one a key away.
     Works in every mode and without the animation library. A screen is a link to its picture, so
     without this script it still opens. A long form (the Desk) scrolls inside the viewer.
     ------------------------------------------------------------------------ */
  function initViewer() {
    const links = $$('a.scr__open'); if (!links.length) return;
    let box, stage, img, area, title, stat, count, btns, last = null, at = 0;
    const el = (tag, cls, attrs) => { const e = d.createElement(tag); if (cls) e.className = cls; if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
    const scrollable = () => stage.scrollHeight > stage.clientHeight + 1 || stage.scrollWidth > stage.clientWidth + 1;
    function build() {
      box = el('div', 'lb', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'A screen of Inspera, larger', hidden: '' });
      stage = el('div', 'lb__stage', { 'data-lenis-prevent': '' });
      img = el('img', 'lb__img', { alt: '' }); stage.appendChild(img);
      const bar = el('p', 'lb__bar');
      area = el('span', 'lb__area'); title = el('span', 'lb__t'); stat = el('span', 'lb__st'); count = el('span', 'lb__n');
      const demo = el('span', 'lb__demo'); demo.textContent = 'Demo data';
      bar.append(area, title, stat, count, demo);
      const x = el('button', 'lb__btn lb__x', { type: 'button', 'aria-label': 'Close' }); x.textContent = '×';
      const prev = el('button', 'lb__btn lb__prev', { type: 'button', 'aria-label': 'Previous screen' }); prev.textContent = '‹';
      const next = el('button', 'lb__btn lb__next', { type: 'button', 'aria-label': 'Next screen' }); next.textContent = '›';
      btns = [x, prev, next];
      box.append(stage, bar, x, prev, next); d.body.appendChild(box);
      x.addEventListener('click', close); prev.addEventListener('click', () => show(at - 1)); next.addEventListener('click', () => show(at + 1));
      stage.addEventListener('click', e => { if (e.target === stage) close(); });
      box.addEventListener('keydown', e => {
        const k = e.key, page = stage.clientHeight * 0.85;
        if (k === 'Escape') close();
        else if (k === 'ArrowLeft') show(at - 1);
        else if (k === 'ArrowRight') show(at + 1);
        else if (k === 'ArrowDown') stage.scrollBy(0, 90);
        else if (k === 'ArrowUp') stage.scrollBy(0, -90);
        else if (k === 'PageDown') stage.scrollBy(0, page);
        else if (k === 'PageUp') stage.scrollBy(0, -page);
        else if (k === 'Home') stage.scrollTop = 0;
        else if (k === 'End') stage.scrollTop = stage.scrollHeight;
        else if (k === 'Tab') { const i = btns.indexOf(d.activeElement); btns[(i + (e.shiftKey ? btns.length - 1 : 1)) % btns.length].focus(); }
        else return;
        e.preventDefault();
      });
      /* the page behind stays where it is: a wheel or a finger moves only a long screen inside the viewer */
      const hold = e => { if (e.touches && e.touches.length > 1) return; if (!stage.contains(e.target) || !scrollable()) e.preventDefault(); };   // two fingers: the visitor is zooming
      box.addEventListener('wheel', hold, { passive: false }); box.addEventListener('touchmove', hold, { passive: false });
    }
    function show(i) {
      at = (i + links.length) % links.length;
      const a = links[at], fig = a.closest('.scr'), small = $('img', a);
      const big = a.getAttribute('data-large') || a.getAttribute('href'), vw = +a.getAttribute('data-vw') || 1440;
      const phone = fig.classList.contains('scr--phone'), long = !phone && +small.getAttribute('height') > +small.getAttribute('width') * 0.75;   // a long form is read by scrolling
      box.classList.toggle('lb--phone', phone); box.classList.toggle('lb--fit', !long && !phone);
      img.style.setProperty('--vw', vw);                         // never larger than the screen was when it was photographed (site.css)
      img.alt = small.alt; img.src = small.currentSrc || small.src;   // what the page already holds, at once
      const hi = new Image(); hi.onload = () => { if (links[at] === a && !box.hidden) img.src = big; }; hi.src = big;   // then the sharper file
      area.textContent = fig.getAttribute('data-area') || ''; title.textContent = fig.getAttribute('data-title') || '';
      const group = fig.closest('.phones'), tagEl = $('.tag', group || fig);                 // a screen that is not live says so here too
      stat.className = 'lb__st' + (tagEl ? ' ' + tagEl.className : ''); stat.textContent = tagEl ? tagEl.textContent : ''; stat.hidden = !tagEl;
      count.textContent = (at + 1) + ' / ' + links.length;
      stage.scrollTop = 0; stage.scrollLeft = 0;
    }
    function open(a) {
      if (!box) build();
      last = a; box.hidden = false; if (lenis) lenis.stop();
      show(links.indexOf(a));
      requestAnimationFrame(() => box.classList.add('is-on'));
      btns[0].focus({ preventScroll: true });
    }
    function close() {
      box.classList.remove('is-on'); box.hidden = true; img.removeAttribute('src'); if (lenis) lenis.start();
      if (last) last.focus({ preventScroll: true });
    }
    d.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a.scr__open'); if (!a) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;      // a new tab or window was asked for: let it be
      e.preventDefault(); open(a);
    });
  }

  /* ------------------------------------------------------------------------
     Start
     ------------------------------------------------------------------------ */
  function desiredMode() {
    const p = /[?&]mode=(still|flow|cinema)/.exec(location.search); if (p) return p[1];
    if (w.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'still';
    const W = w.innerWidth, H = w.innerHeight;
    return W >= 1100 && H >= 720 && W / H >= 1.25 ? 'cinema' : 'flow';
  }

  function start() {
    gsap = w.gsap; ScrollTrigger = w.ScrollTrigger;
    if (mode !== 'still' && !(gsap && ScrollTrigger)) { mode = 'still'; root.setAttribute('data-mode', 'still'); root.classList.remove('anim'); } // the animation library did not arrive: show the finished page
    clearTimeout(w.__failsafe);
    themeEls = themed(); navLinks = $$('.nav__links a');
    initMenu(); initAnchors(); initForm(); initViewer(); initFold(); initBarCta();
    PLATE.fit(); let pf; w.addEventListener('resize', () => { cancelAnimationFrame(pf); pf = requestAnimationFrame(PLATE.fit); });
    const go = async () => {
      try {
        if (mode === 'cinema') await cinema(); else if (mode === 'flow') await flow(); else still();
        fitGlines();
        initKeyplan();
      } catch (err) {
        // never leave the page hidden behind a failed animation
        root.setAttribute('data-mode', 'still'); root.classList.remove('anim'); mode = 'still';
        if (w.console) console.error(err);
      }
      if (ScrollTrigger && mode !== 'still') ScrollTrigger.refresh();
      trackTheme();
      if (location.hash.length > 1) { const y = targetY(location.hash.slice(1)); if (y !== null) setTimeout(() => (lenis ? lenis.scrollTo(y, { immediate: true }) : w.scrollTo(0, y)), 60); }
    };
    const fontsReady = d.fonts && d.fonts.ready ? Promise.race([d.fonts.ready, new Promise(r => setTimeout(r, 2500))]) : Promise.resolve();
    fontsReady.then(() => requestAnimationFrame(go));
    // a different mode after a resize or a settings change means a different page: reload once
    let mt;
    const check = () => { clearTimeout(mt); mt = setTimeout(() => { if (!/[?&]mode=/.test(location.search) && desiredMode() !== root.getAttribute('data-mode') && !(root.getAttribute('data-mode') === 'still' && !w.gsap)) location.reload(); }, 400); };
    w.addEventListener('resize', check);
    const mq = w.matchMedia('(prefers-reduced-motion: reduce)'); if (mq.addEventListener) mq.addEventListener('change', check);
    if ('ResizeObserver' in w) { let ft; const ro = new ResizeObserver(() => { clearTimeout(ft); ft = setTimeout(fitGlines, 120); }); $$('.sheet__fig').forEach(f => ro.observe(f)); }
  }

  w.__inspera = { y: targetY, mode: () => mode };
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', start); else start();
})();
