/**
 * Built-in branch-name generator for the worktree flow (spec:
 * docs/superpowers/specs/2026-10-11-command-center-worktrees-themes-design.md,
 * "Clarification 2026-10-13", section 2). Pure and dependency-free: the caller injects the RNG so tests are
 * deterministic. All words are lowercase ASCII and pass `git check-ref-format` unchanged.
 * The name format is fixed (`{adjective}-{noun}`); there is intentionally no user-facing
 * template setting (review 2026-10-13: a free-form template is an error surface).
 */

const ADJECTIVES = [
  "sleepy",
  "grumpy",
  "sneaky",
  "confused",
  "lazy",
  "fearless",
  "clumsy",
  "awkward",
  "dramatic",
  "suspicious",
  "chaotic",
  "cursed",
  "mysterious",
  "invisible",
  "spicy",
  "wobbly",
  "fluffy",
  "tiny",
  "giant",
  "angry",
  "dizzy",
  "fancy",
  "funky",
  "silly",
  "crazy",
  "dancing",
  "flying",
  "hungry",
  "nervous",
  "legendary",
  "cosmic",
  "quantum",
  "galactic",
  "orbital",
  "lunar",
  "stellar",
  "interstellar",
  "solar",
  "nebular",
  "alien",
  "radioactive",
  "hypersonic",
  "intergalactic",
] as const;

const ANIMALS = [
  "capybara",
  "penguin",
  "raccoon",
  "otter",
  "platypus",
  "goose",
  "llama",
  "panda",
  "axolotl",
  "hamster",
  "walrus",
  "octopus",
  "sloth",
  "koala",
  "ferret",
  "hedgehog",
  "lobster",
  "alpaca",
  "meerkat",
  "chinchilla",
] as const;

const FANTASY = [
  "wizard",
  "goblin",
  "dragon",
  "kraken",
  "ninja",
  "unicorn",
  "ghost",
  "phoenix",
  "troll",
  "gremlin",
  "yeti",
  "vampire",
  "zombie",
  "elf",
  "orc",
] as const;

const OBJECTS = [
  "potato",
  "toaster",
  "waffle",
  "pickle",
  "banana",
  "donut",
  "pancake",
  "marshmallow",
  "cactus",
  "taco",
  "burrito",
  "noodle",
  "cupcake",
  "muffin",
  "avocado",
  "pineapple",
  "teapot",
  "rubberduck",
  "popcorn",
  "cookie",
] as const;

/**
 * Pattern weights keep mundane combinations common and cross-group mashups rare
 * (weights confirmed by the user, 2026-10-13).
 */
const NOUN_PATTERNS: ReadonlyArray<{ nouns: readonly string[]; weight: number }> = [
  { nouns: ANIMALS, weight: 35 },
  { nouns: FANTASY, weight: 20 },
  { nouns: OBJECTS, weight: 20 },
  { nouns: [...ANIMALS, ...FANTASY, ...OBJECTS], weight: 25 },
];

const NOUN_PATTERN_TOTAL_WEIGHT = NOUN_PATTERNS.reduce((sum, pattern) => sum + pattern.weight, 0);

type RandomSource = () => number;

function pickWord(words: readonly string[], random: RandomSource): string {
  return words[Math.floor(random() * words.length)]!;
}

function pickAdjective(random: RandomSource): string {
  return pickWord(ADJECTIVES, random);
}

function pickNoun(random: RandomSource): string {
  let roll = random() * NOUN_PATTERN_TOTAL_WEIGHT;
  const pattern =
    NOUN_PATTERNS.find((candidate) => {
      roll -= candidate.weight;
      return roll < 0;
    }) ?? NOUN_PATTERNS[0]!;
  return pickWord(pattern.nouns, random);
}

/** One generated `<adjective>-<noun>` candidate; single source of the fixed name format. */
export function generateWorktreeBranchNameCandidate(random: RandomSource = Math.random): string {
  return `${pickAdjective(random)}-${pickNoun(random)}`;
}

/**
 * Generate a branch name, retrying when the composed candidate is already taken. `isTaken`
 * receives the RAW generated name so the caller composes the branch prefix first (the
 * composed value is what collides with real branches). After the attempt budget runs out the
 * last candidate is returned as-is; the existing branch-name validation and the server stay
 * authoritative for the leftover conflict.
 */
export function generateWorktreeBranchName({
  isTaken = () => false,
  random = Math.random,
  maxAttempts = 10,
}: {
  isTaken?: (candidate: string) => boolean;
  random?: RandomSource;
  maxAttempts?: number;
} = {}): string {
  let candidate = generateWorktreeBranchNameCandidate(random);
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    if (!isTaken(candidate)) {
      return candidate;
    }
    candidate = generateWorktreeBranchNameCandidate(random);
  }
  return candidate;
}
