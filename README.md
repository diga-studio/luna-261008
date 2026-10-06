# sqlite-message-relay

Persistent guest-to-agent text message delivery library (TypeScript + SQLite via `node:sqlite`).

One direction only: guests enqueue text messages for a fixed agent. Conversation
identity and receiver identity are supplied by the caller; the library does no
accounting or routing. Actual delivery is performed by a caller-injected
`deliver(conversationId, seq, messageId, text)` function returning a Promise.

## Requirements

- Node.js >= 22.13 (uses the built-in `node:sqlite` module without a flag; Node 24 LTS recommended)
- `npm install` (only devDependency is `typescript`)

## Usage

```ts
import { Messenger } from "./src/index.js";

const messenger = new Messenger("relay.sqlite", async (conversationId, seq, messageId, text) => {
  await sendToAgent(conversationId, seq, messageId, text); // your transport
});

const seq = messenger.enqueue("conv-1", "msg-1", "hello"); // persistent, idempotent per messageId
messenger.setOnline("conv-1", true);                       // receiver connectivity
messenger.pump(Date.now());                                // drive due delivery attempts
messenger.acknowledge("conv-1", seq);                      // single-message ACK (only ACKs confirm)
messenger.close();
```

## Semantics

- `enqueue` returns a per-conversation seq starting at 1, gapless. Same
  `messageId` + same text returns the original seq; same `messageId` with
  different text throws.
- Per continuous online period each unacknowledged message gets 1 first
  delivery + up to 3 retries, with >= 5000 ms (caller time) between attempt
  initiations. Failed and synchronously-throwing calls count. Exhausted
  messages stay persisted and are retried after the next real
  offline->online transition.
- Only `acknowledge` confirms a message; a settled deliver Promise does not.
  Late completions of pre-disconnect calls never touch the new online
  period's quota or schedule.
- No real timers: `pump(now)` is driven by caller-supplied non-decreasing
  milliseconds. No global queue: a slow delivery never blocks other
  conversations, and no SQLite transaction ever spans a `deliver` call.
- Closing and reopening preserves messages, seqs and acknowledgements;
  a new instance starts offline.

## Development

```sh
npm install
npm test   # builds with tsc, then runs node --test on dist/test/
```
