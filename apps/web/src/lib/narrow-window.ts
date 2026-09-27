import { useEffect, useState } from 'react';

/** Below Tailwind's `md` breakpoint a 16rem sidebar leaves too little room for the page. */
const NARROW_QUERY = '(max-width: 767px)';

function narrowNow(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
}

/** Whether the window is phone-sized, following resizes; false where matchMedia is missing (jsdom). */
export function useNarrowWindow(): boolean {
  const [narrow, setNarrow] = useState(narrowNow);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return narrow;
}
