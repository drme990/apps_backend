# Next.js App Router API Directory

This hierarchical directory contains the core REST API endpoints for the multi-app platform (Admin Panel, Ghadaq App, and Manasik App). All logic is built using Next.js App Router (`route.ts`).

## Overview on Security & Auth

Different scopes within this system apply various security wrappers from `@/lib/auth.ts`:

- **`requireAdminPageAccess('page')`**: Guards `/api/admin/*` endpoints strictly to admin JWT sessions mapped with specific Role-Based Access Control (RBAC).
- **`requireAppAuth(appId)`**: Guards user-specific actions (like profile edit, listing user orders).
- **Public**: Routes like public catalogs, specific checkouts, and system webhooks.

---

## 1. Admin Endpoints (`/api/admin/`)

_Highly Protected: Requires Admin JSON Web Token and relevant Role Permissions._

| Endpoint                   | Method(s)              | Description                                                                                                               |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `.../appearance/[project]` | GET, PUT               | Edit the storefront appearance (logo, colors, theming) for Ghadaq/Manasik.                                                |
| `.../auth/login`           | POST                   | Admin login authentication. (Public)                                                                                      |
| `.../auth/logout`          | POST                   | Destroy admin session cookies.                                                                                            |
| `.../auth/me`              | GET                    | Retrieve currently logged-in Admin Profile.                                                                               |
| `.../booking`              | GET, PUT               | Manage globally blocked dates (e.g., stopping checkouts for certain days).                                                |
| `.../countries...`         | GET, POST, PUT, DELETE | CRUD ops and reordering logic for platform-supported countries & calling codes.                                           |
| `.../coupons...`           | GET, POST, PUT, DELETE | Administrative CRUD operations for marketing custom coupons.                                                              |
| `.../currency/rates`       | GET                    | Check current local currency conversion rates.                                                                            |
| `.../customers...`         | GET, PATCH             | View registered customers for each app or issue account bans.                                                             |
| `.../exchange...`          | GET, POST              | Check rate-sync audit logs and force manual currency price recalculation.                                                 |
| `.../logs`                 | GET                    | Audit log directory listing admin actions (creation, deletions, settings changes).                                        |
| `.../orders...`            | GET, PUT               | Detailed order retrieval, order status changes, bulk updating statuses, and manual payment link generation.               |
| `.../payments...`          | GET, POST, DELETE      | Manage explicitly generated custom payment links (Pay-links).                                                             |
| `.../products...`          | GET, POST, PUT, DELETE | Central platform product catalog manipulation inclusive of sorting (reorder) and dynamic auto-pricing logic integrations. |
| `.../referrals...`         | GET, POST, PUT, DELETE | Manage referral entities and trace uses.                                                                                  |
| `.../stats...`             | GET                    | Retrieve overall metrics and analytics data arrays (e.g., new sales, revenue, statuses).                                  |
| `.../upload/image`         | POST, DELETE           | Multi-part form handler routing images via Next.js strictly to Cloudinary Storage.                                        |
| `.../users...`             | GET, POST, PUT, DELETE | Manage internal Administrator accounts based on Roles mapping.                                                            |

---

## 2. Authentication Flow (`/api/auth/`)

_Manages Multi-Tenancy Authentication utilizing stateless cookies & JWT tokens._

| Scope               | Endpoints      | Description                                                                                 |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `/auth/admin/...`   | POST, GET, PUT | Dedicated admin account registration, login verification, and token session checking.       |
| `/auth/ghadaq/...`  | POST, GET      | Registration, Authentication, and Session verification for the `Ghadaq` consumer frontend.  |
| `/auth/manasik/...` | POST, GET      | Registration, Authentication, and Session verification for the `Manasik` consumer frontend. |

---

## 3. Operations & Customer Endpoints

_Core integration API consumed directly by storefront applications._

| Endpoint                 | Method(s) | Auth Level | Description                                                                               |
| ------------------------ | --------- | ---------- | ----------------------------------------------------------------------------------------- |
| `appearance`             | GET       | Public     | Fetch frontend styling configurations based on calling domain or query ID.                |
| `booking/blocked-dates`  | GET       | Public     | Supply checkout with dates un-selectable by customers.                                    |
| `countries`              | GET       | Public     | Feeds the checkout/signup dropdown selectors for supported geographies.                   |
| `coupons/validate`       | POST      | Public     | Validates a discount code against given app context prior to order creation.              |
| `currency/rates`         | GET       | Public     | Fetches normalized rate metrics for client-side price conversions.                        |
| `customer/[app]/profile` | GET, PUT  | App Auth   | Customer profile reading and updating requests.                                           |
| `fb-event`               | POST      | Public     | Proxy logic for sending off Facebook Pixel (Conversions API) events server-side securely. |
| `orders`                 | GET       | Public\*   | Retrieve limited order status.                                                            |
| `orders/my-orders`       | GET       | App Auth   | Retrieves historical orders belonging specifically to the logged-in customer token.       |
| `products...`            | GET       | Public     | Retrieve active product catalog with associated current variations and media.             |
| `referral/[id]`          | GET       | Public     | Resolves referral codes against specific system configurations.                           |

---

## 4. Payments System (`/api/payment/`)

_Handles transactional integrity, checkout progression, and Payment Gateway integration endpoints._

| Endpoint           | Method(s) | Auth / Status    | Description                                                                                                                                            |
| ------------------ | --------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `checkout`         | POST      | Application      | Handles core cart ingestion, final amount validation, order document generation in DB, and initiation of redirect URLs to providers (like _EasyKash_). |
| `create-link`      | POST      | Internal Auth    | Intermediary gateway process linking a generated system order to a specific live URL logic block.                                                      |
| `pay-link/[token]` | GET       | Public Proxy     | Resolves an admin-generated custom invoice URL so a user can open it on their browser.                                                                 |
| `referral-info`    | GET       | Public           | Contextual validation of applying a referral inside an active checkout.                                                                                |
| `status`           | GET       | Public / Gateway | Pinged on redirect finishes confirming live state logic (Success / Fail redirects to the Next.js client).                                              |
| `webhook`          | POST      | Encrypted/GW     | Core system listener for Webhooks (EasyKash Server-to-Server) handling paid callbacks securely out-of-band and modifying DB.                           |

---

## 5. Cron Services (`/api/cron/`)

_Automated Background Functions._

| Endpoint        | Method(s) | Description                                                                                                      |
| --------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `update-prices` | GET       | Triggers a scheduled job securely to rebuild product base prices reflecting currency-live rates via Vercel Cron. |
