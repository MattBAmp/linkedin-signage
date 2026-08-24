/**
 * Ampcontrol LinkedIn signage — feed indexer
 *
 * Reads the rss.app feed, pulls the LinkedIn permalink out of each item,
 * converts it to a post URN, checks the post is actually embeddable, and
 * writes posts.json at the repo root.
 *
 * The feed URL comes from the FEED_URL repository secret.
 */

import { writeFile, readFile } from 'node:fs/promises';

const FEED_URL  = process.env.FEED_URL;
const MAX_POSTS = 12;     // a few spare, so unembeddable ones can be dropped
const OUT       = 'posts.json';

const TYPES = { activity: 'activity', share: 'share', ugcpost: 'ugcPost' };
const UA = 'Mozilla/5.0 (compatible; ampcontrol-signage/1.0)';

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

/**
 * Ask LinkedIn for the embed and see whether it actually renders.
 * Returns true / false / null, where null means "couldn't tell".
 * Never returns false on a network problem — better to show a post that
 * might be broken than to silently empty the screens.
 */
async function embeddable(urn) {
  try {
    const res = await fetch('https://www.linkedin.com/embed/feed/update/' + urn, {
      headers: { 'user-agent': UA, accept: 'text/html' },
      redirect: 'follow'
    });

    if (res.status === 404 || res.status === 410) return false;
    if (!res.ok) return null;

    const html = await res.text();

    // Bounced to a login or checkpoint page — tells us nothing about the post
    if (/authwall|checkpoint\/challenge|<title>[^<]*Sign Up[^<]*<\/title>/i.test(html)) {
      return null;
    }

    if (/(post|content|page)\s+(is\s+)?(not\s+available|unavailable|no longer available)|couldn.t find this|isn.t available/i.test(html)) {
      return false;
    }

    return true;
  } catch {
    return null;
  }
}

async function previous() {
  try {
    return JSON.parse(await readFile(OUT, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  if (!FEED_URL) {
    console.error('FEED_URL is not set. Add it as a repository secret.');
    process.exit(1);
  }

  const res = await fetch(FEED_URL, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error('Feed responded ' + res.status);

  const xml   = await res.text();
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  const seen  = new Set();
  const found = [];

  for (const item of items) {
    const urn = toUrn(pick(item, 'link')) || toUrn(pick(item, 'guid'));
    if (!urn || seen.has(urn)) continue;

    seen.add(urn);
    found.push({
      urn,
      title: pick(item, 'title').slice(0, 180),
      date:  pick(item, 'pubDate')
    });

    if (found.length >= MAX_POSTS) break;
  }

  console.log('Found ' + found.length + ' posts in the feed.');

  const verdicts = await Promise.all(found.map(p => embeddable(p.urn)));

  const rejected = [];
  const kept = found.filter((p, i) => {
    if (verdicts[i] === false) { rejected.push(p.urn); return false; }
    return true;
  });

  let posts = kept;

  // Safety net: if the check threw out most of the feed, it's far more likely
  // that LinkedIn changed its error page than that every post broke at once.
  if (found.length >= 4 && kept.length < found.length / 2) {
    console.warn('Embed check rejected ' + rejected.length + ' of ' + found.length +
                 ' posts — that looks wrong, so ignoring the check this run.');
    posts = found;
  } else if (rejected.length) {
    console.log('Dropped ' + rejected.length + ' post(s) that will not embed: ' +
                rejected.join(', '));
  }

  if (!posts.length) {
    const old = await previous();
    if (old && old.posts && old.posts.length) {
      console.log('Nothing usable this run — keeping the previous list.');
      return;
    }
    console.warn('No usable LinkedIn posts found. Check FEED_URL.');
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
