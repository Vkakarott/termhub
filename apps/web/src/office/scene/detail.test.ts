import { describe, expect, it } from 'vitest';
import type { FocusTarget } from '../model';
import { ROOM_SIGN_SCALE, signVisibility } from './detail';

const city: FocusTarget = { kind: 'city' };
const machine: FocusTarget = { kind: 'machine', machineId: 'm1' };
const room: FocusTarget = { kind: 'room', machineId: 'm1', roomId: 'p1' };
const far = ROOM_SIGN_SCALE / 2;
const near = ROOM_SIGN_SCALE;

describe('signVisibility', () => {
  it('shows only machine signs across a city zoomed out', () => {
    expect(signVisibility(city, far, 'm1')).toEqual({ roomSigns: false, machineSign: true });
    expect(signVisibility(city, far, 'm2')).toEqual({ roomSigns: false, machineSign: true });
  });

  it('shows both once the city is zoomed in far enough to read a room sign', () => {
    expect(signVisibility(city, near, 'm1')).toEqual({ roomSigns: true, machineSign: true });
  });

  it('names the rooms of the focused machine and drops its own now-redundant sign', () => {
    expect(signVisibility(machine, near, 'm1')).toEqual({ roomSigns: true, machineSign: false });
    expect(signVisibility(room, near, 'm1')).toEqual({ roomSigns: true, machineSign: false });
  });

  // zoomed out under a machine's own focus: the room signs are unreadable and the block is about to
  // be one building among many again, so its name comes back before `onGoUp` fires
  it('gives the focused machine its sign back once the view is wider than it', () => {
    expect(signVisibility(machine, far, 'm1')).toEqual({ roomSigns: true, machineSign: true });
  });

  it('keeps the signs of the OTHER machines, so the neighbours stay identifiable', () => {
    expect(signVisibility(machine, far, 'm2')).toEqual({ roomSigns: false, machineSign: true });
    expect(signVisibility(machine, near, 'm2')).toEqual({ roomSigns: true, machineSign: true });
  });
});
