# inkpipe wire protocol

**Status:** describes what is built and tested as of the vertical slice
(issue #2). Sections marked PLANNED are not implemented.

**This document and `packages/protocol/` move together.** A change to that
package without a change here fails `scripts/check-doc-drift.sh`, in CI and in
the pre-push hook. See CLAUDE.md.

---

## 1. Roles

| Role | Holds | Can |
|---|---|---|
| **phone** | Ed25519 identity key | upload blobs |
| **pc** | Ed25519 identity key, X25519 content key | create pairings, list, download, ack |
| **server** | public keys and ciphertext only | store and serve opaque bytes |

The server can never read a note. It holds no private key, and the content
private key exists only on the desktop.

## 2. Keys

Two keypairs, doing unrelated jobs. They are never interchangeable.

| | Curve | Purpose | Private half lives |
|---|---|---|---|
| Identity | Ed25519 | signs requests so the server knows who is calling | on each device |
| Content | X25519 | the phone seals pages to it | **desktop only** |

Public keys are 32 raw bytes, transmitted as unpadded base64url, which is
exactly 43 characters. The `PublicKey` schema enforces that length.

## 3. Sealed box

Every page is sealed to the desktop's X25519 public key before it leaves the
phone.

```
layout:  ephemeralPublicKey(32) || nonce(24) || ciphertext+tag(n+16)
kdf:     HKDF-SHA256(sharedSecret, salt = ephemeralPub || recipientPub,
                     info = "inkpipe/v1/sealed-box")
aead:    XChaCha20-Poly1305, with the 56 byte header as associated data
```

Consequences, each covered by a test in `packages/crypto/test`:

- The sender cannot decrypt its own message. The phone's local backup copy
  (decision 15) is plaintext on the phone instead.
- Two seals of identical plaintext differ, so the server cannot tell that the
  same page was uploaded twice.
- The header is authenticated, so flipping any byte of the ephemeral key or
  nonce fails the open rather than decrypting to something else.
- Overhead is exactly 72 bytes.

## 4. Request signing

Every authenticated request carries three headers:

```
x-inkpipe-device      device id (uuid)
x-inkpipe-timestamp   ISO 8601, must be within 300 seconds of server time
x-inkpipe-signature   Ed25519 over the signing string, base64url
```

The signing string is built by `signingString()` in `@inkpipe/protocol`, and
both sides import it rather than rebuilding it:

```
METHOD \n path-with-query \n timestamp \n sha256hex(rawBody)
```

The path includes the query string, so a signature for one query cannot be
replayed against another. The body hash is over the exact bytes received, not a
re-serialised object.

Rejections are all `401` with no detail that would help an attacker distinguish
an unknown device from a bad signature, beyond a short reason string.

## 5. Endpoints

### `GET /health`

Unauthenticated. Returns exactly `{ ok, version, devices, pendingBlobs }` and
nothing personal. Tested to have those four keys and no others.

### `POST /pair/register-pc`

The desktop registers itself using the join token printed by the VPS bootstrap.
Creates an account and the `pc` device in one step.

```
-> { joinToken, ed25519PublicKey, x25519PublicKey, label }
<- 201 { accountId, deviceId }
<- 401 on a wrong join token
```

### `POST /pair/create`  (pc only)

Mints a short-lived single-use pairing token. The response is the QR payload.

```
-> { ttlSeconds }                    30..900, default 300
<- 201 { pairingToken, expiresAt, serverUrl, x25519PublicKey }
```

### `POST /pair/complete`

The phone redeems the token and receives the key it will seal to. **The pairing
exchange is the key exchange.**

```
-> { pairingToken, ed25519PublicKey, label }
<- 201 { accountId, deviceId, x25519PublicKey }
<- 401 if unknown, expired, or already used
```

Single use is enforced by a conditional update, so two concurrent redemptions
cannot both succeed.

### `POST /blobs`  (phone only)

```
-> { blobId, sessionId, seq, sizeBytes, capturedAt, ciphertext }
<- 201 { blobId, duplicate: false }
<- 200 { blobId, duplicate: true }    idempotent replay
<- 400 sizeBytes does not match the bytes received
<- 413 over maxBlobBytes
<- 507 over the device quota
```

`blobId` is a client-generated UUIDv7, so a retried upload is idempotent and can
never produce a duplicate page. `sizeBytes` is checked against the actual
decoded length, otherwise a client could declare 1 byte and upload 12 MB to
defeat the quota.

### `GET /blobs`  (pc only)

Returns pending metadata for the caller's account, ordered by session then seq.
Never returns another account's blobs.

### `GET /blobs/:blobId`  (pc only)

Returns the metadata plus base64 ciphertext. `404` for a blob belonging to
another account, deliberately indistinguishable from one that does not exist.

### `POST /blobs/ack`  (pc only)

```
-> { blobIds: [...] }
<- { deleted: n }
```

Deletes row and file. Scoped by account, so acking another account's blob
deletes nothing and returns `0`. Acking is batched because a note is many pages
and a partial ack would leave a session half-delivered.

## 6. Limits

From `LIMITS` in `@inkpipe/protocol`. These are protocol facts, not server
preferences: the phone needs them to avoid uploading something that will be
refused, and the server enforces them because it cannot trust the phone.

| | |
|---|---|
| `maxBlobBytes` | 12 MB |
| `maxBytesPerDevice` | 2 GB (decision 14) |
| `retentionDays` | 30 (decision 14) |
| `signatureSkewSeconds` | 300 |
| `maxPagesPerSession` | 100 |

## 7. Delivery model

The desktop polls (decision 13, 60 second default). There is no push and no
inbound port on the desktop, so it works behind any NAT and survives sleep.

Blobs are deleted only on explicit ack, and the desktop acks only after the note
is written and committed. A crash mid-session therefore redelivers rather than
losing pages.

## 8. What the server never does

Enforced by review and by the absence of any image dependency in
`apps/server`:

- decode, inspect, resize or parse a blob
- store a private key
- see a vault path, a note title, a course name, or any transcript

The only plaintext metadata is `sessionId`, `seq`, `sizeBytes` and `capturedAt`,
which are needed to group pages and enforce quota, and which say nothing about
content.

## 9. PLANNED

Not built yet, listed so the gaps are explicit:

- Recovery code that wraps the desktop content key (decision 17)
- Second desktop paired to one account
- Retention sweep on a timer (`pruneExpired` exists and is unscheduled)
- Rate limiting per device
- The phone's local 90 day backup store (decision 15)
