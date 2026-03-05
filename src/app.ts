import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { connectDB } from './config/db';
import { errorHandler } from './middleware/error-handler';

// Route imports
import publicProductRoutes from './routes/public/products';
import publicCountryRoutes from './routes/public/countries';
import publicCouponRoutes from './routes/public/coupons';
import publicPaymentRoutes from './routes/public/payment';
import publicCurrencyRoutes from './routes/public/currency';
import publicAppearanceRoutes from './routes/public/appearance';
import publicFbEventRoutes from './routes/public/fb-event';

import adminAuthRoutes from './routes/admin/auth';
import adminUserRoutes from './routes/admin/users';
import adminProductRoutes from './routes/admin/products';
import adminOrderRoutes from './routes/admin/orders';
import adminCouponRoutes from './routes/admin/coupons';
import adminCountryRoutes from './routes/admin/countries';
import adminReferralRoutes from './routes/admin/referrals';
import adminLogRoutes from './routes/admin/logs';
import adminUploadRoutes from './routes/admin/upload';
import adminAppearanceRoutes from './routes/admin/appearance';
import adminCurrencyRoutes from './routes/admin/currency';
import adminStatsRoutes from './routes/admin/stats';

const app = express();

// ─── CORS ────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) return callback(null, true);
      if (allowedOrigins.length === 0) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  }),
);

// ─── Body parsers ────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Request logger ──────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.ip ||
    '-';

  res.on('finish', () => {
    const ms = Date.now() - start;
    const color =
      res.statusCode >= 500
        ? '\x1b[31m' // red
        : res.statusCode >= 400
          ? '\x1b[33m' // yellow
          : res.statusCode >= 300
            ? '\x1b[36m' // cyan
            : '\x1b[32m'; // green
    const reset = '\x1b[0m';
    const dim = '\x1b[2m';
    console.log(
      `${dim}${new Date().toISOString()}${reset} ` +
        `${color}${res.statusCode}${reset} ` +
        `${req.method.padEnd(7)} ${req.originalUrl} ` +
        `${dim}${ip} ${ms}ms${reset}`,
    );
  });

  next();
});

// ─── Health check ────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Public routes ───────────────────────────────────────────────
app.use('/api/products', publicProductRoutes);
app.use('/api/countries', publicCountryRoutes);
app.use('/api/coupons', publicCouponRoutes);
app.use('/api/payment', publicPaymentRoutes);
app.use('/api/currency', publicCurrencyRoutes);
app.use('/api/appearance', publicAppearanceRoutes);
app.use('/api/fb-event', publicFbEventRoutes);

// ─── Admin routes ────────────────────────────────────────────────
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/users', adminUserRoutes);
app.use('/api/admin/products', adminProductRoutes);
app.use('/api/admin/orders', adminOrderRoutes);
app.use('/api/admin/coupons', adminCouponRoutes);
app.use('/api/admin/countries', adminCountryRoutes);
app.use('/api/admin/referrals', adminReferralRoutes);
app.use('/api/admin/logs', adminLogRoutes);
app.use('/api/admin/upload/image', adminUploadRoutes);
app.use('/api/admin/appearance', adminAppearanceRoutes);
app.use('/api/admin/currency', adminCurrencyRoutes);
app.use('/api/admin/stats', adminStatsRoutes);

// ─── Error handler ───────────────────────────────────────────────
app.use(errorHandler);

export { app, connectDB };
