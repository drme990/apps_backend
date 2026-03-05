import mongoose from 'mongoose';

const MONGODB_URI =
  process.env.DATA_BASE_URL || 'mongodb://localhost:27017/manasik';

// Cache the connection promise so concurrent cold-start requests all await
// the same promise instead of racing to create separate connections.
const cached: {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
} = { conn: null, promise: null };

export async function connectDB(): Promise<typeof mongoose> {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(MONGODB_URI, {
        bufferCommands: false,
        maxPoolSize: 10,
        minPoolSize: 1,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        connectTimeoutMS: 10000,
        family: 4,
      })
      .then((conn) => {
        console.log('[DB] Connected to MongoDB');
        return conn;
      });
  }

  try {
    cached.conn = await cached.promise;
  } catch (error) {
    cached.promise = null; // allow retry on next request
    throw error;
  }

  return cached.conn;
}
