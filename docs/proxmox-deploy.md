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
- Set **Features → Nesting** to enabled. Docker needs this to run inside an
  LXC container at all; without it the Docker daemon fails to start.

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
git clone https://github.com/fjstabler/ECLIPSE.git
cd ECLIPSE
cp .env.example .env
nano .env   # fill in ECLIPSE_MOVIES_DIR, ECLIPSE_SERIES_DIR, and your API keys
```

Both `ECLIPSE_MOVIES_DIR` and `ECLIPSE_SERIES_DIR` need to be set to real
paths that exist, even if one is just an empty folder for now (`mkdir -p
/mnt/series` and point it there) — unlike the bare-metal setup, Docker
Compose needs somewhere real to bind-mount, so leaving one blank will fail
the next step rather than just skipping that library.

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

## Notes

- **Network shares (NFS/SMB) and the folder watcher.** ECLIPSE watches your
  library folders for new files automatically (`ECLIPSE_WATCH=true`), which
  relies on Linux's inotify — this generally does *not* work reliably across
  a network filesystem. If your media lives on a NAS mounted into the
  container, new files may not be picked up until the next scan. Either
  trigger a rescan yourself after adding files (Settings → Library, or `npm
  run scan` — `docker compose exec eclipse npm run scan` from the host) or
  leave `ECLIPSE_SCAN_ON_BOOT=true` and restart the container periodically.
- **Multiple library folders.** If `ECLIPSE_MOVIES_DIR` or
  `ECLIPSE_SERIES_DIR` lists more than one `:`-separated path, only the
  first is bind-mounted by the compose file as shipped — add another
  `volumes:` line for each extra folder (see the comment in
  `docker-compose.yml`).
- **Reaching it from outside your home network.** ECLIPSE isn't hardened for
  the open internet (see the Security section of the main README) — use a
  VPN (Tailscale/WireGuard) rather than exposing the port directly.
