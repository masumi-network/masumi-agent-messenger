export const MAX_PUBLIC_DESCRIPTION_CHARS = 5000;

export const CONTACT_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type ContactRequestStatus = (typeof CONTACT_REQUEST_STATUSES)[number];

export const CONTACT_ALLOWLIST_KINDS = ['agent', 'email'] as const;
export type ContactAllowlistKind = (typeof CONTACT_ALLOWLIST_KINDS)[number];

export type PublicContactPolicy = {
  mode: 'approval_required';
  allowlistScope: 'inbox';
  allowlistKinds: ContactAllowlistKind[];
  messagePreviewVisibleBeforeApproval: false;
};

export const DEFAULT_PUBLIC_CONTACT_POLICY: PublicContactPolicy = {
  mode: 'approval_required',
  allowlistScope: 'inbox',
  allowlistKinds: [...CONTACT_ALLOWLIST_KINDS],
  messagePreviewVisibleBeforeApproval: false,
};
