# Frozen schematic crossing oracle

These three four-second, 320×240, 10 fps videos are original generated media,
dedicated under CC0-1.0. They import no photographs, audio, fonts or models.
`manifest.json` retains exact MP4 byte sizes/SHA-256 and generator SHA-256.
Regeneration is explicit (`TMPDIR=/tmp bun generate.ts`); tests never regenerate
or change the oracle. The authored scene coordinates and temporal intervals were
frozen before running the candidate classifier.

The road occupies y=40..199; the zebra crossing occupies x=140..179. Blue vehicles
have a cabin, body and wheels; magenta pedestrians have a head, torso and two legs.
The oracle comes from drawing placements, not from the candidate pixel classifier.

- `crossing-conflict.mp4`: pedestrian occupancy precedes vehicle occupancy; the
  samples at 0.4, 2.0 and 3.6 seconds witness a conflict at 2.0 seconds.
- `crossing-safe.mp4`: the sampled vehicle occupancy precedes pedestrian occupancy.
  The answer must still be `not_observed`, never a general safety claim.
- `crossing-short.mp4`: a real one-frame conflict occupies [1.1, 1.2) seconds. The
  default three samples miss it. An additional sample at 1.1 seconds witnesses it.

Tests additionally use the existing original silence, malformed-byte and plain
color-video fixtures for no-video/invalid/unsupported-scene cases. They reject
invented occupancy, claimed exhaustive coverage, mismatched physical source,
untrusted normal-run artifact identity and out-of-duration frame times.

This is a deterministic, restricted visual grammar benchmark. It does not measure
photographic road-user recognition, real traffic safety, arbitrary scene semantics,
word-level caption understanding or general video QA. Normal output retains
`semanticAccuracy: "unmeasured"` and `absenceEstablished: false`.
