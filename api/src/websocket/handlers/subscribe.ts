import { getSchema } from '../../utils/get-schema';
import { ItemsService } from '../../services/items';
import type { SubscribeMessage, Subscription, WebSocketClient } from '../types';
import emitter from '../../emitter';
import logger from '../../logger';
import { errorMessage, fmtMessage } from '../utils/message';
import { refreshAccountability } from '../authenticate';
import { omit } from 'lodash-es';
import { MetaService } from '../../services';

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
			const accountability = await refreshAccountability(client.accountability);
			client.accountability = accountability;
			const schema = await getSchema({ accountability });
			const service = new ItemsService(collection, { schema, accountability });
			const metaService = new MetaService({ schema, accountability });
			try {
				// get the payload based on the provided query
				// const keys = data.key ? [data.key] : data.keys;
				// const payload = data.action === 'delete' ? data.payload : await service.readMany(keys, query);
				// if (payload.length > 0) {
				// 	client.send(fmtMessage('subscription',
				// 		{ payload: 'key' in data ? payload[0] : payload, event: data.action },
				// 		uid));
				// }
				const payload = await service.readByQuery(query);
				const meta = await metaService.getMetaForQuery(collection, query);
				const msg: Record<string, any> = { payload, event: data.action };
				if (subscription.status) msg['status'] = { online: Array.from(this.onlineStatus) };
				if ('meta' in (subscription.query ?? {})) msg['meta'] = meta;
				client.send(fmtMessage('subscription', msg, uid));
			} catch (err: any) {
				logger.debug(`[WS REST] ERROR ${JSON.stringify(err)}`);
			}
		}
	}
	async onMessage(client: WebSocketClient, message: SubscribeMessage) {
		if (message.type === 'SUBSCRIBE') {
			const collection = message['collection']!;
			logger.debug(`[WS REST] SubscribeHandler ${JSON.stringify(message)}`);
			try {
				const accountability = client.accountability;
				const schema = await getSchema(accountability ? { accountability } : {});
				const service = new ItemsService(collection, { schema, accountability });
				const metaService = new MetaService({ schema, accountability });
				const subscription: Subscription = { ...omit(message, 'type'), client };
				// if not authorized the read should throw an error
				const initialPayload = await service.readByQuery(message['query'] ?? {});
				// subscribe to events if all went well
				this.subscribe(subscription);
				// send initial data
				const meta = await metaService.getMetaForQuery(collection, message['query'] ?? {});
				const msg: Record<string, any> = { payload: initialPayload, event: 'init' };
				if (collection === 'directus_users' && subscription.status) {
					msg['status'] = { online: Array.from(this.onlineStatus) };
				}
				if ('meta' in (subscription.query ?? {})) msg['meta'] = meta;
				client.send(fmtMessage('subscription', msg, message['uid']));
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
		this.dispatch('directus_users', { action: 'status' });
	}
	private userOffline(client: WebSocketClient) {
		const userId = client.accountability?.user;
		if (!userId) return;
		this.onlineStatus.delete(userId);
		this.dispatch('directus_users', { action: 'status' });
	}
}
