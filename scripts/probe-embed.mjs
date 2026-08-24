/**
 * Ampcontrol LinkedIn signage — extraction probe, v5
 *
 * Two jobs:
 *   1. Find the markup for the author header (name, avatar, followers) and
 *      the reaction / comment counts, so those can be rebuilt on our cards.
 *   2. Show which image size token each post actually uses, to confirm why
 *      some posts came through as copy-only.
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

/** Dump the HTML around the first occurrence of a needle. */
function around(html, needle, before = 400, after = 700) {
  const i = html.search(needle instanceof RegExp ? needle : new RegExp(needle, 'i'));
  if (i < 0) return null;
  return html.slice(Math.max(0, i - before), i + after).replace(/\s+/g, ' ');
}

function tokenOf(u) {
  const m = u.match(/\/([a-z0-9-]*(?:shrink|scale|images|cover|logo)[a-z0-9-]*_?[0-9x_]*)\//i);
  return m ? m[1] : '?';
}

async function probePost(urn, i) {
  console.log('');
  console.log('='.repeat(64));
  console.log('[' + i + '] ' + urn);

  let res, html;
  try {
    res = await fetch('https://www.linkedin.com/embed/feed/update/' + urn, {
      headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow'
    });
    html = await res.text();
  } catch (err) { console.log('  fetch failed: ' + err.message); return; }

  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || ['', ''])[1]).trim();
  console.log('  ' + title.slice(0, 70));
  console.log('  status ' + res.status + '  bytes ' + html.length.toLocaleString());

  /* ---------- 1. every licdn image, with its size token ---------- */
  const imgs = [...new Set((html.match(
    /https:\/\/media\.licdn\.com\/dms\/image\/[^"'\\\s<>)]+/gi) || []).map(decode))];
  console.log('');
  console.log('  IMAGE TOKENS (' + imgs.length + ')');
  imgs.forEach(u => console.log('    ' + tokenOf(u).padEnd(34) + u.slice(0, 90)));
  const postImage = imgs.filter(u =>
    !/company-logo|profile-displayphoto|videocover|document-cover/i.test(u));
  console.log('  -> candidate POST images: ' + postImage.length +
              (postImage.length ? '' : '   << this post would render copy-only'));

  /* ---------- 2. author header ---------- */
  console.log('');
  console.log('  AUTHOR HEADER');
  const followers = around(html, /follower/i, 700, 400);
  console.log('    around "follower": ' + (followers ? followers.slice(0, 900) : 'NOT FOUND'));

  /* ---------- 3. reactions and comments ---------- */
  console.log('');
  console.log('  SOCIAL COUNTS');
  for (const anchor of [
    /social-details/i,
    /social-actions/i,
    /num-reactions|numReactions/i,
    /reactions?-?(count|icon)/i,
    /comments?["\s-]/i
  ]) {
    const hit = around(html, anchor, 300, 800);
    console.log('    [' + anchor.source.slice(0, 28) + '] ' +
      (hit ? hit.slice(0, 800) : 'not found'));
    console.log('');
  }

  /* ---------- 4. any data-* attributes carrying numbers ---------- */
  const dataAttrs = [...new Set((html.match(/data-[a-z-]*(?:count|reaction|comment|num)[a-z-]*="[^"]{0,40}"/gi) || []))];
  console.log('  NUMERIC data-* ATTRS: ' + (dataAttrs.length || 'none'));
  dataAttrs.slice(0, 12).forEach(a => console.log('    ' + a));
}

async function main() {
  let urns = ['urn:li:activity:7496053505011589121'];
  try {
    const posts = JSON.parse(await readFile('posts.json', 'utf8')).posts || [];
    if (posts.length) urns = posts.map(p => p.urn);
  } catch { console.log('No posts.json - using fallback.'); }

  console.log('Probe v5 - header + reactions markup, and image tokens');
  console.log('Probing ' + Math.min(urns.length, MAX_POSTS) + ' of ' + urns.length);

  for (let i = 0; i < Math.min(urns.length, MAX_POSTS); i++) await probePost(urns[i], i + 1);
  console.log('');
  console.log('Done. Paste the whole log back.');
}

main().catch(err => { console.error(err); process.exit(1); });
