# ECLIPSE for Fire TV

A thin native shell around the same web client everyone else uses — full
screen, no browser chrome, an icon on the Fire TV home screen, and the
remote's D-pad wired up to move around the interface. There's no separate
codebase to maintain: this loads your ECLIPSE server the same way a laptop
browser does, so every feature (and every future change to `web/`) shows up
here automatically.

## Installing it on the Fire Stick

Fire TV doesn't have the Play Store's version of app installs — sideloading
through the **Downloader** app is the standard way in, and it's what this is
built for.

**1. Get the APK onto your Fire Stick**

The easiest way is the hosted build: every push to this repo builds the app
and publishes it at a fixed address —

```
https://github.com/fjstabler/ECLIPSE/releases/download/firetv-latest/eclipse-firetv.apk
```

**2. On the Fire Stick**

1. Settings → My Fire TV → Developer Options → **Apps from Unknown Sources**
   → On (also enable **ADB Debugging** if it's offered; some Fire OS versions
   gate sideloading behind it).
2. Install **Downloader** from the Amazon Appstore if you don't have it.
3. Open Downloader, enter the URL above, and confirm.
4. When it finishes, choose **Install**, then **Open** (or find "ECLIPSE" on
   the home screen / in Your Apps & Channels).

**3. First run**

It asks once for your server's address — the same one you'd type into a
browser, e.g. `http://192.168.1.50:8383`. It's saved on the device; you won't
be asked again unless you change it. Press the **Menu** button on the remote
any time to update it (if your PC's IP changes, for instance).

## Using it

Everything works the way it does in a browser — Home, Films, Series, search,
N.O.V.A., the player. Arrow keys on the remote move focus between posters,
shelves and buttons (see `web/js/tvnav.js`); Select activates whatever's
focused; Back steps back through pages and then exits; long fullscreen video
uses the same keyboard shortcuts as the browser player.

## Building it yourself

Needs a JDK and the Android SDK (`platforms;android-34`,
`build-tools;34.0.0`). From this directory:

```bash
./gradlew assembleDebug
```

The APK lands at `app/build/outputs/apk/debug/app-debug.apk`. It's signed
with Gradle's own debug key, which is exactly what sideloading wants — Fire
TV doesn't care who signed it, only that it's signed at all.

## Why a WebView shell instead of a rewrite

ECLIPSE's server is already a clean HTTP surface with no build step on the
client side — the whole point of v1. Rewriting the interface natively would
mean maintaining two UIs in lockstep for no real benefit; wrapping it means
this app never goes stale. If it's ever worth it, `MainActivity.java` is a
small, self-contained place to grow real native pieces (a proper Leanback
row-based home screen, DVR-style channel integration, etc.) without
disturbing the browser experience.

## What's deliberately not here

- **No auto-updates.** Re-download the APK from the link above to update; Fire
  OS lets you install over the existing app without uninstalling first, and
  your saved server address survives.
- **No app-side authentication or key storage.** The only thing saved on the
  device is the server address; everything else — login, sessions — goes
  through the same cookie-based flow the browser uses.
