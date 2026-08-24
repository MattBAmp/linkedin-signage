# Ampcontrol LinkedIn signage

A portrait signage page that rotates through recent Ampcontrol LinkedIn posts,
rendered by LinkedIn's own embed so carousels and video come across properly.

## How it works

1. `.github/workflows/refresh-feed.yml` runs twice an hour.
2. It calls `scripts/build-feed.mjs`, which reads the rss.app feed, extracts
   each post's permalink, converts it to a LinkedIn post URN, and writes
   `posts.json`.
3. GitHub Pages serves `index.html` and `posts.json` together.
4. The page polls `posts.json` every 15 minutes and rebuilds the rotation
   whenever the list changes.

Nobody touches anything after setup.

## Setup

- Repo must be **public** (GitHub Pages needs Pro for private repos).
- Add a repository secret named `FEED_URL` containing the rss.app feed URL
  (Settings → Secrets and variables → Actions → New repository secret).
- Enable Pages: Settings → Pages → Source: Deploy from a branch → `main` → `/`.
- Enable Actions: the Actions tab → enable workflows.
- Run the workflow once by hand (Actions → Refresh LinkedIn feed → Run workflow).

## Watch out

Scheduled workflows are disabled automatically after 60 days of repository
inactivity. Bot commits are widely reported not to reset that timer, so either
push a manual commit every couple of months or add a keepalive action.

## Tuning

Everything adjustable lives in the `CONFIG` block at the top of `index.html`.
`embedHeight` is the one worth revisiting once you've seen a week of real posts.
