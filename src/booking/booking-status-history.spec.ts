import type { Prisma } from '@prisma/client';
import { recordBookingStatusChange } from './booking-status-history';

describe('recordBookingStatusChange (PYG-461/462)', () => {
  let create: jest.Mock;
  let tx: Prisma.TransactionClient;

  beforeEach(() => {
    create = jest.fn().mockResolvedValue({});
    tx = {
      bookingStatusHistory: { create },
    } as unknown as Prisma.TransactionClient;
  });

  it('inserts one row on the given tx with every field mapped', async () => {
    await recordBookingStatusChange(tx, {
      bookingId: 'b-1',
      fromStatus: 'pending',
      toStatus: 'expired',
      changedBy: 'user-1',
      reason: 'expired_no_accept',
      metadata: { source: 'booking_expiry_cron' },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        bookingId: 'b-1',
        fromStatus: 'pending',
        toStatus: 'expired',
        changedBy: 'user-1',
        reason: 'expired_no_accept',
        metadata: { source: 'booking_expiry_cron' },
      },
    });
  });

  it('changedBy omitted → null (system/cron actor), metadata omitted → not written', async () => {
    await recordBookingStatusChange(tx, {
      bookingId: 'b-1',
      fromStatus: 'accepted',
      toStatus: 'expired',
    });

    const { data } = create.mock.calls[0][0];
    expect(data.changedBy).toBeNull();
    expect(data.metadata).toBeUndefined();
  });

  it('propagates insert failure so the caller tx rolls back the status change too', async () => {
    create.mockRejectedValue(new Error('insert failed'));

    await expect(
      recordBookingStatusChange(tx, {
        bookingId: 'b-1',
        fromStatus: 'pending',
        toStatus: 'expired',
      }),
    ).rejects.toThrow('insert failed');
  });
});
