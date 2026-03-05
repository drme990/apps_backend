import mongoose from 'mongoose';

const MONGODB_URI =
  process.env.DATA_BASE_URL || 'mongodb://localhost:27017/manasik';

let isConnected = false;

export async function connectDB(): Promise<typeof mongoose> {
  if (isConnected) return mongoose;

  const conn = await mongoose.connect(MONGODB_URI, {
    bufferCommands: false,
    maxPoolSize: 10,
    minPoolSize: 1,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 10000,
    family: 4,
  });

  isConnected = true;
  console.log('[DB] Connected to MongoDB');
  return conn;
}
