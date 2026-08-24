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
const MAX_POSTS = 12;
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
  const out = { type: 'text', image: null, video: null, poster: null, pages: null, pageCount: 0 };

  // Image posts: image-shrink_1280 in raw HTML
  const imgMatch = html.match(
    /https:\/\/media\.licdn\.com\/dms\/image\/[^"'\\\s<>)]*image-shrink_1280[^"'\\\s<>)]+/i
  );
  if (imgMatch) {
    out.type = 'image';
    out.image = decode(imgMatch[0]);
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
      if (config.doc && config.doc.coverPages) {
        out.pages = config.doc.coverPages
          .filter(p => p.type === 'image' && p.config && p.config.src)
          .map(p => p.config.src);
        out.pageCount = out.pages.length;
        out.image = out.pages[0] || null;
      }
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

/* ── enrich each post by fetching its embed page ── */

async function enrich(post) {
  try {
    const res = await fetch('https://www.linkedin.com/embed/feed/update/' + post.urn, {
      headers: { 'user-agent': UA, accept: 'text/html', 'accept-language': 'en-AU,en;q=0.9' },
      redirect: 'follow'
    });
    if (!res.ok) {
      console.log('  ' + post.urn + ': embed returned ' + res.status);
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

    // Media
    const media = extractMedia(html);
    post.mediaType = media.type;
    if (media.image)     post.image     = media.image;
    if (media.poster)    post.poster    = media.poster;
    if (media.video)     post.video     = media.video;
    if (media.pages)     post.pages     = media.pages;
    if (media.pageCount) post.pageCount = media.pageCount;

    console.log('  ' + post.urn + ': ' + media.type +
      (media.image ? ' img' : '') +
      (media.video ? ' vid×' + media.video.length : '') +
      (media.pages ? ' pages×' + media.pages.length : ''));

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

    if (found.length >= MAX_POSTS) break;
  }

  console.log('Found ' + found.length + ' posts in the feed.');

  // Enrich each post with media from the embed page
  console.log('Enriching posts from embed pages...');
  const enriched = [];
  for (const post of found) {
    enriched.push(await enrich(post));
  }

  // Drop dead posts
  const posts = enriched.filter(p => !p._dead);
  const deadCount = enriched.length - posts.length;
  if (deadCount) console.log('Dropped ' + deadCount + ' dead post(s).');

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
