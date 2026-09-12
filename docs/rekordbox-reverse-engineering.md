# Rekordbox Reverse-Engineering Notes

This note captures the useful local findings from Phrase2Photon's Rekordbox now-playing investigation.

The immediate goal was to replace the current file-state heuristic with a real playback clock from Rekordbox.

## Scope

These notes cover:

- how to derive the SQLCipher key for `master.db`,
- what `master.db` contains,
- what it does not contain,
- other local stores that were checked,
- the remaining evidence pointing at Rekordbox's local `PSvLink` / `ProDJLink` transport,
- and later findings from the public `rkbx_link` project about direct memory reading on macOS.

## Installed Paths

Useful local paths:

- Rekordbox app: `/Applications/rekordbox 7/rekordbox.app`
- Agent binary: `/Applications/rekordbox 7/rekordbox.app/Contents/MacOS/rekordboxAgent.app/Contents/MacOS/rekordboxAgent`
- Agent Electron helper: `/Applications/rekordbox 7/rekordbox.app/Contents/MacOS/rekordboxAgent.app/Contents/Frameworks/rekordboxAgent Helper.app/Contents/MacOS/rekordboxAgent Helper`
- User library DB: `~/Library/Pioneer/rekordbox/master.db`
- Agent options: `~/Library/Application Support/Pioneer/rekordboxAgent/storage/options.json`
- Agent log: `~/Library/Application Support/Pioneer/rekordboxAgent/log.log`

Current locally installed Rekordbox version during this investigation:

- `7.2.13.0321`

## `master.db` Decryption

### What worked

`master.db` is SQLCipher-encrypted. The working path was not guessing a static key, but executing the installed `rekordboxAgent` bootstrap under its own Electron runtime and observing how it mutates config during startup.

Important details:

- the extracted app code uses Bytenode-compiled `.jsc` files,
- `main_core.jsc` updates the runtime config during the Electron `ready` path,
- the argv payload includes `--db-path` and `--dp`,
- `--dp` is decoded with `egoroof-blowfish` using `ECB` and `PKCS5`,
- the final SQLCipher password appears in the mutated config object after the `ready` callback runs.

### Practical decode path

1. Extract or point at the agent app bundle contents.
2. Run the bundled Electron helper with `ELECTRON_RUN_AS_NODE=1`.
3. Load Bytenode from the agent's bundled `node_modules`.
4. Stub enough Electron APIs for `main_core.jsc` to load:
   - `electron`
   - `electron-log`
   - `electron-json-storage`
   - sometimes `express_loader`
5. Intercept `app.on("ready", cb)` or `app.once("ready", cb)`.
6. Require the agent config JSON and `main_core.jsc`.
7. Invoke the stored `ready` callback manually.
8. Read the mutated SQLCipher password from `config.database.sqlite.password`.

### Important caution

Do not commit the recovered password. It is a local secret and should be treated as installation-specific runtime material.

Commit the method, not the key.

## Opening `master.db`

The easiest working client was the agent's own bundled SQLCipher module:

- module path: `/tmp/rb-agent-app/node_modules/@journeyapps/sqlcipher`
- reported cipher version during validation: `4.4.2 community`

Minimal shape:

```js
const sqlite3 = require("/tmp/rb-agent-app/node_modules/@journeyapps/sqlcipher").verbose();
const db = new sqlite3.Database("/Users/you/Library/Pioneer/rekordbox/master.db", sqlite3.OPEN_READONLY);
db.serialize(() => {
  db.run("PRAGMA key='...recovered password...'");
  db.get("SELECT count(*) AS c FROM sqlite_master", console.log);
});
```

Once keyed correctly, normal schema queries work.

## What `master.db` Contains

`master.db` is the Rekordbox library database.

Representative tables observed:

- `djmdContent`
- `djmdCue`
- `djmdPlaylist`
- `djmdSongPlaylist`
- `djmdHistory`
- `djmdSongHistory`
- `djmdArtist`
- `djmdAlbum`
- `djmdGenre`
- `djmdKey`
- `djmdLabel`
- `djmdColor`
- `djmdMixerParam`
- `contentCue`
- `contentFile`
- `agentNotification`

Useful static fields seen during schema inspection include:

- `djmdContent.BPM`
- `djmdContent.DJPlayCount`
- `djmdContent.MasterDBID`
- `djmdContent.MasterSongID`
- `djmdContent.SamplerPlayOffset`
- `djmdCue.ActiveLoop`
- `djmdCue.BeatLoopSize`

This makes `master.db` useful for:

- library metadata,
- file-path lookup,
- playlists,
- cues and loops,
- history-style records,
- joining content ids back to tracks.

## What `master.db` Does Not Contain

`master.db` did not surface a reliable live transport clock.

We explicitly looked for schema and column names related to:

- current deck state,
- active player,
- playback position,
- elapsed time,
- live beat or transport,
- active master clock.

Conclusion:

- `master.db` is not the live now-playing source for exact deck position,
- it is useful for track identity and cue metadata, but not for a real-time transport clock.

## Other Local Stores Checked

These were also inspected:

- `~/Library/Pioneer/rekordbox/networkAnalyze6.db`
- `~/Library/Pioneer/rekordbox/networkRecommend.db`
- `~/Library/Application Support/Pioneer/rekordbox6/LightingDB/user.db3`
- `/Volumes/MUSIC/PIONEER/rekordbox/exportLibrary.db`
- `/Volumes/MUSIC/PIONEER/rekordbox/export.pdb`
- `/Volumes/MUSIC/PIONEER/rekordbox/exportExt.pdb`

Findings:

- `networkAnalyze6.db` was plain SQLite with only `manage_tbl`
- `networkRecommend.db` was plain SQLite with only `manage_tbl`
- `LightingDB/user.db3` contained lighting-related tables such as:
  - `content`
  - `direct_control`
  - `fixture`
  - `lighting_data`
  - `lighting_property`
  - `phrase_data`
  - `venue`
- `exportLibrary.db` was not plain SQLite in the same easy way

None of these produced the live deck clock either.

## Local Agent Findings

The authenticated local agent on `127.0.0.1:30001` was partially reverse-engineered earlier.

Confirmed points:

- `/api/v1/agent/token` gates access,
- it expects signed bootstrap material,
- `/api/v1/agent/messages` long-polls,
- authenticated message polls were observed returning empty `items`,
- the agent REST surface exposed library-style data but did not yield the live playback clock.

That means the agent is still useful context, but it no longer looks like the best path for transport sync.

## Public `rkbx_link` Findings

After the local packet and agent work stalled, the next useful public reference was:

- `grufkork/rkbx_link`

Repository:

- <https://github.com/grufkork/rkbx_link>

### Why it matters

This is the strongest public evidence found that exact Rekordbox transport sync is possible on macOS and Windows without OCR:

- it explicitly claims to read live transport position directly from Rekordbox memory,
- it joins that with Rekordbox `ANLZ` files to recover beatgrid and phrase data,
- and it exports beat-accurate timing over Ableton Link, OSC, and other outputs.

This confirms the problem is not that Rekordbox lacks a precise position internally. The missing piece is access.

### How `rkbx_link` works

Source inspection shows a compact architecture:

1. Read a small set of versioned pointer chains from Rekordbox memory:
   - master deck index
   - per-deck BPM
   - per-deck sample position
   - per-deck track info string
   - per-deck `.DAT` analysis path
2. Parse the Rekordbox `ANLZ` files for the active tracks:
   - beatgrid from `.DAT`
   - song structure / phrases from `.EXT`
3. Derive current musical state from:
   - `sample_position / 44100.0`
   - beatgrid lookup
   - phrase-structure lookup

Important source files:

- `src/memory/macos_memory.rs`
- `src/memory/mod.rs`
- `src/beatkeeper.rs`
- `data/offsets-macos`
- `MACOS_SETUP.md`

### Pointer-chain format

The project stores offsets as:

- module-relative base offset,
- zero or more pointer dereferences,
- final field offset.

For example, the macOS offsets file for Rekordbox `7.2.8` contains pointer chains for:

- master deck index
- deck BPM
- deck sample position
- deck `Track info (Title:)`
- deck `ANLZ .DAT path`

So the exact-sync path does not require huge memory scraping. It only needs a handful of stable pointers per version.

### macOS-specific blocker

The macOS backend uses:

- `task_for_pid`
- `mach_vm_read_overwrite`

Its own setup doc is explicit that this does **not** work against the stock notarized Rekordbox app.

`rkbx_link` solves that by re-signing Rekordbox to add:

- `com.apple.security.get-task-allow`

Their helper script:

- extracts Rekordbox's current entitlements,
- injects `get-task-allow`,
- removes Apple's original signature,
- re-signs the app locally.

Phrase2Photon now has a local equivalent helper at:

- `scripts/resign_rekordbox_macos.sh`

This keeps SIP enabled, but it intentionally breaks the original Apple notarization trust chain.

### Current local relevance

Two hard blockers remain on this machine before the `rkbx_link` memory method can work directly:

1. The installed Rekordbox app currently does **not** have `get-task-allow`.
   Current extracted entitlements included:
   - `com.apple.security.cs.allow-unsigned-executable-memory`
   - `com.apple.security.cs.disable-library-validation`
   - `com.apple.security.device.audio-input`
   - `com.apple.security.device.camera`
   But **not** `com.apple.security.get-task-allow`.
2. The public community macOS offsets bundled in `rkbx_link` only cover:
   - Rekordbox `7.2.8` on Apple Silicon

Our local install is:

- Rekordbox `7.2.13.0321`

So even after re-signing, offsets for the current local build would still need to be derived or sourced.

### Confirmed `7.2.8` rollback artifact

The exact historical macOS installer URL for the public `rkbx_link` offset baseline was recovered from FileHorse's archived download flow and verified against the vendor CDN:

- `https://cdn.rekordbox.com/files/20251203151846/Install_rekordbox_7_2_8.pkg_.zip`

Validation observed locally on 2026-05-25:

- `HTTP/2 200`
- `content-type: application/zip`
- `content-length: 923761921`
- `last-modified: Wed, 03 Dec 2025 06:18:54 GMT`
- `sha256: dab0ff14f063248932b67aa1ebdd3d0c6162cdc2a1ebd7d35b928e5676992dea`

This is important because it means the rollback path does not depend on a third-party mirror once the URL is known. The vendor CDN still serves the exact `7.2.8` package directly.

### Rootless local `7.2.8` staging

System-wide replacement under `/Applications/rekordbox 7` still requires root because both the directory and app bundle are owned by `root:wheel`.

The successful workaround was:

1. Expand the package payload without installing:
   - `pkgutil --expand-full Install_rekordbox_7_2_8.pkg .../pkg-expanded`
2. Copy the full payload tree into a user-owned app root:
   - `~/Applications/rekordbox 7.2.8/`
3. Re-sign the staged app with:
   - `scripts/resign_rekordbox_macos.sh "$HOME/Applications/rekordbox 7.2.8/rekordbox.app"`

The package payload already includes the sibling directories Rekordbox expects:

- `rekordbox.app`
- `drivers`
- `firmware`
- `tools`
- `residentmanager`

So a full payload copy preserves the intended relative layout even without a privileged installer run.

### Verified memory-read proof on local `7.2.8`

After re-signing the user-owned `7.2.8.0327` app, direct Mach access succeeded against the running main process:

- `task_for_pid(...) -> KERN_SUCCESS`
- `mach_vm_region_recurse(...) -> KERN_SUCCESS`
- `mach_vm_read_overwrite(...) -> KERN_SUCCESS`

Example probe result from the running process:

- `pid=11628`
- `base=0x104134000`
- first 16 bytes at base:
  - `cffaedfe0c0000010000000002000000`

This confirms the macOS blocker was resolved by the `7.2.8` + `get-task-allow` path. The remaining work is now pointer interpretation and live transport extraction, not OS-level attach permissions.

### Live `7.2.8` pointer confirmation

With a real track loaded in the staged `7.2.8` app, the public community pointer chains were confirmed live:

- BPM pointer resolved correctly
- sample-position pointer advanced at playback rate
- sample-position pointer froze exactly while paused
- sample-position pointer jumped discontinuously on scrub/jump
- track-info pointer yielded parseable `Title:`, `Artist:`, and `Album:` strings
- ANLZ path pointer yielded the active track's `ANLZ0000.DAT` path

This is enough for Phrase2Photon's exact Rekordbox transport sync for a selected deck.

One offset is still unresolved:

- the public `master_deck` pointer currently reads a sentinel-like block
  - `ffffffff0000000064000000ffffffff`
  - single-byte read produced `255`

So the remaining reverse-engineering work is mostly around active/master deck selection in multi-deck cases, not the core transport clock itself.

### Implication for Phrase2Photon

This makes the likely best long-term architecture:

- keep open-file polling as the durable identity layer,
- use direct Rekordbox memory reads for exact transport position,
- use `ANLZ` parsing for beatgrid and phrase alignment,
- and treat OCR / Accessibility text scraping only as weak fallbacks.

The main product decision is no longer technical feasibility. It is operational:

- are we willing to require a locally re-signed Rekordbox app,
- or do we need a weaker but lower-friction fallback for users who keep stock notarized Rekordbox?

## Local Transport Evidence

The strongest remaining evidence points at Rekordbox's own local `PSvLink` / `ProDJLink` transport.

### Binary evidence

Strings observed in the main Rekordbox binary include:

- `N7psvlink6common7MessageE`
- `N7psvlink6common13CommonMessageE`
- `N7psvlink6common18CommonMessageQueueE`
- `N9prodjlink9ProDJLinkE`
- `/tmp/PSvLinkProc`
- `%s OK 50000`
- `%s OK 50001`
- `%s OK 50002`
- `%s OK 50004`
- `%s OK 50111`
- `portchk`

### Live socket evidence

Observed Rekordbox-local listeners included:

- TCP: `50000`, `55000`, `55002`
- UDP: `50000`, `50001`, `50002`, `50004`, `50111`

The main process also had a POSIX semaphore open at:

- `/tmp/PSvLinkProc`

### Probe behavior

Quick probe behavior on the local TCP listeners:

- `50000` accepts a connection and stays silent
- `55000` accepts a connection but closes on junk input
- `55002` behaves like `55000`

These do not behave like ordinary HTTP or JSON endpoints.

Current working assumption:

- the real live deck clock is carried over a custom local protocol on the `PSvLink` / `ProDJLink` side of Rekordbox,
- not in SQLite,
- and not in the agent REST data routes we already decoded.

## Confirmed Port Roles

Disassembly of the active Rekordbox binary established these UDP roles:

- `PSvLinkShortInterval::startRecv(...)` binds UDP `50001`
- `PSvLinkNormalInterval::startRecv(...)` binds UDP `50002`
- `PSvLinkMonitor::startRecv(...)` binds UDP `50004`

`PSvLinkNetworkAccess::startRecv(...)` starts all three of those receivers together.

What remains unresolved:

- UDP `50000`
- UDP `50111`
- TCP `50000`

Those likely belong to adjacent `PSvLink` / system-manager paths that still need targeted tracing.

## Packet Framing

The shared frame header is no longer a guess.

### Header size

- fixed header length: `0x24` bytes
- total frame size: `0x24 + payload_length`
- payload length is stored as a 16-bit network-endian value at offset `0x22`

### Header magic

The header constructor writes these fixed identifiers:

- `"Qspt1WmJOL"` at the beginning of the frame
- `"rekordbox"` in the next identifier region

The parser checks those bytes before doing message-specific work.

### Important offsets

From constructor and parser inspection:

- offset `0x0a`: one message-type byte used by parsers
- offset `0x1a`: another type/family byte checked before dispatch
- offset `0x1f`: compared by parser callbacks
- offset `0x20`: compared by parser callbacks
- offset `0x21`: another constructor-set byte not fully classified yet
- offset `0x22`: 16-bit payload size

This is enough to recognize valid PSvLink frames in a packet capture.

## Runtime Receive Behavior

The UDP and TCP receive loops are straightforward once decoded:

- `PSvLinkUDP::run()` calls `recvfrom()` into a `1472`-byte buffer
- `PSvLinkTCPServer::run()` calls `accept()` and then `recv()` up to `1024` bytes
- both wrap incoming bytes in a `juce::MemoryBlock` and hand them to a virtual `messageReceived(...)` path

This means:

- UDP messages are expected to fit under standard MTU-sized datagrams,
- TCP likely carries the same framed payloads but through a different request/response path.

## Internal Message Queue

The `/tmp/PSvLinkProc` semaphore is real, but it appears to back an internal process queue rather than the external loopback transport.

What disassembly showed:

- `PSvLinkMessageManager::appendMessage(...)` stores messages in an internal array,
- it then calls `sem_post(...)`,
- `psvlink::common::CommonMessageQueue::recvCommonMessage(int)` waits on an internal event and dequeues local message objects.

Interpretation:

- `PSvLinkProc` matters for internal orchestration,
- but the loopback UDP/TCP ports are still the cleaner path for recovering an external playback clock without injecting into Rekordbox internals.

## Concrete Message Hints

A few message codes are now grounded in the binary:

- `PSvLinkTimeBeatCounter::run()` periodically appends local message type `0x44`
- `PSvLinkMonitor::GetLinkMonitorInfo()` appends local message type `0x31`
- `PSvLinkMonitor::messageReceived()` appends local message type `0x32` when it observes position changes
- `PSvLinkShortInterval::messageReceived()` recognizes header byte `0x0a` values `0x26`, `0x27`, and `0x28`
- `PSvLinkMonitor::messageReceived()` branches on header byte `0x0a` values `0x1f` and `0x20`

Those values should be treated as anchors when decoding live captures.

## Why This Matters For Phrase2Photon

Phrase2Photon's current Rekordbox support can identify likely tracks and estimate position from file-open state, but that heuristic fails on:

- pause detection,
- scrubs and jumps,
- buffered-local-file edge cases,
- exact phrase alignment.

The missing piece is a true transport clock from Rekordbox itself.

## Recommended Next Steps

1. Capture loopback traffic on the `PSvLink` ports while loading, playing, pausing, and scrubbing.
2. Correlate packet timing with obvious deck actions.
3. Reverse-engineer the message framing for the local TCP and UDP listeners.
4. Identify the smallest stable subset needed for:
   - active track identity
   - play/pause state
   - current playback position
   - BPM if available
5. Add a dedicated Rekordbox clock adapter in Phrase2Photon once the packet format is understood.

## Practical Reminder

If this work resumes later, do not start by re-deriving SQLCipher access. That part is solved enough to be useful. Start at the local `PSvLink` transport instead.
