/**
 * Ampcontrol LinkedIn signage — feed indexer v2
 *
 * Reads the rss.app feed, extracts each post's URN, then fetches LinkedIn's
 * embed page for every post to pull out the real media URLs and post copy.
 *
 * Writes an enriched posts.json that the signage page renders directly —
 * no LinkedIn iframes, full control over layout.
 *
 * Post types and what gets extracted:
 *   image    -> image-shrink_1280 URL
 *   video    -> videocover-high poster + mp4 sources (360/640/720p)
 *   document -> coverPages array (all slides at 480px) + page count
 *   text     -> og:description only
 */

import { writeFile, readFile } from 'node:fs/promises';

const FEED_URL  = process.env.FEED_URL;
const MAX_POSTS = Number(process.env.MAX_POSTS || 15);   // usable posts wanted
const SCAN_EXTRA = 8;   // spare candidates, because 404s are dropped later
const OUT       = 'posts.json';

const TYPES = { activity: 'activity', share: 'share', ugcpost: 'ugcPost' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ── feed parsing (unchanged) ── */

export function toUrn(input) {
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
    .replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
    .replace(/&amp;/g, '&').trim();
}

function pick(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? unwrap(m[1]) : '';
}

/* ── HTML entity decoding ── */

export function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/* ── extract media from embed page ── */

function ogMeta(html, prop) {
  const m = html.match(
    new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']*)', 'i')
  );
  return m ? decode(m[1]) : null;
}

/** Strip HTML tags, collapse whitespace, trim. */
export function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function extractMedia(html) {
  const out = { type: 'text', image: null, video: null, poster: null, pages: null,
                pageCount: 0, totalPages: 0, docTitle: null };

  // Image posts. LinkedIn serves several size tokens depending on the source
  // file — image-shrink_1280, image-shrink_800, feedshare-shrink_2048 and so
  // on. Matching only one of them silently turned those posts into text-only
  // cards, so collect every candidate and keep the largest.
  const imgCandidates = (html.match(
    /https:\/\/media\.licdn\.com\/dms\/image\/[^"'\\\s<>)]+/gi
  ) || [])
    .map(decode)
    .filter(u => /(?:image|feedshare)-(?:shrink|scale)_/i.test(u))
    .filter(u => !/company-logo|videocover|document-cover|profile-displayphoto/i.test(u));

  if (imgCandidates.length) {
    // A post can carry several images, and LinkedIn may offer the same image
    // at several sizes. Group by asset so multi-image posts keep every photo,
    // then within each asset take the largest variant on offer.
    const px = u => {
      const m = u.match(/_(\d+)(?:x(\d+))?/);
      return m ? Math.max(Number(m[1] || 0), Number(m[2] || 0)) : 0;
    };
    const byAsset = new Map();
    for (const u of imgCandidates) {
      const id = (u.match(/\/dms\/image\/v2\/([^/]+)\//) || [, u])[1];
      const best = byAsset.get(id);
      if (!best || px(u) > px(best)) byAsset.set(id, u);
    }
    const ordered = [...byAsset.values()];

    out.type = 'image';
    out.image = ordered[0];
    if (ordered.length > 1) {
      out.pages = ordered;
      out.pageCount = ordered.length;
    }
    return out;
  }

  // Video posts: data-sources JSON array + videocover-high
  const videoSrc = html.match(
    /https:\/\/(?:dms|media)\.licdn\.com\/[^"'\\\s<>)]*(?:playlist\/vid|mp4-\d+p)[^"'\\\s<>)]+/i
  );
  const posterSrc = html.match(
    /https:\/\/media\.licdn\.com\/dms\/image\/[^"'\\\s<>)]*videocover-high[^"'\\\s<>)]+/i
  );
  if (videoSrc || posterSrc) {
    out.type = 'video';
    out.poster = posterSrc ? decode(posterSrc[0]) : null;

    // Extract all video renditions from data-sources
    const dsMatch = html.match(/data-sources="([^"]+)"/i);
    if (dsMatch) {
      try {
        const sources = JSON.parse(decode(dsMatch[1]));
        // Pick highest bitrate
        sources.sort((a, b) => (b['data-bitrate'] || 0) - (a['data-bitrate'] || 0));
        out.video = sources.map(s => ({ src: s.src, type: s.type || 'video/mp4' }));
      } catch { /* fall through to single URL */ }
    }
    if (!out.video && videoSrc) {
      out.video = [{ src: decode(videoSrc[0]), type: 'video/mp4' }];
    }
    return out;
  }

  // Document posts: coverPages array in data-native-document-config
  const docConfig = html.match(/data-native-document-config="([^"]+)"/i);
  if (docConfig) {
    out.type = 'document';
    try {
      const config = JSON.parse(decode(docConfig[1]));
      const doc = config.doc || {};

      if (doc.coverPages) {
        out.pages = doc.coverPages
          .filter(p => p.type === 'image' && p.config && p.config.src)
          .map(p => p.config.src);
        out.pageCount = out.pages.length;
        out.image = out.pages[0] || null;
      }

      // LinkedIn caps coverPages at three no matter how long the document is,
      // and each page URL is individually signed, so pages beyond the third
      // cannot be constructed. It does tell us the real total, so the card can
      // at least label itself honestly.
      if (typeof doc.totalPageCount === 'number' && doc.totalPageCount > 0) {
        out.totalPages = doc.totalPageCount;
      } else {
        const sub = String(doc.subtitle || '').match(/(\d+)\s*pages?/i);
        if (sub) out.totalPages = Number(sub[1]);
      }
      if (doc.title) out.docTitle = String(doc.title).slice(0, 120);
    } catch (e) {
      console.log('  doc config parse failed: ' + e.message);
    }
    // Fallback: grab cover image from raw HTML
    if (!out.image) {
      const coverMatch = html.match(
        /https:\/\/media\.licdn\.com\/dms\/image\/[^"'\\\s<>)]*document-cover[^"'\\\s<>)]+/i
      );
      if (coverMatch) out.image = decode(coverMatch[0]);
    }
    return out;
  }

  return out;
}

/* ── author header and social counts ──
   All lifted from attributes LinkedIn puts on the embed, not from class
   names, so this survives their styling churn better than it otherwise would.
   Reaction icons appear once per reaction type actually present on the post. */

export function extractMeta(html) {
  const meta = {};

  // "Ampcontrol", from the actor link
  const name = html.match(/feed-actor-name[^>]*>\s*([^<]+?)\s*</i);
  if (name) meta.author = decode(name[1]).trim();

  // "22,508 followers"
  const foll = html.match(/([\d,]+)\s+followers?/i);
  if (foll) meta.followers = foll[1];

  // the small circular company logo
  const av = html.match(
    /https:\/\/media\.licdn\.com\/dms\/image\/[^"'\\\s<>)]*company-logo[^"'\\\s<>)]+/i
  );
  if (av) meta.avatar = decode(av[0]);

  // LinkedIn's own relative age: "58m", "3d", "2w"
  const t = html.match(/<time[^>]*>\s*([^<\s]+)\s*/i);
  if (t) meta.age = decode(t[1]).trim();

  // counts
  const nr = html.match(/data-num-reactions="(\d+)"/i);
  if (nr) meta.reactions = Number(nr[1]);
  const nc = html.match(/data-num-comments="(\d+)"/i);
  if (nc) meta.comments = Number(nc[1]);

  // which reaction types are on the post, in the order LinkedIn shows them
  const types = [];
  const re = /data-reaction-type="([A-Z_]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    const t2 = m[1].toUpperCase();
    if (!types.includes(t2)) types.push(t2);
  }
  if (types.length) meta.reactionTypes = types.slice(0, 3);

  return meta;
}

/* ── enrich each post by fetching its embed page ── */

async function enrich(post) {
  try {
    const res = await fetch('https://www.linkedin.com/embed/feed/update/' + post.urn, {
      headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-AU,en;q=0.9' },
      redirect: 'follow'
    });
    if (!res.ok) {
      // A 404 here means LinkedIn will not serve the post at all. Previously
      // this returned the post alive, so it reached the screens as an empty
      // copy-only card. Drop it.
      console.log('  ' + post.urn + ': embed returned ' + res.status + ' — dropping');
      post._dead = true;
      return post;
    }
    const html = await res.text();

    // Dead post check
    const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || ['', ''])[1]).trim();
    if (/this (post|content) (is|isn.t|is no longer)/i.test(title) ||
        res.status === 404 || res.status === 410) {
      console.log('  ' + post.urn + ': dead post');
      post._dead = true;
      return post;
    }

    // Copy: the RSS description carries the full post text and is reliable.
    // og:description is sometimes near-empty (one post returned 2 chars), so
    // it is only a fallback for when the feed gave us nothing.
    const desc = ogMeta(html, 'og:description') || '';
    if (!post.copy || post.copy.length < 20) {
      if (desc.length > post.copy.length) post.copy = desc;
    }

    // Post title from page title (strip " | LinkedIn" suffix)
    const pageTitle = ogMeta(html, 'og:title') || title;
    if (pageTitle) post.title = pageTitle.replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();

    // Author header and social counts
    Object.assign(post, extractMeta(html));

    // Media
    const media = extractMedia(html);
    post.mediaType = media.type;
    if (media.image)     post.image     = media.image;
    if (media.poster)    post.poster    = media.poster;
    if (media.video)     post.video     = media.video;
    if (media.pages)      post.pages      = media.pages;
    if (media.pageCount)  post.pageCount  = media.pageCount;
    if (media.totalPages) post.totalPages = media.totalPages;
    if (media.docTitle)   post.docTitle   = media.docTitle;

    console.log('  ' + post.urn + ': ' + media.type +
      (media.image ? ' img' : '') +
      (media.video ? ' vid×' + media.video.length : '') +
      (media.pages ? ' pages×' + media.pages.length +
        (media.totalPages > media.pages.length ? ' of ' + media.totalPages : '') : '') +
      '  ' + (post.reactions != null ? post.reactions + ' reactions' : 'no reaction count') +
      (post.comments ? ', ' + post.comments + ' comments' : ''));

  } catch (err) {
    console.log('  ' + post.urn + ': enrich failed — ' + err.message);
  }
  return post;
}

/* ── main ── */

async function previous() {
  try { return JSON.parse(await readFile(OUT, 'utf8')); }
  catch { return null; }
}

export async function main() {
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

    // Get copy from RSS description (HTML with links)
    const descHtml = pick(item, 'description');

    found.push({
      urn,
      title: pick(item, 'title').slice(0, 180) || '',
      date:  pick(item, 'pubDate'),
      copy:  stripHtml(descHtml).slice(0, 600) || '',
      mediaType: 'text'
    });

    if (found.length >= MAX_POSTS + SCAN_EXTRA) break;
  }

  console.log('Found ' + found.length + ' posts in the feed.');

  // Enrich until we have MAX_POSTS that actually work. Posts LinkedIn refuses
  // are dropped, so asking for exactly MAX_POSTS candidates would leave us
  // short by however many 404'd — which is how a 15-post wall became 13.
  console.log('Enriching posts from embed pages (want ' + MAX_POSTS + ' usable)...');
  const posts = [];
  let attempted = 0, deadCount = 0;

  for (const post of found) {
    if (posts.length >= MAX_POSTS) break;
    attempted++;
    const done = await enrich(post);
    if (done._dead) { deadCount++; continue; }
    delete done._dead;
    posts.push(done);
  }

  console.log('Checked ' + attempted + ' of ' + found.length + ' candidates, ' +
              'dropped ' + deadCount + ', kept ' + posts.length + '.');
  if (posts.length < MAX_POSTS) {
    console.log('Only ' + posts.length + ' usable posts available — the feed ' +
                'does not carry enough. Raise the item count in rss.app if you ' +
                'want more.');
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

  console.log('Wrote ' + posts.length + ' posts (' +
    posts.filter(p => p.mediaType === 'image').length + ' image, ' +
    posts.filter(p => p.mediaType === 'video').length + ' video, ' +
    posts.filter(p => p.mediaType === 'document').length + ' document, ' +
    posts.filter(p => p.mediaType === 'text').length + ' text).');
}

const isDirect = process.argv[1] && import.meta.url.endsWith(
  process.argv[1].replace(/^.*[\\/]/, '')
);
if (isDirect) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
