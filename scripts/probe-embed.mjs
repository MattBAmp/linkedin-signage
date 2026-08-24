/**
 * Ampcontrol LinkedIn signage — extraction probe, v3
 *
 * v2 reported zeroes everywhere because of two mistakes of mine:
 *   - the entity decoder only handled named entities, so LinkedIn's numeric-
 *     encoded <code> payloads never parsed
 *   - media was only searched inside those payloads, never in the raw HTML
 *
 * v3 fixes both, inventories media from the raw HTML as well, and pressure-
 * tests the two document routes (master manifest, cover image) with a Referer.
 *
 * Writes nothing. Deploys nothing. Prints a report.
 */

import { readFile } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MAX_POSTS = Number(process.env.PROBE_LIMIT || 6);
const FALLBACK  = ['urn:li:activity:7496053505011589121'];

/* ── proper entity decoding. This was the v2 bug. ── */
function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');   // last, so &amp;#x27; unwinds correctly
}

function meta(html, prop) {
  const m = html.match(
    new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']*)', 'i')
  );
  return m ? decode(m[1]) : null;
}

function shortUrl(u, n) {
  n = n || 140;
  return u.length > n ? u.slice(0, n) + '\u2026' : u;
}

/** The size token in a licdn path, e.g. image-shrink_800 or ...-images_480 */
function sizeToken(u) {
  const m = u.match(/\/([a-z-]*(?:shrink|images|scale|document[a-z-]*|master[a-z-]*)[a-z-]*_?[0-9x_]*)\//i);
  return m ? m[1] : '?';
}

/* ── raw-HTML media inventory: where I should have looked first ── */
function rawMedia(html) {
  const found = html.match(/https:\/\/(?:media|dms|static)\.licdn\.com\/[^"'\\\s<>)]+/gi) || [];
  const out = new Map();
  for (const raw of found) {
    const u = decode(raw);
    if (/company-logo|aero-v1|ampcontrol_cover|sc\/h\//.test(u)) continue;  // chrome, not content
    if (!out.has(u)) out.set(u, sizeToken(u));
  }
  return out;
}

/** LinkedIn hides structured data in entity-encoded <code> elements. */
function codePayloads(html) {
  const blocks = [];
  const re = /<code[^>]*>([\s\S]*?)<\/code>/gi;
  let m;
  while ((m = re.exec(html))) blocks.push(m[1]);

  const parsed = [];
  const failures = [];
  blocks.forEach((b, i) => {
    const raw = decode(b).trim();
    if (!raw.startsWith('{') && !raw.startsWith('[')) {
      failures.push({ i, why: 'not JSON-shaped', head: raw.slice(0, 80) });
      return;
    }
    try { parsed.push(JSON.parse(raw)); }
    catch (e) { failures.push({ i, why: e.message.slice(0, 60), head: raw.slice(0, 80) }); }
  });
  return { total: blocks.length, parsed, failures, firstRaw: blocks[0] || '' };
}

function findMedia(node, path, hits) {
  path = path || ''; hits = hits || [];
  if (node === null || node === undefined) return hits;
  if (typeof node === 'string') {
    if (/^https:\/\/(media|dms)\.licdn\.com\//.test(node) || /\.(m3u8|mp4)(\?|$)/.test(node)) {
      hits.push({ path, url: node });
    }
    return hits;
  }
  if (typeof node !== 'object') return hits;
  if (Array.isArray(node)) {
    node.forEach((v, i) => findMedia(v, path + '[' + i + ']', hits));
    return hits;
  }
  Object.keys(node).forEach(k => findMedia(node[k], path ? path + '.' + k : k, hits));
  return hits;
}

function classify(html) {
  if (/native-document|manifestUrl|coverPages/i.test(html)) return 'document / carousel';
  if (/playbackUrl|progressiveStreams|\.m3u8|videoPlayMetadata|dms\/playlist/i.test(html)) return 'video';
  if (/image-shrink|feedshare-shrink/i.test(html)) return 'image';
  return 'unknown (text, or metadata hidden in JSON)';
}

async function head(url, label, referer) {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'image/avif,image/webp,image/*,application/json,*/*',
        'accept-language': 'en-AU,en;q=0.9',
        ...(referer ? { referer: 'https://www.linkedin.com/' } : {})
      },
      redirect: 'follow'
    });
    const ct  = res.headers.get('content-type') || '?';
    const len = res.headers.get('content-length') || '?';
    console.log('      ' + label.padEnd(30) + res.status + '  ' + ct + '  ' + len + ' bytes');
    return res;
  } catch (err) {
    console.log('      ' + label.padEnd(30) + 'failed: ' + err.message);
    return null;
  }
}

async function probeDocument(html) {
  console.log('    -- document routes --');

  const manifest = (html.match(/https:\/\/media\.licdn\.com\/dms\/document\/[^"'\\\s<>)]+/i) || [])[0];
  const cover    = (html.match(/https:\/\/media\.licdn\.com\/dms\/image\/[^"'\\\s<>)]*document-cover[^"'\\\s<>)]*/i) || [])[0];

  if (manifest) {
    const u = decode(manifest);
    console.log('      manifest URL len ' + u.length);
    await head(u, 'manifest, no referer', false);
    const res = await head(u, 'manifest, with referer', true);
    if (res && res.ok) {
      const body = await res.text();
      console.log('      manifest body head: ' + body.slice(0, 300).replace(/\n/g, ' '));
    }
  } else {
    console.log('      no manifest URL in HTML');
  }

  if (cover) {
    const u = decode(cover);
    await head(u, 'cover image as-is', true);
    // Do signed URLs survive a size swap? Decides whether we can get it sharper.
    const bigger = u.replace(/-images_\d+/, '-images_1280');
    if (bigger !== u) await head(bigger, 'cover upsized to 1280', true);
  } else {
    console.log('      no cover image URL in HTML');
  }
}

async function probePost(urn, i) {
  console.log('');
  console.log('='.repeat(60));
  console.log('[' + i + '] ' + urn);

  let res, html;
  try {
    res = await fetch('https://www.linkedin.com/embed/feed/update/' + urn, {
      headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-AU,en;q=0.9' },
      redirect: 'follow'
    });
    html = await res.text();
  } catch (err) {
    console.log('  fetch failed: ' + err.message);
    return;
  }

  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || ['', ''])[1]).trim();
  console.log('  status      ' + res.status + '   bytes ' + html.length.toLocaleString());
  console.log('  title       ' + title.slice(0, 75));
  console.log('  type        ' + classify(html));
  console.log('  og:desc     ' + (meta(html, 'og:description') || '').length + ' chars');

  /* raw HTML media */
  const raw = rawMedia(html);
  console.log('  media in raw HTML: ' + raw.size);
  let n = 0;
  for (const [u, tok] of raw) {
    if (n++ >= 5) { console.log('    ... and ' + (raw.size - 5) + ' more'); break; }
    console.log('    [' + tok + ']');
    console.log('      ' + shortUrl(u));
  }

  /* code payloads, now decoded properly */
  const cp = codePayloads(html);
  console.log('  <code> blocks: ' + cp.total + ' found, ' + cp.parsed.length +
              ' parsed, ' + cp.failures.length + ' failed');
  cp.failures.slice(0, 3).forEach(f =>
    console.log('    block ' + f.i + ' failed (' + f.why + '): ' + f.head));
  if (cp.total && !cp.parsed.length) {
    console.log('    first block, raw first 200 chars:');
    console.log('    ' + cp.firstRaw.slice(0, 200).replace(/\n/g, ' '));
  }

  const inJson = findMedia(cp.parsed).filter(h => !/company-logo|aero-v1/.test(h.url));
  console.log('  media inside JSON: ' + inJson.length);
  inJson.slice(0, 6).forEach(h => {
    console.log('    ' + h.path);
    console.log('      ' + shortUrl(h.url));
  });

  /* video hunt */
  const vid = (html.match(/https:\/\/[^"'\\\s<>)]*\.(m3u8|mp4)[^"'\\\s<>)]*/gi) || []);
  console.log('  video URLs: ' + vid.length + (vid.length ? '' : ' (none in HTML)'));
  vid.slice(0, 3).forEach(v => console.log('      ' + shortUrl(decode(v))));

  if (/native-document|manifestUrl|coverPages/i.test(html)) await probeDocument(html);
}

async function main() {
  let urns = FALLBACK;
  try {
    const posts = JSON.parse(await readFile('posts.json', 'utf8')).posts || [];
    if (posts.length) urns = posts.map(p => p.urn);
  } catch { console.log('Could not read posts.json - using fallback URN.'); }

  console.log('Probe v3 - ' + Math.min(urns.length, MAX_POSTS) + ' of ' + urns.length + ' posts');

  for (let i = 0; i < Math.min(urns.length, MAX_POSTS); i++) await probePost(urns[i], i + 1);

  console.log('');
  console.log('Done. Paste the whole log back.');
}

main().catch(err => { console.error(err); process.exit(1); });
