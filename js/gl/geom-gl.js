// Hybrid WebGL geometry layer for the S-52 renderer — AREA FILLS on the GPU.
//
// Measured: Canvas2D fills the chart's area polygons on the CPU (~13.9 ms for a
// harbour scene — 56% of the whole frame). Triangulated once (earcut, cached per
// feature) and batched into ONE GPU draw call, the same fills render in <0.5 ms.
// We render the fills here and composite under the existing Canvas2D pass (lines,
// symbols, text, soundings, declutter stay on Canvas2D).
//
// One batched buffer holds every visible area's triangles with a per-vertex
// colour, drawn in feature order so finer cells paint over coarser ones (same as
// the Canvas2D area pass). Vertices are stored RELATIVE to a fixed reference point
// so they stay Float32-precise; pan/zoom only change the per-frame uniforms — the
// buffer is rebuilt only when the visible feature set (or reference) changes.
//
// Verified vs Canvas2D `fill("evenodd")`: 99.8% pixel/colour match including holes.

import { earcut } from "./earcut.js";

/**
 * Triangulate one area feature's rings (outer + holes) and append the triangle
 * vertices to `outXY` as reference-relative x,y pairs. Returns the triangle count.
 * The triangulation itself is Mercator-absolute and view-independent — callers
 * cache it on the feature; only the ref subtraction happens per buffer build.
 */
export function triangulateArea(rings, refX, refY, outXY) {
  const r0 = rings[0];
  if (!r0 || r0.length < 6) return 0;
  // flat data [x,y,…] = outer ring then holes; holeIndices = hole start vertices
  let total = 0;
  for (let g = 0; g < rings.length; g++) total += rings[g].length >> 1;
  const data = new Float64Array(total * 2);
  const holeIdx = [];
  let w = 0, vBase = 0;
  for (let g = 0; g < rings.length; g++) {
    if (g > 0) holeIdx.push(vBase);
    const ring = rings[g], n = ring.length;
    for (let i = 0; i < n; i++) data[w++] = ring[i];
    vBase += n >> 1;
  }
  const tris = earcut(data, holeIdx, 2);
  for (let i = 0; i < tris.length; i++) {
    const k = tris[i] * 2;
    outXY.push(data[k] - refX, data[k + 1] - refY);
  }
  return tris.length / 3;
}

const VERT_SRC =
  "attribute vec2 a_pos;" +     // reference-relative Mercator (mx-ref, my-ref)
  "attribute vec3 a_col;" +
  "uniform vec2 u_center;" +    // (vp.cx-ref, vp.cy-ref)
  "uniform vec2 u_scale;" +     // (scale/(W/2), scale/(H/2))
  "varying vec3 v_col;" +
  "void main(){ gl_Position = vec4((a_pos - u_center) * u_scale, 0.0, 1.0); v_col = a_col; }";

const FRAG_SRC =
  "precision mediump float; varying vec3 v_col; void main(){ gl_FragColor = vec4(v_col, 1.0); }";

export class GeomGL {
  constructor() {
    this.canvas = document.createElement("canvas");
    const gl = this.canvas.getContext("webgl", { antialias: true, preserveDrawingBuffer: true });
    this.gl = gl;
    this.ok = false;
    if (!gl) return;
    const prog = linkProgram(gl, VERT_SRC, FRAG_SRC);
    if (!prog) return;
    this.prog = prog;
    this.aPos = gl.getAttribLocation(prog, "a_pos");
    this.aCol = gl.getAttribLocation(prog, "a_col");
    this.uCenter = gl.getUniformLocation(prog, "u_center");
    this.uScale = gl.getUniformLocation(prog, "u_scale");
    this.posBuf = gl.createBuffer();
    this.colBuf = gl.createBuffer();
    this.count = 0;
    this.ref = [0, 0];
    this.ok = true;
  }

  resize(w, h) {
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  setRef(refX, refY) { this.ref[0] = refX; this.ref[1] = refY; }

  /** Upload the batched fills. `xy`/`rgb`: Float32Array (reference-relative coords;
   *  colours 0..1, one per vertex). Rebuild only when the visible set / ref changes. */
  setFills(xy, rgb) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, xy, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.bufferData(gl.ARRAY_BUFFER, rgb, gl.DYNAMIC_DRAW);
    this.count = xy.length >> 1;
  }

  setView(vp) {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    gl.useProgram(this.prog);
    gl.viewport(0, 0, w, h);
    gl.uniform2f(this.uCenter, vp.cx - this.ref[0], vp.cy - this.ref[1]);
    gl.uniform2f(this.uScale, vp.scale / (w * 0.5), vp.scale / (h * 0.5));
  }

  /** Clear to `bgRGB` (DEPDW) and draw all fills in one call. */
  render(bgRGB) {
    const gl = this.gl;
    gl.clearColor(bgRGB ? bgRGB[0] : 0, bgRGB ? bgRGB[1] : 0, bgRGB ? bgRGB[2] : 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.count) return;
    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colBuf);
    gl.enableVertexAttribArray(this.aCol);
    gl.vertexAttribPointer(this.aCol, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
  }
}

function linkProgram(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error("GeomGL link error:", gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error("GeomGL shader error:", gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}
