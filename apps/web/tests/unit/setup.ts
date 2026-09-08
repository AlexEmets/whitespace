import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// vitest.config.ts does not enable `test.globals`, so @testing-library/react's
// auto-cleanup (which detects a global `afterEach`) never registers itself. Do it
// explicitly instead of turning on globals repo-wide for one library's convenience.
afterEach(() => {
  cleanup();
});
