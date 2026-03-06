# Quick Start - Admin Authentication

## 1. Install Required Dependencies

```bash
npm install jsonwebtoken bcryptjs
npm install --save-dev @types/jsonwebtoken @types/bcryptjs tsx
```

## 2. Set Environment Variables

Add to your `.env.local` file:

```env
JWT_SECRET=change-this-to-a-random-secret-key-in-production-make-it-long
DATA_BASE_URL=mongodb://localhost:27017/manasik
BASE_URL=http://localhost:3000
NODE_ENV=development
```

## 3. Create Your First Admin User

Run the admin creation script:

```bash
npx tsx scripts/create-admin.ts
```

Follow the prompts to enter:

- Admin name
- Admin email
- Password (minimum 6 characters)
- Confirm password

## 4. Start the Development Server

```bash
npm run dev
```

## 5. Login to Admin Dashboard

Navigate to: `http://localhost:3000/admin/login`

Use the credentials you created in step 3.

## What You Can Do Now

✅ **Dashboard** - View stats and quick actions at `/admin`
✅ **Products** - Manage products at `/admin/products`
✅ **Users** - Create/delete admin users at `/admin/users`
✅ **Activity Logs** - Track all actions at `/admin/logs`

## Important Notes

- All admin routes are protected - you must login first
- All product/user create/update/delete actions are automatically logged
- Passwords are securely hashed with bcrypt
- Sessions last 7 days with HTTP-only cookies
- `super_admin` role has full access, `admin` role has limited access

## Troubleshooting

**Can't run the script?**

```bash
npm install -g tsx
# Then try again:
npx tsx scripts/create-admin.ts
```

**MongoDB connection error?**

- Make sure MongoDB is running
- Check DATA_BASE_URL in .env.local is correct

**Dependencies not found?**

```bash
npm install
npm install jsonwebtoken bcryptjs @types/jsonwebtoken @types/bcryptjs
```

That's it! Your admin dashboard with authentication and logging is ready to use. 🎉

For more detailed information, see [ADMIN_SETUP.md](./ADMIN_SETUP.md)
