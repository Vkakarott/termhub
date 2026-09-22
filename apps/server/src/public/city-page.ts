import type { Repositories } from '../db/repositories/index.js';
import { normalizeNickname } from './nickname.js';
import { readPublicCity } from './read.js';
import type { PublicCity } from './city.js';

/** Where along `/city/@nick[/building][?room=]` a link points. */
export interface CityDepth {
  building?: string;
  room?: string;
}

interface CityMeta {
  title: string;
  description: string;
  image: string;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Every value spliced into the document — an owner's, a machine's or a project's name — was written by someone else: never trust it as markup. */
function attr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** The neutral document for a nickname nobody can read a city out of: no name, the landing's own card. */
const FALLBACK_TITLE = 'Cidade não encontrada · termhub';
const FALLBACK_DESCRIPTION = 'Cada tab é uma sessão tmux que sobrevive ao navegador. Self-hosted, open source (MIT).';
const FALLBACK_IMAGE = 'https://termhub.dev/og-image.png';

/** The card this depth's link unfurls to — same nickname and `?building=`/`?room=` the page itself carries (Task 9's route). */
function cardImageUrl(nickname: string, depth: CityDepth): string {
  const params = new URLSearchParams();
  if (depth.building) params.set('building', depth.building);
  if (depth.room) params.set('room', depth.room);
  const qs = params.toString();
  return `https://termhub.dev/api/public/city/${encodeURIComponent(nickname)}/card.png${qs ? `?${qs}` : ''}`;
}

/**
 * The link preview's text for the depth a `/city/@nick[/building][?room=]` URL points at: the city,
 * one of its buildings, or one of a building's rooms. A depth id that matches nothing in the city
 * (stale link, wrong id) resolves one level up, the same forgiving rule `buildCardSvg` uses — never
 * a broken page over a slightly-too-shallow one.
 */
export function cityMetaFor(city: PublicCity | undefined, depth: CityDepth): CityMeta {
  if (!city) return { title: FALLBACK_TITLE, description: FALLBACK_DESCRIPTION, image: FALLBACK_IMAGE };
  const building = depth.building ? city.buildings.find((b) => b.id === depth.building) : undefined;
  const room = building && depth.room ? building.rooms.find((r) => r.id === depth.room) : undefined;
  const image = cardImageUrl(city.nickname, { building: building?.id, room: room?.id });
  if (room) {
    return {
      title: `${room.name} — a cidade de ${city.owner_name}`,
      description: `${room.name}, em ${building!.name}: um projeto publicado na cidade de ${city.owner_name} no termhub.`,
      image,
    };
  }
  if (building) {
    return {
      title: `${building.name} — a cidade de ${city.owner_name}`,
      description: `${building.name}, uma das máquinas publicadas na cidade de ${city.owner_name} no termhub.`,
      image,
    };
  }
  return {
    title: `A cidade de ${city.owner_name} no termhub`,
    description: `Terminais e projetos publicados por ${city.owner_name}, ao vivo, no termhub.`,
    image,
  };
}

/** Splices the depth's title and Open Graph tags into the city bundle's raw document, every value escaped into the attribute. */
export function renderCityDocument(html: string, meta: CityMeta): string {
  const withTitle = html.replace(/<title>[^<]*<\/title>/, `<title>${attr(meta.title)}</title>`);
  const tags = [
    `<meta property="og:title" content="${attr(meta.title)}" />`,
    `<meta property="og:description" content="${attr(meta.description)}" />`,
    `<meta property="og:image" content="${attr(meta.image)}" />`,
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

/** The nickname and the depth of a `/city/@nick[/building]?room=` request URL — the server-side mirror of `apps/web/src/city/url.ts`. */
export function depthFromCityUrl(url: string): { nickname: string; depth: CityDepth } {
  const [pathname = '', search = ''] = url.split('?');
  const parts = pathname.split('/').filter(Boolean); // ['city', '@nick', 'building'?]
  const nickname = (segment(parts[1]) ?? '').replace(/^@/, '');
  return { nickname, depth: { building: segment(parts[2]), room: new URLSearchParams(search).get('room') ?? undefined } };
}

/**
 * The public city document: `dist-city`'s own `index-city.html`, with the title and Open Graph tags
 * set for the depth this URL points at. Never refuses on its own — an unknown or malformed nickname
 * renders the same neutral, name-free document a crawler would otherwise see for a broken link; the
 * page itself is what shows *Cidade não encontrada* once it fetches the snapshot.
 */
export async function renderCityPage(repos: Repositories, template: string, url: string): Promise<string> {
  const { nickname, depth } = depthFromCityUrl(url);
  const parsed = normalizeNickname(nickname);
  const city = parsed.ok ? await readPublicCity(repos, parsed.value) : undefined;
  return renderCityDocument(template, cityMetaFor(city, depth));
}
