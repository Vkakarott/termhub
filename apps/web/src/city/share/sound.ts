/**
 * The city soundscape (spec 2026-09-23 §2.5), synthesised with Web Audio — no audio files, no
 * rights: a low hum, keyboard clicks as dense as the robots typing, and a soft ding when a robot
 * raises its hand. It exists only inside a recording: the output goes to a
 * MediaStreamAudioDestinationNode, never to the speakers, so the page itself stays silent.
 */
import type { CityModel } from '../../office/model';

export type SoundEvent = { kind: 'typing'; typists: number } | { kind: 'ding'; desk: string };

function read(model: CityModel): { typists: number; raised: Set<string> } {
  let typists = 0;
  const raised = new Set<string>();
  for (const building of model.buildings) {
    for (const desk of building.desks) {
      if (desk.pose === 'type') typists += 1;
      // keyed by building too: two buildings may carry desks with the same id
      if (desk.marker === 'input' || desk.marker === 'permission') raised.add(`${building.id}:${desk.id}`);
    }
  }
  return { typists, raised };
}

/** What to play between two snapshots of the model the page draws. `prev` null = the clip starts. */
export function soundEvents(prev: CityModel | null, next: CityModel): SoundEvent[] {
  const now = read(next);
  if (!prev) return now.typists > 0 ? [{ kind: 'typing', typists: now.typists }] : [];
  const before = read(prev);
  const events: SoundEvent[] = [];
  if (now.typists !== before.typists) events.push({ kind: 'typing', typists: now.typists });
  for (const desk of now.raised) if (!before.raised.has(desk)) events.push({ kind: 'ding', desk });
  return events;
}

export interface Soundscape {
  readonly stream: MediaStream;
  play(events: SoundEvent[]): void;
  stop(): void;
}

/** Clicks per second each typing robot contributes, and the most one tick schedules. */
const KEYS_PER_SECOND = 6;
const TICK_MS = 50;
const MAX_CLICKS_PER_TICK = 4;

export function createSoundscape(ctx: AudioContext): Soundscape {
  const out = ctx.createMediaStreamDestination();
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(out);

  // the hum: a low sine and its octave, barely there
  const hum = ctx.createOscillator();
  hum.type = 'sine';
  hum.frequency.value = 55;
  const humOctave = ctx.createOscillator();
  humOctave.type = 'sine';
  humOctave.frequency.value = 110;
  const humGain = ctx.createGain();
  humGain.gain.value = 0.05;
  hum.connect(humGain);
  humOctave.connect(humGain);
  humGain.connect(master);
  hum.start();
  humOctave.start();

  // one key click: 30 ms of noise with a steep decay, reused for every click
  const click = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.03)), ctx.sampleRate);
  const data = click.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 4;
  const clickAt = (when: number) => {
    const src = ctx.createBufferSource();
    src.buffer = click;
    src.playbackRate.value = 0.85 + Math.random() * 0.3;
    const g = ctx.createGain();
    g.gain.value = 0.18;
    src.connect(g);
    g.connect(master);
    src.start(when);
  };

  let typists = 0;
  const timer = setInterval(() => {
    const expected = (typists * KEYS_PER_SECOND * TICK_MS) / 1000;
    let n = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
    n = Math.min(n, MAX_CLICKS_PER_TICK);
    for (let i = 0; i < n; i++) clickAt(ctx.currentTime + Math.random() * (TICK_MS / 1000));
  }, TICK_MS);

  const ding = () => {
    const t = ctx.currentTime;
    for (const [freq, level] of [[880, 0.16], [1320, 0.06]] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(level, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      osc.connect(g);
      g.connect(master);
      osc.start(t);
      osc.stop(t + 1);
    }
  };

  return {
    stream: out.stream,
    play(events) {
      for (const e of events) {
        if (e.kind === 'typing') typists = e.typists;
        else ding();
      }
    },
    stop() {
      clearInterval(timer);
      hum.stop();
      humOctave.stop();
      master.disconnect();
    },
  };
}
