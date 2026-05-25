// Loads the S-57 object-class and attribute catalogs (the CSVs shipped with
// OpenCPN) so numeric codes stored in the .000 file can be mapped to acronyms.

function parseCSV(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === "\r") { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function loadCatalog(objUrl, attrUrl) {
  const [objTxt, attrTxt] = await Promise.all([
    fetch(objUrl).then((r) => r.text()),
    fetch(attrUrl).then((r) => r.text()),
  ]);
  const objClasses = new Map(); // code -> acronym
  const attrCodes = new Map();  // code -> {acronym, type}

  const objRows = parseCSV(objTxt);
  for (let i = 1; i < objRows.length; i++) {
    const r = objRows[i];
    if (r.length < 3) continue;
    const code = parseInt(r[0], 10);
    if (Number.isNaN(code)) continue;
    objClasses.set(code, r[2].trim());
  }

  const attrRows = parseCSV(attrTxt);
  for (let i = 1; i < attrRows.length; i++) {
    const r = attrRows[i];
    if (r.length < 4) continue;
    const code = parseInt(r[0], 10);
    if (Number.isNaN(code)) continue;
    attrCodes.set(code, { acronym: r[2].trim(), type: r[3].trim() });
  }
  return { objClasses, attrCodes };
}

export { loadCatalog };
