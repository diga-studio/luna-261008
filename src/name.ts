import { DnsParseError, type DomainName } from "./types.js";

const MAX_EXPANDED_NAME_LENGTH = 255;

/**
 * Registry of message offsets that are valid compression-pointer targets:
 * label-length bytes, pointer first bytes, and root-terminator bytes of
 * names that have been fully parsed. Only offsets belonging to completed
 * names are ever added, so a pointer can never reference the name currently
 * being parsed, header bytes, plain fields, label contents, or opaque RDATA.
 */
export class NameTargetRegistry {
  private readonly targets = new Set<number>();

  add(offset: number): void {
    this.targets.add(offset);
  }

  has(offset: number): boolean {
    return this.targets.has(offset);
  }
}

export interface ParsedName {
  name: DomainName;
  /** Offset one past the name's own encoded bytes (before any pointer jump). */
  endOffset: number;
}

/**
 * Reads a possibly compressed domain name starting at `offset`.
 *
 * `limit` bounds the name's own encoded bytes (label bytes, terminator, and
 * pointer bytes read before the first jump); bytes reached by following a
 * pointer may lie anywhere in the message. On success, the offsets of the
 * name's own label starts, pointer first byte, or root terminator are
 * registered as valid pointer targets.
 */
export function readName(
  bytes: Uint8Array,
  offset: number,
  limit: number,
  registry: NameTargetRegistry,
): ParsedName {
  const labels: DomainName = [];
  const ownTargets: number[] = [];
  let pos = offset;
  let endOffset = -1;
  let jumped = false;
  let expandedLength = 0;

  for (;;) {
    if (pos >= bytes.length) {
      throw new DnsParseError(`name encoding runs past end of message at offset ${pos}`);
    }
    if (!jumped && pos >= limit) {
      throw new DnsParseError(`name encoding crosses its boundary at offset ${pos}`);
    }
    const first = bytes[pos]!;
    const tag = first & 0xc0;

    if (tag === 0xc0) {
      if (pos + 1 >= bytes.length) {
        throw new DnsParseError(`truncated compression pointer at offset ${pos}`);
      }
      if (!jumped && pos + 2 > limit) {
        throw new DnsParseError(`compression pointer crosses its boundary at offset ${pos}`);
      }
      const target = ((first & 0x3f) << 8) | bytes[pos + 1]!;
      if (!registry.has(target)) {
        throw new DnsParseError(`compression pointer at offset ${pos} targets invalid offset ${target}`);
      }
      if (!jumped) {
        ownTargets.push(pos);
        endOffset = pos + 2;
        jumped = true;
      }
      pos = target;
      continue;
    }

    if (tag !== 0x00) {
      throw new DnsParseError(`reserved label tag 0x${tag.toString(16)} at offset ${pos}`);
    }

    const length = first;
    if (length === 0) {
      expandedLength += 1;
      if (expandedLength > MAX_EXPANDED_NAME_LENGTH) {
        throw new DnsParseError("expanded name exceeds 255 bytes");
      }
      if (!jumped) {
        ownTargets.push(pos);
        endOffset = pos + 1;
      }
      for (const t of ownTargets) {
        registry.add(t);
      }
      return { name: labels, endOffset };
    }

    if (pos + 1 + length > bytes.length) {
      throw new DnsParseError(`label at offset ${pos} runs past end of message`);
    }
    if (!jumped && pos + 1 + length > limit) {
      throw new DnsParseError(`label at offset ${pos} crosses its boundary`);
    }
    expandedLength += 1 + length;
    if (expandedLength > MAX_EXPANDED_NAME_LENGTH) {
      throw new DnsParseError("expanded name exceeds 255 bytes");
    }
    if (!jumped) {
      ownTargets.push(pos);
    }
    labels.push(bytes.slice(pos + 1, pos + 1 + length));
    pos += 1 + length;
  }
}
