import { registerEnumType } from '@nestjs/graphql';

export enum DisputeStatus {
  none = 'none',
  flagged = 'flagged',
  resolved = 'resolved',
}

registerEnumType(DisputeStatus, {
  name: 'DisputeStatus',
  description: 'Status of a booking dispute (PYG-287)',
});
