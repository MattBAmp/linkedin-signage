/**
 * Ampcontrol LinkedIn signage — extraction probe
 *
 * Throwaway diagnostic. Answers one question: from a GitHub Actions runner,
 * can we get a carousel post's image and copy out of LinkedIn's own pages?
 *
 * It does not write anything or touch posts.json. It fetches, inspects, and
 * prints a report to the Actions log. Run it, paste the log back.
 *
 * Usage (via the workflow):
 *   Actions -> Probe LinkedIn extraction -> Run workflow
 *   Optionally pass a URN; defaults to the YAKKA carousel post.
 */

const URN = (process.env.PROBE_URN || 'urn:li:activity:7496053505011589121').trim();

// Two user agents, because LinkedIn serves different pages to bots and browsers.
const AGENTS = {
  bot: 'Mozilla/5.0 (compatible; ampcontrol-signage/1.0)',
  browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'
};

const TARGETS = [
  { label: 'embed page',  url: 'https://www.linkedin.com/embed/feed/update/' + URN },
  { label: 'public post', url: 'https://www.linkedin.com/feed/update/' + URN + '/' }
];

function meta(html, prop) {
  const patterns = [
    new RegExp('<meta[^>]+property=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)', 'i'),
    new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']' + prop + '["\']', 'i'),
    new RegExp('<meta[^>]+name=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)', 'i')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function uniq(arr) { return Array.from(new Set(arr)); }

function report(label, agent, res, html) {
  const line = (k, v) => console.log('    ' + k.padEnd(22) + (v === null || v === undefined ? '—' : v));

  console.log('');
  console.log('  ' + label + '  [' + agent + ' UA]');
  line('status', res.status + ' ' + res.statusText);
  line('content-type', res.headers.get('content-type'));
  line('bytes', html.length.toLocaleString());

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();
  line('<title>', title.slice(0, 90) || null);

  // Did we get bounced?
  const walled = /authwall|checkpoint\/challenge|session_redirect|Join LinkedIn|Sign in to view/i.test(html);
  line('authwalled?', walled ? 'YES — this route is a dead end' : 'no');

  // The metadata we would actually build cards from
  line('og:image', meta(html, 'og:image'));
  line('og:title', (meta(html, 'og:title') || '').slice(0, 70) || null);
  line('og:description', (meta(html, 'og:description') || '').slice(0, 70) || null);
  line('og:video', meta(html, 'og:video') || meta(html, 'og:video:url'));

  // Every LinkedIn-hosted media URL on the page
  const media = uniq(html.match(/https:\/\/media[^"'\\\s)]*licdn\.com\/[^"'\\\s)]+/gi) || []);
  line('licdn media URLs', media.length);
  media.slice(0, 6).forEach((u, i) => console.log('      [' + (i + 1) + '] ' + u.slice(0, 150)));
  if (media.length > 6) console.log('      … and ' + (media.length - 6) + ' more');

  // Document-post specific hooks. If any of these appear, carousel tiles are
  // individually addressable and this becomes straightforward.
  const hooks = [
    'transcribedDocumentUrl', 'documentUrl', 'manifestUrl', 'coverPages',
    'data-document-url', 'data-sources', 'nativeDocument', 'DocumentComponent'
  ].filter(h => html.includes(h));
  line('document hooks', hooks.length ? hooks.join(', ') : null);

  // Is the post copy present in the HTML at all?
  const hasCopy = /YAKKA|Immersion Day|attributedDescriptionText|commentary/i.test(html);
  line('post copy present?', hasCopy ? 'yes' : 'no');

  // Embedded JSON payloads are where the useful structure usually hides
  const codeBlocks = (html.match(/<code[^>]*>/gi) || []).length;
  line('<code> JSON blocks', codeBlocks || null);

  const verdict =
    walled                                  ? 'BLOCKED' :
    (media.length && (hooks.length || meta(html, 'og:image'))) ? 'VIABLE' :
    media.length                            ? 'PARTIAL — media present, no clean handle' :
                                              'NOTHING USABLE';
  line('>> verdict', verdict);
}

async function main() {
  console.log('Probing ' + URN);
  console.log('Runner IP is what matters here, not your browser.');

  for (const t of TARGETS) {
    for (const [agent, ua] of Object.entries(AGENTS)) {
      try {
        const res = await fetch(t.url, {
          headers: {
            'user-agent': ua,
            accept: 'text/html,application/xhtml+xml',
            'accept-language': 'en-AU,en;q=0.9'
          },
          redirect: 'follow'
        });
        const html = await res.text();
        report(t.label, agent, res, html);
      } catch (err) {
        console.log('');
        console.log('  ' + t.label + '  [' + agent + ' UA]');
        console.log('    fetch failed: ' + err.message);
      }
    }
  }

  console.log('');
  console.log('Done. Paste this whole log back.');
}

main().catch(err => { console.error(err); process.exit(1); });
