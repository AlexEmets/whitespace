import type { Metadata } from 'next';
import { PrivacyPolicy } from '@/components/legal/PrivacyPolicy';

export const metadata: Metadata = {
  title: 'Privacy Policy — Whitespace',
  description:
    'What Whitespace handles: no accounts, cookies or analytics; a faucet record of wallet address and IP; public blockchain data; settings kept in your browser.',
};

export default function PrivacyPage() {
  return <PrivacyPolicy />;
}
