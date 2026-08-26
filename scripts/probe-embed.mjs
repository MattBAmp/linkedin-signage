/**
 * Ampcontrol LinkedIn signage — extraction probe, v6
 *
 * One question: carousels with more than 3 slides only give us 3.
 *   a) Where is the true page count?
 *   b) Are the URLs for pages 4+ obtainable, or is coverPages all we get?
 *
 * Dumps the ENTIRE native-document config rather than the first 900 chars,
 * which is all I have ever looked at. Document posts only.
 *
 * Writes nothing. Deploys nothing.
 */

import { readFile } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/** Walk an object and list every key path, so nothing is missed. */
function keyPaths(node, path = '', out = []) {
  if (node && typeof node === 'object') {
    if (Array.isArray(node)) {
      out.push(path + '  [array of ' + node.length + ']');
      if (node.length) keyPaths(node[0], path + '[0]', out);
    } else {
      for (const k of Object.keys(node)) {
        const v = node[k];
        const p = path ? path + '.' + k : k;
        if (v && typeof v === 'object') keyPaths(v, p, out);
        else out.push(p + '  = ' + JSON.stringify(v).slice(0, 110));
      }
    }
  }
  return out;
}

async function probe(urn, i) {
  console.log('');
  console.log('='.repeat(64));
  console.log('[' + i + '] ' + urn);

  let html;
  try {
    const res = await fetch('https://www.linkedin.com/embed/feed/update/' + urn, {
      headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow'
    });
    html = await res.text();
    if (!res.ok) { console.log('  status ' + res.status + ' — skipping'); return; }
  } catch (e) { console.log('  fetch failed: ' + e.message); return; }

  if (!/native-document|coverPages/i.test(html)) {
    console.log('  not a document post — skipping');
    return;
  }

  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || ['', ''])[1]).trim();
  console.log('  ' + title.slice(0, 70));

  /* ---- 1. any "N pages" text LinkedIn renders ---- */
  console.log('');
  console.log('  PAGE-COUNT TEXT');
  const pageTexts = [...new Set((html.match(/[\w\s]{0,30}\b\d+\s*pages?\b/gi) || [])
    .map(t => decode(t).replace(/\s+/g, ' ').trim()))];
  pageTexts.slice(0, 8).forEach(t => console.log('    "' + t + '"'));
  if (!pageTexts.length) console.log('    none found');

  /* ---- 2. any key that looks like a total ---- */
  console.log('');
  console.log('  COUNT-LIKE KEYS IN RAW HTML');
  const countKeys = [...new Set((html.match(
    /(?:total|num|count|page)[A-Za-z]*["']?\s*[:=]\s*["']?\d+/gi) || []))];
  countKeys.slice(0, 20).forEach(k => console.log('    ' + decode(k)));
  if (!countKeys.length) console.log('    none found');

  /* ---- 3. THE WHOLE document config, not the first 900 chars ---- */
  console.log('');
  console.log('  FULL native-document config');
  const cfg = html.match(/data-native-document-config="([^"]+)"/i);
  if (!cfg) {
    console.log('    attribute not found');
  } else {
    const raw = decode(cfg[1]);
    console.log('    raw length: ' + raw.length + ' chars');
    let json = null;
    try { json = JSON.parse(raw); } catch (e) { console.log('    parse failed: ' + e.message); }
    if (json) {
      console.log('    -- every key path --');
      keyPaths(json).forEach(k => console.log('      ' + k));
      const pages = json.doc && json.doc.coverPages ? json.doc.coverPages : [];
      console.log('    -- coverPages: ' + pages.length + ' --');
      pages.forEach((p, n) => {
        const src = p && p.config && p.config.src ? p.config.src : '(no src)';
        console.log('      [' + n + '] ' + src);
      });
    } else {
      console.log('    raw (first 2000): ' + raw.slice(0, 2000));
    }
  }

  /* ---- 4. every ads-document URL anywhere on the page ---- */
  console.log('');
  console.log('  ALL ads-document URLS');
  const docUrls = [...new Set((html.match(
    /https:\/\/media\.licdn\.com\/dms\/(?:image|document)\/[^"'\\\s<>)]*(?:document|manifest)[^"'\\\s<>)]*/gi
  ) || []).map(decode))];
  docUrls.forEach(u => console.log('    ' + u.slice(0, 165)));
  console.log('    total: ' + docUrls.length);

  /* ---- 5. is the signature bound to the page index? ---- */
  console.log('');
  console.log('  SIGNATURE TEST (are pages 4+ guessable?)');
  const first = docUrls.find(u => /document-cover/.test(u));
  if (first) {
    const sig = (first.match(/[?&]t=([^&]+)/) || [])[1] || '';
    console.log('    page 0 signature: ' + sig.slice(0, 24) + '...');
    const others = docUrls.filter(u => /document-cover/.test(u))
      .map(u => (u.match(/[?&]t=([^&]+)/) || [])[1] || '');
    const unique = new Set(others).size;
    console.log('    distinct signatures across ' + others.length + ' pages: ' + unique);
    console.log('    -> ' + (unique > 1
      ? 'per-page signatures, so page 4 CANNOT be constructed by hand'
      : 'shared signature, so the index may simply be incrementable'));
  } else {
    console.log('    no cover URL to test');
  }
}

async function main() {
  let urns = [];
  try {
    const posts = JSON.parse(await readFile('posts.json', 'utf8')).posts || [];
    urns = posts.filter(p => p.mediaType === 'document').map(p => p.urn);
  } catch { /* fall through */ }
  if (!urns.length) urns = ['urn:li:activity:7496053505011589121'];

  console.log('Probe v6 — full document config for ' + urns.length + ' carousel post(s)');
  for (let i = 0; i < Math.min(urns.length, 5); i++) await probe(urns[i], i + 1);
  console.log('');
  console.log('Done. Paste the whole log back.');
}

main().catch(e => { console.error(e); process.exit(1); });
