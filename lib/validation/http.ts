import { NextResponse } from 'next/server';
import { ZodError, ZodSchema } from 'zod';

export class ApiError extends Error {
  code: string;
  status: number;
  details?: unknown;

  constructor(
    code: string,
    message: string,
    status: number = 400,
    details?: unknown,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
    this.name = 'ApiError';
  }

  toResponse() {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: this.code,
          message: this.message,
          details: this.details,
        },
      },
      { status: this.status },
    );
  }
}

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
      response: new ApiError(
        'ERR_INVALID_JSON',
        'Invalid JSON request body',
      ).toResponse(),
    };
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return {
      success: false,
      response: new ApiError(
        'ERR_VALIDATION_FAILED',
        'Request validation failed',
        400,
        formatZodError(parsed.error),
      ).toResponse(),
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
      response: new ApiError(
        'ERR_VALIDATION_FAILED',
        'Request validation failed',
        400,
        formatZodError(parsed.error),
      ).toResponse(),
    };
  }

  return { success: true, data: parsed.data };
}
