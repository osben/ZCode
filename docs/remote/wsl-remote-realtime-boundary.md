# WSL remote workspace realtime boundary fix

> **Status: historical fault record; the boundary conclusion still holds.** The `sendPrompt`/dynamic stream
> mentioned here are the old entry points at the time of the fix; the current conversation main chain has
> moved to V4 command/topic, but an ordinary WSL/server desktop connection must still not register the
> `relay_bridge` that mobile replayable uses.

## Background

An ordinary desktop WSL remote workspace should keep using the `desktop-continuous` main chain. The mobile
remote-control replayable attachment chain, and the relay behavior of existing SSH / Docker / Bot remote
runtimes, stay unchanged first to avoid widening the regression surface.

## Problem

User reports concentrated on ordinary WSL remote workspaces. The main process used to register this desktop
chain as a `relay_bridge` too, which caused:

1. The remote host subscribed to the remote `onDynamicStreamEvent` additionally on `sendPrompt`
2. Every stream event was mirrored into `task_stream_mirror_batch`
3. The desktop host does not need this replayable mirror, yet the host bridge still deduplicated by `eventId` and held the cache
4. WSL traffic is higher, so host memory grew quickly within a short time; Windows/WSL swap and VHDX grew fast too, showing as "memory leak + disk usage surge"

## Fix boundary

- Ordinary desktop WSL Remote Host: does not register `relay_bridge`
- SSH / Docker ordinary remote workspaces: keep the existing `relay_bridge` behavior
- Bot remote runtime / mobile replayable attachment chain: keep using `relay_bridge`
- The host-side realtime bridge's `eventId` dedup cache gets a fixed cap as a general defense, so an abnormal path cannot again grow memory linearly

## Verification points

- Opening an ordinary WSL workspace on desktop no longer creates a `relay_bridge` host
- An SSH remote workspace still keeps the original `relay_bridge` registration
- Bot remote runtime still keeps `relay_bridge`, so mobile remote control and the bot chain are unaffected
- After the dedup window is exceeded the host bridge may accept an old `eventId` again, but resident memory stays bounded
