/**
 * Identity-provider interface. A real provider (DigiLocker, an e-KYC vendor, ...) can
 * verify documents automatically; for now everything goes to the owner for manual review.
 */
export interface KycCheckResult {
  outcome: 'MANUAL_REVIEW' | 'VERIFIED' | 'FAILED';
  reason?: string;
}

export interface KycProvider {
  readonly name: string;
  check(input: { tenantProfileId: string; idType: string; idFileId: string; photoFileId: string }): Promise<KycCheckResult>;
}

export class ManualReviewKycProvider implements KycProvider {
  readonly name = 'manual';
  async check(): Promise<KycCheckResult> {
    return { outcome: 'MANUAL_REVIEW' };
  }
}

let provider: KycProvider = new ManualReviewKycProvider();
export const kyc = () => provider;
export function setKycProvider(p: KycProvider) {
  provider = p;
}
