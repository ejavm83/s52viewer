// ISO/IEC 8211 (DDF) reader — the container format used by S-57 ENC .000 files.
// Parses the Data Descriptive Record (DDR) to learn field/subfield layouts,
// then decodes each Data Record (DR) into tagged fields of subfield objects.

const FT = 0x1e; // field terminator
const UT = 0x1f; // unit terminator

function ascii(bytes, start, len) {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[start + i]);
  return s;
}

// Parse a DDR format-controls string like "(A(2),I(5),2b24,b11)" into a flat
// list of {type, width, count}. Repeat counts and nested parens are expanded.
function parseFormatControls(str) {
  // strip outer parentheses
  str = str.trim();
  if (str.startsWith("(")) str = str.slice(1, str.lastIndexOf(")"));
  const out = [];
  // tokenize respecting nested parentheses
  const tokens = [];
  let depth = 0, cur = "";
  for (const ch of str) {
    if (ch === "(") { depth++; cur += ch; }
    else if (ch === ")") { depth--; cur += ch; }
    else if (ch === "," && depth === 0) { tokens.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.length) tokens.push(cur);

  for (let tok of tokens) {
    tok = tok.trim();
    if (!tok) continue;
    // leading repeat count
    let m = tok.match(/^(\d+)(.*)$/);
    let repeat = 1;
    if (m && !tok.startsWith("(")) { repeat = parseInt(m[1], 10); tok = m[2]; }
    // a parenthesised group repeats its contents
    if (tok.startsWith("(")) {
      const inner = parseFormatControls(tok);
      for (let r = 0; r < repeat; r++) out.push(...inner.map((x) => ({ ...x })));
      continue;
    }
    const fmt = parseSingleFormat(tok);
    for (let r = 0; r < repeat; r++) out.push({ ...fmt });
  }
  return out;
}

function parseSingleFormat(tok) {
  tok = tok.trim();
  // binary: b<sign><bytes>  e.g. b11 b12 b14 b21 b22 b24
  let m = tok.match(/^b(\d)(\d)$/i);
  if (m) {
    return { type: "b", signed: m[1] === "2", width: parseInt(m[2], 10) };
  }
  // bit field b<n> would be rare in S-57; treat plain "b" similar to bytes
  // A(n) / A  ascii string ; A() delimited
  m = tok.match(/^([A-Za-z])\((\d*)\)$/);
  if (m) {
    return { type: m[1].toUpperCase(), width: m[2] ? parseInt(m[2], 10) : 0 };
  }
  m = tok.match(/^([A-Za-z])$/);
  if (m) return { type: m[1].toUpperCase(), width: 0 };
  // fallback: delimited ascii
  return { type: "A", width: 0 };
}

// Decode one subfield value from a DataView at offset; returns {value, next}.
function readSubfield(view, bytes, offset, fmt, end) {
  if (fmt.type === "b") {
    const w = fmt.width;
    let v = 0;
    if (fmt.signed) {
      if (w === 1) v = view.getInt8(offset);
      else if (w === 2) v = view.getInt16(offset, true);
      else if (w === 4) v = view.getInt32(offset, true);
    } else {
      if (w === 1) v = view.getUint8(offset);
      else if (w === 2) v = view.getUint16(offset, true);
      else if (w === 4) v = view.getUint32(offset, true);
    }
    return { value: v, next: offset + w };
  }
  // B(n): bit string, n bits => n/8 raw bytes (used by NAME foreign keys).
  if (fmt.type === "B") {
    const nbytes = Math.ceil((fmt.width || 0) / 8);
    const raw = bytes.subarray(offset, offset + nbytes);
    return { value: raw, next: offset + nbytes };
  }
  // ASCII-family: A (string), I (int), R (real)
  if (fmt.width > 0) {
    const s = ascii(bytes, offset, fmt.width);
    return { value: coerce(fmt.type, s), next: offset + fmt.width };
  }
  // delimited: read until UT or FT or end
  let i = offset;
  while (i < end && bytes[i] !== UT && bytes[i] !== FT) i++;
  const s = ascii(bytes, offset, i - offset);
  let next = i;
  if (bytes[i] === UT) next = i + 1; // consume unit terminator
  return { value: coerce(fmt.type, s), next, hitDelim: bytes[i] === UT };
}

function coerce(type, s) {
  if (type === "I") { const n = parseInt(s, 10); return Number.isNaN(n) ? s : n; }
  if (type === "R") { const n = parseFloat(s); return Number.isNaN(n) ? s : n; }
  return s;
}

// A parsed record-field schema from the DDR.
class FieldDef {
  constructor(tag, name, subfieldLabels, formats) {
    this.tag = tag;
    this.name = name;
    this.labels = subfieldLabels; // array of subfield names
    this.formats = formats;       // array of {type,width,...}
  }
}

class DDF {
  constructor() {
    this.fieldDefs = new Map(); // tag -> FieldDef
    this.nall = 1; // national lexical level (1=Latin-1, 2=UCS-2); set from DSSI
  }

  static parse(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const ddf = new DDF();
    let pos = 0;
    // ----- DDR -----
    const ddr = readLeaderAndDirectory(bytes, pos);
    ddf._buildFieldDefs(bytes, ddr);
    pos = ddr.recordEnd;

    // ----- Data records -----
    const records = [];
    while (pos < bytes.length) {
      // tolerate trailing padding / EOF
      if (bytes.length - pos < 24) break;
      const dr = readLeaderAndDirectory(bytes, pos);
      if (dr.recordLength <= 0) break;
      const rec = ddf._decodeRecord(view, bytes, dr);
      records.push(rec);
      pos = dr.recordEnd;
    }
    ddf.records = records;
    return ddf;
  }

  _buildFieldDefs(bytes, rec) {
    for (const entry of rec.directory) {
      const start = rec.fieldAreaStart + entry.position;
      // field controls are the leading bytes up to the first non-control;
      // for S-57 the data-descriptive field = [field controls][name]UT[labels]UT[formats]FT
      let p = start;
      const fieldEnd = start + entry.length;
      if (entry.tag === "0000") continue; // file control field — skip layout
      // field controls: read until... they are fixed but contain the structure code.
      // Find the three UT/FT-delimited parts after the control prefix.
      // Strategy: scan for UT delimiters.
      // First part: from start, the "field controls" + "field name" up to first UT.
      let i = p;
      while (i < fieldEnd && bytes[i] !== UT) i++;
      const head = ascii(bytes, p, i - p); // controls + name
      // field name: controls are leading; in S-57 control length given by leader.
      // We take name as head minus the numeric control prefix (non-printable safe).
      const name = head.replace(/^[0-9;&\-]+/, "");
      i++; // skip UT
      let j = i;
      while (j < fieldEnd && bytes[j] !== UT) j++;
      const arrayDesc = ascii(bytes, i, j - i);
      j++; // skip UT
      let k = j;
      while (k < fieldEnd && bytes[k] !== FT) k++;
      const formatControls = ascii(bytes, j, k - j);

      // The leading '*' in an array descriptor marks the start of the repeating
      // subfield group; strip it so labels match the S-57 acronyms (YCOO, ATTL…).
      const labels = arrayDesc.length
        ? arrayDesc.split("!").map((x) => x.trim().replace(/^\*/, ""))
        : [];
      const formats = parseFormatControls(formatControls);
      ddfSetDef(this, entry.tag, name, labels, formats);
    }
  }

  _decodeRecord(view, bytes, rec) {
    const fields = {}; // tag -> array of subfield-objects (one per repeat)
    const order = [];
    for (const entry of rec.directory) {
      const def = this.fieldDefs.get(entry.tag);
      const start = rec.fieldAreaStart + entry.position;
      const end = start + entry.length; // includes trailing FT
      if (!def || def.formats.length === 0) {
        continue; // structural / unknown
      }
      // National attributes (NATF) use the dataset's national lexical level.
      // Korean ENCs use NALL=2 (UCS-2 / UTF-16LE) for NOBJNM/NINFOM.
      const repeats = (entry.tag === "NATF" && this.nall === 2)
        ? decodeNatfUCS2(view, start, end)
        : decodeField(view, bytes, start, end, def);
      fields[entry.tag] = repeats;
      order.push(entry.tag);
    }
    // learn the national lexical level from the dataset structure record
    if (fields.DSSI && fields.DSSI[0] && fields.DSSI[0].NALL != null) {
      this.nall = fields.DSSI[0].NALL;
    }
    return { fields, order };
  }
}

// Decode a NATF field whose ATVL subfields are UCS-2 (UTF-16LE) — used for
// national-language text (e.g. Korean NOBJNM). Each row is ATTL (2-byte int)
// followed by UTF-16 code units terminated by the unit terminator (0x001F).
function decodeNatfUCS2(view, start, end) {
  const rows = [];
  let off = start;
  while (off + 2 <= end) {
    const attl = view.getUint16(off, true);
    if (attl === 0x001e) break; // field terminator
    off += 2;
    let s = "";
    while (off + 2 <= end) {
      const u = view.getUint16(off, true);
      off += 2;
      if (u === 0x001f || u === 0x001e) break; // unit / field terminator
      s += String.fromCharCode(u);
    }
    rows.push({ ATTL: attl, ATVL: s });
  }
  return rows;
}

function ddfSetDef(ddf, tag, name, labels, formats) {
  ddf.fieldDefs.set(tag, new FieldDef(tag, name, labels, formats));
}

// Decode all subfield repeats inside one field's data area.
function decodeField(view, bytes, start, end, def) {
  const dataEnd = bytes[end - 1] === FT ? end - 1 : end;
  const repeats = [];
  let offset = start;
  // The set of formats describes one "row". Repeat across the field until data
  // is exhausted (S-57 uses repeating rows for SG2D, VRPT, ATTF, etc.).
  const guard = 100000;
  let count = 0;
  while (offset < dataEnd && count++ < guard) {
    const row = {};
    for (let s = 0; s < def.formats.length; s++) {
      const fmt = def.formats[s];
      const label = def.labels[s] || `SF${s}`;
      if (offset >= dataEnd) { row[label] = fmt.type === "b" ? 0 : ""; continue; }
      const r = readSubfield(view, bytes, offset, fmt, dataEnd);
      row[label] = r.value;
      offset = r.next;
    }
    repeats.push(row);
    // if formats are all fixed-width and consumed exactly, loop continues;
    // if a delimited subfield consumed an FT we may have passed dataEnd.
    if (offset >= dataEnd) break;
  }
  return repeats;
}

function readLeaderAndDirectory(bytes, pos) {
  const recordLength = parseInt(ascii(bytes, pos + 0, 5), 10);
  const leaderId = String.fromCharCode(bytes[pos + 6]);
  const fieldControlLength = parseInt(ascii(bytes, pos + 10, 2), 10) || 0;
  const baseAddress = parseInt(ascii(bytes, pos + 12, 5), 10);
  const sizeFieldLength = parseInt(String.fromCharCode(bytes[pos + 20]), 10);
  const sizeFieldPos = parseInt(String.fromCharCode(bytes[pos + 21]), 10);
  const sizeFieldTag = parseInt(String.fromCharCode(bytes[pos + 23]), 10);

  // Directory begins after 24-byte leader, ends at field terminator.
  const dirStart = pos + 24;
  const entrySize = sizeFieldTag + sizeFieldLength + sizeFieldPos;
  const directory = [];
  let p = dirStart;
  while (bytes[p] !== FT && p < pos + recordLength) {
    const tag = ascii(bytes, p, sizeFieldTag);
    const length = parseInt(ascii(bytes, p + sizeFieldTag, sizeFieldLength), 10);
    const position = parseInt(
      ascii(bytes, p + sizeFieldTag + sizeFieldLength, sizeFieldPos),
      10
    );
    directory.push({ tag, length, position });
    p += entrySize;
  }
  return {
    recordLength,
    leaderId,
    fieldControlLength,
    baseAddress,
    fieldAreaStart: pos + baseAddress,
    directory,
    recordEnd: pos + recordLength,
  };
}

export { DDF };
