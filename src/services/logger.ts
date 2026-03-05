import ActivityLog, { IActivityLog } from '../models/ActivityLog';

export async function logActivity(
  data: Omit<IActivityLog, '_id' | 'createdAt'>,
): Promise<void> {
  try {
    await ActivityLog.create(data);
  } catch (error) {
    console.error('Error logging activity:', error);
  }
}
