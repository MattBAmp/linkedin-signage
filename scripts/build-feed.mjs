/**
 * Ampcontrol LinkedIn signage — feed indexer
 *
 * Reads the rss.app feed, pulls the LinkedIn permalink out of each item,
 * converts it to a post URN, and writes posts.json at the repo root.
 * Run by .github/workflows/refresh-feed.yml on a schedule.
 *
 * The feed URL comes from the FEED_URL repository secret, so it stays out
 * of the public repo.
 */

import { writeFile, readFile } from 'node:fs/promises';

const FEED_URL  = process.env.FEED_URL;
const MAX_POSTS = 8;
const OUT       = 'posts.json';

const TYPES = { activity: 'activity', share: 'share', ugcpost: 'ugcPost' };

function toUrn(input) {
  const s = String(input || '').trim();
  let m;

  m = s.match(/urn:li:(activity|share|ugcPost):(\d+)/i);
  if (m) return 'urn:li:' + TYPES[m[1].toLowerCase()] + ':' + m[2];

  m = s.match(/-(activity|share|ugcPost)-(\d+)/i);
  if (m) return 'urn:li:' + TYPES[m[1].toLowerCase()] + ':' + m[2];

  return null;
}

function unwrap(str) {
  return String(str || '')
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .replace(/&amp;/g, '&')
    .trim();
}

function pick(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? unwrap(m[1]) : '';
}

async function main() {
  if (!FEED_URL) {
    console.error('FEED_URL is not set. Add it as a repository secret.');
    process.exit(1);
  }

  const res = await fetch(FEED_URL, {
    headers: { 'user-agent': 'ampcontrol-signage/1.0' }
  });

  if (!res.ok) throw new Error('Feed responded ' + res.status);

  const xml   = await res.text();
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  const seen  = new Set();
  const posts = [];

  for (const item of items) {
    // the permalink can sit in <link> or <guid> depending on the feed
    const urn = toUrn(pick(item, 'link')) || toUrn(pick(item, 'guid'));
    if (!urn || seen.has(urn)) continue;

    seen.add(urn);
    posts.push({
      urn,
      title: pick(item, 'title').slice(0, 180),
      date:  pick(item, 'pubDate')
    });

    if (posts.length >= MAX_POSTS) break;
  }

  // Never blank the screens over a bad fetch — if this run found nothing
  // but a previous run did, keep the old file.
  if (!posts.length) {
    let existing = null;
    try {
      existing = JSON.parse(await readFile(OUT, 'utf8'));
    } catch { /* no previous file */ }

    if (existing && existing.posts && existing.posts.length) {
      console.log('No posts found this run — keeping the previous list.');
      return;
    }
    console.warn('No LinkedIn posts found in the feed. Check FEED_URL.');
  }

  await writeFile(
    OUT,
    JSON.stringify({ ok: true, updated: new Date().toISOString(), posts }, null, 2) + '\n'
  );

  console.log('Wrote ' + posts.length + ' posts.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
