'use strict';
/* 3D toolpath viewer: WebGL2, no libraries. Every extrusion segment is drawn as a screen-space ribbon (instanced quads). */
I18N.ready.then(function () {
  const $ = (s) => document.querySelector(s);
  const canvas = $('#gl');
  const msg = $('#msg');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  addEventListener('langchange', () => location.reload());
  const fail = (text) => { msg.hidden = false; msg.textContent = text; };

  const id = new URLSearchParams(location.search).get('id');
  if (!id || !/^\d+$/.test(id)) return fail(t('pv.noRequest'));
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!gl) return fail(t('pv.noWebgl'));

  // ------------------------------------------------------------ colours
  const hsv = (h, s, v) => { const f = (n) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return [f(5), f(3), f(1)]; };
  function typeColor(name, i) {
    const n = name.toLowerCase();
    if (/overhang/.test(n)) return [0.25, 0.45, 1.0];
    if (/external|outer/.test(n)) return [1.0, 0.55, 0.12];
    if (/perimeter|wall|inner/.test(n)) return [1.0, 0.85, 0.22];
    if (/top/.test(n)) return [0.9, 0.3, 0.85];
    if (/solid/.test(n)) return [0.62, 0.32, 0.9];
    if (/bridge/.test(n)) return [0.3, 0.82, 0.92];
    if (/gap/.test(n)) return [0.95, 0.95, 0.95];
    if (/support.*(interface|roof|floor)/.test(n)) return [0.15, 0.62, 0.5];
    if (/support/.test(n)) return [0.3, 0.8, 0.4];
    if (/infill|fill/.test(n)) return [0.86, 0.2, 0.2];
    if (/skirt|brim/.test(n)) return [0.35, 0.55, 0.95];
    if (/wipe/.test(n)) return [0.7, 0.7, 0.7];
    return hsv((i * 0.137) % 1, 0.55, 0.95);
  }

  // ------------------------------------------------------------ small matrix helpers (column-major)
  const mul = (a, b) => { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
  const perspective = (fov, aspect, near, far) => { const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far); return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
  const lookAt = (eye, ctr, up) => {
    const z = norm([eye[0] - ctr[0], eye[1] - ctr[1], eye[2] - ctr[2]]), x = norm(cross(up, z)), y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]), -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]), -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1]);
  };

  // ------------------------------------------------------------ shaders
  function program(vs, fs) {
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  const pathProg = program(`#version 300 es
    precision highp float;
    uniform mat4 uMVP; uniform vec2 uViewport; uniform float uWidth, uClipZ, uZMin, uZMax; uniform int uMode; uniform vec2 uDepth;
    uniform vec3 uPal[32]; uniform float uVis[32];
    in vec2 aCorner; in vec3 aA; in vec3 aB; in float aType;
    out vec3 vColor;
    void main() {
      int ti = int(aType + 0.5);
      if (uVis[ti] < 0.5 || max(aA.z, aB.z) > uClipZ) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vColor = vec3(0.0); return; }
      vec4 pa = uMVP * vec4(aA, 1.0), pb = uMVP * vec4(aB, 1.0);
      vec2 sa = pa.xy / pa.w * uViewport * 0.5, sb = pb.xy / pb.w * uViewport * 0.5;
      vec2 d = sb - sa; float len = length(d); d = len > 1e-4 ? d / len : vec2(1.0, 0.0);
      vec2 n = vec2(-d.y, d.x);
      vec4 p = mix(pa, pb, aCorner.x);
      vec2 off = n * aCorner.y * uWidth * 0.5 + d * (aCorner.x * 2.0 - 1.0) * uWidth * 0.5;
      p.xy += off / (uViewport * 0.5) * p.w;
      gl_Position = p;
      vec3 c;
      if (uMode == 1) {
        float t = clamp(((aA.z + aB.z) * 0.5 - uZMin) / max(uZMax - uZMin, 1e-3), 0.0, 1.0);
        c = clamp(vec3(abs(t * 6.0 - 3.0) - 1.0, 2.0 - abs(t * 6.0 - 2.0), 2.0 - abs(t * 6.0 - 4.0)), 0.0, 1.0);
        c = mix(vec3(0.15, 0.3, 1.0), c, smoothstep(0.0, 0.08, t)) ;
      } else c = uPal[ti];
      float depth = clamp((p.w - uDepth.x) / max(uDepth.y - uDepth.x, 1e-3), 0.0, 1.0);
      vColor = c * mix(1.0, 0.5, depth);
    }`, `#version 300 es
    precision mediump float; in vec3 vColor; out vec4 o; void main() { o = vec4(vColor, 1.0); }`);
  const gridProg = program(`#version 300 es
    precision highp float; uniform mat4 uMVP; in vec3 aPos; in vec3 aCol; out vec3 vCol;
    void main() { gl_Position = uMVP * vec4(aPos, 1.0); vCol = aCol; }`, `#version 300 es
    precision mediump float; in vec3 vCol; out vec4 o; void main() { o = vec4(vCol, 1.0); }`);
  const U = (p, n) => gl.getUniformLocation(p, n);

  // ------------------------------------------------------------ load
  let data;
  (async function load() {
    let res;
    try { res = await fetch(`/api/staff/requests/${id}/preview`, { credentials: 'same-origin' }); } catch (e) { return fail(t('pv.noServer')); }
    if (res.status === 401) return fail(t('pv.login'));
    if (!res.ok) { let m = ''; try { const d = await res.json(); m = d.code && has(`err.${d.code}`) ? t(`err.${d.code}`, d.params) : d.error; } catch { /* ignore */ } return fail(m || t('pv.unavailable', { status: res.status })); }
    const buf = await res.arrayBuffer();
    const hl = new DataView(buf).getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
    const n = head.count, off = 4 + hl;
    if (!n) return fail(t('pv.noMoves'));
    data = { head, segs: new Float32Array(buf, off, n * 6), types: new Uint8Array(buf, off + n * 24, n) };
    try { start(); } catch (e) { fail(t('pv.startFailed', { detail: e.message })); }
  })();

  // ------------------------------------------------------------ viewer
  function start() {
    const { head, segs, types } = data, n = head.count;
    const bb = head.bbox, ctr = [0, 1, 2].map((i) => (bb.min[i] + bb.max[i]) / 2), size = [0, 1, 2].map((i) => bb.max[i] - bb.min[i]);
    const radius = Math.max(0.5 * Math.hypot(...size), 5);
    const zmin = bb.min[2], zmax = Math.max(bb.max[2], zmin + 0.001);

    // path buffers
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const corners = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = (name) => gl.getAttribLocation(pathProg, name);
    gl.enableVertexAttribArray(loc('aCorner')); gl.vertexAttribPointer(loc('aCorner'), 2, gl.FLOAT, false, 0, 0);
    const sb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, sb); gl.bufferData(gl.ARRAY_BUFFER, segs, gl.STATIC_DRAW);
    for (const [name, o] of [['aA', 0], ['aB', 12]]) { gl.enableVertexAttribArray(loc(name)); gl.vertexAttribPointer(loc(name), 3, gl.FLOAT, false, 24, o); gl.vertexAttribDivisor(loc(name), 1); }
    const tb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, tb); gl.bufferData(gl.ARRAY_BUFFER, types, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc('aType')); gl.vertexAttribPointer(loc('aType'), 1, gl.UNSIGNED_BYTE, false, 0, 0); gl.vertexAttribDivisor(loc('aType'), 1);

    // bed grid and axes
    const gx0 = Math.floor((bb.min[0] - 10) / 10) * 10, gx1 = Math.ceil((bb.max[0] + 10) / 10) * 10, gy0 = Math.floor((bb.min[1] - 10) / 10) * 10, gy1 = Math.ceil((bb.max[1] + 10) / 10) * 10;
    const gv = [], line = (a, b, c) => gv.push(...a, ...c, ...b, ...c);
    for (let x = gx0; x <= gx1; x += 10) line([x, gy0, 0], [x, gy1, 0], x % 50 === 0 ? [0.28, 0.32, 0.4] : [0.17, 0.2, 0.25]);
    for (let y = gy0; y <= gy1; y += 10) line([gx0, y, 0], [gx1, y, 0], y % 50 === 0 ? [0.28, 0.32, 0.4] : [0.17, 0.2, 0.25]);
    line([gx0, gy0, 0], [gx0 + 25, gy0, 0], [0.95, 0.3, 0.3]); line([gx0, gy0, 0], [gx0, gy0 + 25, 0], [0.3, 0.85, 0.35]); line([gx0, gy0, 0], [gx0, gy0, 25], [0.35, 0.5, 1.0]);
    const gvao = gl.createVertexArray(); gl.bindVertexArray(gvao);
    const gb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, gb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gv), gl.STATIC_DRAW);
    const gp = gl.getAttribLocation(gridProg, 'aPos'), gc = gl.getAttribLocation(gridProg, 'aCol');
    gl.enableVertexAttribArray(gp); gl.vertexAttribPointer(gp, 3, gl.FLOAT, false, 24, 0); gl.enableVertexAttribArray(gc); gl.vertexAttribPointer(gc, 3, gl.FLOAT, false, 24, 12);
    const gridCount = gv.length / 6;

    // palette + visibility
    const names = head.types, pal = new Float32Array(32 * 3), vis = new Float32Array(32).fill(1);
    names.forEach((nm, i) => pal.set(typeColor(nm, i), i * 3));
    let mode = 0, clipZ = Infinity;

    // UI
    const layers = head.layers;
    const counts = new Array(names.length).fill(0); for (let i = 0; i < n; i++) counts[types[i]]++;
    const legend = $('#legend');
    legend.innerHTML = names.map((nm, i) => { const c = pal.slice(i * 3, i * 3 + 3); return `<label><input type="checkbox" data-t="${i}" checked><span class="sw" style="background:rgb(${c.map((v) => Math.round(v * 255))})"></span>${esc(has('type.' + nm.toLowerCase()) ? t('type.' + nm.toLowerCase()) : nm)}</label>`; }).join('')
      + `<select id="mode"><option value="0">${esc(t('pv.colourType'))}</option><option value="1">${esc(t('pv.colourHeight'))}</option></select><button id="reset">${esc(t('pv.reset'))}</button>`;
    legend.hidden = false;
    legend.addEventListener('change', (e) => { if (e.target.dataset.t !== undefined) { vis[+e.target.dataset.t] = e.target.checked ? 1 : 0; draw(); } if (e.target.id === 'mode') { mode = +e.target.value; draw(); } });
    $('#reset').onclick = () => { resetView(); draw(); };
    $('#title').innerHTML = `<b>#${esc(head.id)} · ${esc(head.file)}</b> <span style="color:#98a2b3">${head.user ? '· ' + esc(head.user) : ''}</span>`; $('#title').hidden = false;
    const time = head.seconds ? `${Math.floor(head.seconds / 3600)} h ${String(Math.floor(head.seconds / 60) % 60).padStart(2, '0')} min` : '–';
    $('#info').innerHTML = `${[size[0], size[1], bb.max[2]].map((v) => v.toFixed(1)).join(' × ')} mm · ${t('pv.layers', { n: layers.length })} · ${t('pv.moves', { n: n.toLocaleString(I18N.locale) })}<br>${head.grams ? Math.round(head.grams) + ' g ' : ''}${esc(head.material || '')} · ${time}`; $('#info').hidden = false;
    if (head.truncated) { $('#warn').textContent = t('pv.truncated', { n: n.toLocaleString(I18N.locale), z: head.truncatedAtZ?.toFixed(2) }); $('#warn').hidden = false; }
    $('#help').hidden = false;
    const slider = $('#layer'), label = $('#layerlabel');
    slider.min = 1; slider.max = layers.length; slider.value = layers.length; $('#layerbox').hidden = layers.length < 2;
    const setLayer = (v) => { v = Math.max(1, Math.min(layers.length, v)); slider.value = v; clipZ = v >= layers.length ? Infinity : layers[v - 1] + 1e-3; label.textContent = t('pv.layer', { v, total: layers.length, z: layers[v - 1].toFixed(2) }); draw(); };
    slider.oninput = () => setLayer(+slider.value);
    addEventListener('keydown', (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setLayer(+slider.value + (e.shiftKey ? 10 : 1)); else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setLayer(+slider.value - (e.shiftKey ? 10 : 1)); else if (e.key === 'Home') setLayer(1); else if (e.key === 'End') setLayer(layers.length); else return; e.preventDefault(); });
    msg.hidden = true;

    // camera
    const fov = 40 * Math.PI / 180;
    let az, el, dist; const target = [0, 0, 0];
    function resetView() { az = -Math.PI / 2 - 0.55; el = 0.55; dist = radius / Math.sin(fov / 2) * 1.05; target[0] = ctr[0]; target[1] = ctr[1]; target[2] = ctr[2]; }
    resetView();
    function draw() {
      const dpr = Math.min(devicePixelRatio || 1, 2), w = Math.max(1, Math.round(canvas.clientWidth * dpr)), h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h); gl.clearColor(0.071, 0.086, 0.11, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); gl.enable(gl.DEPTH_TEST);
      const ce = Math.cos(el), eye = [target[0] + dist * ce * Math.cos(az), target[1] + dist * ce * Math.sin(az), target[2] + dist * Math.sin(el)];
      const near = Math.max(dist - radius * 1.5, dist * 0.02), far = dist + radius * 2 + 10;
      const mvp = mul(perspective(fov, w / h, near, far), lookAt(eye, target, [0, 0, 1]));
      gl.useProgram(gridProg); gl.uniformMatrix4fv(U(gridProg, 'uMVP'), false, mvp); gl.bindVertexArray(gvao); gl.drawArrays(gl.LINES, 0, gridCount);
      const pxPerMm = h / (2 * dist * Math.tan(fov / 2));
      gl.useProgram(pathProg);
      gl.uniformMatrix4fv(U(pathProg, 'uMVP'), false, mvp); gl.uniform2f(U(pathProg, 'uViewport'), w, h);
      gl.uniform1f(U(pathProg, 'uWidth'), Math.max(1.6 * dpr, Math.min(0.5 * pxPerMm, 14 * dpr)));
      gl.uniform1f(U(pathProg, 'uClipZ'), clipZ); gl.uniform1f(U(pathProg, 'uZMin'), zmin); gl.uniform1f(U(pathProg, 'uZMax'), zmax); gl.uniform1i(U(pathProg, 'uMode'), mode);
      gl.uniform2f(U(pathProg, 'uDepth'), dist - radius, dist + radius);
      gl.uniform3fv(U(pathProg, 'uPal'), pal); gl.uniform1fv(U(pathProg, 'uVis'), vis);
      gl.bindVertexArray(vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      canvas.dataset.frame = String((+canvas.dataset.frame || 0) + 1);
    }
    let raf = 0; const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
    addEventListener('resize', redraw);

    // mouse / touch
    let drag = null;
    const pan = (dx, dy, h) => {
      const k = 2 * dist * Math.tan(fov / 2) / h, ce = Math.cos(el);
      const fwd = norm([-ce * Math.cos(az), -ce * Math.sin(az), -Math.sin(el)]), right = norm(cross(fwd, [0, 0, 1])), up = cross(right, fwd);
      for (let i = 0; i < 3; i++) target[i] += (-right[i] * dx + up[i] * dy) * k;
    };
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); canvas.classList.add('drag'); drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.button === 1 || e.shiftKey }; });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || (e.pointerType === 'touch' && touches.size > 1)) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) pan(dx, dy, canvas.clientHeight); else { az -= dx * 0.008; el = Math.max(-1.54, Math.min(1.54, el + dy * 0.008)); }
      redraw();
    });
    const end = (e) => { drag = null; canvas.classList.remove('drag'); touches.delete(e.pointerId); };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); dist = Math.max(radius * 0.05, Math.min(radius * 40, dist * Math.exp(e.deltaY * 0.0015))); redraw(); }, { passive: false });
    canvas.addEventListener('dblclick', () => { resetView(); redraw(); });
    // two-finger pinch / move
    const touches = new Map(); let pinch = null;
    canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') touches.set(e.pointerId, [e.clientX, e.clientY]); pinch = null; });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 2) {
        const [a, b] = [...touches.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (pinch) { dist = Math.max(radius * 0.05, Math.min(radius * 40, dist * pinch.d / d)); pan(m[0] - pinch.m[0], m[1] - pinch.m[1], canvas.clientHeight); redraw(); }
        pinch = { d, m };
      }
    });

    setLayer(layers.length);
    window.__preview = { draw, get az() { return az; }, get el() { return el; }, get dist() { return dist; }, count: n };
  }
});
