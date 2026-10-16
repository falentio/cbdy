import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Credentials {
  accessToken: string;
  userId: string;
  refreshToken?: string;
  expiresAt?: number;
}

export class CredentialsUnavailableError extends Error {
  override name = 'CredentialsUnavailableError';
}

// The auth id the CodeBuddy product config declares for the default endpoint.
const AUTH_ID = 'Tencent-Cloud.coding-copilot';

export function credentialFilePath(home: string = os.homedir()): string {
  return path.join(
    home,
    '.local/share/CodeBuddyExtension/Data/Public/auth',
    `${AUTH_ID}.info`,
  );
}

export function userIdFromJwt(token: string): string | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: string;
    };
    return claims.sub;
  } catch {
    return undefined;
  }
}

export function readStoredCredentials(filePath: string = credentialFilePath()): Credentials | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    account?: { uid?: string };
    auth?: { accessToken?: string; refreshToken?: string; expiresAt?: number };
  };
  const accessToken = stored.auth?.accessToken;
  if (!accessToken) return undefined;
  const userId = stored.account?.uid ?? userIdFromJwt(accessToken);
  if (!userId) return undefined;
  return {
    accessToken,
    userId,
    ...(stored.auth?.refreshToken === undefined ? {} : { refreshToken: stored.auth.refreshToken }),
    ...(stored.auth?.expiresAt === undefined ? {} : { expiresAt: stored.auth.expiresAt }),
  };
}

/**
 * Env tokens win over the CLI's stored session, matching
 * getAuthenticationAttributesSync in the CodeBuddy bundle.
 */
export function resolveCredentials(
  env: NodeJS.ProcessEnv = process.env,
  filePath: string = credentialFilePath(),
): Credentials {
  const stored = readStoredCredentials(filePath);
  const fromEnv = env.CODEBUDDY_AUTH_TOKEN ?? env.CODEBUDDY_API_KEY;
  if (fromEnv) {
    const accessToken = fromEnv.startsWith('Bearer ') ? fromEnv.slice(7) : fromEnv;
    const userId = stored?.userId ?? userIdFromJwt(accessToken);
    if (!userId) {
      throw new CredentialsUnavailableError(
        'CODEBUDDY_AUTH_TOKEN carries a token with no sub claim and no stored account is available for the user id header',
      );
    }
    return { ...stored, accessToken, userId };
  }
  if (!stored) {
    throw new CredentialsUnavailableError(
      `No CodeBuddy credentials. Run \`codebuddy\` once to sign in, or set CODEBUDDY_AUTH_TOKEN. Looked in ${filePath}.`,
    );
  }
  return stored;
}
