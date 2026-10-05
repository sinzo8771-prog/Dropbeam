/**
 * Verification phrase — the man-in-the-middle check (PRD 9.3).
 *
 * Both DTLS fingerprints are sorted, hashed with SHA-256, and mapped onto
 * three words from a fixed 2048-word list. Because both sides derive the
 * phrase from the *same* two fingerprints, a substituted fingerprint (an
 * attacker in the middle) produces different words on the two devices, and the
 * mismatch is visible at a glance.
 *
 * The word list is a small, curated, dependency-free subset: no network fetch,
 * no third-party word source, and no randomness in the derivation itself.
 */

/** 2048 = 2^11 words, so 11 bits of the digest select one word per position. */
export const WORDS_PER_PHRASE = 3;
const WORD_BITS = 11;
const WORD_COUNT = 1 << WORD_BITS; // 2048

const WORD_LIST: string[] = [
  "acorn",
  "amber",
  "anchor",
  "apple",
  "apron",
  "arrow",
  "aspen",
  "atlas",
  "autumn",
  "bacon",
  "badge",
  "bamboo",
  "basin",
  "beacon",
  "berry",
  "birch",
  "blanket",
  "bloom",
  "board",
  "bonnet",
  "boulder",
  "bracket",
  "branch",
  "brave",
  "breeze",
  "brick",
  "bridge",
  "bronze",
  "brook",
  "brush",
  "bubble",
  "bucket",
  "buffalo",
  "burrow",
  "butter",
  "cabin",
  "cable",
  "cactus",
  "candle",
  "canoe",
  "canvas",
  "canyon",
  "carbon",
  "cargo",
  "carpet",
  "carrot",
  "castle",
  "cedar",
  "cello",
  "chalk",
  "cherry",
  "chess",
  "chime",
  "cider",
  "cinema",
  "circle",
  "civic",
  "clay",
  "clever",
  "cliff",
  "cloud",
  "clover",
  "coast",
  "cocoa",
  "collar",
  "comet",
  "compass",
  "copper",
  "coral",
  "cotton",
  "county",
  "cove",
  "crane",
  "crate",
  "crayon",
  "creek",
  "crest",
  "cricket",
  "crown",
  "crystal",
  "cubic",
  "cupid",
  "curate",
  "curtain",
  "cushion",
  "cypress",
  "dagger",
  "dahlia",
  "daisy",
  "dancer",
  "dawn",
  "delta",
  "denim",
  "desert",
  "diamond",
  "diner",
  "dolphin",
  "donut",
  "dragon",
  "drama",
  "dream",
  "drift",
  "drum",
  "dune",
  "eagle",
  "earth",
  "echo",
  "eclipse",
  "elbow",
  "ember",
  "emerald",
  "engine",
  "enigma",
  "escape",
  "ether",
  "fabric",
  "falcon",
  "fable",
  "feather",
  "fern",
  "ferret",
  "fiber",
  "flame",
  "flask",
  "flint",
  "flora",
  "flute",
  "forest",
  "fossil",
  "fountain",
  "fox",
  "fresco",
  "frost",
  "galaxy",
  "gallery",
  "garnet",
  "gazelle",
  "ginger",
  "glacier",
  "glider",
  "granite",
  "graphite",
  "gravel",
  "grotto",
  "guitar",
  "gull",
  "harbor",
  "hazel",
  "heather",
  "heron",
  "hickory",
  "hollow",
  "honey",
  "horizon",
  "hunter",
  "indigo",
  "island",
  "ivory",
  "jade",
  "jasmine",
  "jasper",
  "jungle",
  "juniper",
  "kayak",
  "kettle",
  "kindle",
  "koala",
  "lagoon",
  "lantern",
  "larch",
  "lark",
  "laurel",
  "lavender",
  "ledger",
  "lemon",
  "lilac",
  "linen",
  "lizard",
  "lotus",
  "lumber",
  "lunar",
  "lyric",
  "magnet",
  "magnolia",
  "mallard",
  "mango",
  "maple",
  "marble",
  "marina",
  "meadow",
  "melody",
  "mesa",
  "mica",
  "mint",
  "mirror",
  "monsoon",
  "moss",
  "mulberry",
  "mustard",
  "nectar",
  "needle",
  "nickel",
  "nimbus",
  "noble",
  "nomad",
  "nutmeg",
  "oasis",
  "oat",
  "obelisk",
  "ocean",
  "olive",
  "onyx",
  "opal",
  "orbit",
  "orchid",
  "oregano",
  "otter",
  "oxide",
  "oyster",
  "pacific",
  "paddle",
  "palm",
  "pancake",
  "papaya",
  "paprika",
  "pebble",
  "pelican",
  "pepper",
  "petal",
  "pewter",
  "phoenix",
  "piano",
  "pigeon",
  "pilot",
  "pine",
  "pistachio",
  "pixel",
  "plateau",
  "plum",
  "pollen",
  "pond",
  "poplar",
  "porcelain",
  "prairie",
  "puzzle",
  "quarry",
  "quartz",
  "quiver",
  "rabbit",
  "radish",
  "rapids",
  "raven",
  "reef",
  "relic",
  "rhythm",
  "ribbon",
  "ridge",
  "rifle",
  "river",
  "roast",
  "robin",
  "rocket",
  "rosemary",
  "ruby",
  "rustic",
  "saffron",
  "sage",
  "sailor",
  "salmon",
  "sandal",
  "sapphire",
  "satellite",
  "savanna",
  "scarlet",
  "seaglass",
  "sequoia",
  "shadow",
  "shale",
  "shore",
  "sierra",
  "silver",
  "slate",
  "sonnet",
  "sorrel",
  "spark",
  "spruce",
  "squash",
  "starling",
  "stellar",
  "sterling",
  "stone",
  "storm",
  "summit",
  "sunset",
  "swallow",
  "sycamore",
  "tandem",
  "tangerine",
  "tapestry",
  "tempo",
  "thicket",
  "thistle",
  "thunder",
  "timber",
  "tundra",
  "tunnel",
  "tulip",
  "tundra",
  "umber",
  "valley",
  "velvet",
  "venison",
  "vertex",
  "vessel",
  "violet",
  "vista",
  "walnut",
  "warbler",
  "waterfall",
  "weasel",
  "wheat",
  "whisper",
  "willow",
  "window",
  "winter",
  "wisteria",
  "wren",
  "yarrow",
  "yellow",
  "yonder",
  "zephyr",
  "zinnia",
  "zenith",
];

/**
 * The curated list above is a human-sized subset rather than a full 2048-word
 * list; it is extended deterministically (suffix `1`, `2`, …) so every index
 * in 0..2047 maps to a distinct, pronounceable token and the mapping stays
 * total. PRD 9.3 also sanctions the 6-digit form, which is derived alongside
 * the words so a user can read the digits out loud instead.
 */
function wordAt(index: number): string {
  const base = WORD_LIST[index % WORD_LIST.length]!;
  const round = Math.floor(index / WORD_LIST.length);
  return round === 0 ? base : `${base}${round}`;
}

export type VerificationPhrase = {
  /** Three words, e.g. `maple harbor quartz`. */
  words: string[];
  /** The same information as six digits, for read-aloud over a phone. */
  digits: string;
};

/**
 * Derive the phrase from both fingerprints. Order-independent: the caller
 * passes the two fingerprints in any order and gets the same phrase, because
 * both devices hold one local and one remote fingerprint.
 */
export async function deriveVerificationPhrase(
  fingerprintA: string,
  fingerprintB: string,
): Promise<VerificationPhrase> {
  if (!fingerprintA || !fingerprintB) {
    throw new Error("both fingerprints are required");
  }
  const [first, second] = [fingerprintA, fingerprintB].sort();
  const digest = await sha256(`${first}|${second}`);
  const words: string[] = [];
  for (let i = 0; i < WORDS_PER_PHRASE; i++) {
    // Each word consumes 11 bits, taken from the digest in order. A 24-bit
    // window is read so the shift stays non-negative for every offset.
    const bitOffset = i * WORD_BITS;
    const byteOffset = Math.floor(bitOffset / 8);
    const shift = bitOffset % 8; // 0..7
    const chunk =
      ((digest[byteOffset] ?? 0) << 16) |
      ((digest[byteOffset + 1] ?? 0) << 8) |
      (digest[byteOffset + 2] ?? 0);
    const index = (chunk >>> (24 - shift - WORD_BITS)) & (WORD_COUNT - 1);
    words.push(wordAt(index));
  }
  // Six digits from the last six bytes: readable and unambiguous out loud.
  let numeric = 0;
  for (let i = 0; i < 6; i++) numeric = numeric * 256 + (digest[digest.length - 6 + i] ?? 0);
  const digits = String(numeric % 1_000_000).padStart(6, "0");
  return { words, digits };
}

/** SHA-256 via WebCrypto; the digest is what maps onto words. */
async function sha256(text: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest);
}

/** Two phrases match only when the same pair of fingerprints produced them. */
export function phrasesMatch(a: VerificationPhrase, b: VerificationPhrase): boolean {
  return a.words.join(" ") === b.words.join(" ");
}
