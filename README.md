# credit-scoring

Multi-dimensional bidirectional credit scoring library (TypeScript + SQLite).
Merchants rate customers and customers rate merchants through the same API;
authentication, rating direction and appeal arbitration are the caller's
responsibility — every call into this library is trusted.

## Requirements

- Node.js >= 22.13 (uses the built-in `node:sqlite`; no native modules)

## Build & test

```sh
npm install
npm test
```

## API

```ts
import { CreditLibrary } from "credit-scoring";

const lib = new CreditLibrary("credit.db"); // or ":memory:"

// Replace the dimension weights of a business (label = dimension).
lib.configure("shop-1", { quality: 2, service: 1 });

// Append a new version to a logical rating, fully replacing its previous
// dimension values. Values are integers in units of 0.01 points.
// An empty map revokes the whole rating (appeal won); old versions are kept.
lib.record("shop-1", "customer-9", "rating-42", { quality: 8000, service: 5000 });

// Current credit score and invitation restriction.
const { score, restricted } = lib.credit("shop-1", "customer-9");
```

## Scoring rules

- Only the latest version of each logical rating contributes; every version
  and revocation is preserved in SQLite and never overwritten.
- For each configured label with at least one observation, values are
  averaged per label, then combined into a weighted average over those
  labels. Labels without observations stay out of the denominator.
- With no participating label the score is 100.
- Unconfigured labels do not score, but their values are stored and take
  effect immediately once the label is configured.
- Invitation is restricted when the *unrounded* score is strictly below 40.
  All arithmetic is exact (BigInt rationals); `score` is rounded to 0.01
  only for display.
- Businesses are fully isolated from each other.
