import 'dotenv/config';
import { app, connectDB } from './app';

const PORT = parseInt(process.env.PORT || '5000', 10);

async function start() {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`[Backend] Running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
