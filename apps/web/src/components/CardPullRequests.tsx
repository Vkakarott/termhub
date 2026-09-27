import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { PullRequestBadge } from '../lib/types';
import { PullRequestBadges } from './ProgressPanel';

/** The card's pull requests with CI and deploy (spec 2026-09-26 progress-panel §5.6); nothing when it has none. */
export function CardPullRequests({ taskId }: { taskId: string }) {
  const [pulls, setPulls] = useState<PullRequestBadge[]>([]);
  useEffect(() => {
    let alive = true;
    api.tasks.pullRequests(taskId).then(
      (r) => alive && setPulls(r.pull_requests),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [taskId]);
  if (pulls.length === 0) return null;
  return (
    <div className="space-y-1">
      <h3 className="text-xs font-medium uppercase text-zinc-500">Pull requests</h3>
      <PullRequestBadges pulls={pulls} />
    </div>
  );
}
