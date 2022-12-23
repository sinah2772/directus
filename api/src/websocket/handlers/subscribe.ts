import { getSchema } from '../../utils/get-schema';
import { ItemsService } from '../../services/items';
import type { SubscribeMessage, Subscription, WebSocketClient } from '../types';
import emitter from '../../emitter';
import logger from '../../logger';
import { fmtMessage } from '../utils/message';
import { refreshAccountability } from '../authenticate';
import { MetaService } from '../../services';
import { sanitizeQuery } from '../../utils/sanitize-query';
import { handleWebsocketException, WebSocketException } from '../exceptions';
import type { Accountability, PrimaryKey, SchemaOverview } from '@directus/shared/types';

type UserFocus = {
	user: string;
	collection: string;
	item?: string | number;
	field?: string;
};

export class SubscribeHandler {
	subscriptions: Record<string, Set<Subscription>>;
	onlineStatus: Set<string>;
	userFocus: Record<string, UserFocus>;

	constructor() {
		this.subscriptions = {};
		this.onlineStatus = new Set();
		this.userFocus = {};
		this.bindWebsocket();
		this.bindModules([
			'items',
			'activity',
			'collections',
			'fields',
			'files',
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
			} catch (error) {
				handleWebsocketException(client, error, 'subscribe');
			}
		});
		emitter.onAction('websocket.connect', ({ client }) => {
			this.userOnline(client);
		});
		emitter.onAction('websocket.error', ({ client }) => {
			this.userOffline(client);
			this.unsubscribe(client);
			this.removeFocus(client);
		});
		emitter.onAction('websocket.close', ({ client }) => {
			this.userOffline(client);
			this.unsubscribe(client);
			this.removeFocus(client);
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
		if (uid !== undefined) {
			const subscription = this.getSubscription(uid);
			if (subscription && subscription.client === client) {
				this.subscriptions[subscription.collection]?.delete(subscription);
				// this.removeFocus(client, subscription);
				this.dispatch(subscription.collection, { action: 'focus' });
			} else {
				// logger.warn(`Couldn't find subscription with UID="${uid}" for current user`);
			}
		} else {
			for (const key of Object.keys(this.subscriptions)) {
				const subscriptions = Array.from(this.subscriptions[key] || []);
				for (let i = subscriptions.length - 1; i >= 0; i--) {
					const subscription = subscriptions[i];
					if (!subscription) continue;
					if (subscription.client === client && (!uid || subscription.uid === uid)) {
						this.subscriptions[key]?.delete(subscription);
						this.dispatch(subscription.collection, { action: 'focus' });
					}
				}
			}
		}
	}
	async dispatch(collection: string, data: Record<string, any>) {
		const subscriptions = this.subscriptions[collection] ?? new Set();
		for (const subscription of subscriptions) {
			const { client } = subscription;
			if (data['action'] === 'focus' && !subscription.status) {
				continue; // skip focus updates if not applicable
			}
			if (
				data['action'] === 'status' &&
				'item' in subscription &&
				!(subscription.collection === 'directus_users' && subscription.status)
			) {
				continue; // skip status updates if not applicable
			}
			try {
				const accountability = await refreshAccountability(client.accountability);
				client.accountability = accountability;
				const schema = await getSchema({ accountability });
				const result =
					'item' in subscription
						? await this.getSinglePayload(subscription, accountability, schema, data['action'])
						: await this.getMultiPayload(subscription, accountability, schema, data['action']);
				client.send(fmtMessage('subscription', result, subscription.uid));
			} catch (err) {
				// console.error(err);
				handleWebsocketException(client, err, 'subscribe');
				// logger.debug(`[WS REST] ERROR ${JSON.stringify(err)}`);
			}
		}
	}
	async onMessage(client: WebSocketClient, message: SubscribeMessage) {
		if (message.type === 'SUBSCRIBE') {
			logger.debug(`[WS REST] SubscribeHandler ${JSON.stringify(message)}`);
			try {
				const collection = message.collection!;
				const accountability = client.accountability;
				const schema = await getSchema(accountability ? { accountability } : {});
				// console.log(accountability, JSON.stringify(schema, null, 2));
				if (!accountability?.admin && !(await schema.hasCollection(collection))) {
					throw new WebSocketException(
						'subscribe',
						'INVALID_COLLECTION',
						'The provided collection does not exists or is not accessible.',
						message.uid
					);
				}

				const subscription: Subscription = {
					client,
					collection,
					status: !!message.status,
				};
				if ('query' in message) {
					subscription.query = sanitizeQuery(message.query, accountability);
				}
				if ('item' in message) subscription.item = message.item;
				if ('uid' in message) subscription.uid = message.uid;
				// remove the subscription if it already exists
				this.unsubscribe(client, subscription.uid);

				let data: Record<string, any>;
				if ('item' in subscription) {
					data = await this.getSinglePayload(subscription, accountability, schema);
					this.addFocus(client, subscription);
				} else {
					data = await this.getMultiPayload(subscription, accountability, schema);
				}
				// if no errors were thrown register the subscription
				this.subscribe(subscription);
				this.dispatch(subscription.collection, { action: 'focus' });
				if (!subscription.status || !('item' in subscription) || subscription.collection !== 'directus_users') {
					// prevent double events for init and focus
					client.send(fmtMessage('subscription', data, subscription.uid));
				}
			} catch (err) {
				handleWebsocketException(client, err, 'subscribe');
				// logger.debug(`[WS REST] ERROR ${JSON.stringify(err)}`);
			}
		}
		if (message.type === 'UNSUBSCRIBE') {
			this.unsubscribe(client, message.uid);
		}
		if (message.type === 'FOCUS') {
			this.addFocus(client, message);
		}
	}
	private async getSinglePayload(
		subscription: Subscription,
		accountability: Accountability | null,
		schema: SchemaOverview,
		event = 'init'
	): Promise<Record<string, any>> {
		const service = new ItemsService(subscription.collection, { schema, accountability });
		const metaService = new MetaService({ schema, accountability });
		const query = subscription.query ?? {};
		const id = subscription.item!;

		const result: Record<string, any> = { event };
		result['payload'] = await service.readOne(id, query);
		if ('meta' in query) {
			result['meta'] = await metaService.getMetaForQuery(subscription.collection, query);
		}
		if (subscription.status) {
			const focus = Object.values(this.userFocus)
				.filter(({ collection, item }) => collection === subscription.collection && item === subscription.item)
				.map(({ user }) => user);
			result['status'] = { focus: Array.from(new Set(focus)) };
		}
		return result;
	}
	private async getMultiPayload(
		subscription: Subscription,
		accountability: Accountability | null,
		schema: SchemaOverview,
		event = 'init'
	): Promise<Record<string, any>> {
		// console.error('test', subscription.collection, accountability);
		const service = new ItemsService(subscription.collection, { schema, accountability });
		const metaService = new MetaService({ schema, accountability });
		const query = subscription.query ?? {};
		const result: Record<string, any> = { event };
		result['payload'] = await service.readByQuery(query);
		if ('meta' in query) {
			result['meta'] = await metaService.getMetaForQuery(subscription.collection, query);
		}
		if (subscription.status) {
			result['status'] = {};
			if (subscription.collection === 'directus_users') {
				result['status'].online = Array.from(this.onlineStatus);
			}
			const focus = Object.values(this.userFocus).filter(({ collection }) => collection === subscription.collection);
			result['status'].focus = focus;
		}
		return result;
	}
	private getSubscription(uid: string) {
		for (const subList of Object.values(this.subscriptions)) {
			for (const subscription of subList) {
				if (subscription.uid === uid) {
					return subscription;
				}
			}
		}
		return undefined;
	}
	private addFocus(client: WebSocketClient, opts: { collection: string; item?: PrimaryKey; field?: string }) {
		if (!client.accountability?.user) return;
		this.userFocus[client.accountability.user] = { user: client.accountability.user, ...opts } as UserFocus;
		this.dispatch(opts.collection, { action: 'focus' });
	}
	private removeFocus(client: WebSocketClient) {
		if (!client.accountability?.user || !this.userFocus[client.accountability.user]?.collection) return;
		const collection = this.userFocus[client.accountability.user]!.collection;
		delete this.userFocus[client.accountability.user];
		this.dispatch(collection, { action: 'focus' });
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
