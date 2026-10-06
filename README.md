# ntfs-deleted-recovery

TypeScript library for recovering deleted files from NTFS raw/dd images.
Called directly by upper-level forensic tooling: the caller supplies the
trusted volume geometry, the image offset of the target `$MFT` record, and an
allocation bitmap covering the whole volume. Recovered content is written to a
new local file.

Fixed geometry: 512-byte sectors, 4096-byte clusters, 1024-byte `$MFT` records.
Images up to 2 TiB and logical files up to 500 MiB are supported, including
records and data located past the 4 GiB mark.

## Usage

```ts
import { NtfsRecovery } from "ntfs-deleted-recovery";

const rec = new NtfsRecovery(imagePath, bitmapPath, {
  volumeOffset: 1048576,   // absolute offset of the volume in the image
  volumeLength: 268435456, // volume length in bytes
  recordOffset: 12582912,  // absolute offset of the target $MFT record
});

const info = rec.inspect();            // recoverable? sizes? run list?
const slice = rec.readRange(0, 65536); // logical range read
rec.recoverToFile("/case/evidence.bin"); // full recovery to a new file
rec.close();
```

## Semantics

- Records are validated against NTFS sector-tail fixup (USA). Any fixup
  mismatch, truncated record, out-of-bounds attribute, incomplete run list, or
  physical reference beyond the volume is treated as corruption: no candidate
  is returned and no output file is produced.
- Only the unnamed `$DATA` attribute is recovered, resident or non-resident
  (fragmented and sparse files included). Named streams are ignored.
  Compressed, encrypted, and extension-record-dependent files are reported as
  unsupported and never partially recovered.
- Run-list cluster deltas are signed and relative; sparse runs have no
  physical cluster and do not change the delta base.
- Logical length is the declared real size of `$DATA`. Cluster tail padding is
  never emitted; sparse regions and bytes beyond the initialized size read as
  zero. `readRange` returns the intersection of the request with the logical
  range and never reads file content outside the requested range.
- Recovery and reads are allowed only while the record is marked unused and
  every referenced physical cluster is free in the allocation bitmap
  (LSB-first, cluster 0 = bit 0 of byte 0). If any cluster is in use, the
  whole file is refused and no output file is left behind. "Free" only means
  currently extractable, not that content was never overwritten.
- Single operations use well under 64 MiB of working memory: recovery streams
  through a reused 1 MiB buffer.

Errors are `RecoveryError` with a `code`: `CORRUPT_RECORD`,
`CORRUPT_ATTRIBUTE`, `CORRUPT_RUNLIST`, `OUT_OF_BOUNDS`, `UNSUPPORTED`,
`NOT_DELETED`, `CLUSTERS_IN_USE`, `IO`.

## Build & test

Requires only Node.js and npm:

```
npm install
npm test
```
