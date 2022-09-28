import logger from '../../logger';
import { getSchema } from '../../utils/get-schema';
import { ItemsService } from '../../services/items';
import type { WebSocketClient, WebSocketMessage } from '../types';
import { errorMessage, fmtMessage, trimUpper } from '../utils/message';
import emitter from '../../emitter';

export class ItemsHandler {
	constructor() {
		emitter.onAction('websocket.message', ({ client, message }) => {
			try {
				this.onMessage(client, message);
			} catch (err) {
				client.send(errorMessage(err as string, message['uid']));
			}
		});
	}
	async onMessage(client: WebSocketClient, message: WebSocketMessage) {
		if (trimUpper(message.type) !== 'ITEMS') return;
		const uid = message['uid'];
		if (!message['collection']) {
			return client.send(errorMessage('invalid collection', uid));
		}
		const service = new ItemsService(message['collection'], {
			accountability: client.accountability,
			schema: await getSchema(),
		});
		if (!['create', 'read', 'update', 'delete'].includes(message['action'])) {
			return client.send(errorMessage('invalid action', uid));
		}
		let result;
		switch (message['action']) {
			case 'create':
				if (Array.isArray(message['data'])) {
					const keys = await service.createMany(message['data']);
					result = await service.readMany(keys, message['query'] || {});
				} else if (!message['data']) {
					return client.send(errorMessage('invalid data payload', uid));
				} else {
					const key = await service.createOne(message['data']);
					result = await service.readOne(key, message['query'] || {});
				}
				break;
			case 'read':
				if (!message['query']) {
					return client.send(errorMessage('invalid query', uid));
				}
				result = await service.readByQuery(message['query']);
				break;
			case 'update':
				if (Array.isArray(message['data'])) {
					const keys = await service.updateMany(message['ids'], message['data']);
					result = await service.readMany(keys, message['query']);
				} else if (!message['data']) {
					return client.send(errorMessage('invalid data payload', uid));
				} else {
					const key = await service.updateOne(message['id'], message['data']);
					result = await service.readOne(key);
				}
				break;
			case 'delete':
				if (message['keys']) {
					await service.deleteMany(message['keys']);
					result = message['keys'];
				} else if (message['key']) {
					await service.deleteOne(message['key']);
					result = message['key'];
				} else {
					return client.send(errorMessage("Either 'keys' or 'key' is required for a DELETE request", uid));
				}
				break;
		}
		logger.debug(`[WS REST] ItemsHandler ${JSON.stringify(message)}`);
		client.send(fmtMessage('items', { data: result }, uid));
	}
}
