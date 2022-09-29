import type { BaseException } from '@directus/shared/exceptions';
import type { Accountability } from '@directus/shared/types';
import { AuthenticationService } from '../services';
import { getSchema } from '../utils/get-schema';
import { DEFAULT_AUTH_PROVIDER } from '../constants';
import type { AuthenticationState, AuthMessage, ResponseMessage } from './types';
import { AuthenticationFailedException } from '../exceptions/authentication-failed';
import { getAccountabilityForToken } from '../utils/get-accountability-for-token';
import { getAccountabilityForRole } from '../utils/get-accountability-for-role';
import getDatabase from '../database';
import { getExpiresAtForToken } from './utils/get-expires-at-for-token';

export async function authenticateWithToken(token: string, expires?: number) {
	const accountability = await getAccountabilityForToken(token);
	let expiresAt: number | null = expires ?? null;
	if (!expires) {
		expiresAt = getExpiresAtForToken(token);
	}
	return { accountability, expiresAt } as AuthenticationState;
}

export async function authenticateConnection(message: AuthMessage): Promise<AuthenticationState> {
	let access_token: string | undefined, expires_at: number | undefined;
	if ('email' in message && 'password' in message) {
		const authenticationService = new AuthenticationService({ schema: await getSchema() });
		const { accessToken, expires } = await authenticationService.login(DEFAULT_AUTH_PROVIDER, message);
		access_token = accessToken;
		expires_at = expires;
	}
	if ('refresh_token' in message) {
		const authenticationService = new AuthenticationService({ schema: await getSchema() });
		const { accessToken } = await authenticationService.refresh(message.refresh_token);
		access_token = accessToken;
	}
	if ('access_token' in message) {
		access_token = message.access_token;
	}
	if (!access_token) throw new AuthenticationFailedException();
	return await authenticateWithToken(access_token, expires_at);
}

export async function refreshAccountability(
	accountability: Accountability | null | undefined
): Promise<Accountability> {
	const result: Accountability = await getAccountabilityForRole(accountability?.role || null, {
		accountability: accountability || null,
		schema: await getSchema(),
		database: getDatabase(),
	});
	result.user = accountability?.user || null;
	return result;
}

export function authenticationError(error?: BaseException, uid?: string): string {
	error = error ?? new AuthenticationFailedException();
	return JSON.stringify({
		type: 'auth',
		status: 'error',
		error: {
			code: error.code,
			message: error.message,
		},
		...(uid ? { uid } : {}),
	} as ResponseMessage);
}

export function authenticationSuccess(uid?: string): string {
	return JSON.stringify({
		type: 'auth',
		status: 'ok',
		...(uid ? { uid } : {}),
	} as ResponseMessage);
}
