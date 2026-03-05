import mongoose from 'mongoose';
import readline from 'readline';

const MONGODB_URI =
  process.env.DATA_BASE_URL || 'mongodb://localhost:27017/manasik';

// Inline schema to avoid import issues with tsx
const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, required: true, enum: ['admin', 'super_admin'] },
    allowedPages: {
      type: [String],
      enum: [
        'dashboard',
        'products',
        'orders',
        'coupons',
        'countries',
        'referrals',
        'appearance',
        'users',
        'logs',
      ],
      default: [
        'dashboard',
        'products',
        'orders',
        'coupons',
        'countries',
        'referrals',
        'appearance',
        'users',
        'logs',
      ],
    },
  },
  { timestamps: true },
);

UserSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  const bcrypt = await import('bcryptjs');
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

async function createAdmin() {
  try {
    console.log('\n🔧 Creating Super Admin User\n');
    console.log('='.repeat(50));

    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const name = await question('Enter admin name: ');
    const email = await question('Enter admin email: ');
    const password = await question('Enter admin password (min 6 chars): ');
    const confirmPassword = await question('Confirm password: ');

    if (!name || !email || !password) {
      console.error('\n❌ All fields are required!');
      process.exit(1);
    }

    if (password.length < 6) {
      console.error('\n❌ Password must be at least 6 characters!');
      process.exit(1);
    }

    if (password !== confirmPassword) {
      console.error('\n❌ Passwords do not match!');
      process.exit(1);
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      console.error('\n❌ User with this email already exists!');
      process.exit(1);
    }

    const admin = await User.create({
      name,
      email,
      password,
      role: 'super_admin',
    });

    console.log('\n' + '='.repeat(50));
    console.log('✅ Super Admin user created successfully!\n');
    console.log('📧 Email:', admin.email);
    console.log('👤 Name:', admin.name);
    console.log('🔑 Role:', admin.role);
    console.log('='.repeat(50) + '\n');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error creating admin:', error);
    process.exit(1);
  } finally {
    rl.close();
    await mongoose.disconnect();
  }
}

createAdmin();
