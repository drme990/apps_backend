import ActivityLog from '../models/ActivityLog';
import { captureException } from './error-monitor';

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
    captureException(error, {
      service: 'ActivityLogger',
      operation: 'logActivity',
      severity: 'low',
      metadata: { data },
    });
  }
}
