import type { WebSocket, MessageEvent } from 'ws';
import type { WebSocketMessage } from '../types';
import { trimUpper } from './message';
import { parseIncomingMessage } from './parse-incoming-message';

export const waitForAnyMessage = (client: WebSocket, timeout: number): Promise<WebSocketMessage> => {
	return new Promise((resolve, reject) => {
		client.addEventListener('message', awaitMessage);
		const timer = setTimeout(() => {
			client.removeEventListener('message', awaitMessage);
			reject();
		}, timeout);

		function awaitMessage(event: MessageEvent) {
			try {
				clearTimeout(timer);
				client.removeEventListener('message', awaitMessage);
				resolve(parseIncomingMessage(event.data as string));
			} catch (err) {
				reject(err);
			}
		}
	});
};

export const waitForMessageType = (client: WebSocket, type: string, timeout: number): Promise<WebSocketMessage> => {
	type = trimUpper(type);
	return new Promise((resolve, reject) => {
		client.addEventListener('message', awaitMessage);
		const timer = setTimeout(() => {
			client.removeEventListener('message', awaitMessage);
			reject();
		}, timeout);

		function awaitMessage(event: MessageEvent) {
			let msg: WebSocketMessage;
			try {
				msg = parseIncomingMessage(event.data as string);
			} catch {
				return;
			}
			try {
				if (msg.type === type) {
					clearTimeout(timer);
					client.removeEventListener('message', awaitMessage);
					resolve(msg);
				}
			} catch (err) {
				reject(msg);
			}
		}
	});
};
