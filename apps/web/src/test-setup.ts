import { configure } from '@testing-library/dom';

// testing-library's default `waitFor`/`findBy*` timeout is 1 s. On the GitHub runner, with the
// whole suite in parallel workers, a screen that renders in ~50 ms here takes longer than that
// often enough to fail a run (BoardColumnsSettings "renames on blur" timed out on main once).
// 5 s changes nothing for a passing test — waitFor resolves as soon as the assertion holds —
// and only stops a slow worker from being read as a bug.
configure({ asyncUtilTimeout: 5_000 });
