/**
 * Design-app callback service.
 *
 * The backend calls the design app's `/api/orders/generate-design`
 * endpoint to trigger generation of an order design from a booking
 * template. The design app renders the template, uploads the JPG to R2,
 * and returns the public URL.
 *
 * Env vars:
 *   DESIGN_APP_URL            — base URL of the design app
 *                               (e.g. https://design.manasik.net)
 *   DESIGN_APP_CALLBACK_SECRET — shared secret sent in the
 *                                `x-callback-secret` header
 */

// 4 minutes for the manual admin path — deliberately UNDER the typical
// Nginx/proxy 300s cap so the abort fires cleanly on our side and the
// retry loop gets the failure early instead of the connection dying at
// the proxy after we've already waited past the point of recovery.
const DEFAULT_TIMEOUT_MS = 240_000;
const AUTO_TIMEOUT_MS = 120_000; // 2 minutes — shorter for auto path (serverless-safe)

function getDesignAppUrl(): string {
  const url = (process.env.DESIGN_APP_URL || '').trim().replace(/\/+$/, '');
  return url;
}

/**
 * Extract the REAL reason behind a Node `fetch` failure.
 *
 * Node's fetch (undici) throws a generic `TypeError: fetch failed` and
 * buries the actual cause — ECONNREFUSED, ENOTFOUND, socket hangup,
 * TLS error — in `error.cause`. When the connection was attempted to
 * multiple addresses (e.g. localhost → ::1 + 127.0.0.1), `cause` is an
 * AggregateError with a `.errors` array. Without digging these out, every
 * failure logs as the useless string "fetch failed".
 */
function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const parts: string[] = [error.message];
  let cause: unknown = error.cause;

  // Unwrap nested causes (undici sometimes nests twice)
  for (let depth = 0; depth < 3 && cause; depth++) {
    if (cause instanceof AggregateError && Array.isArray(cause.errors)) {
      const inner = cause.errors
        .map((e) => describeFetchError(e))
        .filter(Boolean)
        .join(' | ');
      if (inner) parts.push(inner);
      break;
    }
    if (cause instanceof Error) {
      const detail =
        'code' in cause && typeof cause.code === 'string'
          ? `${cause.code}${'address' in cause ? ` ${cause.address}` : ''}${'port' in cause ? `:${cause.port}` : ''}`
          : cause.message;
      if (detail && detail !== error.message) parts.push(detail);
      cause = cause.cause;
    } else {
      parts.push(String(cause));
      break;
    }
  }

  return parts.join(' — ');
}

function getCallbackSecret(): string {
  return process.env.DESIGN_APP_CALLBACK_SECRET || '';
}

export type TemplateType = 'text' | 'image';

/** Result returned by the design app for a single product */
export interface DesignAppResult {
  success: boolean;
  productId: string;
  /** Public R2 URL of the generated JPG (only when success=true) */
  url?: string;
  /** Which template variant was used */
  templateType?: TemplateType;
  /**
   * ID of the design-app project (design instance) generated for this
   * order. The admin panel opens the editor at /editor/d/{projectId} so
   * the admin edits THIS design, not the template.
   */
  projectId?: string;
  /**
   * The saved-version number assigned by the design app (see
   * `order-history-enhanced.md`). The backend stores this on
   * `designUrls[].currentVersion` so the admin panel can mark the
   * current version in the history UI.
   */
  version?: number;
  /** Error code from the design app (when success=false) */
  error?: string;
  /** Human-readable error message */
  message?: string;
}

interface DesignAppResponseBody {
  success: boolean;
  data?: {
    url: string;
    key: string;
    orderNumber: string;
    /** ID of the design instance project (for editing in the design app) */
    projectId?: string;
    designName?: string;
    /** ID of the template the design instance was created from (reference) */
    templateId?: string;
    templateName?: string;
    templateType?: TemplateType;
    /** Saved-version number assigned by the design app's history system */
    version?: number;
  };
  error?: string;
  message?: string;
}

/**
 * Call the design app to generate a design for a single product.
 *
 * The design app will:
 *   1. Look up the booking product by `productId`.
 *   2. Check if it has a template assigned.
 *   3. STRICTLY pick the template variant based on `hasReservationPhoto`
 *      — 'image' template (imageTemplateId) if the order has a
 *      reservation photo, 'text' template (templateId) otherwise.
 *      NO fallback between types — if the required template is missing,
 *      the design app returns `noTemplate`.
 *   4. Render the template with the order data and upload the JPG to R2.
 *   5. Return the public URL.
 *
 * If the product has no template (of the required type), the design app
 * responds with `success: false, error: 'noTemplate'` and this function
 * returns a failed `DesignAppResult` — the caller (admin route) skips
 * it and
 * tries the next product.
 */
export async function generateDesignForProduct(params: {
  orderNumber: string;
  productId: string;
  hasReservationPhoto: boolean;
  /** 1-based index of this item within the order — used for multi-item filenames */
  itemIndex: number;
  orderData: Record<string, unknown>;
  /**
   * History trigger (see `order-history-enhanced.md` §7). The backend
   * knows whether this is an auto generation (webhook) or an admin
   * regeneration (admin button). The design app records this on the
   * saved version so the history UI can distinguish them. Defaults to
   * 'auto' for backward compatibility.
   */
  trigger?: 'auto' | 'admin_regenerate';
  /**
   * Idempotency key for the saved version. For auto generation, the
   * backend derives a stable key from (orderNumber, productId, itemIndex)
   * so webhook retries don't create duplicate versions. For admin
   * regeneration, a fresh key is generated per request. If omitted, the
   * design app generates a stable one.
   */
  operationId?: string;
}): Promise<DesignAppResult> {
  const { orderNumber, productId, hasReservationPhoto, itemIndex, orderData, trigger, operationId } = params;

  const baseUrl = getDesignAppUrl();
  if (!baseUrl) {
    return {
      success: false,
      productId,
      error: 'designAppNotConfigured',
      message: 'DESIGN_APP_URL is not set on the backend.',
    };
  }
  if (!/^https?:\/\/.+/.test(baseUrl)) {
    return {
      success: false,
      productId,
      error: 'designAppNotConfigured',
      message: `DESIGN_APP_URL is not a valid http(s) URL: "${baseUrl}"`,
    };
  }

  const secret = getCallbackSecret();
  if (!secret) {
    return {
      success: false,
      productId,
      error: 'callbackSecretNotConfigured',
      message: 'DESIGN_APP_CALLBACK_SECRET is not set on the backend.',
    };
  }

  // Use a shorter timeout for the auto path (webhook/status-change)
  // since it may run on Vercel serverless where long-running requests
  // are killed. The manual admin button uses a longer timeout that
  // stays under the Nginx 300s proxy cap.
  // The retry loop in design-generation-core.ts handles transient
  // timeouts from the shorter window.
  const timeoutMs = trigger === 'auto' ? AUTO_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/api/orders/generate-design`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-callback-secret': secret,
      },
      body: JSON.stringify({
        orderNumber,
        productId,
        hasReservationPhoto,
        itemIndex,
        orderData,
        trigger,
        operationId,
      }),
      signal: controller.signal,
    });

    // Check content-type before parsing — the design app might return
    // an HTML error page (e.g. 502 from a reverse proxy, or a Next.js
    // error page) instead of JSON. Parsing HTML as JSON throws
    // "Unexpected token '<'" which is unhelpful.
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      // Read the body as text for the error message (truncated)
      const text = await response.text();
      const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
      return {
        success: false,
        productId,
        error: 'fetchFailed',
        message: `Design app returned non-JSON response (HTTP ${response.status}, ${contentType || 'no content-type'}): ${snippet || '(empty body)'}`,
      };
    }

    const body = (await response.json()) as DesignAppResponseBody;

    if (!response.ok || !body.success || !body.data?.url) {
      return {
        success: false,
        productId,
        error: body.error || `http_${response.status}`,
        message: body.message,
      };
    }

    return {
      success: true,
      productId,
      url: body.data.url,
      templateType: body.data.templateType ?? 'text',
      projectId: body.data.projectId,
      version: body.data.version,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        success: false,
        productId,
        error: 'timeout',
        message: `Design app did not respond within ${timeoutMs / 1000}s.`,
      };
    }
    const detail = describeFetchError(error);
    console.error(
      `[design-gen] fetch to ${baseUrl}/api/orders/generate-design failed:`,
      detail,
    );
    return {
      success: false,
      productId,
      error: 'fetchFailed',
      message: detail,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ask the design app to delete design-instance projects created for an
 * order. The design app removes the `design_projects` documents AND
 * their per-design R2 assets (BG copies, the generated JPG).
 *
 * Called when the admin deletes designs from an order — without this,
 * the design-app side is orphaned (project docs + R2 files accumulate).
 *
 * Best-effort: returns silently on any failure (caller logs).
 */
export async function deleteDesignAppProjects(projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;

  const baseUrl = getDesignAppUrl();
  const secret = getCallbackSecret();
  if (!baseUrl || !secret) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    await fetch(`${baseUrl}/api/orders/delete-designs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-callback-secret': secret,
      },
      body: JSON.stringify({ projectIds }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

