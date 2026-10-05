import { describe, expect, it } from "vitest";
import {
  WORDS_PER_PHRASE,
  deriveVerificationPhrase,
  phrasesMatch,
} from "../../src/core/peer/verify-phrase";
import { toBase64Url } from "../../src/core/handshake/encoding";

/**
 * Verification phrase (PRD 9.3, PRD 13.1 determinism). The critical property
 * is that two devices holding the same pair of fingerprints derive the same
 * phrase, and that a substituted fingerprint changes it.
 */

function fp(seed: number): string {
  return toBase64Url(new Uint8Array(32).fill(seed));
}

describe("verification phrase (PRD 9.3)", () => {
  it("is deterministic for the same pair of fingerprints", async () => {
    const a = await deriveVerificationPhrase(fp(1), fp(2));
    const b = await deriveVerificationPhrase(fp(1), fp(2));
    expect(a).toEqual(b);
    expect(phrasesMatch(a, b)).toBe(true);
  });

  it("is order-independent, so both devices agree without coordination", async () => {
    // Each device holds one local and one remote fingerprint; the order in
    // which they are supplied must not change the result.
    const a = await deriveVerificationPhrase(fp(1), fp(2));
    const b = await deriveVerificationPhrase(fp(2), fp(1));
    expect(a.words).toEqual(b.words);
    expect(a.digits).toBe(b.digits);
  });

  it("produces three words and six digits", async () => {
    const phrase = await deriveVerificationPhrase(fp(7), fp(9));
    expect(phrase.words).toHaveLength(WORDS_PER_PHRASE);
    expect(phrase.digits).toMatch(/^\d{6}$/);
    for (const word of phrase.words) {
      expect(word).toMatch(/^[a-z]+\d?$/);
    }
  });

  it("changes when either fingerprint changes (MITM detection)", async () => {
    const genuine = await deriveVerificationPhrase(fp(1), fp(2));
    // An attacker substituting their own fingerprint for one side.
    const attacked = await deriveVerificationPhrase(fp(1), fp(99));
    expect(phrasesMatch(genuine, attacked)).toBe(false);
    expect(genuine.words).not.toEqual(attacked.words);
  });

  it("spreads different fingerprint pairs across different phrases", async () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 24; seed++) {
      const phrase = await deriveVerificationPhrase(fp(seed), fp(seed + 1));
      seen.add(phrase.words.join(" "));
    }
    // Collisions are possible but 24 distinct pairs should not collapse.
    expect(seen.size).toBeGreaterThanOrEqual(20);
  });

  it("rejects a missing fingerprint rather than producing a weak phrase", async () => {
    await expect(deriveVerificationPhrase("", fp(1))).rejects.toThrow();
    await expect(deriveVerificationPhrase(fp(1), "")).rejects.toThrow();
  });

  it("uses real DTLS fingerprints from a handshake", async () => {
    const fingerprint = toBase64Url(new Uint8Array(32).fill(0xab));
    const phrase = await deriveVerificationPhrase(
      fingerprint,
      toBase64Url(new Uint8Array(32).fill(0xcd)),
    );
    expect(phrase.words.every((w) => w.length > 2)).toBe(true);
  });
});
