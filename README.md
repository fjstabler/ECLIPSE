<div align="center">

# ECLIPSE

**A private streaming service for your home network.**

Drop films and series into a folder. ECLIPSE finds them, fetches the artwork and
synopses, and serves them to every browser in the house — with N.O.V.A., a curator
that learns what each person actually likes.

</div>

---

## What this is

A replacement for Jellyfin that looks and feels like the streaming services you
actually use, and knows your taste.

- **Watched folders.** Point ECLIPSE at a directory. New files appear in the
  library within seconds, no manual scan needed.
- **Automatic metadata.** Posters, backdrops, synopses, cast, crew, certificates
  and episode titles, pulled from TMDB and cached locally.
- **A real streaming interface.** Hero banner, horizontal shelves, hover states,
  a proper player with resume, next-episode and keyboard control.
- **N.O.V.A.** A recommendation engine that scores your whole library against your
  taste, plus a conversational layer that can take "something short and funny,
  I've got ninety minutes" and give you a real answer.
- **Per-person profiles.** Everyone gets their own history, watchlist and taste
  profile, so N.O.V.A. recommends to *them*, not to the household average.

Version 1 runs in the browser. It's built to be judged and edited — no build
step, no bundler, no framework. Change a colour in the CSS and refresh.

---

## Getting started

You need [Node.js](https://nodejs.org) 20 or newer. Then, in a terminal:

```bash
git clone https://github.com/fjstabler/ECLIPSE.git
cd ECLIPSE
npm install
npm run setup
npm start
```

`npm run setup` asks where your films and series live and whether you want the
two optional API keys, then writes the `.env` file for you. That file doesn't
exist until you run it — it holds private keys, so it's deliberately kept out of
the repository.

Open the address it prints. The first profile you create is the administrator.

Re-run `npm run setup` any time to add a key or change a folder; your existing
answers become the defaults, so pressing Enter through it changes nothing.

**Want to see the interface before pointing it at real media?**

```bash
npm run demo              # seeds 12 films and 6 series
npm run demo -- --clear   # removes them again
```

Demo titles are for judging the interface — the files are placeholders and
won't play.

---

## How your files should be named

ECLIPSE reads the same naming conventions Jellyfin and Plex do, including messy
scene releases. Any of these work:

```
Films/
  The Matrix (1999).mkv
  The Matrix (1999)/The Matrix (1999) 2160p UHD BluRay x265-GRP.mkv
  Blade.Runner.2049.2017.1080p.BluRay.x264-AMIABLE.mkv
  Dune Part Two 2024 2160p WEB-DL DDP5.1 Atmos HDR H.265-FLUX.mkv

Series/
  Breaking Bad/Season 01/Breaking Bad - S01E01 - Pilot.mkv
  Severance/Season 2/Severance.S02E03.Who.Is.Alive.1080p.ATVP.WEB-DL.mkv
  The Office/Season 03/The Office - 3x05 - Initiation.avi
  Doctor Who/Specials/Doctor Who - S00E01 - The Star Beast.mkv
  Firefly/Firefly.S01E01E02.Serenity.mkv
```

Quality tags, codecs, release groups and language markers are stripped
automatically. A year in the title is handled correctly — *Blade Runner 2049*,
*1917* and *2012* all resolve to the right film.

Subtitles sitting next to a video are picked up too:
`Arrival (2016).en.srt`, `Arrival (2016).eng.forced.srt`.

---

## Playback

Browsers play `.mp4`, `.m4v` and `.webm` directly, with proper seeking via HTTP
range requests.

For `.mkv` and other containers the browser can't open, ECLIPSE remuxes on the
fly if **ffmpeg** is installed — copying the video stream where possible so it's
cheap enough to run on a NAS. If a direct play fails, the player falls back to
the converted stream by itself.

```bash
# Debian/Ubuntu
sudo apt install ffmpeg
# macOS
brew install ffmpeg
```

Without ffmpeg, `.mkv` files appear in the library but won't play. Set
`ECLIPSE_TRANSCODE=false` to disable conversion entirely.

**Multiple audio languages.** A file with more than one audio track — common
for `.mkv` releases — gets a language button in the player. For files the
browser plays directly, switching is instant, through the browser's own
audio track list. For everything remuxed through ffmpeg, switching restarts
the stream at the current position with the chosen track, the same way
seeking already works. Track languages come from whatever the file itself
is tagged with; a file scanned before this existed picks its tracks up on
the next `npm run scan -- --full`.

**Player keyboard shortcuts**

| Key | Action | Key | Action |
|---|---|---|---|
| `Space` / `K` | Play or pause | `F` | Fullscreen |
| `←` / `→` | Skip 10 seconds | `M` | Mute |
| `↑` / `↓` | Volume | `C` | Cycle subtitles |
| `A` | Cycle audio language | `Esc` | Close player |

Elsewhere: `/` opens search, `N` toggles N.O.V.A.

---

## Fire TV

There's a Fire Stick app — a thin native shell around this same interface,
with the remote's D-pad wired up to move between posters and buttons. Grab it
with the **Downloader** app; see [`firetv/README.md`](firetv/README.md) for
the full walkthrough. The direct download link, rebuilt automatically on
every push:

```
https://github.com/fjstabler/ECLIPSE/releases/download/firetv-latest/eclipse-firetv.apk
```

---

## N.O.V.A.

N.O.V.A. works in two layers, and the first one needs no API key at all.

### The engine (always on)

A content-based recommender that builds a weighted taste vector from three
signals — the profile you filled in, what you actually watched, and how you
rated it — then scores every unwatched title in your library against it.

It's deliberately content-based rather than collaborative: a home server has one
household on it, so there's nobody to collaborate with. What it does have is a
lot of signal about a few people, which is exactly what this approach needs.

Every recommendation comes with the reason it scored well:

> **Arrival** (2016) — *Because you like Science Fiction and Drama, directed by
> Denis Villeneuve.*

Thumbs up and down on any title feed straight back in. So does finishing
something, which counts for more than starting it.

### The conversation (needs an OpenAI API key)

Add `OPENAI_API_KEY` to `.env` and the N.O.V.A. panel becomes a conversation.
She reaches your library through a fixed set of tools — searching, scoring,
finding similar titles, reading your history — so **she can only ever recommend
things that are actually on your server**. She can't hallucinate a film you
don't own.

She also writes back. Tell her "I can't stand gore" and it goes into your taste
profile, and the next session starts from it.

```bash
OPENAI_API_KEY=sk-...
NOVA_MODEL=gpt-4o
```

Get a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
It lives in `.env` on your own machine and is never sent to the browser — only
the server talks to OpenAI. If the model you set isn't available to your
account, N.O.V.A. says so in the chat panel and lists the ones that are.

Because this uses the standard Chat Completions API, `OPENAI_BASE_URL` will
point her at any OpenAI-compatible endpoint instead — LM Studio, Ollama,
OpenRouter, or a model running on your own hardware.

Without a key, asking N.O.V.A. a question still returns real recommendations
from the engine — just without the back-and-forth.

---

## Metadata

A free [TMDB API key](https://www.themoviedb.org/settings/api) gets you posters,
backdrops, synopses, cast, crew and episode titles. Set `TMDB_API_KEY` in
`.env`.

Without it, ECLIPSE derives titles and years from filenames and generates its
own artwork — deterministic gradient posters, so the same film always looks the
same. Everything works; it just looks plainer.

Artwork is cached to disk, so the interface stays fast and keeps working if TMDB
is unreachable.

**Got the wrong match, or want to write your own?** An administrator can edit
any title by hand — open it and use the edit (pencil) button next to the
other actions. You can rewrite the title, year, synopsis, tagline,
certification, genres, poster and backdrop directly, or just point it at a
different TMDB id if the automatic match picked the wrong one. Either way,
it's marked so future scans leave it alone rather than quietly overwriting
what you typed — reverting is a matter of clearing the fields you changed
and re-matching against TMDB.

---

## Configuration

Run `npm run setup` to change any of this. It all lives in `.env`, which you can
also edit by hand — `.env.example` is the annotated reference. The ones
that matter:

| Variable | What it does |
|---|---|
| `ECLIPSE_MOVIES_DIR` | Folder(s) of films. Separate multiple with `:` |
| `ECLIPSE_SERIES_DIR` | Folder(s) of series |
| `TMDB_API_KEY` | Enables real artwork and metadata |
| `OPENAI_API_KEY` | Enables conversational N.O.V.A. |
| `PORT` | Default `8383` |
| `ECLIPSE_WATCH` | Watch folders for new files. Default `true` |
| `ECLIPSE_TRANSCODE` | Allow ffmpeg conversion. Default `true` |

---

## Commands

```bash
npm run setup             # create or update .env (folders and API keys)
npm start                 # run the server
npm run dev               # run with auto-restart on file changes
npm run scan              # scan the library by hand
npm run scan -- --full    # re-read every file, ignoring the cache
npm run demo              # seed a demo library
npm run demo -- --clear   # remove it
npm run reset             # wipe profiles, history and the scanned library
node scripts/selftest.js  # check the wiring, parser and engine
```

Testing N.O.V.A.'s conversation without spending anything on API calls:

```bash
node scripts/mock-openai.js &        # a stand-in OpenAI server
OPENAI_API_KEY=test OPENAI_BASE_URL=http://localhost:8399/v1 \
  NOVA_MODEL=mock-model node scripts/nova-probe.js "something short and funny"
```

`nova-probe.js` also works against a real key — drop the `OPENAI_BASE_URL` — and
prints the tools she called and the reply she streamed, which is the quickest
way to see whether a model behaves well before wiring it into the UI.

---

## How it's built

```
server/
  index.js          Express app and startup
  config.js         Environment configuration
  db.js  schema.sql SQLite, applied on boot
  auth.js           Profiles, scrypt passwords, session cookies
  library.js        The read model shared by the API and N.O.V.A.
  util/parse.js     Filename → title, year, season, episode
  scanner/          Library walk, ingestion, folder watching
  metadata/         TMDB client and artwork caching
  nova/
    engine.js       The recommendation engine
    tools.js        The tools N.O.V.A. can call
    openai.js       The conversational layer
  routes/           HTTP API
web/
  index.html        The whole client shell
  css/eclipse.css   The design system
  js/               ES modules, served straight from disk
  js/tvnav.js       Arrow-key spatial navigation, for keyboards and TV remotes
firetv/             Native Fire TV shell — see firetv/README.md
```

**No build step.** The client is plain ES modules and CSS. Edit and refresh.

**Design tokens** live at the top of `web/css/eclipse.css`. The palette is one
gradient — violet through magenta to amber, the corona of an eclipse — over
near-black surfaces. Change `--corona` and the whole app follows.

---

## Where this goes next

Version 1 is deliberately a browser app so the interface can be judged and
changed quickly. The obvious next steps:

- Hardware-accelerated transcoding and HLS for seeking within converted streams
- Downloads for offline viewing
- Chromecast / AirPlay
- Live TV and DVR

---

## Security

ECLIPSE is built for a home network. Passwords are hashed with scrypt and
sessions are httpOnly cookies, but it is **not hardened for the public
internet** — there's no rate limiting, no TLS, and no CSRF tokens. If you want
to reach it from outside the house, put it behind a VPN or a reverse proxy that
handles TLS and authentication.

---

## Licence

MIT.
