# Ampcontrol LinkedIn signage

A signage page that rotates through recent Ampcontrol LinkedIn posts.

It no longer embeds LinkedIn's own post component. Instead the build step
extracts each post's copy and media URLs, and the page renders its own cards.
That was the only way to stop LinkedIn's embed cropping carousel slides and
photos to fit its fixed media band.

**Nothing is cropped.** Every image, carousel slide and video is letterboxed
whole into an identical media area, so all three cards are the same height
regardless of what's in them.

## How it works

1. `.github/workflows/refresh-feed.yml` runs twice an hour, on every push to
   `main`, and on demand from the Actions tab.
2. It runs `scripts/build-feed.mjs`, which:
   - reads the rss.app feed and converts each permalink to a post URN
   - fetches LinkedIn's embed page for each post
   - pulls out the post copy and the real media URLs
   - drops posts whose embed has gone
   - writes `posts.json`
3. The workflow packages `index.html` + `posts.json` and deploys to Pages.
4. The page polls `posts.json` every 15 minutes and rebuilds only when the
   list of posts has actually changed.

## What gets extracted per post type

Each card carries the LinkedIn header (logo, name, follower count, post age)
above the copy, and the reaction icons, reaction count and comment count below
the media — the same information the native embed showed, redrawn in Ampcontrol's
own layout. Counts are read at build time, so they lag by up to one refresh.

| Post type | What the card shows |
|---|---|
| Image | The image whole, at the largest size LinkedIn offers. Posts with several images page through them. |
| Video | Plays the video muted on a loop, highest quality the browser accepts (720p / 640p / 360p). Falls back to the poster frame if playback is refused. |
| Document carousel | The slides LinkedIn releases, cross-fading, with page dots. |
| Post LinkedIn won't serve | Dropped. A 404 from the embed means the post is gone; it is no longer published as an empty card. |
| Text only | The copy at a larger size, filling the card |

If a piece of media won't load, that card silently becomes a copy-only card
rather than showing an empty grey box.

## Setup

- Repository secret `FEED_URL` = the rss.app **feed** URL
  (`https://rss.app/feeds/XXXXXXXX.xml`), not the widget embed ID.
- Settings → Pages → **Source: GitHub Actions**. Not "Deploy from a branch".
- Actions tab → enable workflows.
- Run it once by hand: Actions → Refresh LinkedIn feed → Run workflow.
- Check the run log. It ends with a line like
  `Wrote 9 posts (4 image, 2 video, 2 document, 1 text)`. If everything says
  `text`, the extraction has broken — see below.

The page lands at `https://<owner>.github.io/<repo>/`. Add that to Fusion
Signage as a website media item.

## A limit on carousels

LinkedIn's embed hands over **only the first three slides** of a document, no
matter how long it is, and each slide URL is individually signed — so slides
four and beyond cannot be constructed or fetched. The config does carry the
real length, so a six-page document is labelled `3 of 6 slides` rather than
pretending three is the whole thing. The master manifest that would contain
every page returns a Cloudflare error from LinkedIn's own servers.

If showing complete carousels matters more than layout control, the fallback is
to post them as multi-image posts rather than documents — every image comes
through in that format.

## How many posts

`MAX_POSTS` in `scripts/build-feed.mjs` is 15. The feed can only give what
rss.app publishes, so if the build log says `Found 12 posts in the feed` the
limit is rss.app's item count, not this setting — raise it in your rss.app
feed settings.

## Tuning

Everything adjustable is in the `CONFIG` block at the top of `index.html`.

| Setting | What it does |
|---|---|
| `postsPerScreen` | How many posts share a screen, 1–4. |
| `layout` | `columns` side by side, `rows` stacked, `auto` by screen shape. |
| `secondsPerScreen` | How long each screenful holds. |
| `slideSeconds` | How long each carousel slide holds before the next. |
| `playVideo` | `false` shows the poster frame instead of playing. |
| `maxCopyLines` | Lines of post copy shown above the media. |
| `refreshMinutes` | How often the page re-reads `posts.json`. |

## Checking it on the screen

Plug a keyboard in, or open the page on a laptop:

- **D** — shows which media loaded and which was refused, per post. This is the
  first thing to check on a new screen.
- **Arrow keys** — step between screenfuls.
- **Space** — pause.

The D overlay matters because LinkedIn's document cover images returned errors
when fetched from GitHub's servers. They may or may not load from your office
network. If the overlay says `slides blocked`, carousels will show as copy-only
cards and there is nothing to be done from our side — that's LinkedIn refusing
the request, not a bug here.

## Watch out

**Scheduled workflows auto-disable after 60 days of repository inactivity,**
and Actions-bot commits don't reset the timer. It stops refreshing silently.
Either push a trivial commit every six weeks or add
`gautamkrishnar/keepalive-workflow`.

**This depends on LinkedIn's internal markup.** The build reads media URLs out
of LinkedIn's embed HTML. When LinkedIn changes that markup — not if, when —
extraction breaks and every post starts coming through as text-only. The
symptom is that run-log summary line showing everything as `text`. The fix is
re-reading the embed HTML and updating the patterns in `extractMedia()`.

**Failures are safe.** If the feed fetch fails or nothing usable comes back,
the previous `posts.json` is left alone and the screens keep showing the last
good set.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Everything shows as copy-only | Extraction broke. Check the run log summary line. |
| Carousels are copy-only, images fine | LinkedIn refusing the document cover images from your network. Press D to confirm. |
| Video shows a still, doesn't play | Browser refused all three renditions. Poster fallback is working as designed. |
| "Can't reach the feed" | `CONFIG.feedApi` should be `./posts.json`. |
| Page not updating | Hard-refresh (Ctrl+Shift+R); Pages takes a minute to redeploy. |
| Copy is cut short | Raise `maxCopyLines`. |
