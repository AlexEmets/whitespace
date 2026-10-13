'use client';

import { useSyncExternalStore } from 'react';
import { hasAcceptedTerms, subscribeTermsAccepted } from '@/lib/legal';

/** Whether this browser has agreed to the current Terms. False on the server, where there
 * is no browser to have agreed. */
export function useTermsAccepted(): boolean {
  return useSyncExternalStore(subscribeTermsAccepted, () => hasAcceptedTerms(), () => false);
}
