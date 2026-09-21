/**
 * Terminal tabs are named after fictional teammates ("Alex", "Blair", ...) instead of
 * "Terminal 1", "Terminal 2": with several agents running side by side, a name is much
 * easier to refer to than a number.
 */
const TEAMMATE_NAMES = [
  'Alex', 'Blair', 'Casey', 'Dana', 'Emory', 'Finn', 'Greta', 'Hugo', 'Ines', 'Jonas',
  'Kai', 'Lena', 'Milo', 'Nina', 'Otto', 'Pia', 'Quinn', 'Rio', 'Sasha', 'Theo',
  'Uma', 'Vera', 'Wren', 'Xime', 'Yuri', 'Zoe', 'Aria', 'Bruno', 'Cleo', 'Dima',
  'Elia', 'Fritz', 'Gil', 'Hana', 'Ivo', 'June', 'Klaus', 'Luca', 'Mira', 'Noor',
  'Olga', 'Pedro', 'Rune', 'Sven', 'Tova', 'Ugo', 'Vito', 'Wanda', 'Yann', 'Zara',
];

/**
 * Picks a teammate name that no tab in the project uses yet (case-insensitive). Once the
 * pool is exhausted, names repeat with a suffix ("Alex 2") so the result is always unique.
 */
export function nextTerminalName(existingNames: string[]): string {
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()));
  const free = TEAMMATE_NAMES.filter((n) => !taken.has(n.toLowerCase()));
  if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
  for (let round = 2; ; round += 1) {
    for (const name of TEAMMATE_NAMES) {
      const candidate = `${name} ${round}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }
}
