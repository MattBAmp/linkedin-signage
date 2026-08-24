/**
 * Ampcontrol LinkedIn signage — extraction probe, v4
 *
 * v3 established:
 *   image posts -> image-shrink_1280, usable
 *   video posts -> mp4-360p playlist URL + videocover-high poster, usable
 *   documents   -> cover image AND manifest both return Cloudflare 1101
 *
 * That last result is suspicious: the cover is an ordinary dms/image URL of the
 * same shape as the image-post URLs that work. So v4:
 *   1. CONTROL — fetch a known-good image-post URL. If that 500s too, the
 *      fault is in how I build requests, not in LinkedIn's document paths.
 *   2. Print URLs in full, untruncated, so a malformed one is visible.
 *   3. Dump the raw HTML around the document URLs, to find the real
 *      native-document.html iframe src and its query parameters.
 *   4. Test the video mp4 and poster actually fetch.
 *
 * Writes nothing. Deploys nothing.
 */

import { readFile } from 'node:fs/promises';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_POSTS = Number(process.env.PROBE_LIMIT || 6);

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/* Media URL sweep of raw HTML. Video URLs carry the codec in a path segment
   rather than an extension, which is why v3's extension regex missed them. */
function mediaUrls(html) {
  const hits = html.match(/https:\/\/(?:media|dms|static)\.licdn\.com\/[^"'\\\s<>)]+/gi) || [];
  const out = [];
  const seen = new Set();
  for (const raw of hits) {
    const u = decode(raw);
    if (/company-logo|aero-v1|sc\/h\/|ampcontrol_cover/.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function kind(u) {
  if (/playlist\/vid|mp4-\d+p/.test(u))        return 'VIDEO mp4';
  if (/videocover/.test(u))                    return 'VIDEO poster';
  if (/document-cover/.test(u))                return 'DOC cover';
  if (/master-manifest/.test(u))               return 'DOC manifest';
  if (/native-document/.test(u))               return 'DOC viewer iframe';
  if (/image-shrink|feedshare/.test(u))        return 'IMAGE';
  return 'other';
}

async function tryFetch(url, label, extraHeaders) {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        'accept-language': 'en-AU,en;q=0.9',
        ...(extraHeaders || {})
      },
      redirect: 'follow'
    });
    const ct = res.headers.get('content-type') || '?';
    const cl = res.headers.get('content-length') || '?';
    console.log('      ' + label.padEnd(34) + res.status + '  ' + ct + '  ' + cl);
    if (!res.ok && /json/.test(ct)) {
      const b = await res.text();
      const j = (() => { try { return JSON.parse(b); } catch { return null; } })();
      if (j && j.error_code) console.log('        -> ' + j.error_code + ' ' + (j.error_name || ''));
    }
    return res;
  } catch (err) {
    console.log('      ' + label.padEnd(34) + 'FAILED ' + err.message);
    return null;
  }
}

/* Show the HTML surrounding a needle, so I can see the real attribute
   it lives in and any sibling parameters. */
function context(html, needle, before, after) {
  const i = html.indexOf(needle);
  if (i < 0) return null;
  return html.slice(Math.max(0, i - (before || 300)), i + needle.length + (after || 500));
}

async function probePost(urn, i, control) {
  console.log('');
  console.log('='.repeat(64));
  console.log('[' + i + '] ' + urn);

  let res, html;
  try {
    res = await fetch('https://www.linkedin.com/embed/feed/update/' + urn, {
      headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow'
    });
    html = await res.text();
  } catch (err) { console.log('  fetch failed: ' + err.message); return null; }

  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || ['', ''])[1]).trim();
  console.log('  ' + title.slice(0, 70));

  const urls = mediaUrls(html);
  console.log('  media URLs: ' + urls.length);
  urls.forEach(u => {
    console.log('');
    console.log('    [' + kind(u) + ']  len ' + u.length);
    console.log('    ' + u);          // FULL url, no truncation
  });

  const isDoc   = urls.some(u => /master-manifest|document-cover/.test(u));
  const isVideo = urls.some(u => /playlist\/vid|videocover/.test(u));

  /* ---- control: does an ordinary image URL work from here? ---- */
  if (!control.done) {
    const img = urls.find(u => /image-shrink|feedshare/.test(u));
    if (img) {
      control.done = true;
      console.log('');
      console.log('    -- CONTROL: ordinary image post URL --');
      await tryFetch(img, 'image-shrink as-is', { accept: 'image/avif,image/webp,image/*,*/*' });
      await tryFetch(img, 'image-shrink + referer',
        { accept: 'image/*,*/*', referer: 'https://www.linkedin.com/' });
    }
  }

  /* ---- documents ---- */
  if (isDoc) {
    console.log('');
    console.log('    -- DOCUMENT ROUTES --');
    const cover    = urls.find(u => /document-cover/.test(u));
    const manifest = urls.find(u => /master-manifest/.test(u));

    if (cover) {
      await tryFetch(cover, 'cover, image accept', { accept: 'image/avif,image/webp,image/*,*/*' });
      await tryFetch(cover, 'cover, + referer',
        { accept: 'image/*,*/*', referer: 'https://www.linkedin.com/' });
      // Does the signature survive dropping the cache-buster?
      await tryFetch(cover.replace(/[?&]e=\d+/, ''), 'cover, no e= param', { accept: 'image/*,*/*' });
    }
    if (manifest) {
      await tryFetch(manifest, 'manifest, json accept',
        { accept: 'application/json,*/*', referer: 'https://www.linkedin.com/' });
    }

    /* The real prize: the viewer iframe and whatever params it carries */
    console.log('');
    console.log('    -- RAW HTML around native-document --');
    const ctx = context(html, 'native-document', 500, 900);
    console.log(ctx ? '    ' + ctx.replace(/\s+/g, ' ') : '    (not found)');

    console.log('');
    console.log('    -- RAW HTML around document-cover --');
    const ctx2 = context(html, 'document-cover', 400, 400);
    console.log(ctx2 ? '    ' + ctx2.replace(/\s+/g, ' ') : '    (not found)');
  }

  /* ---- video ---- */
  if (isVideo) {
    console.log('');
    console.log('    -- VIDEO ROUTES --');
    const mp4    = urls.find(u => /playlist\/vid|mp4-\d+p/.test(u));
    const poster = urls.find(u => /videocover/.test(u));
    if (mp4)    await tryFetch(mp4, 'mp4 (range request)',
                   { accept: 'video/*,*/*', range: 'bytes=0-1023' });
    if (poster) await tryFetch(poster, 'poster frame', { accept: 'image/*,*/*' });

    console.log('');
    console.log('    -- RAW HTML around playlist/vid --');
    const ctx = context(html, 'playlist/vid', 400, 700);
    console.log(ctx ? '    ' + ctx.replace(/\s+/g, ' ') : '    (not found)');
  }

  return html;
}

async function main() {
  let urns = ['urn:li:activity:7496053505011589121'];
  try {
    const posts = JSON.parse(await readFile('posts.json', 'utf8')).posts || [];
    if (posts.length) urns = posts.map(p => p.urn);
  } catch { console.log('No posts.json - using fallback.'); }

  console.log('Probe v4 - ' + Math.min(urns.length, MAX_POSTS) + ' of ' + urns.length);

  const control = { done: false };
  for (let i = 0; i < Math.min(urns.length, MAX_POSTS); i++) {
    await probePost(urns[i], i + 1, control);
  }
  console.log('');
  console.log('Done. Paste the whole log back.');
}

main().catch(err => { console.error(err); process.exit(1); });
