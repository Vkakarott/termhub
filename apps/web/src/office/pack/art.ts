/** Pixel-art desks, agents and displays that live beside the generated pack (PNG files in `./art`). */
import agentVUrl from './art/agent-v.png';
import chairEmptyHUrl from './art/chair-empty-h.png';
import deskNotebookHOffUrl from './art/desk-notebook-h-off.png';
import deskVOff2Url from './art/desk-v-off-2.png';
import displayVOn2Url from './art/display-v-on-2.png';

/** Vite URL for each art file we ship. Keys match sprite ids used by the scene. */
export const ART_URLS: Record<string, string> = {
  'desk/side-v-2': deskVOff2Url,
  'desk/side-h': deskNotebookHOffUrl,
  'display/v-2': displayVOn2Url,
  'agent/side-v': agentVUrl,
  'chair/h': chairEmptyHUrl,
};

/**
 * Shared station registration — layers of a stack share one 1500 canvas transform.
 * Foot sits near the desk legs.
 */
export const STATION_ANCHOR = { x: 0.5, y: 0.84 };

/** @deprecated kept for call sites that keyed by sprite id */
export const ART_ANCHOR: Record<string, { x: number; y: number }> = {
  'desk/side-v-2': STATION_ANCHOR,
  'desk/side-h': STATION_ANCHOR,
  'display/v-2': STATION_ANCHOR,
  'agent/side-v': STATION_ANCHOR,
  'chair/h': STATION_ANCHOR,
};

/** On-screen width of a station sheet (all layers share this scale). */
export const DESK_ART_SIZE = 72 * 0.9;
export type DeskArtKeys = {
  desk: string;
  /** person+chair when occupied; null when empty / phone */
  agent: string | null;
  /** empty chair when no agent; drawn above the empty desk */
  chair: string | null;
  /** lit monitors under the agent; null when the seat is empty */
  display: string | null;
};

/**
 * Occupied: desk-v-2 → display → agent (same place).
 * Empty: desk-h → chair-h on top (same place).
 * `index` is kept for call-site compatibility.
 */
export function deskArtKeys(_index: number, showAgent: boolean): DeskArtKeys {
  if (showAgent) {
    return {
      desk: 'desk/side-v-2',
      agent: 'agent/side-v',
      chair: null,
      display: 'display/v-2',
    };
  }
  return {
    desk: 'desk/side-h',
    agent: null,
    chair: 'chair/h',
    display: null,
  };
}
