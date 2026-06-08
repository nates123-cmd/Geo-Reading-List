# Geo's Reading List

A glossy web library of every book Geo has read, built automatically from his
OneDrive Excel sheet. Covers, publish years, and summaries come from
[OpenLibrary](https://openlibrary.org); favorites and themes are derived from his
own notes.

**Live site:** _(GitHub Pages URL — added on deploy)_

## How it stays up to date

A scheduled GitHub Action (`.github/workflows/update.yml`, daily) does:

1. **Pull** the latest `.xlsx` from the OneDrive share link (anonymous, no login —
   see `scripts/fetch-onedrive.sh`). The link is stored in the repo variable
   `GEO_SHEET_URL`.
2. **Enrich** only *new* books via OpenLibrary (`build.mjs` is resumable — existing
   books are cached in `data/books.json`).
3. **Commit** the refreshed `data/books.json`, which redeploys GitHub Pages.

So Geo just edits the Excel in OneDrive; the site catches up within a day.

## Fixing a wrong match ("Wrong book!")

OpenLibrary sometimes returns the wrong edition. Books it couldn't confirm by
author are flagged `unverified`.

1. Open the site with `?edit=1` (e.g. `…github.io/Geo-Reading-List/?edit=1`).
   A maintainer bar appears with an **unverified** count and **Show unverified**.
2. Open a book → **✎ Wrong book?** → pick the correct edition from the live
   OpenLibrary results (or retype the search).
3. Click **⬇ Export corrections** → save the downloaded `overrides.json` to
   `data/overrides.json` in the repo and commit it.

`build.mjs` reads `data/overrides.json` and pins those editions on every rebuild.
Grandpa (without `?edit=1`) never sees any of this.

## Run it locally

```bash
npm install
GEO_SHEET_URL='https://1drv.ms/x/...' npm run fetch   # download latest xlsx
npm run build                                          # enrich -> data/books.json
npm run serve                                          # preview at localhost:8731
FORCE=1 npm run build                                  # re-enrich everything from scratch
```
