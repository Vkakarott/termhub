import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';

interface FocusState {
  /** the page asked for the whole window: Layout hides the sidebar */
  focus: boolean;
  setFocus: (on: boolean) => void;
}

const FocusContext = createContext<FocusState>({ focus: false, setFocus: () => {} });

/** Focus mode lives in the URL (`?focus=1`): a second monitor left open all day must survive a reload. */
export function FocusProvider({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const focus = params.get('focus') === '1';
  const setFocus = useCallback(
    (on: boolean) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (on) next.set('focus', '1');
          else next.delete('focus');
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const value = useMemo(() => ({ focus, setFocus }), [focus, setFocus]);
  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

export function useFocusMode(): FocusState {
  return useContext(FocusContext);
}
