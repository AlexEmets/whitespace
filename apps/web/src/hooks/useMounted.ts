'use client';

import { useEffect, useState } from 'react';

/** False on the server render and the first client render, true afterwards. Anything
 * reaching for `document` — a portal target, most obviously — needs to wait for this or
 * it throws during SSR and mismatches on hydration. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
