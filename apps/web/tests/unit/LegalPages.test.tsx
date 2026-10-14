import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PrivacyPolicy } from '@/components/legal/PrivacyPolicy';
import { TermsOfUse } from '@/components/legal/TermsOfUse';
import { PRIVACY_LAST_UPDATED, RESTRICTED_JURISDICTIONS, TERMS_LAST_UPDATED } from '@/lib/legal';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/**
 * The clauses the Terms exist for, and the data practices the Privacy Policy has to state
 * truthfully. Wording can change; these commitments must not quietly disappear.
 */
describe('Terms of Use', () => {
  it('dates the version and links the Privacy Policy', () => {
    render(<TermsOfUse />);
    expect(screen.getByTestId('terms-updated')).toHaveTextContent(TERMS_LAST_UPDATED);
    expect(within(screen.getByTestId('terms-agreement')).getByText('Privacy Policy')).toHaveAttribute('href', '/privacy');
  });

  it('says the testnet tokens have no value', () => {
    render(<TermsOfUse />);
    expect(screen.getByTestId('terms-testnet')).toHaveTextContent(/Neither has any monetary value/);
  });

  /** Points may lead to an airdrop — possibly, and with nothing guaranteed. Saying more would
   * be a promise of a token; saying less now contradicts what the channels announce. */
  it('says points may count toward a possible airdrop, and guarantees nothing about it', () => {
    render(<TermsOfUse />);
    const points = screen.getByTestId('terms-points');
    expect(points).toHaveTextContent(/no monetary value/);
    expect(points).toHaveTextContent(/We may, at our sole discretion, take points into account in a possible future token distribution, such as an airdrop/);
    expect(points).toHaveTextContent(/Nothing about one is guaranteed: not that it will happen, nor who is eligible, how much/);
    expect(points).toHaveTextContent(/Points give no right to any token/);
    expect(points).toHaveTextContent(/restricted jurisdiction \(see below\) is excluded/);
  });

  it('dates the Privacy Policy on its own, not with the Terms', () => {
    render(<PrivacyPolicy />);
    expect(screen.getByTestId('privacy-updated')).toHaveTextContent(PRIVACY_LAST_UPDATED);
    expect(PRIVACY_LAST_UPDATED).not.toBe(TERMS_LAST_UPDATED);
  });

  it('lists every restricted jurisdiction and forbids getting around them', () => {
    render(<TermsOfUse />);
    const eligibility = screen.getByTestId('terms-eligibility');
    for (const place of RESTRICTED_JURISDICTIONS) expect(eligibility).toHaveTextContent(place);
    expect(eligibility).toHaveTextContent(/at least 18 years old/);
    expect(eligibility).toHaveTextContent(/VPN/);
  });

  it('spells out the risks, including fees from margin, fills and the unaudited contracts', () => {
    render(<TermsOfUse />);
    const risks = screen.getByTestId('terms-risks');
    expect(risks).toHaveTextContent(/entire margin lost/);
    expect(risks).toHaveTextContent(/fees are taken from your margin/);
    expect(risks).toHaveTextContent(/limit orders fill at their price or better/);
    expect(risks).toHaveTextContent(/have not been audited/);
  });

  it('puts the responsibility on the user, with no warranty and liability limited as far as the law allows', () => {
    render(<TermsOfUse />);
    expect(screen.getByTestId('terms-responsibilities')).toHaveTextContent(/any loss that results from your use/);
    expect(screen.getByTestId('terms-warranties')).toHaveTextContent(/as is/);
    const liability = screen.getByTestId('terms-liability');
    expect(liability).toHaveTextContent(/To the fullest extent permitted by law/);
    expect(liability).toHaveTextContent(/cannot lawfully be excluded or limited/);
    expect(screen.getByTestId('terms-indemnity')).toHaveTextContent(/indemnify/);
    expect(screen.getByTestId('terms-no-advice')).toHaveTextContent(/no fiduciary duty/);
  });

  it('does not print a made-up contact address', () => {
    render(<TermsOfUse />);
    expect(screen.getByTestId('terms-contact')).toHaveTextContent(/will be published/);
    expect(screen.getByTestId('terms-contact').querySelector('a[href^="mailto:"]')).toBeNull();
  });
});

describe('Privacy Policy', () => {
  it('states there are no accounts, cookies or analytics', () => {
    render(<PrivacyPolicy />);
    const none = screen.getByTestId('privacy-not-collected');
    expect(none).toHaveTextContent(/no accounts/);
    expect(none).toHaveTextContent(/We do not set cookies/);
    expect(none).toHaveTextContent(/no analytics/);
  });

  it('names exactly what the faucet keeps, and why', () => {
    render(<PrivacyPolicy />);
    const faucet = screen.getByTestId('privacy-faucet');
    expect(faucet).toHaveTextContent(/wallet address/);
    expect(faucet).toHaveTextContent(/IP address — for IPv6, only the \/64 network prefix/);
    expect(faucet).toHaveTextContent(/one claim per wallet and per network every 24 hours/);
  });

  it('says what the servers log and for how long', () => {
    render(<PrivacyPolicy />);
    const servers = screen.getByTestId('privacy-servers');
    expect(servers).toHaveTextContent(/does not write access logs/);
    expect(servers).toHaveTextContent(/at most 14 days/);
  });

  it('warns that the one-click key lives in the browser and can trade but not withdraw', () => {
    render(<PrivacyPolicy />);
    const browser = screen.getByTestId('privacy-browser');
    expect(browser).toHaveTextContent(/never sent to us/);
    expect(browser).toHaveTextContent(/cannot withdraw your funds/);
  });

  it('explains that on-chain data is public and cannot be deleted', () => {
    render(<PrivacyPolicy />);
    expect(screen.getByTestId('privacy-blockchain')).toHaveTextContent(/neither we nor anyone else can delete it/);
  });
});
