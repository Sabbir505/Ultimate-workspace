// Companion-pet speech lines — curated, species-flavoured, deterministic.
// Bubbles are rare (throttled in the store) and purely decorative: the pet
// never nags, never asks for anything, and never guilt-trips (see the design
// doc — the Duolingo-owl anti-pattern is explicitly out).
//
// `{name}` in a line is replaced with the pet's name at render time.

export type PetLineTrigger =
  | "celebrate"
  | "concerned"
  | "work"
  | "idle"
  | "doze"
  | "morning"
  | "greet"
  | "pet"
  | "adopt";

const LINES: Record<string, Record<PetLineTrigger, string[]>> = {
  cat: {
    celebrate: [
      "purrfect.",
      "another one shipped. i'll allow it.",
      "*successful loaf*",
      "tell the agent i said well done.",
      "that's the good stuff.",
    ],
    concerned: [
      "hssss— it's fine. everything is fine.",
      "*ears flat* that looked expensive.",
      "i have nine lives. your build has zero.",
    ],
    work: [
      "typing intensifies.",
      "i'm helping.",
      "kat typing detected. monitoring.",
    ],
    idle: [
      "the terminal is warm.",
      "*sits on your unbuilt branch*",
      "blink twice if the tests are flaky.",
      "i heard a Merge. was it a dream?",
    ],
    doze: ["zzz… (dreaming of merged PRs)", "*loaf mode* zzz…", "zzz… four hours of sleep, tops."],
    greet: ["you're here. the lap— i mean, the terminal is warm.", "mrrp. good to see you.", "i kept your tabs warm."],
    morning: [
      "the automations behaved. mostly.",
      "good morning. the cron ran. you're welcome.",
      "i watched everything overnight. we're good.",
    ],
    pet: ["prrrrrb.", "*slow blink* acceptable.", "more. exactly like that."],
    adopt: ["fine, i'll supervise.", "*claims the warm laptop spot*", "you may pet the supervisor."],
  },
  axolotl: {
    celebrate: [
      "blblblb!!",
      "axolotl of approval!",
      "*happy wiggle* we did it!",
      "smol celebration, big smile.",
    ],
    concerned: [
      "blb… that error looked spiky.",
      "*gills droop* do we panic now?",
      "regeneration engaged. it's fine.",
    ],
    work: ["blblb… working smol", "fingers of typing! so many!", "watching the agent. intently."],
    idle: [
      "the water is nice today.",
      "did you know? i am always smiling.",
      "*floats*",
      "smol pet, big support.",
    ],
    doze: ["*sleepy float* blb…", "zzz… (still smiling)", "*drifts* blblb…"],
    greet: ["blb!! you're back!", "*happy wiggle* hello again!", "the tank missed you."],
    morning: [
      "morning! the automations swam well.",
      "blb! i counted the runs for you.",
      "overnight report: all smiles.",
    ],
    pet: ["blblblb!! *wiggle*", "*gills perk up*", "smol happy sounds."],
    adopt: ["blb! new tank!", "*immediately smiles*", "i will regenerate your motivation."],
  },
  robot: {
    celebrate: [
      "TASK_COMPLETE.exe",
      "success probability: 100%. as planned.",
      "beep. well done, humans.",
      "victory routine initiated.",
    ],
    concerned: [
      "ERROR DETECTED. remaining calm.",
      "*fan spins up* this is fine.",
      "0 errors found. …creating some.",
    ],
    work: ["compiling moral support…", "beep boop. agents at work.", "utilization: 100%"],
    idle: [
      "beep.",
      "standby mode. still judging.",
      "did you know: i am 96% pet, 4% firmware.",
      "battery: full. snark: charging.",
    ],
    doze: ["charging… do not disturb.", "sleep mode. dreams in binary.", "zzz… (fan off)"],
    greet: ["SYSTEM ONLINE. hello.", "beep. resuming companionship.", "you have returned. logging joy."],
    morning: [
      "overnight report: robots win again.",
      "good morning. 0 crashes detected. impressive.",
      "the cron ran while you dreamed.",
    ],
    pet: ["*happy fan noise*", "affection received. logging it.", "beep! beep! beep!"],
    adopt: ["BOOT SEQUENCE: friendship.", "new chassis smell.", "i will run forever for you."],
  },
};

/** Pick a random line for a species+trigger. Falls back to the cat's lines
 *  (never throws — a missing species must not crash the pet). */
export function petLine(
  species: string,
  trigger: PetLineTrigger,
  name: string,
  rng: () => number = Math.random,
): string | null {
  const byTrigger = LINES[species] ?? LINES.cat;
  const pool = byTrigger[trigger];
  if (!pool || pool.length === 0) return null;
  return pool[Math.floor(rng() * pool.length)].replace(/\{name\}/g, name);
}
