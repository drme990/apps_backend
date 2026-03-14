import { NextResponse } from 'next/server';
import { ZodError, ZodSchema } from 'zod';

interface ValidationSuccess<T> {
  success: true;
  data: T;
}

interface ValidationFailure {
  success: false;
  response: NextResponse;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'body';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export async function parseJsonBody<T>(
  request: Request,
  schema: ZodSchema<T>,
): Promise<ValidationResult<T>> {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return {
      success: false,
      response: NextResponse.json(
        { success: false, error: 'Invalid JSON request body' },
        { status: 400 },
      ),
    };
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return {
      success: false,
      response: NextResponse.json(
        {
          success: false,
          error: 'Request validation failed',
          details: formatZodError(parsed.error),
        },
        { status: 400 },
      ),
    };
  }

  return { success: true, data: parsed.data };
}

export function validateInput<T>(
  payload: unknown,
  schema: ZodSchema<T>,
): ValidationResult<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return {
      success: false,
      response: NextResponse.json(
        {
          success: false,
          error: 'Request validation failed',
          details: formatZodError(parsed.error),
        },
        { status: 400 },
      ),
    };
  }

  return { success: true, data: parsed.data };
}
