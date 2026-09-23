/**
 * Claude Code's default spinner verbs ("✻ Moonwalking… (12s · esc to interrupt)"): the only verbs
 * the public city may show. A person can replace or extend the list with their own words
 * (settings.json `spinnerVerbs`), and those are theirs — the office shows them, the street does not.
 *
 * The union of the list older Claude Code releases shipped and the one current releases ship,
 * kept to what the hook script can send at all (2-24 ASCII letters): "Beboppin'", "Flambéing",
 * "Sautéing" and the hyphenated ones ("Dilly-dallying"…) never reach the server, so they are left out.
 * A word Claude Code adds later simply stays off the street until it is added here.
 */
const DEFAULT_SPINNER_VERBS: ReadonlySet<string> = new Set([
  'Accomplishing', 'Actioning', 'Actualizing', 'Architecting', 'Baking', 'Beaming', 'Befuddling',
  'Billowing', 'Blanching', 'Bloviating', 'Boogieing', 'Boondoggling', 'Booping', 'Bootstrapping',
  'Brewing', 'Bunning', 'Burrowing', 'Calculating', 'Canoodling', 'Caramelizing', 'Cascading',
  'Catapulting', 'Cerebrating', 'Channeling', 'Channelling', 'Choreographing', 'Churning',
  'Clauding', 'Coalescing', 'Cogitating', 'Combobulating', 'Composing', 'Computing', 'Concocting',
  'Conjuring', 'Considering', 'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching',
  'Crystallizing', 'Cultivating', 'Deciphering', 'Deliberating', 'Determining', 'Discombobulating',
  'Divining', 'Doing', 'Doodling', 'Drizzling', 'Ebbing', 'Effecting', 'Elucidating',
  'Embellishing', 'Enchanting', 'Envisioning', 'Evaporating', 'Fermenting', 'Finagling',
  'Flibbertigibbeting', 'Flowing', 'Flummoxing', 'Fluttering', 'Forging', 'Forming', 'Frolicking',
  'Frosting', 'Gallivanting', 'Galloping', 'Garnishing', 'Generating', 'Germinating',
  'Gesticulating', 'Gitifying', 'Grooving', 'Gusting', 'Harmonizing', 'Hashing', 'Hatching',
  'Herding', 'Honking', 'Hullaballooing', 'Hustling', 'Hyperspacing', 'Ideating', 'Imagining',
  'Improvising', 'Incubating', 'Inferring', 'Infusing', 'Ionizing', 'Jitterbugging', 'Jiving',
  'Julienning', 'Kneading', 'Leavening', 'Levitating', 'Lollygagging', 'Manifesting', 'Marinating',
  'Meandering', 'Metamorphosing', 'Misting', 'Moonwalking', 'Moseying', 'Mulling', 'Musing',
  'Mustering', 'Nebulizing', 'Nesting', 'Newspapering', 'Noodling', 'Nucleating', 'Orbiting',
  'Orchestrating', 'Osmosing', 'Perambulating', 'Percolating', 'Perusing', 'Philosophising',
  'Photosynthesizing', 'Pollinating', 'Pondering', 'Pontificating', 'Pouncing', 'Precipitating',
  'Prestidigitating', 'Processing', 'Proofing', 'Propagating', 'Puttering', 'Puzzling',
  'Quantumizing', 'Razzmatazzing', 'Recombobulating', 'Reticulating', 'Roosting', 'Ruminating',
  'Scampering', 'Scheming', 'Schlepping', 'Scurrying', 'Seasoning', 'Shenaniganing', 'Shimmying',
  'Shucking', 'Simmering', 'Skedaddling', 'Sketching', 'Slithering', 'Smooshing', 'Spelunking',
  'Spinning', 'Sprouting', 'Stewing', 'Sublimating', 'Sussing', 'Swirling', 'Swooping',
  'Symbioting', 'Synthesizing', 'Tempering', 'Thinking', 'Thundering', 'Tinkering', 'Tomfoolering',
  'Transfiguring', 'Transmuting', 'Twisting', 'Undulating', 'Unfurling', 'Unravelling', 'Vibing',
  'Waddling', 'Wandering', 'Warping', 'Whatchamacalliting', 'Whirlpooling', 'Whirring', 'Whisking',
  'Wibbling', 'Wizarding', 'Working', 'Wrangling', 'Zesting', 'Zigzagging',
]);

/** The verb when it is one of Claude Code's defaults, null for anything else (a custom verb, garbage, null). */
export function publicSpinnerVerb(verb: string | null | undefined): string | null {
  return typeof verb === 'string' && DEFAULT_SPINNER_VERBS.has(verb) ? verb : null;
}
