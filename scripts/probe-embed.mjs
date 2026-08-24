/**
 * Ampcontrol LinkedIn signage — extraction probe, v2
 *
 * v1 answered "can we reach LinkedIn from the runner?" — yes. The BLOCKED
 * verdicts were a false positive in my detection, not a real block.
 *
 * v2 answers the questions that actually decide the rebuild:
 *   1. What's inside the document master manifest? (carousel tiles, all pages)
 *   2. What do image and video posts expose?
 *   3. Where in the embedded JSON does the useful media live?
 *
 * Reads URNs from posts.json, so there's nothing to gather by hand.
 * Writes nothing. Deploys nothing. Prints a report.
 */

import { readFile } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const MAX_POSTS = Number(process.env.PROBE_LIMIT || 6);
const FALLBACK  = ['urn:li:activity:7496053505011589121'];

function decode(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function meta(html, prop) {
  const m = html.match(
    new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']*)', 'i')
  );
  return m ? decode(m[1]) : null;
}

/** LinkedIn hides structured data in HTML-escaped <code> elements. */
function codePayloads(html) {
  const out = [];
  const re = /<code[^>]*>([\s\S]*?)<\/code>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = decode(m[1]).trim();
    if (!raw.startsWith('{') && !raw.startsWith('[')) continue;
    try { out.push(JSON.parse(raw)); } catch { /* not JSON, skip */ }
  }
  return out;
}

/** Walk any structure and record where media-ish strings live. */
function findMedia(node, path, hits) {
  path = path || '';
  hits = hits || [];
  if (node === null || node === undefined) return hits;

  if (typeof node === 'string') {
    if (/^https:\/\/(media|dms)\.licdn\.com\//.test(node) || /\.(m3u8|mp4)(\?|$)/.test(node)) {
      hits.push({ path: path, url: node });
    }
    return hits;
  }
  if (typeof node !== 'object') return hits;

  if (Array.isArray(node)) {
    node.forEach(function (v, i) { findMedia(v, path + '[' + i + ']', hits); });
    return hits;
  }
  Object.keys(node).forEach(function (k) {
    findMedia(node[k], path ? path + '.' + k : k, hits);
  });
  return hits;
}

function classify(html) {
  if (/native-document|manifestUrl|coverPages/i.test(html)) return 'document / carousel';
  if (/playbackUrl|progressiveStreams|\.m3u8|videoPlayMetadata/i.test(html)) return 'video';
  if (/image-shrink|feedshare-shrink/i.test(html)) return 'image';
  return 'text only';
}

function shortUrl(u, n) {
  n = n || 130;
  return u.length > n ? u.slice(0, n) + '\u2026' : u;
}

async function get(url, accept) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: accept || 'text/html,application/xhtml+xml',
      'accept-language': 'en-AU,en;q=0.9'
    },
    redirect: 'follow'
  });
  return { res: res, body: await res.text() };
}

/* ── the manifest: the thing that decides whether carousels work ── */
async function probeManifest(url) {
  console.log('');
  console.log('  \u2500\u2500 document master manifest \u2500\u2500');
  console.log('    ' + shortUrl(url, 170));

  let res, body;
  try {
    const r = await get(url, 'application/json,text/plain,*/*');
    res = r.res; body = r.body;
  } catch (err) {
    console.log('    fetch failed: ' + err.message);
    return;
  }

  console.log('    status         ' + res.status + ' ' + res.statusText);
  console.log('    content-type   ' + res.headers.get('content-type'));
  console.log('    bytes          ' + body.length.toLocaleString());

  let json = null;
  try { json = JSON.parse(body); } catch (e) { /* not JSON */ }

  if (!json) {
    console.log('    not JSON. First 400 chars:');
    console.log('    ' + body.slice(0, 400).replace(/\n/g, ' '));
    return;
  }

  console.log('    top-level keys ' + Object.keys(json).join(', '));

  const media = findMedia(json);
  console.log('    media URLs     ' + media.length);
  media.slice(0, 8).forEach(function (h) {
    console.log('      ' + h.path);
    console.log('        ' + shortUrl(h.url, 150));
  });
  if (media.length > 8) console.log('      \u2026 and ' + (media.length - 8) + ' more');

  // Page count is the tell: if it matches the carousel's page count, we have
  // every tile and can render them ourselves at full size.
  Object.keys(json).forEach(function (k) {
    if (Array.isArray(json[k]) && /page|slide|image|entr/i.test(k)) {
      console.log('    array "' + k + '" length ' + json[k].length);
    }
  });

  console.log('');
  console.log('    \u2500\u2500 raw structure, first 900 chars \u2500\u2500');
  console.log('    ' + JSON.stringify(json, null, 1).slice(0, 900).replace(/\n/g, '\n    '));
}

async function probePost(urn, i) {
  console.log('');
  console.log('\u2550'.repeat(58));
  console.log('[' + i + '] ' + urn);

  const url = 'https://www.linkedin.com/embed/feed/update/' + urn;
  let res, body;
  try {
    const r = await get(url);
    res = r.res; body = r.body;
  } catch (err) {
    console.log('  fetch failed: ' + err.message);
    return;
  }

  const title = decode((body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || ['', ''])[1]).trim();

  console.log('  status        ' + res.status);
  console.log('  title         ' + title.slice(0, 80));
  console.log('  post type     ' + classify(body));
  console.log('  og:desc len   ' + (meta(body, 'og:description') || '').length + ' chars');

  // A real unavailability test: a dead post has no copy and a generic title.
  const dead = res.status === 404 || res.status === 410 ||
               /this (post|content) (is|isn.t|is no longer)/i.test(title);
  console.log('  dead post?    ' + (dead ? 'YES' : 'no'));

  const payloads = codePayloads(body);
  console.log('  JSON payloads ' + payloads.length + ' parsed');

  const media = findMedia(payloads);
  const useful = media.filter(function (h) {
    return !/company-logo|ampcontrol_cover|aero-v1/.test(h.url);
  });
  console.log('  media in JSON ' + media.length + ' (' + useful.length + ' excluding logos)');
  useful.slice(0, 6).forEach(function (h) {
    console.log('    ' + h.path);
    console.log('      ' + shortUrl(h.url));
  });

  const manifest = (body.match(/https:\/\/media\.licdn\.com\/dms\/document\/[^"'\\\s)<]+/i) || [])[0];
  if (manifest) await probeManifest(decode(manifest));
  else console.log('  no document manifest on this post');
}

async function main() {
  let urns = FALLBACK;
  try {
    const posts = JSON.parse(await readFile('posts.json', 'utf8')).posts || [];
    if (posts.length) urns = posts.map(function (p) { return p.urn; });
  } catch (e) {
    console.log('Could not read posts.json \u2014 using the fallback URN.');
  }

  console.log('Probing ' + Math.min(urns.length, MAX_POSTS) + ' of ' + urns.length +
              ' posts from posts.json');

  for (let i = 0; i < Math.min(urns.length, MAX_POSTS); i++) {
    await probePost(urns[i], i + 1);
  }

  console.log('');
  console.log('Done. Paste the whole log back.');
}

main().catch(function (err) { console.error(err); process.exit(1); });
