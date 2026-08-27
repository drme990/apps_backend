import mongoose from 'mongoose';

export interface IErrorLog {
  _id?: string;
  /** Error severity level */
  level: 'error' | 'warn' | 'fatal';
  /** Short error message / title */
  message: string;
  /** Full error stack trace (if available) */
  stack?: string;
  /** Where the error originated — route path, function name, etc. */
  source?: string;
  /** HTTP method if from a request */
  method?: string;
  /** Request URL path */
  url?: string;
  /** HTTP status code returned to the client */
  statusCode?: number;
  /** The app/source that generated the error */
  appId?: string;
  /** User data at the time of the error (if authenticated) */
  user?: {
    userId?: string;
    email?: string;
    name?: string;
    role?: string;
  };
  /** Session/request context data */
  session?: {
    ip?: string;
    userAgent?: string;
    locale?: string;
    traceId?: string;
    referrer?: string;
  };
  /** Any additional metadata (request body, params, etc.) */
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

const ErrorLogSchema = new mongoose.Schema<IErrorLog>(
  {
    level: {
      type: String,
      required: true,
      enum: ['error', 'warn', 'fatal'],
      default: 'error',
      index: true,
    },
    message: { type: String, required: true },
    stack: { type: String },
    source: { type: String, index: true },
    method: { type: String },
    url: { type: String, index: true },
    statusCode: { type: Number },
    appId: { type: String, index: true },
    user: {
      userId: { type: String },
      email: { type: String },
      name: { type: String },
      role: { type: String },
    },
    session: {
      ip: { type: String },
      userAgent: { type: String },
      locale: { type: String },
      traceId: { type: String },
      referrer: { type: String },
    },
    metadata: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ErrorLogSchema.index({ createdAt: -1 });
ErrorLogSchema.index({ level: 1, createdAt: -1 });

// Auto-expire documents after 30 days to prevent unbounded growth
ErrorLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

if (mongoose.models.ErrorLog) {
  delete mongoose.models.ErrorLog;
}

const ErrorLog = mongoose.model<IErrorLog>('ErrorLog', ErrorLogSchema);

export default ErrorLog;
