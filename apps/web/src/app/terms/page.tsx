import type { Metadata } from 'next';
import { TermsOfUse } from '@/components/legal/TermsOfUse';

export const metadata: Metadata = {
  title: 'Terms of Use — Whitespace',
  description:
    'The terms for using Whitespace: testnet software with no-value tokens and points, the risks of leveraged trading, restricted jurisdictions, and the limits of our liability.',
};

export default function TermsPage() {
  return <TermsOfUse />;
}
