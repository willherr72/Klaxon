import { ConvexClient, ConvexHttpClient, type ConnectionState } from 'convex/browser';
import { api } from './contracts';

type Grant = { userId: string; accessToken: string; refreshToken: string; refreshTokenExpiresAt: number };
type Events = {
  connection: (state: ConnectionState) => void;
  authenticated: () => void;
  expired: (message: string) => void;
};

function hasFields<K extends string>(value: unknown, ...fields: K[]): value is Record<K, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validGrant(value: unknown): value is Grant {
  return hasFields(value, 'userId', 'accessToken', 'refreshToken', 'refreshTokenExpiresAt')
    && nonblank(value.userId) && nonblank(value.accessToken) && nonblank(value.refreshToken)
    && typeof value.refreshTokenExpiresAt === 'number' && Number.isFinite(value.refreshTokenExpiresAt)
    && value.refreshTokenExpiresAt > 0;
}

export class SignInError extends Error {}

export async function signIn(origin: string, username: string, password: string, events: Events) {
  const issuer = new ConvexHttpClient(origin, {
    logger: false,
    fetch: (input, options) => fetch(input, { ...options, signal: AbortSignal.timeout(15_000) }),
  });
  let result: unknown;
  try {
    result = await issuer.mutation(api.signIn, { username, password });
  } catch {
    throw new SignInError('Could not reach the sign-in service. Check your connection and try again.');
  }
  if (hasFields(result, 'status', 'userError') && result.status === 'error') {
    throw new SignInError('Sign-in failed. Check your username and password.');
  }
  // Auth 2.1 returns a grant inside the already-unwrapped mutation value.
  if (!hasFields(result, 'status', 'tokens') || result.status !== 'complete' || !validGrant(result.tokens)) {
    throw new SignInError('Sign-in could not be confirmed. Try again.');
  }
  return createSession(origin, issuer, result.tokens, events);
}

function createSession(origin: string, issuer: ConvexHttpClient, grant: Grant, events: Events) {
  // The browser session lasts only as long as this page. P6 owns native refresh storage.
  let tokens: Grant | undefined = grant;
  let refreshing: Promise<string | null> | undefined;
  let signingOut = false;
  let unsubscribe: (() => void) | undefined;
  const client = new ConvexClient(origin, { logger: false, expectAuth: true, initialAuthTokenReuse: true });

  function dispose() {
    if (!tokens) return;
    tokens = undefined;
    unsubscribe?.();
    void client.close();
  }

  function expire(message = 'Session expired. Sign in again.') {
    if (!tokens) return;
    dispose();
    events.expired(message);
  }

  async function rotate(previous: Grant) {
    const rotated = await issuer.mutation(api.refresh, { refreshToken: previous.refreshToken });
    if (!tokens) return null;
    if (hasFields(rotated, 'kind') && rotated.kind === 'noSession') {
      expire();
      return null;
    }
    if (!hasFields(rotated, 'kind', 'tokens') || rotated.kind !== 'rotated' || !validGrant(rotated.tokens)
        || rotated.tokens.userId !== previous.userId || rotated.tokens.refreshToken === previous.refreshToken) {
      throw new Error('Invalid refresh response');
    }
    tokens = rotated.tokens;
    return tokens.accessToken;
  }

  async function fetchToken({ forceRefreshToken }: { forceRefreshToken: boolean }) {
    if (signingOut || !tokens) return null;
    if (!forceRefreshToken) return tokens.accessToken;
    try {
      refreshing ??= rotate(tokens).finally(() => { refreshing = undefined; });
      return await refreshing;
    } catch {
      // Convex pauses the socket while waiting for this callback to settle.
      if (!signingOut) expire('Session refresh could not be confirmed. Reconnect and sign in again.');
      return null;
    }
  }

  function authenticate() {
    client.setAuth(fetchToken, authenticated => {
      if (signingOut || !tokens) return;
      if (authenticated) events.authenticated();
      else expire();
    });
  }

  return {
    client,
    userId: grant.userId,
    start() {
      unsubscribe = client.subscribeToConnectionState(state => {
        if (tokens) events.connection(state);
      });
      events.connection(client.connectionState());
      authenticate();
    },
    expire,
    dispose,
    async signOut() {
      signingOut = true;
      try {
        // Revoke the current refresh token even if rotation was already in flight.
        await refreshing;
        if (tokens && await issuer.mutation(api.signOut, { refreshToken: tokens.refreshToken }) !== null) {
          throw new Error('Invalid sign-out acknowledgment');
        }
        dispose();
      } catch {
        signingOut = false;
        if (tokens) authenticate();
        throw new Error('Sign-out could not be confirmed. Reconnect and try again.');
      }
    },
  };
}

export type Session = Awaited<ReturnType<typeof signIn>>;
