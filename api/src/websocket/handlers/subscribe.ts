import { getSchema } from '../../utils/get-schema';
import { ItemsService } from '../../services/items';
import type { SubscribeMessage, Subscription, WebSocketClient } from '../types';
import type { Item } from '@directus/shared/types';
import emitter from '../../emitter';
import logger from '../../logger';
import { errorMessage, fmtMessage } from '../utils/message';
import { refreshAccountability } from '../authenticate';
import { omit } from 'lodash-es';

export class SubscribeHandler {
	subscriptions: Record<string, Set<Subscription>>;
	onlineStatus: Set<string>;

	constructor() {
		this.subscriptions = {};
		this.onlineStatus = new Set();
		this.bindWebsocket();
		this.bindModules([
			'items',
			'activity',
			'collections',
			'fields',
			'folders',
			'permissions',
			'presets',
			'relations',
			'revisions',
			'roles',
			'settings',
			'users',
			'webhooks',
		]);
	}
	bindWebsocket() {
		emitter.onAction('websocket.message', ({ client, message }) => {
			try {
				this.onMessage(client, message as SubscribeMessage);
			} catch (err: any) {
				return client.send(errorMessage(err, message['uid']));
			}
		});
		emitter.onAction('websocket.connect', ({ client }) => {
			this.userOnline(client);
		});
		emitter.onAction('websocket.error', ({ client }) => {
			this.userOffline(client);
			this.unsubscribe(client);
		});
		emitter.onAction('websocket.close', ({ client }) => {
			this.userOffline(client);
			this.unsubscribe(client);
		});
		emitter.onAction('websocket.auth.success', ({ client }) => {
			this.userOnline(client);
		});
		emitter.onAction('websocket.auth.failure', ({ client }) => {
			this.userOffline(client);
		});
	}
	bindModules(modules: string[]) {
		const bindAction = (event: string, mutator?: (args: any) => any) => {
			emitter.onAction(event, async (args: any) => {
				const message = mutator ? mutator(args) : {};
				message.action = event.split('.').pop();
				message.collection = args.collection;
				message.payload = args.payload;
				logger.debug(`[ WS ] event ${event} ` /*- ${JSON.stringify(message)}`*/);
				this.dispatch(message.collection, message);
			});
		};
		for (const module of modules) {
			bindAction(module + '.create', ({ key }: any) => ({ key }));
			bindAction(module + '.update', ({ keys }: any) => ({ keys }));
			bindAction(module + '.delete');
		}
	}
	subscribe(subscription: Subscription) {
		const { collection } = subscription;
		if (!this.subscriptions[collection]) {
			this.subscriptions[collection] = new Set();
		}
		this.subscriptions[collection]?.add(subscription);
	}
	unsubscribe(client: WebSocketClient, uid?: string) {
		for (const key of Object.keys(this.subscriptions)) {
			const subscriptions = Array.from(this.subscriptions[key] || []);
			for (let i = subscriptions.length - 1; i >= 0; i--) {
				const subscription = subscriptions[i];
				if (!subscription) continue;
				if (subscription.client === client && (!uid || subscription.uid === uid)) {
					this.subscriptions[key]?.delete(subscription);
				}
			}
		}
	}
	async dispatch(collection: string, data: any) {
		const subscriptions = this.subscriptions[collection] ?? new Set();
		for (const subscription of subscriptions) {
			const { uid, client, query = {} } = subscription;
			client.accountability = await refreshAccountability(client.accountability);
			const service = new ItemsService(collection, {
				schema: await getSchema({ accountability: client.accountability }),
				accountability: client.accountability,
			});
			try {
				// get the payload based on the provided query
				// const keys = data.key ? [data.key] : data.keys;
				// const payload = data.action === 'delete' ? data.payload : await service.readMany(keys, query);
				// if (payload.length > 0) {
				// 	client.send(fmtMessage('subscription',
				// 		{ payload: 'key' in data ? payload[0] : payload, event: data.action },
				// 		uid));
				// }
				const payload = this.mergeStatusData(await service.readByQuery(query), subscription);
				client.send(fmtMessage('subscription', { payload, event: data.action }, uid));
			} catch (err: any) {
				logger.debug(`[WS REST] ERROR ${JSON.stringify(err)}`);
			}
		}
	}
	async onMessage(client: WebSocketClient, message: SubscribeMessage) {
		if (message.type === 'SUBSCRIBE') {
			const collection = message['collection']!;
			logger.debug(`[WS REST] SubscribeHandler ${JSON.stringify(message)}`);
			const service = new ItemsService(collection, {
				schema: await getSchema(),
				accountability: client.accountability,
			});
			try {
				const subscription: Subscription = { ...omit(message, 'type'), client };
				// if not authorized the read should throw an error
				const initialPayload = this.mergeStatusData(await service.readByQuery(message['query'] ?? {}), subscription);
				// subscribe to events if all went well
				this.subscribe(subscription);
				// send initial data
				client.send(
					fmtMessage(
						'subscription',
						{
							payload: initialPayload,
							event: 'init',
						},
						message['uid']
					)
				);
			} catch (err: any) {
				logger.debug(`[WS REST] ERROR ${JSON.stringify(err)}`);
			}
		}
		if (message.type === 'UNSUBSCRIBE') {
			this.unsubscribe(client, message['uid']);
		}
	}
	private userOnline(client: WebSocketClient) {
		const userId = client.accountability?.user;
		if (!userId) return;
		this.onlineStatus.add(userId);
	}
	private userOffline(client: WebSocketClient) {
		const userId = client.accountability?.user;
		if (!userId) return;
		this.onlineStatus.delete(userId);
	}
	private mergeStatusData(items: Item[], subscription: Subscription) {
		if (!subscription.status) return items;
		if (subscription.collection === 'directus_users') {
			// merge in online status
			return items.map((item) => {
				if (item['id']) item['online'] = this.onlineStatus.has(item['id']);
				return item;
			});
		} else {
			return items;
			// do something for open subscriptions
			// const watchedItems = this.watchedItems(subscription.collection);
			// return items.map((item) => {
			// 	if (item['id'] && watchedItems[item['id']]) {
			// 		item['']
			// 	}
			// 	return item;
			// })
		}
	}
}
