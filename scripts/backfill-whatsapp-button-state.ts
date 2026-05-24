import { connectDB } from '@/lib/db';
import Order from '@/lib/models/Order';

async function main() {
  await connectDB();

  const clickRequiredStatuses = ['paid', 'partial-paid'];
  const noNeedStatuses = [
    'pending',
    'processing',
    'completed',
    'failed',
    'refunded',
    'cancelled',
  ];

  const missingClickedState = await Order.countDocuments({
    isWhatsappButtonClicked: { $exists: false },
    status: { $in: clickRequiredStatuses },
  });

  const missingNoNeedState = await Order.countDocuments({
    isWhatsappButtonClicked: { $exists: false },
    status: { $in: noNeedStatuses },
  });

  console.log(
    `Found ${missingClickedState + missingNoNeedState} orders without WhatsApp state (${missingClickedState} payment-related, ${missingNoNeedState} no-need).`,
  );

  if (!process.argv.includes('--apply')) {
    console.log('Dry run only. Re-run with --apply to update the database.');
    return;
  }

  const clickedResult = await Order.updateMany(
    {
      isWhatsappButtonClicked: { $exists: false },
      status: { $in: clickRequiredStatuses },
    },
    { $set: { isWhatsappButtonClicked: 'not-clicked' } },
  );

  const noNeedResult = await Order.updateMany(
    {
      isWhatsappButtonClicked: { $exists: false },
      status: { $in: noNeedStatuses },
    },
    { $set: { isWhatsappButtonClicked: 'no-need-to-click' } },
  );

  console.log(
    `Updated ${clickedResult.modifiedCount + noNeedResult.modifiedCount} orders.`,
  );
}

main().catch((error) => {
  console.error('Failed to backfill WhatsApp button state:', error);
  process.exitCode = 1;
});
