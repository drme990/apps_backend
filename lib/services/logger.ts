import ActivityLog from '../models/ActivityLog';

interface LogData {
  action: string;
  resource: string;
  resourceId?: string;
  details?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  ipAddress?: string;
}

export async function logActivity(data: LogData): Promise<void> {
  try {
    await ActivityLog.create(data);
  } catch (error) {
    console.error('Error logging activity:', error);
  }
}
