import type { Repositories } from '../db/repositories/index.js';
import { normalizeNickname } from './nickname.js';
import { readPublicCityCached } from './read.js';
import type { PublicCity } from './city.js';

/** Where along `/city/@nick[/building]` a link points. A `?room=` from the links of the city by machine is not read. */
export interface CityDepth {
  building?: string;
}

interface CityMeta {
  title: string;
  description: string;
  image: string;
  /** og:url; absent for the neutral not-found document */
  url?: string;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Every value spliced into the document — an owner's or a project's name — was written by someone else: never trust it as markup. */
function attr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** The neutral document for a nickname nobody can read a city out of: no name, the landing's own card. */
const FALLBACK_TITLE = 'Cidade não encontrada · termhub';
const FALLBACK_DESCRIPTION = 'Cada tab é uma sessão tmux que sobrevive ao navegador. Self-hosted, open source (MIT).';

/**
 * Every absolute URL below is built from this instance's own public-city address
 * (`config.publicCityUrl`, e.g. https://termhub.dev/city), never a hardcoded host: on a self-hosted
 * instance a termhub.dev URL would unfurl to somebody else's city, or to nothing.
 */
const originOf = (base: string) => new URL(base).origin;

/** The card this depth's link unfurls to — the same nickname and `?building=` the page itself carries. */
function cardImageUrl(base: string, nickname: string, depth: CityDepth): string {
  const qs = depth.building ? `?${new URLSearchParams({ building: depth.building }).toString()}` : '';
  return `${originOf(base)}/api/public/city/${encodeURIComponent(nickname)}/card.png${qs}`;
}

/** The canonical address of this depth of the city: the same shape the app's share button copies. */
function cityPageUrl(base: string, nickname: string, depth: CityDepth): string {
  return `${base}/@${encodeURIComponent(nickname)}${depth.building ? `/${encodeURIComponent(depth.building)}` : ''}`;
}

/**
 * The link preview's text for the depth a `/city/@nick[/building]` URL points at: the city, or one
 * of its buildings (a published project). A building id that matches nothing in the city — a stale
 * link, or a machine id from the links of the city by machine — resolves to the city, the same
 * forgiving rule `buildCardSvg` uses: never a broken page over a slightly-too-shallow one.
 */
export function cityMetaFor(city: PublicCity | undefined, depth: CityDepth, base: string): CityMeta {
  if (!city) return { title: FALLBACK_TITLE, description: FALLBACK_DESCRIPTION, image: `${originOf(base)}/og-image.png` };
  const building = depth.building ? city.buildings.find((b) => b.id === depth.building) : undefined;
  const resolved: CityDepth = { building: building?.id };
  const image = cardImageUrl(base, city.nickname, resolved);
  const url = cityPageUrl(base, city.nickname, resolved);
  if (building) {
    return {
      title: `${building.name} — a cidade de ${city.owner_name}`,
      description: `${building.name}, um dos projetos publicados de ${city.owner_name} no termhub.`,
      image,
      url,
    };
  }
  return {
    title: `A cidade de ${city.owner_name} no termhub`,
    description: `Terminais e projetos publicados por ${city.owner_name}, ao vivo, no termhub.`,
    image,
    url,
  };
}

/** Splices the depth's title and Open Graph tags into the city bundle's raw document, every value escaped into the attribute. */
export function renderCityDocument(html: string, meta: CityMeta): string {
  const withTitle = html.replace(/<title>[^<]*<\/title>/, `<title>${attr(meta.title)}</title>`);
  const tags = [
    `<meta property="og:title" content="${attr(meta.title)}" />`,
    `<meta property="og:description" content="${attr(meta.description)}" />`,
    `<meta property="og:image" content="${attr(meta.image)}" />`,
    ...(meta.url ? [`<meta property="og:url" content="${attr(meta.url)}" />`] : []),
  ].join('\n    ');
  return withTitle.replace('</head>', `    ${tags}\n  </head>`);
}

/**
 * One path segment, decoded. A bare `%` makes `decodeURIComponent` throw — the same malformed-escape
 * case `apps/web/src/city/url.ts`'s `segment()` guards on the browser side — so it is handed on raw
 * and resolves to the same not-found meta as any other nickname that does not exist, never a 500.
 */
function segment(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The nickname and the building of a `/city/@nick[/building]` request URL — the server-side mirror of `apps/web/src/city/url.ts`. Any query string (an old `?room=`) is ignored. */
export function depthFromCityUrl(url: string): { nickname: string; depth: CityDepth } {
  const [pathname = ''] = url.split('?');
  const parts = pathname.split('/').filter(Boolean); // ['city', '@nick', 'building'?]
  const nickname = (segment(parts[1]) ?? '').replace(/^@/, '');
  return { nickname, depth: { building: segment(parts[2]) } };
}

/**
 * The public city document: `dist-city`'s own `index-city.html`, with the title and Open Graph tags
 * set for the depth this URL points at. Never refuses on its own — an unknown or malformed nickname
 * renders the same neutral, name-free document a crawler would otherwise see for a broken link; the
 * page itself is what shows *Cidade não encontrada* once it fetches the snapshot.
 */
export async function renderCityPage(repos: Repositories, template: string, url: string, base: string): Promise<string> {
  const { nickname, depth } = depthFromCityUrl(url);
  const parsed = normalizeNickname(nickname);
  const city = parsed.ok ? await readPublicCityCached(repos, parsed.value) : undefined;
  return renderCityDocument(template, cityMetaFor(city, depth, base));
}
