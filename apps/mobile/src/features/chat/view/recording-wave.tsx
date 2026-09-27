import { useEffect, useState } from 'react';
import { View } from 'react-native';

/** How many bars the wave keeps: the newest on the right, the oldest dropping off the left. */
const BARS = 28;
/** A silent bar is a dot; a loud one is as tall as the text line. */
const DOT = 4;
const TALLEST = 22;

/** Heights for a recorder that reports no level: a slow ripple that moves once a second, so the pill
 * still looks alive without pretending to follow the voice. */
function ripple(seconds: number): number[] {
  return Array.from({ length: BARS }, (_, i) => ((i * 7 + seconds * 3) % 5) / 8);
}

/**
 * The recording pill's wave (ChatGPT's): dots while it is quiet, bars that rise with the microphone's
 * level as the person speaks. `level` is the latest reading (0–1) or `null` when the recorder reports
 * none; `seconds` drives the fallback ripple. Decorative: the clock beside it says what it means.
 */
export function RecordingWave({ level, seconds }: { level: number | null; seconds: number }) {
  const [history, setHistory] = useState<number[]>(() => Array.from({ length: BARS }, () => 0));
  useEffect(() => {
    if (level === null) return;
    setHistory((h) => [...h.slice(1), level]);
  }, [level]);
  const bars = level === null ? ripple(seconds) : history;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="recording-wave" className="h-6 flex-1 flex-row items-center justify-between overflow-hidden">
      {bars.map((v, i) => (
        <View key={i} style={{ height: DOT + v * (TALLEST - DOT) }} className="w-1 rounded-full bg-app-text" />
      ))}
    </View>
  );
}
