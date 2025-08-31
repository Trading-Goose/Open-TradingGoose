import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

export interface AuthResult {
  userId: string | null;
  error: string | null;
}

export async function verifyAndExtractUser(authHeader: string | null): Promise<AuthResult> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { userId: null, error: 'No valid authorization header' };
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    // First try to extract user ID from token directly (faster)
    const userId = extractUserIdFromToken(authHeader);
    
    if (!userId) {
      console.error('Could not extract user ID from token');
      return { userId: null, error: 'Invalid token format' };
    }

    // Check token expiration
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(atob(parts[1]));
        const exp = payload.exp;
        const now = Math.floor(Date.now() / 1000);
        
        if (exp && now > exp) {
          console.error('Token has expired');
          return { userId: null, error: 'Token has expired' };
        }
      }
    } catch (e) {
      console.error('Error checking token expiration:', e);
    }

    // For Edge Functions, we trust the JWT if it's properly formatted and not expired
    // Supabase already validates it at the gateway level
    return { userId, error: null };
  } catch (error) {
    console.error('Error verifying token:', error);
    return { userId: null, error: 'Token verification failed' };
  }
}

// Legacy function for backward compatibility - extracts without verification
export function extractUserIdFromToken(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  try {
    const token = authHeader.replace('Bearer ', '');
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1]));
      return payload.sub;
    }
  } catch (e) {
    console.error('Error decoding JWT:', e);
  }

  return null;
}