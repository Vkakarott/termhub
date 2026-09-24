import { useEffect, useRef, useState } from 'react';
import { AppText } from './text';

function formatCountdown(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function Countdown({ until, onExpire }: { until: string; onExpire?(): void }) {
  const target = new Date(until).getTime();
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, target - Date.now()));
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    const initial = Math.max(0, target - Date.now());
    setRemainingMs(initial);
    if (initial === 0) {
      // Already expired by the time this mounted: fire once here, no interval needed.
      onExpireRef.current?.();
      return;
    }
    const id = setInterval(() => {
      const next = Math.max(0, target - Date.now());
      setRemainingMs(next);
      if (next === 0) {
        clearInterval(id);
        onExpireRef.current?.();
      }
    }, 1000);
    return () => clearInterval(id);
  }, [target]);

  return <AppText variant="code">{formatCountdown(remainingMs)}</AppText>;
}
