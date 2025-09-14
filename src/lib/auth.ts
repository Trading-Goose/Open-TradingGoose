// Unified authentication system for all users
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { supabase } from './supabase';
import { getCachedSession, clearSessionCache, updateCachedSession } from './cachedAuth';
import type { User, Session } from '@supabase/supabase-js';

// Types
export interface Profile {
  id: string;
  email: string;
  name?: string;
  full_name?: string;
  avatar_url?: string;
  created_at: string;
  updated_at?: string;
}

export interface ApiSettings {
  id?: string;
  user_id: string;
  ai_provider: string;
  ai_api_key: string;
  ai_model: string;
  polygon_api_key?: string;
  alpaca_paper_api_key?: string;
  alpaca_paper_secret_key?: string;
  alpaca_live_api_key?: string;
  alpaca_live_secret_key?: string;
  alpaca_paper_trading?: boolean;
  created_at?: string;
  updated_at?: string;
}

interface AuthState {
  // Core state
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  apiSettings: ApiSettings | null;

  // Status flags
  isAuthenticated: boolean;
  isLoading: boolean;

  // Error handling
  error: string | null;

  // Core methods
  initialize: () => Promise<void>;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<{ success: boolean; error?: string }>;

  // Password methods
  resetPassword: (email: string) => Promise<{ success: boolean; error?: string }>;
  updatePassword: (newPassword: string) => Promise<{ success: boolean; error?: string }>;

  // Settings methods
  updateApiSettings: (settings: Partial<ApiSettings>) => Promise<void>;

}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      // Initial state
      session: null,
      user: null,
      profile: null,
      apiSettings: null,
      isAuthenticated: false,
      isLoading: false,  // Start with false, will be set to true during init
      error: null,

      // Initialize authentication
      initialize: async () => {
        // Prevent re-initialization if already loading
        const currentState = get();
        if (currentState.isLoading) {
          console.log('🔐 Auth: Already initializing, skipping...');
          return;
        }


        console.log('🔐 Auth: Initializing...');
        set({ isLoading: true, error: null });

        try {
          // Get current session from cache to reduce API calls
          let session = await getCachedSession();
          let sessionError: any = null;

          // If we have a session, try to refresh it to ensure it's valid
          if (session && !sessionError) {
            const { data: { session: refreshedSession }, error: refreshError } = await supabase.auth.refreshSession();
            if (refreshedSession && !refreshError) {
              console.log('🔐 Auth: Session refreshed successfully');
              // Use the refreshed session and update cache
              session = refreshedSession;
              updateCachedSession(refreshedSession);
            } else if (refreshError) {
              console.warn('Failed to refresh session:', refreshError);
              // Continue with existing session
            }
          }

          if (sessionError) {
            console.error('Session error:', sessionError);
            set({
              session: null,
              user: null,
              profile: null,
              apiSettings: null,
              isAuthenticated: false,
                isLoading: false,
              error: sessionError.message
            });
            return;
          }

          if (!session) {
            console.log('🔐 No session found');
            set({
              session: null,
              user: null,
              profile: null,
              apiSettings: null,
              isAuthenticated: false,
                isLoading: false,
              error: null
            });
            return;
          }

          console.log('🔐 Session found for:', session.user.email);

          // Load profile
          const { data: profileData } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .single();

          const profile = profileData || {
            id: session.user.id,
            email: session.user.email || '',
            name: session.user.user_metadata?.name || session.user.email || '',
            created_at: new Date().toISOString()
          };

          // Load API settings via settings-proxy (with masking)
          let apiSettings = null;
          try {
            const { data: proxyData, error: proxyError } = await supabase.functions.invoke('settings-proxy', {
              body: {
                action: 'get_settings'
              }
            });

            if (!proxyError && proxyData.settings) {
              apiSettings = proxyData.settings;
              console.log('🔐 Auth: Loaded settings from proxy:', {
                analysis_optimization: apiSettings.analysis_optimization,
                analysis_history_days: apiSettings.analysis_history_days,
                hasOptimization: 'analysis_optimization' in apiSettings,
                hasHistoryDays: 'analysis_history_days' in apiSettings
              });
            } else {
              console.log('No settings found via proxy, will create defaults');
            }
          } catch (proxyError) {
            console.error('Error loading settings via proxy:', proxyError);
          }

          // Create default settings if none exist (via settings-proxy)
          if (!apiSettings) {
            try {
              const { data: createData, error: createError } = await supabase.functions.invoke('settings-proxy', {
                body: {
                  action: 'update_settings',
                  settings: {
                    ai_provider: 'openai',
                    ai_api_key: '',
                    ai_model: 'gpt-4'
                  }
                }
              });

              if (!createError && createData.success) {
                apiSettings = createData.settings;
              }
            } catch (createError) {
              console.error('Error creating default settings:', createError);
            }
          }


          set({
            session,
            user: session.user,
            profile,
            apiSettings,
            isAuthenticated: true,
            isLoading: false,
            error: null
          });

          console.log('🔐 Auth initialized:', {
            email: session.user.email
          });

        } catch (error) {
          console.error('Auth initialization error:', error);
          set({
            session: null,
            user: null,
            profile: null,
            apiSettings: null,
            isAuthenticated: false,
            isLoading: false,
            error: error instanceof Error ? error.message : 'Failed to initialize'
          });
        }
      },

      // Login
      login: async (email: string, password: string) => {
        console.log('🔐 Login attempt for:', email);
        set({ isLoading: true, error: null });
        
        // Clear cached sessions before login to avoid conflicts
        clearSessionCache();

        try {
          const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password
          });

          if (error) {
            set({ isLoading: false, error: error.message });
            return { success: false, error: error.message };
          }

          if (data.session) {
            console.log('🔐 Login successful, updating cached session');
            
            // Update the cache with the fresh session
            updateCachedSession(data.session);
            
            // The auth state change listener will handle initialization
            // Just set the basic state here
            set({
              session: data.session,
              user: data.user,
              isAuthenticated: true,
              isLoading: false
            });

            // Load the rest of the data
            await get().initialize();

            return { success: true };
          }

          set({ isLoading: false });
          return { success: false, error: 'Login failed' };

        } catch (error) {
          const message = error instanceof Error ? error.message : 'Login failed';
          set({ isLoading: false, error: message });
          return { success: false, error: message };
        }
      },

      // Logout
      logout: async () => {
        console.log('🔐 Logging out...');
        set({ isLoading: true });

        try {
          // Clear cached session first
          clearSessionCache();
          
          // Clear state first
          set({
            session: null,
            user: null,
            profile: null,
            apiSettings: null,
            isAuthenticated: false,
            error: null
          });

          // Sign out from Supabase
          await supabase.auth.signOut();

          // Clear local storage
          localStorage.removeItem('auth-storage');

        } catch (error) {
          console.error('Logout error:', error);
        } finally {
          set({ isLoading: false });
        }
      },

      // Register
      register: async (email: string, password: string, name: string) => {
        console.log('🔐 Register attempt for:', email);
        set({ isLoading: true, error: null });

        try {
          const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
              data: { name }
            }
          });

          if (error) {
            set({ isLoading: false, error: error.message });
            return { success: false, error: error.message };
          }

          if (data.user) {
            // Create profile
            await supabase
              .from('profiles')
              .insert({
                id: data.user.id,
                email,
                name,
                created_at: new Date().toISOString()
              });

            // If session exists (email confirmation disabled), initialize
            if (data.session) {
              await get().initialize();
            } else {
              set({ isLoading: false });
            }

            return { success: true };
          }

          set({ isLoading: false });
          return { success: false, error: 'Registration failed' };

        } catch (error) {
          const message = error instanceof Error ? error.message : 'Registration failed';
          set({ isLoading: false, error: message });
          return { success: false, error: message };
        }
      },

      // Reset password
      resetPassword: async (email: string) => {
        try {
          const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: `${window.location.origin}/reset-password`,
          });

          if (error) {
            return { success: false, error: error.message };
          }

          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to send reset email'
          };
        }
      },

      // Update password
      updatePassword: async (newPassword: string) => {
        try {
          const { error } = await supabase.auth.updateUser({
            password: newPassword
          });

          if (error) {
            return { success: false, error: error.message };
          }

          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update password'
          };
        }
      },

      // Update API settings via settings-proxy
      updateApiSettings: async (settings: Partial<ApiSettings>) => {
        const state = get();
        if (!state.user) {
          throw new Error('Not authenticated');
        }

        try {
          const { data, error } = await supabase.functions.invoke('settings-proxy', {
            body: {
              action: 'update_settings',
              settings: settings
            }
          });

          if (error) throw error;

          if (data.success && data.settings) {
            set({ apiSettings: data.settings });
          } else {
            throw new Error(data.error || 'Failed to update settings');
          }
        } catch (error) {
          console.error('Update settings error:', error);
          throw error;
        }
      },

    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        // Don't persist sensitive data
        isAuthenticated: state.isAuthenticated,
      })
    }
  )
);

// Initialize auth and set up listeners
let initialized = false;
export const initializeAuth = () => {
  if (initialized) return;
  initialized = true;

  // Initial load
  useAuth.getState().initialize();

  // Listen for auth state changes
  supabase.auth.onAuthStateChange(async (event, session) => {
    console.log('🔐 Auth state changed:', event);

    const currentState = useAuth.getState();

    if (event === 'SIGNED_IN') {
      // Only initialize if we're not already authenticated
      if (!currentState.isAuthenticated && session) {
        await useAuth.getState().initialize();
      }
    } else if (event === 'TOKEN_REFRESHED') {
      // Token was refreshed, update the session and cache
      if (session) {
        console.log('🔐 Token refreshed, updating session');
        updateCachedSession(session);
        useAuth.setState({
          session,
          user: session.user,
          isAuthenticated: true
        });
      }
    } else if (event === 'USER_UPDATED') {
      // User data was updated, refresh everything
      if (session) {
        console.log('🔐 User updated, refreshing auth state');
        await useAuth.getState().initialize();
      }
    } else if (event === 'SIGNED_OUT') {
      // Clear state
      useAuth.setState({
        session: null,
        user: null,
        profile: null,
        apiSettings: null,
        isAuthenticated: false,
        isLoading: false,
        error: null
      });
    }
  });
};

// Utility functions for backward compatibility
export const getCurrentUser = () => useAuth.getState().user;
export const getSession = () => useAuth.getState().session;
export const isAuthenticated = () => useAuth.getState().isAuthenticated;

// Check if required API keys are configured
export const hasRequiredApiKeys = (settings: ApiSettings | null): boolean => {
  if (!settings) return false;

  // At minimum, need an AI provider configured
  if (!settings.ai_provider || !settings.ai_api_key) return false;

  // Check if the API key appears valid based on provider
  switch (settings.ai_provider) {
    case 'openai':
      return settings.ai_api_key.startsWith('sk-') && settings.ai_api_key.length > 20;
    case 'anthropic':
      return settings.ai_api_key.startsWith('sk-ant-') && settings.ai_api_key.length > 20;
    case 'openrouter':
      return settings.ai_api_key.startsWith('sk-or-') && settings.ai_api_key.length > 20;
    default:
      return settings.ai_api_key.length > 10;
  }
};

// API Key validators (for Settings page compatibility)
export const validateOpenAIKey = (key: string): boolean => {
  return key.startsWith('sk-') && key.length > 20;
};

export const validateAnthropicKey = (key: string): boolean => {
  return key.startsWith('sk-ant-') && key.length > 20;
};

export const validateOpenRouterKey = (key: string): boolean => {
  return key.startsWith('sk-or-') && key.length > 20;
};


export const validateDeepSeekKey = (key: string): boolean => {
  return key.startsWith('sk-') && key.length > 20;
};

export const validateGoogleKey = (key: string): boolean => {
  return key.startsWith('AIza') && key.length > 30;
};

// Helper function to check if the session is valid and not expired
export const isSessionValid = (): boolean => {
  const state = useAuth.getState();
  
  // Check if we have an invalid refresh token flag
  if ((window as any).__invalidRefreshToken) {
    console.log('🔐 isSessionValid: Invalid refresh token detected, returning false');
    return false;
  }
  
  // If authenticated, allow it - the token refresh system will handle expiry
  if (state.isAuthenticated && state.session?.access_token) {
    try {
      const payload = JSON.parse(atob(state.session.access_token.split('.')[1]));
      const tokenExp = payload.exp;
      const now = Math.floor(Date.now() / 1000);
      const timeUntilExpiry = tokenExp - now;
      
      // Only return false if token is expired by more than 2 hours (very expired)
      // This prevents normal token refresh scenarios from blocking the UI
      if (timeUntilExpiry < -7200) {
        console.log('🔐 isSessionValid: Token very expired (>2h), returning false');
        return false;
      }
      
      console.log('🔐 isSessionValid: User is authenticated, returning true');
      return true;
    } catch (e) {
      // If we can't decode the token, still return true if authenticated
      console.log('🔐 isSessionValid: User is authenticated (fallback), returning true');
      return true;
    }
  }
  
  // If we're rate limited, consider session as valid to prevent unnecessary API calls
  if ((window as any).__supabaseRateLimited) {
    console.log('🔐 isSessionValid: Rate limited, returning true');
    return true;
  }
  
  // If auth is still loading, consider session as valid to prevent premature failures
  if (state.isLoading) {
    console.log('🔐 isSessionValid: Loading, returning true');
    return true;
  }
  
  // Check if we have a valid session in localStorage that we can restore
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
  const storageKey = `sb-${supabaseUrl.split('//')[1].split('.')[0]}-auth-token`;
  const storedSession = localStorage.getItem(storageKey);
  
  if (storedSession) {
    try {
      const sessionData = JSON.parse(storedSession);
      if (sessionData?.access_token) {
        // Check JWT token expiry
        try {
          const payload = JSON.parse(atob(sessionData.access_token.split('.')[1]));
          const tokenExp = payload.exp;
          const now = Math.floor(Date.now() / 1000);
          const timeUntilExpiry = tokenExp - now;
          
          // If token is valid or expired less than 2 hours ago, consider session valid
          // Be very lenient to prevent auth loss during normal usage
          if (timeUntilExpiry > -7200) {
            console.log(`🔐 isSessionValid: Found stored session (expires in ${timeUntilExpiry}s), triggering restore`);
            // Trigger session restoration
            setTimeout(() => {
              if (!useAuth.getState().isAuthenticated) {
                console.log('🔐 Restoring session from localStorage');
                useAuth.getState().initialize();
              }
            }, 100);
            return true;
          }
        } catch (e) {
          // Fallback to session expiry
          if (sessionData.expires_at) {
            const now = Math.floor(Date.now() / 1000);
            const timeUntilExpiry = sessionData.expires_at - now;
            if (timeUntilExpiry > -7200) {
              console.log(`🔐 isSessionValid: Found stored session (fallback, expires in ${timeUntilExpiry}s), triggering restore`);
              setTimeout(() => {
                if (!useAuth.getState().isAuthenticated) {
                  console.log('🔐 Restoring session from localStorage (fallback)');
                  useAuth.getState().initialize();
                }
              }, 100);
              return true;
            }
          }
        }
      }
    } catch (e) {
      // Invalid stored session
    }
  }
  
  console.log('🔐 isSessionValid: No valid session found, returning false');
  return false;
};