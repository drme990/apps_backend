import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import mongoose, { type Model } from 'mongoose';
import { connectDB } from '@/lib/db';
import { requireAdminPageAccess } from '@/lib/auth';
import {
  getUserModelByAppId,
  type IBaseAppUser,
  type IBaseAppUserMethods,
} from '@/lib/auth/app-users';

const querySchema = z.object({
  appId: z.enum(['ghadaq', 'manasik']).optional(),
  search: z.string().trim().optional(),
  isBanned: z.enum(['true', 'false']).optional(),
  ref: z.string().trim().optional(),
  tier: z.string().trim().optional(),
  country: z.string().trim().optional(),
  detectedCountry: z.string().trim().optional(),
  page: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 1)),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? parseInt(val, 10) : 20)),
});

type CustomerDTO = {
  _id: string;
  name: string;
  email: string;
  phone: string;
  registrationIp?: string;
  lastLoginIp?: string;
  country: string;
  appId: 'ghadaq' | 'manasik';
  isBanned: boolean;
  isAdminCreated?: boolean;
  ref?: string | null;
  detectedCountry?: string;
  lastLoginAt?: Date;
  createdAt: Date;
  tier?: string | null;
};

type AppCustomerModel = Model<IBaseAppUser, object, IBaseAppUserMethods>;

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const auth = await requireAdminPageAccess('customers');
    if ('error' in auth) return auth.error;

    const parsed = querySchema.safeParse({
      appId: request.nextUrl.searchParams.get('appId') || undefined,
      search: request.nextUrl.searchParams.get('search') || undefined,
      isBanned: request.nextUrl.searchParams.get('isBanned') || undefined,
      ref: request.nextUrl.searchParams.get('ref') || undefined,
      tier: request.nextUrl.searchParams.get('tier') || undefined,
      country: request.nextUrl.searchParams.get('country') || undefined,
      detectedCountry:
        request.nextUrl.searchParams.get('detectedCountry') || undefined,
      page: request.nextUrl.searchParams.get('page') || undefined,
      limit: request.nextUrl.searchParams.get('limit') || undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Invalid query parameters' },
        { status: 400 },
      );
    }

    const normalizedSearch = parsed.data.search?.toLowerCase();
    const isBannedFilter =
      parsed.data.isBanned === undefined
        ? undefined
        : parsed.data.isBanned === 'true';
    const refFilter = parsed.data.ref || undefined;
    const tierFilter = parsed.data.tier || undefined;
    const countryFilter = parsed.data.country || undefined;
    const detectedCountryFilter =
      parsed.data.detectedCountry || undefined;
    const page = parsed.data.page || 1;
    const limit = parsed.data.limit || 20;
    const skip = (page - 1) * limit;

    const appIds: Array<'ghadaq' | 'manasik'> = parsed.data.appId
      ? [parsed.data.appId]
      : (['ghadaq', 'manasik'] as const);

    const results = await Promise.all(
      appIds.map(async (appId) => {
        const model = getUserModelByAppId(appId) as unknown as AppCustomerModel;

        const filterQuery: Record<string, unknown> = {};
        if (normalizedSearch) {
          filterQuery.$or = [
            { name: { $regex: normalizedSearch, $options: 'i' } },
            { email: { $regex: normalizedSearch, $options: 'i' } },
            { phone: { $regex: normalizedSearch, $options: 'i' } },
            {
              $expr: {
                $regexMatch: {
                  input: { $toString: '$_id' },
                  regex: normalizedSearch,
                  options: 'i',
                },
              },
            },
            { registrationIp: { $regex: normalizedSearch, $options: 'i' } },
            { lastLoginIp: { $regex: normalizedSearch, $options: 'i' } },
          ];
        }
        if (typeof isBannedFilter === 'boolean') {
          filterQuery.isBanned = isBannedFilter;
        }
        if (countryFilter) {
          filterQuery.country = {
            $regex: `^${countryFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
            $options: 'i',
          };
        }
        if (detectedCountryFilter) {
          filterQuery.detectedCountry = {
            $regex: `^${detectedCountryFilter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
            $options: 'i',
          };
        }

        const andConditions: Record<string, unknown>[] = [];

        if (refFilter) {
          if (refFilter === '__none__') {
            andConditions.push({ $or: [{ ref: 'MNK-D' }, { ref: 'GHD-D' }] });
          } else {
            filterQuery.ref = refFilter;
          }
        }

        if (tierFilter) {
          if (tierFilter === '__none__') {
            andConditions.push({
              $or: [{ tier: { $exists: false } }, { tier: null }],
            });
          } else {
            try {
              const tierOid = new mongoose.Types.ObjectId(tierFilter);
              andConditions.push({
                $or: [{ tier: tierOid }, { tier: tierFilter }],
              });
            } catch {
              filterQuery.tier = tierFilter;
            }
          }
        }

        if (andConditions.length > 0) {
          filterQuery.$and = andConditions;
        }

        const [customers, totalCount] = await Promise.all([
          model
            .find(filterQuery)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .select(
              'name email phone registrationIp lastLoginIp country isBanned isAdminCreated ref detectedCountry lastLoginAt createdAt tier',
            )
            .lean(),
          model.countDocuments(filterQuery),
        ]);

        return {
          customers: customers.map(
            (customer): CustomerDTO => ({
              _id: String(customer._id),
              name: typeof customer.name === 'string' ? customer.name : '',
              email: typeof customer.email === 'string' ? customer.email : '',
              phone: typeof customer.phone === 'string' ? customer.phone : '',
              registrationIp:
                typeof customer.registrationIp === 'string'
                  ? customer.registrationIp
                  : undefined,
              lastLoginIp:
                typeof customer.lastLoginIp === 'string'
                  ? customer.lastLoginIp
                  : undefined,
              country:
                typeof customer.country === 'string' ? customer.country : '',
              appId,
              isBanned: Boolean(customer.isBanned),
              isAdminCreated: customer.isAdminCreated === true ? true : undefined,
              ref: typeof customer.ref === 'string' ? customer.ref : null,
              detectedCountry:
                typeof customer.detectedCountry === 'string'
                  ? customer.detectedCountry
                  : undefined,
              lastLoginAt:
                customer.lastLoginAt instanceof Date
                  ? customer.lastLoginAt
                  : undefined,
              createdAt:
                customer.createdAt instanceof Date
                  ? customer.createdAt
                  : new Date(0),
              tier: customer.tier ? String(customer.tier) : null,
            }),
          ),
          totalCount,
        };
      }),
    );

    let customers: CustomerDTO[] = results.flatMap((r) => r.customers);
    const filteredTotal = results.reduce((sum, r) => sum + r.totalCount, 0);

    customers.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Get overall stats (all customers regardless of filters)
    const statsResults = await Promise.all(
      (['ghadaq', 'manasik'] as const).map(async (appId) => {
        const model = getUserModelByAppId(appId) as unknown as AppCustomerModel;
        const [total, banned] = await Promise.all([
          model.countDocuments(),
          model.countDocuments({ isBanned: true }),
        ]);
        return { appId, total, banned };
      }),
    );

    const stats = {
      total: statsResults.reduce((sum, r) => sum + r.total, 0),
      manasik: statsResults.find((r) => r.appId === 'manasik')?.total || 0,
      ghadaq: statsResults.find((r) => r.appId === 'ghadaq')?.total || 0,
      banned: statsResults.reduce((sum, r) => sum + r.banned, 0),
      active: statsResults.reduce((sum, r) => sum + (r.total - r.banned), 0),
    };

    return NextResponse.json({
      success: true,
      data: {
        customers,
        pagination: {
          page,
          limit,
          total: filteredTotal,
          totalPages: Math.ceil(filteredTotal / limit),
        },
        stats,
      },
    });
  } catch (error) {
    console.error('Error fetching customers:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch customers' },
      { status: 500 },
    );
  }
}
