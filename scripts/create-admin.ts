import mongoose from 'mongoose';
import readline from 'readline';

const MONGODB_URI =
  process.env.DATA_BASE_URL || 'mongodb://localhost:27017/manasik';

type AppId = 'admin_panel' | 'ghadaq' | 'manasik';

const AdminUserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    role: { type: String, required: true, enum: ['admin', 'super_admin'] },
    allowedPages: {
      type: [String],
      enum: [
        'products',
        'orders',
        'booking',
        'coupons',
        'countries',
        'users',
        'referrals',
        'activityLogs',
        'appearance',
        'exchange',
        'payments',
      ],
      default: [],
    },
  },
  { timestamps: true, collection: 'users_admin_panel' },
);

const AppUserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    phone: { type: String, default: '' },
    country: { type: String, default: '' },
    appId: { type: String, required: true, enum: ['ghadaq', 'manasik'] },
  },
  { timestamps: true },
);

AdminUserSchema.pre('save', async function () {
  if (!this.isModified('password')) return;

  const bcrypt = await import('bcryptjs');
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

AppUserSchema.pre('save', async function () {
  if (!this.isModified('password')) return;

  const bcrypt = await import('bcryptjs');
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

const AdminUser =
  mongoose.models.ScriptAdminUser ||
  mongoose.model('ScriptAdminUser', AdminUserSchema);
const GhadqUser =
  mongoose.models.ScriptGhadqUser ||
  mongoose.model('ScriptGhadqUser', AppUserSchema, 'users_ghadaq');
const ManasikUser =
  mongoose.models.ScriptManasikUser ||
  mongoose.model('ScriptManasikUser', AppUserSchema, 'users_manasik');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

function normalizeAppId(input: string): AppId {
  const normalized = input.trim().toLowerCase();
  if (normalized === 'ghadaq' || normalized === 'manasik') {
    return normalized;
  }
  return 'admin_panel';
}

async function createUserFromScript() {
  try {
    console.log('\nCreate User Script\n');
    console.log('='.repeat(60));

    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB\n');

    const appIdInput = await question(
      'App ID (admin_panel/ghadaq/manasik) [admin_panel]: ',
    );
    const appId = normalizeAppId(appIdInput || 'admin_panel');

    const name = (await question('Enter user name: ')).trim();
    const email = (await question('Enter user email: ')).trim().toLowerCase();
    const password = await question('Enter password (min 6 chars): ');
    const confirmPassword = await question('Confirm password: ');

    if (!name || !email || !password) {
      throw new Error('Name, email and password are required.');
    }

    if (password.length < 6) {
      throw new Error('Password must be at least 6 characters.');
    }

    if (password !== confirmPassword) {
      throw new Error('Passwords do not match.');
    }

    if (appId === 'admin_panel') {
      const roleInput = (
        await question('Role (admin/super_admin) [super_admin]: ')
      )
        .trim()
        .toLowerCase();
      const role = roleInput === 'admin' ? 'admin' : 'super_admin';

      const existingUser = await AdminUser.findOne({ email });
      if (existingUser) {
        throw new Error('A user with this email already exists.');
      }

      const user = await AdminUser.create({
        name,
        email,
        password,
        role,
        allowedPages: role === 'admin' ? [] : undefined,
      });

      console.log('\n' + '='.repeat(60));
      console.log('User created successfully.');
      console.log('Collection: users_admin_panel');
      console.log('Email:', user.email);
      console.log('Name:', user.name);
      console.log('Role:', user.role);
      console.log('='.repeat(60) + '\n');
    } else {
      const phone = (await question('Phone (optional): ')).trim();
      const country = (await question('Country (optional): ')).trim();
      const Model = appId === 'ghadaq' ? GhadqUser : ManasikUser;

      const existingUser = await Model.findOne({ email });
      if (existingUser) {
        throw new Error('A user with this email already exists.');
      }

      const user = await Model.create({
        name,
        email,
        password,
        phone,
        country,
        appId,
      });

      console.log('\n' + '='.repeat(60));
      console.log('User created successfully.');
      console.log(
        `Collection: ${appId === 'ghadaq' ? 'users_ghadaq' : 'users_manasik'}`,
      );
      console.log('Email:', user.email);
      console.log('Name:', user.name);
      console.log('App ID:', user.appId);
      console.log('Phone:', user.phone || '-');
      console.log('Country:', user.country || '-');
      console.log('='.repeat(60) + '\n');
    }

    process.exit(0);
  } catch (error) {
    console.error('\nError creating user:', error);
    process.exit(1);
  } finally {
    rl.close();
    await mongoose.disconnect();
  }
}

createUserFromScript();
