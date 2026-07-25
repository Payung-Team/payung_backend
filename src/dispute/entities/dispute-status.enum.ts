import { registerEnumType } from '@nestjs/graphql';

export enum DisputeStatus {
  none = 'none',
  flagged = 'flagged',
  // valid pre-resolve state alongside "flagged" — no admin transition endpoint yet
  under_review = 'under_review',
  resolved = 'resolved',
}

registerEnumType(DisputeStatus, {
  name: 'DisputeStatus',
  description: 'Status of a booking dispute (PYG-287)',
});
