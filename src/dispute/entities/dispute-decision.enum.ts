import { registerEnumType } from '@nestjs/graphql';

export enum DisputeDecision {
  refund_full = 'refund_full',
  refund_partial = 'refund_partial',
  no_refund = 'no_refund',
}

registerEnumType(DisputeDecision, {
  name: 'DisputeDecision',
  description: 'Admin decision when resolving a booking dispute (PYG-287)',
});
