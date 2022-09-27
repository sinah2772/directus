import type { Accountability } from '@directus/shared/types';
import type { IncomingMessage, Server as httpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { parse } from 'url';
import type { SocketControllerConfig, WebRequest } from '../types';
import logger from '../../logger';
import { getAccountabilityForToken } from '../../utils/get-accountability-for-token';
import type internal from 'stream';
import { extractToken } from '../utils';
import emitter from '../../emitter';
import { waitForMessage } from '../utils/wait-for-message';
import { trimUpper } from '../utils/message';
import { getAccountability } from '../utils/get-accountability';

export const defaultSocketConfig: SocketControllerConfig = {
	endpoint: '/websocket',
	auth: { mode: 'strict' },
};

export default abstract class SocketController {
	config: SocketControllerConfig;
	server: WebSocket.Server;
	// hook the websocket handler into the express server
	constructor(httpServer: httpServer, config?: SocketControllerConfig) {
		this.server = new WebSocketServer({ noServer: true });
		this.config = config ?? defaultSocketConfig;

		httpServer.on('upgrade', this.handleUpgrade.bind(this));
	}
	private async handleUpgrade(request: IncomingMessage, socket: internal.Duplex, head: Buffer) {
		const { pathname, query } = parse(request.url!, true);
		if (pathname === this.config.endpoint) {
			const req = request as WebRequest;
			if (this.config.auth.mode === 'strict') {
				let accountability: Accountability | undefined;
				// check token before upgrading when not set to public access
				try {
					accountability = await getAccountabilityForToken(extractToken(request, query));
				} catch {
					accountability = undefined;
				}
				if (!accountability || !accountability.user) {
					// do we need to check the role?
					logger.debug('Websocket upgrade denied - ' + JSON.stringify(accountability || 'invalid'));
					socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
					socket.destroy();
					return;
				}
				if (accountability) req.accountability = accountability;
			}
			this.server.handleUpgrade(request, socket, head, async (ws) => {
				try {
					const _req = await emitter.emitFilter('websocket.upgrade', req, { config: this.config });
					if (this.config.auth.mode === 'handshake') {
						_req.accountability = await this.handleHandshake(ws, this.config.auth.timeout);
					}
					this.server.emit('connection', ws, _req);
				} catch (error: any) {
					// logger.error('upgrade stopped ', JSON.stringify(error));
					ws.send(JSON.stringify({ error: error.message }));
					ws.close();
				}
			});
		}
	}
	private async handleHandshake(client: WebSocket.WebSocket, timeout: number) {
		const payload = await waitForMessage(client, timeout)
			.then((data: any) => data as Record<string, any>)
			.catch(() => {
				throw new Error('Failed handshake.');
			});
		if (!payload) throw new Error('Failed handshake.');
		if (trimUpper(payload['type']) !== 'HANDSHAKE') {
			throw new Error('Failed handshake.');
		}
		if (payload['access_token']) {
			return await getAccountability(payload['access_token']);
		}
		if (payload['email'] && payload['password']) {
			return await getAccountability({
				email: payload['email'],
				password: payload['password'],
			});
		}
		throw new Error('Failed handshake.');
	}
	terminate() {
		this.server.clients.forEach((ws) => {
			ws.terminate();
		});
	}
}
