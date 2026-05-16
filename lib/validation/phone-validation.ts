import { parsePhoneNumber, isValidPhoneNumber, type CountryCode } from 'libphonenumber-js';

/**
 * Validate a phone number using libphonenumber-js
 * @param phone - Phone number string (can include country code)
 * @param countryCode - Optional ISO country code (e.g., 'SA', 'US')
 * @returns Object with isValid flag and error message if invalid
 */
export function validatePhoneNumber(
  phone: string,
  countryCode?: string
): { isValid: boolean; error?: string } {
  if (!phone || phone.trim() === '') {
    return { isValid: false, error: 'Phone number is required' };
  }

  try {
    // Try to parse the phone number
    const phoneNumber = parsePhoneNumber(
      phone,
      countryCode ? (countryCode as CountryCode) : undefined
    );

    if (!phoneNumber) {
      return { isValid: false, error: 'Invalid phone number format' };
    }

    // Check if the phone number is valid
    if (!phoneNumber.isValid()) {
      return { isValid: false, error: 'Invalid phone number for the selected country' };
    }

    return { isValid: true };
  } catch (error) {
    return { isValid: false, error: 'Invalid phone number format' };
  }
}

/**
 * Format a phone number to international format
 * @param phone - Phone number string
 * @param countryCode - Optional ISO country code
 * @returns Formatted phone number or null if invalid
 */
export function formatPhoneNumber(
  phone: string,
  countryCode?: string
): string | null {
  try {
    const phoneNumber = parsePhoneNumber(
      phone,
      countryCode ? (countryCode as CountryCode) : undefined
    );
    if (phoneNumber && phoneNumber.isValid()) {
      return phoneNumber.formatInternational();
    }
    return null;
  } catch (error) {
    return null;
  }
}
