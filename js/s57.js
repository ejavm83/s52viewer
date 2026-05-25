// S-57 semantic layer. Turns raw ISO-8211 records (from iso8211.js) into
// chart features with resolved geometry (lon/lat) and named attributes.
//
// Record model (simplified to what ENC base cells need):
//   DSPM  -> COMF (coord multiplier), SOMF (sounding multiplier)
//   VRID  -> vector record:  RCNM/RCID, plus SG2D/SG3D coords and VRPT pointers
//   FRID  -> feature record: OBJL (class), PRIM (1=pt,2=line,3=area), attrs, FSPT

const RCNM_VI = 110; // isolated node
const RCNM_VC = 120; // connected node
const RCNM_VE = 130; // edge
const RCNM_VF = 140; // face

function nameKey(rcnm, rcid) {
  return rcnm * 0x100000000 + rcid;
}

// Decode a B(40) NAME foreign key (Uint8Array of 5 bytes) -> {rcnm, rcid}.
function decodeName(raw) {
  if (!raw || raw.length < 5) return null;
  const rcnm = raw[0];
  const rcid = raw[1] | (raw[2] << 8) | (raw[3] << 16) | (raw[4] << 24);
  return { rcnm, rcid: rcid >>> 0 };
}

function firstField(rec, tag) {
  const f = rec.fields[tag];
  return f && f.length ? f[0] : null;
}

class S57 {
  static build(ddf, catalog) {
    const objClasses = catalog.objClasses; // code -> acronym
    const attrCodes = catalog.attrCodes;   // code -> {acronym,type}

    let comf = 1e7, somf = 10;
    const vectors = new Map(); // nameKey -> vector record

    // ---- pass 1: dataset params + vector records ----
    for (const rec of ddf.records) {
      const dspm = firstField(rec, "DSPM");
      if (dspm) {
        if (dspm.COMF) comf = dspm.COMF;
        if (dspm.SOMF) somf = dspm.SOMF;
      }
      const vrid = firstField(rec, "VRID");
      if (vrid) {
        const rcnm = vrid.RCNM, rcid = vrid.RCID;
        const coords = [];
        // SG2D: integer YCOO/XCOO scaled by COMF
        for (const sg of rec.fields["SG2D"] || []) {
          coords.push([sg.XCOO / comf, sg.YCOO / comf]);
        }
        // SG3D: soundings (YCOO,XCOO,VE3D)
        const soundings = [];
        for (const sg of rec.fields["SG3D"] || []) {
          soundings.push([sg.XCOO / comf, sg.YCOO / comf, sg.VE3D / somf]);
          coords.push([sg.XCOO / comf, sg.YCOO / comf]);
        }
        // VRPT: pointers to begin/end nodes for edges
        const ptrs = [];
        for (const vp of rec.fields["VRPT"] || []) {
          const n = decodeName(vp.NAME);
          if (n) ptrs.push({ ...n, topi: vp.TOPI, ornt: vp.ORNT });
        }
        vectors.set(nameKey(rcnm, rcid), { rcnm, rcid, coords, soundings, ptrs });
      }
    }

    // node coordinate lookup (isolated or connected node => single coord)
    const nodeCoord = (rcnm, rcid) => {
      const v = vectors.get(nameKey(rcnm, rcid));
      if (v && v.coords.length) return v.coords[0];
      return null;
    };

    // full coordinate list for an edge: beginNode + interior + endNode
    const edgeCoords = (edge, reverse) => {
      let begin = null, end = null;
      for (const p of edge.ptrs) {
        if (p.topi === 1) begin = nodeCoord(p.rcnm, p.rcid);
        else if (p.topi === 2) end = nodeCoord(p.rcnm, p.rcid);
      }
      let pts = [];
      if (begin) pts.push(begin);
      pts.push(...edge.coords);
      if (end) pts.push(end);
      if (reverse) pts = pts.slice().reverse();
      return pts;
    };

    // ---- pass 2: feature records ----
    const features = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const touch = (x, y) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    };

    for (const rec of ddf.records) {
      const frid = firstField(rec, "FRID");
      if (!frid) continue;
      const objl = frid.OBJL;
      const prim = frid.PRIM; // 1 point, 2 line, 3 area
      const acronym = objClasses.get(objl) || `OBJ${objl}`;

      // attributes
      const attrs = {};
      for (const a of rec.fields["ATTF"] || []) {
        const info = attrCodes.get(a.ATTL);
        const key = info ? info.acronym : `A${a.ATTL}`;
        attrs[key] = a.ATVL;
      }
      for (const a of rec.fields["NATF"] || []) {
        const info = attrCodes.get(a.ATTL);
        const key = info ? info.acronym : `A${a.ATTL}`;
        attrs[key] = a.ATVL;
      }

      // spatial pointers
      const spatial = [];
      for (const sp of rec.fields["FSPT"] || []) {
        const n = decodeName(sp.NAME);
        if (n) spatial.push({ ...n, ornt: sp.ORNT, usag: sp.USAG, mask: sp.MASK });
      }

      const feat = { objl, acronym, prim, attrs, geom: null, soundings: null };

      if (prim === 1) {
        // point: a single node reference, or a sounding edge with SG3D
        for (const sp of spatial) {
          const v = vectors.get(nameKey(sp.rcnm, sp.rcid));
          if (!v) continue;
          if (v.soundings && v.soundings.length) {
            feat.soundings = v.soundings;
            for (const s of v.soundings) touch(s[0], s[1]);
          } else if (v.coords.length) {
            feat.geom = { type: "Point", coords: v.coords[0] };
            touch(v.coords[0][0], v.coords[0][1]);
          }
        }
      } else if (prim === 2) {
        // line: ordered edges
        const lines = [];
        let cur = [];
        for (const sp of spatial) {
          if (sp.rcnm !== RCNM_VE) continue;
          const edge = vectors.get(nameKey(sp.rcnm, sp.rcid));
          if (!edge) continue;
          const pts = edgeCoords(edge, sp.ornt === 2);
          for (const p of pts) touch(p[0], p[1]);
          if (cur.length && samePoint(cur[cur.length - 1], pts[0])) {
            cur.push(...pts.slice(1));
          } else {
            if (cur.length) lines.push(cur);
            cur = pts.slice();
          }
        }
        if (cur.length) lines.push(cur);
        feat.geom = { type: "Line", coords: lines };
      } else if (prim === 3) {
        // area: edges concatenated into rings
        const rings = assembleRings(spatial, vectors, edgeCoords, touch);
        feat.geom = { type: "Area", coords: rings };
      }

      features.push(feat);
    }

    return {
      features,
      comf,
      somf,
      bounds: { minX, minY, maxX, maxY },
    };
  }
}

function samePoint(a, b) {
  return a && b && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

// Build closed rings from an ordered list of area edges. Edges are walked and
// joined end-to-end; a new ring starts whenever the chain closes.
function assembleRings(spatial, vectors, edgeCoords, touch) {
  const rings = [];
  let cur = [];
  for (const sp of spatial) {
    if (sp.rcnm !== RCNM_VE) continue;
    const edge = vectors.get(nameKey(sp.rcnm, sp.rcid));
    if (!edge) continue;
    const pts = edgeCoords(edge, sp.ornt === 2);
    for (const p of pts) touch(p[0], p[1]);
    if (!cur.length) {
      cur = pts.slice();
    } else if (samePoint(cur[cur.length - 1], pts[0])) {
      cur.push(...pts.slice(1));
    } else {
      cur.push(...pts);
    }
    // close ring when we return to start
    if (cur.length > 2 && samePoint(cur[0], cur[cur.length - 1])) {
      rings.push(cur);
      cur = [];
    }
  }
  if (cur.length > 2) {
    if (!samePoint(cur[0], cur[cur.length - 1])) cur.push(cur[0]);
    rings.push(cur);
  }
  return rings;
}

export { S57 };
