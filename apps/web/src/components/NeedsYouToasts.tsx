import { useEffect, useRef } from 'react';
import { useData } from '../lib/data';
import { useMonitor } from '../lib/monitor';
import { needsYouText } from '../lib/needs-you';
import { useToast } from '../lib/toast';
import { NEEDS_YOU } from '../lib/types';
import { isTabOnScreen } from '../lib/visible-tabs';

/**
 * Turns "a tab started waiting for you" into a toast (top right), except for a tab the person
 * is already looking at. The toast goes away by itself once the tab stops waiting.
 */
export function NeedsYouToasts() {
  const { items, onNeedsYou } = useMonitor();
  const { projects } = useData();
  const { show, dismiss } = useToast();
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  useEffect(
    () =>
      onNeedsYou((tab, projectId) => {
        if (document.visibilityState === 'visible' && isTabOnScreen(tab.id)) return;
        const project = projectsRef.current.find((p) => p.id === projectId);
        show({
          id: tab.id,
          title: `${project?.name ?? 'Projeto'} › ${tab.name}`,
          body: needsYouText(tab),
          href: `/projects/${projectId}?tab=${tab.id}`,
        });
      }),
    [onNeedsYou, show],
  );

  useEffect(() => {
    for (const { tab } of items) if (!tab.state || !NEEDS_YOU.includes(tab.state)) dismiss(tab.id);
  }, [items, dismiss]);

  return null;
}
