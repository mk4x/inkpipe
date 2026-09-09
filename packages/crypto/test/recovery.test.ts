import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRecoveryPhrase, isValidRecoveryPhrase, normaliseRecoveryPhrase,
  keysFromRecoveryPhrase, formatRecoveryPhrase, RECOVERY_WORD_COUNT,
} from '../src/recovery.ts';
import { seal, open, sign, verify, toBase64Url } from '../src/index.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('generateRecoveryPhrase', () => {
  test('produces 24 words', () => {
    assert.equal(generateRecoveryPhrase().split(' ').length, RECOVERY_WORD_COUNT);
  });

  test('produces a valid phrase', () => {
    assert.equal(isValidRecoveryPhrase(generateRecoveryPhrase()), true);
  });

  test('never repeats', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateRecoveryPhrase()));
    assert.equal(seen.size, 50);
  });
});

describe('keysFromRecoveryPhrase', () => {
  test('is deterministic: the same phrase gives the same keys', () => {
    // The whole feature rests on this. If it ever stops holding, a restore
    // produces different keys and every pending page becomes unreadable.
    const phrase = generateRecoveryPhrase();
    const a = keysFromRecoveryPhrase(phrase);
    const b = keysFromRecoveryPhrase(phrase);

    assert.deepEqual(a.identity.privateKey, b.identity.privateKey);
    assert.deepEqual(a.identity.publicKey, b.identity.publicKey);
    assert.deepEqual(a.content.privateKey, b.content.privateKey);
    assert.deepEqual(a.content.publicKey, b.content.publicKey);
  });

  test('different phrases give different keys', () => {
    const a = keysFromRecoveryPhrase(generateRecoveryPhrase());
    const b = keysFromRecoveryPhrase(generateRecoveryPhrase());
    assert.notDeepEqual(a.content.privateKey, b.content.privateKey);
    assert.notDeepEqual(a.identity.privateKey, b.identity.privateKey);
  });

  test('the identity and content keys differ from each other', () => {
    // They come from one seed, so distinct HKDF info strings are what keeps
    // them apart. If they ever matched, the signing key would also be the
    // decryption key.
    const keys = keysFromRecoveryPhrase(generateRecoveryPhrase());
    assert.notDeepEqual(keys.identity.privateKey, keys.content.privateKey);
  });

  test('keys are 32 bytes, matching the protocol schema', () => {
    const keys = keysFromRecoveryPhrase(generateRecoveryPhrase());
    for (const key of [
      keys.identity.privateKey, keys.identity.publicKey,
      keys.content.privateKey, keys.content.publicKey,
    ]) {
      assert.equal(key.length, 32);
    }
    assert.equal(toBase64Url(keys.identity.publicKey).length, 43);
  });

  test('rejects an invalid phrase rather than deriving nonsense', () => {
    // Silently deriving from a mistyped phrase would give working-looking keys
    // that open nothing, which is far worse than an error.
    for (const bad of [
      'not a real recovery phrase at all',
      '',
      'abandon abandon abandon',
      `${'abandon '.repeat(23)}abandon`, // 24 real words, wrong checksum
    ]) {
      assert.throws(() => keysFromRecoveryPhrase(bad), /valid recovery phrase/);
    }
  });
});

describe('the recovered keys actually work', () => {
  test('a page sealed before the loss opens after recovery', () => {
    // The scenario the feature exists for: the desktop dies, a page is already
    // sealed to its public key and sitting on the server, and a new machine
    // must be able to open it from the phrase alone.
    const phrase = generateRecoveryPhrase();
    const original = keysFromRecoveryPhrase(phrase);

    const page = bytes('the contents of a lecture page');
    const sealed = seal(page, original.content.publicKey);

    // ... disk failure, new machine, only the phrase survives ...
    const recovered = keysFromRecoveryPhrase(phrase);
    const opened = open(sealed, recovered.content.privateKey);

    assert.equal(new TextDecoder().decode(opened), 'the contents of a lecture page');
  });

  test('the recovered identity signs so the server still recognises the device', () => {
    const phrase = generateRecoveryPhrase();
    const original = keysFromRecoveryPhrase(phrase);
    const recovered = keysFromRecoveryPhrase(phrase);

    const message = bytes('GET\n/blobs\n2026-09-09T12:00:00.000Z\nabc');
    const signature = sign(message, recovered.identity.privateKey);

    assert.equal(verify(signature, message, original.identity.publicKey), true,
      'the server holds the ORIGINAL public key and must accept the recovered signature');
  });

  test('a wrong phrase cannot open the page', () => {
    const sealed = seal(bytes('secret'), keysFromRecoveryPhrase(generateRecoveryPhrase()).content.publicKey);
    const attacker = keysFromRecoveryPhrase(generateRecoveryPhrase());
    assert.throws(() => open(sealed, attacker.content.privateKey));
  });
});

describe('normaliseRecoveryPhrase', () => {
  test('accepts a phrase typed the way a human types it', () => {
    const phrase = generateRecoveryPhrase();
    const words = phrase.split(' ');

    const mangled = [
      phrase.toUpperCase(),
      `  ${phrase}  `,
      phrase.replace(/ /g, '  '),
      `${words.slice(0, 12).join(' ')}\n${words.slice(12).join(' ')}`,
      `${words[0][0].toUpperCase()}${words[0].slice(1)} ${words.slice(1).join(' ')}`,
      phrase.replace(/ /g, ', '),
    ];

    for (const variant of mangled) {
      assert.equal(normaliseRecoveryPhrase(variant), phrase, `failed for ${JSON.stringify(variant.slice(0, 40))}`);
      assert.equal(isValidRecoveryPhrase(variant), true);
      assert.deepEqual(
        keysFromRecoveryPhrase(variant).content.privateKey,
        keysFromRecoveryPhrase(phrase).content.privateKey,
        'a cosmetically different phrase must derive identical keys',
      );
    }
  });

  test('does not accept a word that is not in the wordlist', () => {
    const words = generateRecoveryPhrase().split(' ');
    words[5] = 'zzzz';
    assert.equal(isValidRecoveryPhrase(words.join(' ')), false);
  });

  test('does not accept a valid wordlist phrase with a bad checksum', () => {
    // Fixed vectors, not a randomly mutated phrase. Swapping one word in a
    // generated mnemonic leaves roughly a 1 in 256 chance the checksum still
    // passes, which made an earlier version of this test flaky.
    const canonical = `${'abandon '.repeat(23)}art`;   // all-zero entropy, valid
    const corrupted = `${'abandon '.repeat(23)}abandon`; // same words, bad checksum

    assert.equal(isValidRecoveryPhrase(canonical), true, 'the known-good vector must pass');
    assert.equal(isValidRecoveryPhrase(corrupted), false, 'the known-bad checksum must fail');
  });
});

describe('formatRecoveryPhrase', () => {
  test('groups into rows of four for writing down', () => {
    const rows = formatRecoveryPhrase(generateRecoveryPhrase());
    assert.equal(rows.length, 6);
    assert.equal(rows.every((r) => r.length === 4), true);
  });

  test('keeps every word, in order', () => {
    const phrase = generateRecoveryPhrase();
    assert.equal(formatRecoveryPhrase(phrase).flat().join(' '), phrase);
  });
});
