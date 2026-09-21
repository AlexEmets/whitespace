import type { Metadata } from 'next';
import { FaucetPage } from '@/components/FaucetPage';

export const metadata: Metadata = {
  title: 'Faucet — Whitespace',
  description:
    'Claim testnet USDW on Whitechain 1874. A mock ERC-20 with an open mint — not backed, not redeemable, and not worth anything.',
};

/**
 * /faucet — collateral for the testnet, and the honest description of what it is.
 *
 * Split out of /vaults so that "where do I get USDW" is a destination rather than a
 * button discovered by accident on a page about LP positions.
 */
export default function Faucet() {
  return <FaucetPage />;
}
