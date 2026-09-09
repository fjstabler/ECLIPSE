# Running ECLIPSE on Proxmox

This walks through putting ECLIPSE in its own LXC container on a Proxmox
host, running via Docker, so it stays up permanently and survives reboots —
and how to pull down future updates from GitHub once it's live.

If you already have a container or VM with Docker on it, skip to
[3. Deploy ECLIPSE](#3-deploy-eclipse).

---

## 1. Create the LXC container

In the Proxmox web UI: **Create CT**, then:

- **Template** — Debian 12 (download it first under your storage's
  *CT Templates* tab if it's not there yet).
- **Resources** — 2 CPU cores and 2GB RAM is comfortable for a home library;
  give it more if you'll transcode several streams at once. 8–16GB disk is
  plenty — your actual media stays on its own storage, mounted in, not
  copied into the container.
- **Network** — a static IP (or a DHCP reservation on your router) so the
  address doesn't change under you; you'll be pointing browsers and the Fire
  TV app at it.

Before starting it, open the container's **Options** tab and:

- Set **Start at boot** to Yes — this is what makes it come back after a
  Proxmox host reboot.
- Set **Features → Nesting** *and* **keyctl** to enabled. Docker needs both
  to run inside an unprivileged LXC container: without nesting the daemon
  won't start at all, and without keyctl it starts but containers fail with
  keyring errors. If the Features tab won't let you tick them, run this on
  the *Proxmox host* instead, with the container stopped:

  ```bash
  pct set <ctid> --features nesting=1,keyctl=1
  ```

Start the container, then open its console (or SSH in).

## 2. Install Docker

Inside the container (as root):

```bash
apt update && apt install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker
```

That's the official Docker apt repo — the same steps as
[docs.docker.com](https://docs.docker.com/engine/install/debian/), just
condensed. `systemctl enable` is the other half of "starts on boot": Proxmox
starting the container isn't enough on its own if Docker itself doesn't come
up inside it.

## 3. Deploy ECLIPSE

Where your media actually lives matters here more than on a bare-metal
install: point `ECLIPSE_MOVIES_DIR` / `ECLIPSE_SERIES_DIR` at paths *inside
this container* — a mounted NAS share, a bind-mounted host directory passed
through from Proxmox, or a folder on the container's own disk. However you
get your library reachable from inside this container, do that first.

```bash
apt install -y git
mkdir -p /opt/eclipse && cd /opt/eclipse
git clone https://github.com/fjstabler/ECLIPSE.git
cd ECLIPSE
cp .env.example .env
nano .env   # fill in ECLIPSE_MOVIES_DIR, ECLIPSE_SERIES_DIR, and your API keys
```

In the Docker setup those two paths mean something slightly different from
the bare-metal one: they are the paths **on this container's filesystem**
that get bind-mounted into the image, not the paths ECLIPSE reads. Compose
mounts them at `/media/movies` and `/media/series` inside, and points
ECLIPSE there. You don't need to think about that — just give it real paths
to your media.

Both need to be set to folders that actually exist, even if one is empty for
now (`mkdir -p /mnt/series` and point it there). Docker Compose needs
somewhere real to bind-mount, so leaving one blank fails the next step
rather than quietly skipping that library.

```bash
docker compose up -d --build
```

First run builds the image (compiles the native SQLite module, pulls in
ffmpeg) — a couple of minutes. After that, open `http://<container-ip>:8383`
from any browser on your network and create the admin profile.

Check it's actually running any time with:

```bash
docker compose logs -f       # follow the server's own log output
docker compose ps            # confirm it's Up
```

## 4. Updating from GitHub

Whenever there's a new commit you want:

```bash
cd ECLIPSE
git pull
docker compose up -d --build
```

`up -d --build` rebuilds the image only if something changed and restarts
the container with it — your library, watch history and profiles all live
in the `data/` folder (bind-mounted from the host, untouched by rebuilds),
not inside the image.

## 5. Backups

ECLIPSE copies its database to `data/backups/` once a day and keeps the last
seven. That database is the only part of the install that can't be rebuilt:
profiles and PINs, what everyone has watched and how far in, lists, ratings,
favourites, taste profiles and your library setup. The media itself can
always be re-scanned and the artwork re-fetched.

Take one on demand, and download one to keep somewhere else, from
**Settings → Server → Backups**. A backup that only exists on the disk that
fails hasn't saved anything, so copy them off the box:

```bash
# From the Proxmox host, pull the whole backup folder somewhere safe
rsync -a root@<container-ip>:/opt/eclipse/ECLIPSE/data/backups/ /mnt/backups/eclipse/
```

To restore one:

```bash
cd ECLIPSE
docker compose down                       # stop the server first
cp data/backups/eclipse-<timestamp>.db data/eclipse.db
rm -f data/eclipse.db-wal data/eclipse.db-shm   # stale sidecars of the old database
docker compose up -d
```

Don't copy `data/eclipse.db` by hand while the server is running: the
database runs in WAL mode, so recent writes live in `eclipse.db-wal` and a
plain `cp` of the main file silently loses them. The backups ECLIPSE takes
are made through SQLite's own online-backup API, which captures a consistent
snapshot including the write-ahead log while the server keeps serving.

## Notes

- **Network shares (NFS/SMB) and the folder watcher.** ECLIPSE watches your
  library folders for new files automatically (`ECLIPSE_WATCH=true`), which
  relies on Linux's inotify — this generally does *not* work reliably across
  a network filesystem. If your media lives on a NAS mounted into the
  container, that watch will report nothing. This is what the periodic
  re-read is for: ECLIPSE scans the whole library every
  `ECLIPSE_SCAN_INTERVAL_HOURS` (6 by default), so files added from another
  machine turn up on their own. Lower it if you want them sooner, or rescan
  on demand from Settings → Library.
- **Getting your media into an unprivileged container.** Bind-mounting a
  host folder is done from the *Proxmox host*, with the container stopped:

  ```bash
  pct set <ctid> -mp0 /mnt/tank/media,mp=/mnt/media
  ```

  In an unprivileged container root is host UID 100000, so the host folder
  has to be readable by that mapped user or ECLIPSE will scan it and find
  nothing. The quickest fix is to make the media world-readable on the host
  (`chmod -R a+rX /mnt/tank/media`); the tidier one is to map a UID in
  `/etc/pve/lxc/<ctid>.conf`. A library that scans clean but comes back
  empty is nearly always this rather than anything in ECLIPSE — check with
  `ls /mnt/media` *inside* the container before looking further.
- **Multiple library folders.** If `ECLIPSE_MOVIES_DIR` or
  `ECLIPSE_SERIES_DIR` lists more than one `:`-separated path, only the
  first is bind-mounted by the compose file as shipped — add another
  `volumes:` line for each extra folder (see the comment in
  `docker-compose.yml`).
- **Reaching it from outside your home network.** ECLIPSE isn't hardened for
  the open internet (see the Security section of the main README) — use a
  VPN (Tailscale/WireGuard) rather than exposing the port directly.
