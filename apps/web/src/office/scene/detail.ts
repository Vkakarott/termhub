/** What the overlay is allowed to say at a given zoom. Pure: no PixiJS, so it can be tested alone. */
import type { FocusTarget } from '../model';

/**
 * Zoom from which a block reads as a floor rather than as one building on a map. Signs keep their
 * screen size, so below this the room signs of every machine in view pile on each other and on
 * their neighbours' blocks — only the machine's own sign is left there.
 */
export const ROOM_SIGN_SCALE = 0.7;

/** Which of the two signs a machine shows: never both for the machine the person is already inside. */
export function signVisibility(target: FocusTarget, scale: number, machineId: string): { roomSigns: boolean; machineSign: boolean } {
  const focused = target.kind === 'city' ? null : target.machineId;
  return {
    // inside a machine its rooms are always named; elsewhere only once the zoom makes them readable
    roomSigns: focused === machineId || scale >= ROOM_SIGN_SCALE,
    // the name of the machine you are standing in is redundant — until you zoom back out of it
    machineSign: focused !== machineId || scale < ROOM_SIGN_SCALE,
  };
}
