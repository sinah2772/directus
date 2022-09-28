import type WebSocket from 'ws';
import type { Server as httpServer } from 'http';
import type { SocketControllerConfig, WebRequest, WebsocketClient, WebsocketMessage } from '../types';
import logger from '../../logger';
import env from '../../env';
import { refreshAccountability } from '../utils';
import SocketController from './base';
import emitter from '../../emitter';
import { errorMessage } from '../utils/message';

function getEnvConfig(): SocketControllerConfig {
	const endpoint: string = env['WEBSOCKETS_REST_PATH'];
	const mode: 'strict' | 'public' | 'handshake' = env['WEBSOCKETS_REST_AUTH'];
	if (mode === 'handshake') {
		const timeout = env['WEBSOCKETS_REST_AUTH_TIMEOUT'] * 1000;
		return { endpoint, auth: { mode, timeout } };
	} else {
		return { endpoint, auth: { mode } };
	}
}

export class WebsocketController extends SocketController {
	clients: Set<WebsocketClient>;

	constructor(httpServer: httpServer) {
		super(httpServer, getEnvConfig());
		this.clients = new Set();
		this.server.on('connection', (ws: WebSocket, req: WebRequest) => {
			this.createClient(ws, req);
		});
	}
	private createClient(ws: WebSocket, req: WebRequest) {
		const client = ws as WebsocketClient;
		client.accountability = req.accountability;
		const clientName = client.accountability?.user || 'public user';

		ws.addEventListener('message', async (event: WebSocket.MessageEvent) => {
			logger.debug(`[WS REST] ${clientName} message`, event);
			let message: WebsocketMessage;
			try {
				message = await emitter.emitFilter('websocket.message', JSON.parse(event.data as string), {
					client,
					config: this.config,
				});
				client.accountability = await refreshAccountability(client.accountability);
			} catch (err: any) {
				logger.error(err);
				client.send(errorMessage(err.message));
				return;
			}
			try {
				emitter.emitAction('websocket.message', { message, client, config: this.config });
			} catch (err: any) {
				logger.error(err);
				client.send(errorMessage(err.message));
			}
		});
		ws.addEventListener('error', (event: WebSocket.Event) => {
			logger.debug(`[WS REST] ${clientName} error`, event);
			this.clients.delete(client);
			emitter.emitAction('websocket.error', { client, config: this.config });
		});
		ws.addEventListener('close', (event: WebSocket.CloseEvent) => {
			logger.debug(`[WS REST] ${clientName} closed`, event);
			this.clients.delete(client);
			emitter.emitAction('websocket.close', { client, config: this.config });
		});
		// client connected
		logger.debug(`[WS REST] ${clientName} connected`);
		this.clients.add(client);
		emitter.emitAction('websocket.connect', { client, config: this.config });
	}
}
