import type { Accountability } from '@directus/shared/types';
import type { IncomingMessage, Server as httpServer } from 'http';
import type { ParsedUrlQuery } from 'querystring';
import WebSocket, { WebSocketServer } from 'ws';
import type internal from 'stream';
import { parse } from 'url';
import logger from '../../logger';
import { getAccountabilityForToken } from '../../utils/get-accountability-for-token';
import { getExpiresAtForToken } from '../utils/get-expires-at-for-token';
import { authenticateConnection, authenticationError, authenticationSuccess } from '../authenticate';
import { AuthenticationFailedException } from '../../exceptions/authentication-failed';
import type { AuthenticationState, AuthMessage, WebSocketClient, WebSocketMessage } from '../types';

import { errorMessage } from '../utils/message';
import { waitForAnyMessage, waitForMessageType } from '../utils/wait-for-message';
import { parseIncomingMessage } from '../utils/parse-incoming-message';
import { InvalidPayloadException, TokenExpiredException } from '../../exceptions';

type UpgradeContext = {
	request: IncomingMessage;
	socket: internal.Duplex;
	head: Buffer;
};

export default abstract class SocketController {
	name: string;
	server: WebSocket.Server;
	clients: Set<WebSocketClient>;
	authentication: {
		mode: 'public' | 'handshake' | 'strict';
		timeout: number;
	};
	endpoint: string;
	private authTimer: NodeJS.Timer | null;

	constructor(
		httpServer: httpServer,
		name: string,
		endpoint: string,
		authentication: {
			mode: 'public' | 'handshake' | 'strict';
			timeout: number;
		}
	) {
		this.server = new WebSocketServer({ noServer: true });
		this.clients = new Set();
		this.authTimer = null;
		this.name = name;
		this.endpoint = endpoint;
		this.authentication = authentication;
		httpServer.on('upgrade', this.handleUpgrade.bind(this));
	}
	private async handleUpgrade(request: IncomingMessage, socket: internal.Duplex, head: Buffer) {
		const { pathname, query } = parse(request.url!, true);
		if (pathname !== this.endpoint) return;
		const context: UpgradeContext = { request, socket, head };
		if (this.authentication.mode === 'strict') {
			await this.handleStrictUpgrade(context, query);
			return;
		}
		if (this.authentication.mode === 'handshake') {
			await this.handleHandshakeUpgrade(context);
			return;
		}
		this.server.handleUpgrade(request, socket, head, async (ws) => {
			const state = { accountability: null, expiresAt: null } as AuthenticationState;
			this.server.emit('connection', ws, state);
		});
	}
	private async handleStrictUpgrade({ request, socket, head }: UpgradeContext, query: ParsedUrlQuery) {
		let accountability: Accountability | null, expiresAt: number | null;
		try {
			const token = query['access_token'] as string;
			accountability = await getAccountabilityForToken(token);
			expiresAt = getExpiresAtForToken(token);
		} catch {
			accountability = null;
			expiresAt = null;
		}
		if (!accountability || !accountability.user) {
			logger.debug('Websocket upgrade denied - ' + JSON.stringify(accountability || 'invalid'));
			socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
			socket.destroy();
			return;
		}
		this.server.handleUpgrade(request, socket, head, async (ws) => {
			const state = { accountability, expiresAt } as AuthenticationState;
			this.server.emit('connection', ws, state);
		});
	}
	private async handleHandshakeUpgrade({ request, socket, head }: UpgradeContext) {
		this.server.handleUpgrade(request, socket, head, async (ws) => {
			try {
				const payload: WebSocketMessage = await waitForAnyMessage(ws, this.authentication.timeout);
				if (payload.type !== 'AUTH') {
					throw new AuthenticationFailedException();
				}
				const state = await authenticateConnection(payload as AuthMessage);
				ws.send(authenticationSuccess(payload['uid']));
				this.server.emit('connection', ws, state);
			} catch {
				ws.send(errorMessage(new AuthenticationFailedException()));
				ws.close();
			}
		});
	}
	createClient(ws: WebSocket, { accountability, expiresAt }: AuthenticationState) {
		const client = ws as WebSocketClient;
		client.accountability = accountability;
		client.expiresAt = expiresAt;

		ws.on('message', async (data: WebSocket.RawData) => {
			this.log(`${client.accountability?.user || 'public user'} message`);
			let message: WebSocketMessage;
			try {
				message = parseIncomingMessage(data.toString());
			} catch (err: any) {
				client.send(errorMessage(new InvalidPayloadException(err)));
				return;
			}
			this.log(JSON.stringify(message));
			if (message.type === 'AUTH') {
				try {
					const { accountability, expiresAt } = await authenticateConnection(message as AuthMessage);
					client.accountability = accountability;
					client.expiresAt = expiresAt;
					this.setTokenExpireTimer(client);
					client.send(authenticationSuccess(message['uid']));
					this.log(`${client.accountability?.user || 'public user'} authenticated`);
					return;
				} catch (err) {
					this.log(`${client.accountability?.user || 'public user'} failed authentication`);
					client.accountability = null;
					client.expiresAt = null;
					client.send(authenticationError(message['uid']));
				}
			}
			ws.emit('parsed-message', message);
		});
		ws.on('error', () => {
			this.log(`${client.accountability?.user || 'public user'} error`);
			if (this.authTimer) clearTimeout(this.authTimer);
			this.clients.delete(client);
		});
		ws.on('close', () => {
			this.log(`${client.accountability?.user || 'public user'} closed`);
			if (this.authTimer) clearTimeout(this.authTimer);
			this.clients.delete(client);
		});
		this.log(`${client.accountability?.user || 'public user'} connected`);
		this.setTokenExpireTimer(client);
		this.clients.add(client);
		return client;
	}
	setTokenExpireTimer(client: WebSocketClient) {
		if (this.authTimer) clearTimeout(this.authTimer);
		if (!client.expiresAt) return;
		const expiresIn = client.expiresAt * 1000 - Date.now();
		this.authTimer = setTimeout(() => {
			client.accountability = null;
			client.expiresAt = null;
			client.send(authenticationError(new TokenExpiredException()));
			waitForMessageType(client, 'AUTH', this.authentication.timeout).catch((msg: WebSocketMessage) => {
				client.send(authenticationError(undefined, msg['uid']));
				if (this.authentication.mode !== 'public') {
					client.close();
				}
			});
		}, expiresIn);
	}
	terminate() {
		this.server.clients.forEach((ws) => {
			ws.terminate();
		});
	}
	log(message: string) {
		logger.debug(`[${this.name}] ${message}`);
	}
}
